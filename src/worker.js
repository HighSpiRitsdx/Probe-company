const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

const MAX_HISTORY_MESSAGES = 8;
const MAX_SEARCH_RESULTS = 6;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        mode: env.USE_MOCK_BACKEND === "true" ? "mock" : "live",
        hasAiSearchName: Boolean(env.AI_SEARCH_NAME),
        hasGeminiKey: Boolean(env.GEMINI_API_KEY),
        model: env.GEMINI_MODEL || "gemini-3-flash-preview",
      });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是合法 JSON。" }, 400);
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const requestedModel =
    typeof body?.model === "string" && body.model.trim()
      ? body.model.trim()
      : env.GEMINI_MODEL || "gemini-3-flash-preview";

  const normalizedMessages = messages
    .filter((item) => item && typeof item.role === "string" && typeof item.content === "string")
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.content.trim(),
    }))
    .filter((item) => item.content.length > 0)
    .slice(-MAX_HISTORY_MESSAGES);

  const latestUserMessage = [...normalizedMessages].reverse().find((item) => item.role === "user");
  if (!latestUserMessage) {
    return json({ error: "至少需要一条用户消息。" }, 400);
  }

  if (env.USE_MOCK_BACKEND === "true") {
    const mock = buildMockResponse(latestUserMessage.content);
    if (mock.responseType === "list" && hasConfiguredGeminiKey(env.GEMINI_API_KEY)) {
      mock.companies = await enrichCompanyWebsites({
        apiKey: env.GEMINI_API_KEY,
        model: requestedModel,
        companies: mock.companies,
      });
    }
    return json({
      ...mock,
      mode: "mock",
      retrievedCount: 0,
    });
  }

  if (!env.AI_SEARCH_NAME || !env.GEMINI_API_KEY) {
    return json(
      {
        error:
          "缺少后端配置。请设置 AI_SEARCH_NAME、GEMINI_API_KEY，或先把 USE_MOCK_BACKEND 设为 true。",
      },
      500
    );
  }

  if (env.ASSUME_RAG_READY === "true") {
    return handleRetrievedResults({
      env,
      requestedModel,
      normalizedMessages,
      searchResults: buildAssumedRagResults(latestUserMessage.content),
    });
  }

  if (!env.AI || typeof env.AI.autorag !== "function") {
    return json(
      {
        error:
          "当前运行环境没有启用 Cloudflare AI binding。请部署到 Cloudflare，或把 USE_MOCK_BACKEND 设为 true。",
      },
      500
    );
  }

  let retrieval;
  try {
    retrieval = await env.AI.autorag(env.AI_SEARCH_NAME).search({
      query: buildSearchQuery(normalizedMessages),
      rewrite_query: true,
      max_num_results: MAX_SEARCH_RESULTS,
      ranking_options: {
        score_threshold: 0.1,
      },
    });
  } catch (error) {
    return json(
      {
        error: "AI Search 检索失败。",
        detail: stringifyError(error),
      },
      502
    );
  }

  return handleRetrievedResults({
    env,
    requestedModel,
    normalizedMessages,
    searchResults: normalizeSearchResults(retrieval),
  });
}

async function handleRetrievedResults({ env, requestedModel, normalizedMessages, searchResults }) {
  const prompt = buildGenerationPrompt({
    messages: normalizedMessages,
    searchResults,
  });

  let modelOutput;
  try {
    modelOutput = await generateWithGemini({
      apiKey: env.GEMINI_API_KEY,
      model: requestedModel,
      prompt,
    });
  } catch (error) {
    return json(
      {
        error: "Gemini 生成失败。",
        detail: stringifyError(error),
      },
      502
    );
  }

  const normalizedResponse = coerceModelResponse(modelOutput, searchResults.length);
  if (normalizedResponse.responseType === "list" && normalizedResponse.companies.length > 0) {
    normalizedResponse.companies = await enrichCompanyWebsites({
      apiKey: env.GEMINI_API_KEY,
      model: requestedModel,
      companies: normalizedResponse.companies,
    });
  }

  return json({
    ...normalizedResponse,
    mode: env.ASSUME_RAG_READY === "true" ? "assumed-rag" : "live",
    retrievedCount: searchResults.length,
  });
}

async function generateWithGemini({ apiKey, model, prompt }) {
  return generateJsonWithGemini({
    apiKey,
    model,
    prompt,
    systemInstruction:
      "你是探针资本项目库问答助手。你必须严格依据给定检索结果回答，不能编造企业、官网或融资信息。输出必须是 JSON。",
  });
}

async function generateJsonWithGemini({ apiKey, model, prompt, systemInstruction, tools }) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        ...(systemInstruction
          ? {
              system_instruction: {
                parts: [{ text: systemInstruction }],
              },
            }
          : {}),
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        ...(tools ? { tools } : {}),
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini 没有返回可解析内容。");
  }

  return JSON.parse(extractJsonText(text));
}

async function enrichCompanyWebsites({ apiKey, model, companies }) {
  const targets = companies.filter((company) => !company.website).slice(0, 5);

  if (targets.length === 0) {
    return companies;
  }

  const prompt = [
    "请使用 Google Search 为以下企业查找官方网站主页。",
    "只返回明确的公司官网主页 URL。",
    "不要返回新闻、百科、公众号、企查查、招聘页、下载页、应用商店、社交媒体、投资机构页面或文章页。",
    "如果无法确认官网，website 必须返回 null。",
    "",
    ...targets.map(
      (company, index) =>
        `${index + 1}. 名称：${company.name}；城市：${company.city}；标签：${company.category}`
    ),
    "",
    "输出 JSON 格式：",
    '{"companies":[{"name":"企业名称","website":"https://example.com 或 null"}]}',
  ].join("\n");

  try {
    const result = await generateJsonWithGemini({
      apiKey,
      model,
      prompt,
      systemInstruction:
        "你是企业官网识别助手。你必须基于 Google Search 结果判断官网，只在高度确定时返回官网主页 URL，否则返回 null。输出必须是 JSON。",
      tools: [{ google_search: {} }],
    });

    const websiteByName = new Map(
      (Array.isArray(result?.companies) ? result.companies : [])
        .filter((item) => typeof item?.name === "string")
        .map((item) => [item.name.trim(), sanitizeWebsite(item.website)])
    );

    return companies.map((company) => ({
      ...company,
      website: websiteByName.get(company.name) || company.website || null,
    }));
  } catch {
    return companies;
  }
}

function buildGenerationPrompt({ messages, searchResults }) {
  const conversationText = messages
    .map((message) => `${message.role === "assistant" ? "助手" : "用户"}：${message.content}`)
    .join("\n");

  const retrievalText =
    searchResults.length > 0
      ? searchResults
          .map((item, index) => {
            const score = Number.isFinite(item.score) ? item.score.toFixed(4) : "n/a";
            return [
              `结果 ${index + 1} | score=${score}`,
              item.metadataText ? `元数据：${item.metadataText}` : null,
              item.content,
            ]
              .filter(Boolean)
              .join("\n");
          })
          .join("\n\n---\n\n")
      : "没有检索到任何结果。";

  return [
    "你是探针资本项目库的投资邀约助手。",
    "目标不是泛泛总结，而是帮助用户基于企业库快速形成可执行的邀约判断。",
    "",
    "你要先判断当前提问属于哪一类：",
    "1. 多家企业名单筛选",
    "2. 针对单一企业的继续追问",
    "",
    "决策原则：",
    "- 优先考虑与用户活动主题匹配度高的企业。",
    "- 优先保留更适合面向投资机构讲述的企业：赛道明确、故事线清晰、融资或产业位置有辨识度。",
    "- 如果是单企业追问，要直接给判断，不要再扩成名单。",
    "- 如果证据不足，要明确写出证据不足，而不是补想象。",
    "",
    "输出规则：",
    "- responseType 只能是 list 或 detail。",
    "- list 模式最多返回 5 家企业。",
    "- list 模式中 companies 按推荐优先级排序。",
    "- detail 模式只做单企业判断。",
    "- 只能使用检索结果里能支持的事实。",
    "- reason 必须解释为什么这家企业适合或不适合当前活动主题，而不是复述简介。",
    "- summary 应该先给总体判断，再点出筛选口径。",
    "- website 只有在检索结果明确给出官网时才可填写，否则必须为 null。",
    "- 如果证据不足，要在 summary 或 judgement 中明确说明证据不足。",
    "- historyText 要写成便于后续多轮对话压缩的简洁自然语言摘要。",
    "",
    "严格输出以下 JSON 之一：",
    '{"responseType":"list","title":"...","summary":"...","companies":[{"name":"...","city":"...","stage":"...","category":"...","reason":"...","website":null}],"followup":"...","historyText":"..."}',
    '{"responseType":"detail","title":"...","summary":"...","judgement":"...","followups":["..."],"historyText":"..."}',
    "",
    "<conversation>",
    conversationText,
    "</conversation>",
    "",
    "<retrieval>",
    retrievalText,
    "</retrieval>",
  ].join("\n");
}

function buildSearchQuery(messages) {
  const recentMessages = messages.slice(-MAX_HISTORY_MESSAGES);
  const query = recentMessages
    .map((message) => `${message.role === "assistant" ? "助手" : "用户"}：${message.content}`)
    .join("\n")
    .trim();

  return query || "请根据企业库筛选符合要求的医美及消费医疗企业。";
}

function normalizeSearchResults(response) {
  const rawItems = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response?.results)
      ? response.results
      : [];

  return rawItems
    .map((item) => {
      const content =
        extractContentText(
          item?.content ?? item?.text ?? item?.chunk ?? item?.value ?? item?.data?.content
        ) ||
        firstString([item?.attributes?.file?.context]) ||
        "";

      return {
        score: typeof item?.score === "number" ? item.score : null,
        content: content.trim(),
        metadataText:
          objectToText(item?.attributes || item?.metadata || item?.data?.attributes || {}) ||
          [item?.file_id, item?.filename].filter(Boolean).join("; "),
      };
    })
    .filter((item) => item.content);
}

function extractContentText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part.text === "string") {
          return part.text;
        }
        if (part && typeof part.content === "string") {
          return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }

  return "";
}

function firstString(values) {
  return values.find((value) => typeof value === "string" && value.trim());
}

function objectToText(value) {
  if (!value || typeof value !== "object") {
    return "";
  }

  const entries = [];
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue == null) {
      continue;
    }

    if (
      typeof entryValue === "string" ||
      typeof entryValue === "number" ||
      typeof entryValue === "boolean"
    ) {
      entries.push(`${key}: ${entryValue}`);
      continue;
    }

    if (typeof entryValue === "object") {
      const nested = objectToText(entryValue);
      if (nested) {
        entries.push(`${key}: { ${nested} }`);
      }
    }
  }

  return entries.join("; ");
}

function coerceModelResponse(data, retrievedCount) {
  const responseType = data?.responseType === "detail" ? "detail" : "list";

  if (responseType === "detail") {
    const followups = Array.isArray(data?.followups)
      ? data.followups.filter((item) => typeof item === "string" && item.trim()).slice(0, 5)
      : [];

    return {
      responseType,
      title: stringOrFallback(data?.title, "单企业判断"),
      summary: stringOrFallback(
        data?.summary,
        retrievedCount > 0 ? "当前回答已切换为单企业追问模式。" : "没有检索到足够证据，以下为保守判断。"
      ),
      judgement: stringOrFallback(
        data?.judgement,
        "当前证据不足，建议补充更具体的企业名称、赛道或融资线索。"
      ),
      followups,
      historyText: stringOrFallback(
        data?.historyText,
        `${stringOrFallback(data?.title, "单企业判断")}：${stringOrFallback(data?.judgement, "证据不足。")}`
      ),
    };
  }

  const companies = Array.isArray(data?.companies)
    ? data.companies
        .map((company) => ({
          name: stringOrFallback(company?.name, "未命名企业"),
          city: stringOrFallback(company?.city, "未知城市"),
          stage: stringOrFallback(company?.stage, "未知轮次"),
          category: stringOrFallback(company?.category, "待补充标签"),
          reason: stringOrFallback(company?.reason, "未提供推荐理由。"),
          website: typeof company?.website === "string" && /^https?:\/\//i.test(company.website)
            ? company.website
            : null,
        }))
        .slice(0, 5)
    : [];

  return {
    responseType,
    title: stringOrFallback(data?.title, "建议邀约企业"),
    summary: stringOrFallback(
      data?.summary,
      retrievedCount > 0 ? "以下名单基于当前检索结果生成。" : "没有检索到足够证据，暂未形成可靠名单。"
    ),
    companies,
    followup: stringOrFallback(
      data?.followup,
      "可继续追问具体企业、融资轮次、城市，或要求缩小筛选范围。"
    ),
    historyText: stringOrFallback(
      data?.historyText,
      companies.length > 0
        ? `名单结果：${companies.map((item) => item.name).join("、")}`
        : "名单结果：当前没有形成可靠候选。"
    ),
  };
}

function stringOrFallback(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function buildMockResponse(prompt) {
  const companies = [
    {
      name: "普雨科技",
      city: "苏州",
      stage: "天使轮",
      category: "泛半导体 / 设备",
      reason:
        "纳米压印半导体光刻设备属性明确，适合围绕国产替代、微纳制造成本优势和泛半导体应用场景展开机构沟通。",
      website: null,
    },
    {
      name: "思萃热控",
      city: "苏州",
      stage: "A轮",
      category: "半导体热管理材料",
      reason:
        "聚焦新一代半导体与微电子热管理材料，与半导体制造链条强相关，适合作为设备专场中的材料与配套环节补充。",
      website: null,
    },
    {
      name: "海普功能材料",
      city: "苏州",
      stage: "B+轮",
      category: "分离材料 / 工艺装备延展",
      reason:
        "如果活动主题扩大到工艺、材料或先进制造能力，它可作为补充候选；若严格限定半导体设备本体，优先级应降低。",
      website: null,
    },
  ];

  if (/普雨科技|主会场|单企业|这家公司/.test(prompt)) {
    return {
      responseType: "detail",
      title: "普雨科技单企业判断",
      summary: "当前回答已切换为单企业追问模式，因此不显示导出按钮。",
      judgement:
        "如果活动主轴是半导体设备本体，普雨科技仍应作为优先邀约对象。它的设备属性清晰，便于向机构讲述国产替代与制造成本优势。",
      followups: [
        "是否需要评估它更适合主会场还是专题分会场",
        "是否要补充与它同赛道但轮次更高的企业",
        "是否要按机构偏好重写推荐话术",
      ],
      historyText:
        "单企业判断：普雨科技适合半导体设备主题活动的优先邀约名单，可继续细化主会场定位和机构话术。",
    };
  }

  return {
    responseType: "list",
    title: "建议邀约企业",
    summary:
      "建议优先保留半导体设备属性更强、融资故事更清晰、且便于向机构讲述成长逻辑的企业。名单型结果默认显示导出按钮。",
    companies: companies.slice(0, /严格|设备本体/.test(prompt) ? 2 : 3),
    followup:
      "可继续追问某一家企业，或要求缩小范围，例如：只看苏州、近两年融资、偏设备本体。",
    historyText: `名单结果：${companies
      .slice(0, /严格|设备本体/.test(prompt) ? 2 : 3)
      .map((item) => item.name)
      .join("、")}`,
  };
}

function buildAssumedRagResults(prompt) {
  const catalog = [
    {
      name: "普雨科技",
      content:
        "企业名称：普雨科技（苏州）有限公司。定位：纳米压印半导体光刻设备研发商。核心信息：专注纳米压印半导体光刻设备及相关技术，为集成电路和泛半导体行业提供微纳制造解决方案。团队具备半导体设备背景，设备属性强，适合设备主题路演。",
      metadataText:
        "简称: 普雨科技; 所属城市: 苏州; 融资轮次: 天使轮; 融资金额: 数亿元累计; 行业标签: 泛半导体/设备",
      score: 0.96,
    },
    {
      name: "思萃热控",
      content:
        "企业名称：苏州思萃热控材料科技有限公司。定位：半导体与微电子热管理及封装材料研发生产。核心信息：覆盖铝碳化硅复合材料结构件、热沉、IGBT基板、散热片等，适合作为半导体设备链条中的材料与热管理配套企业。",
      metadataText:
        "简称: 思萃热控; 所属城市: 苏州; 融资轮次: A轮; 行业标签: 半导体热管理材料",
      score: 0.88,
    },
    {
      name: "海普功能材料",
      content:
        "企业名称：江苏海普功能材料有限公司。定位：高性能吸附分离材料研发与产业化。核心信息：主营吸附剂、层析填料及特种分离膜，属于先进制造与材料能力企业。与半导体设备本体相关性较弱，但若活动主题扩展到工艺和材料，可作为扩展候选。",
      metadataText:
        "简称: 海普功能材料; 所属城市: 苏州; 融资轮次: B+轮; 行业标签: 分离材料/先进制造",
      score: 0.67,
    },
  ];

  if (/主会场|普雨科技|这家公司|单企业/.test(prompt)) {
    return [catalog[0]];
  }

  if (/严格|设备本体|只保留/.test(prompt)) {
    return [catalog[0], catalog[1]];
  }

  return catalog;
}

function stringifyError(error) {
  return error instanceof Error ? error.message : String(error);
}

function extractJsonText(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return text;
}

function sanitizeWebsite(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    const blockedHosts = [
      "qcc.com",
      "www.qcc.com",
      "baike.baidu.com",
      "mp.weixin.qq.com",
      "weixin.qq.com",
      "www.linkedin.com",
      "linkedin.com",
      "x.com",
      "twitter.com",
      "www.crunchbase.com",
      "crunchbase.com",
    ];

    if (blockedHosts.includes(hostname)) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function hasConfiguredGeminiKey(value) {
  return Boolean(
    typeof value === "string" &&
      value.trim() &&
      value.trim() !== "your-google-ai-api-key"
  );
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}
