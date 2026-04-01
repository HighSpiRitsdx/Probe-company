const pageShell = document.getElementById("page-shell");
const modelSelect = document.getElementById("model-select");
const statusPill = document.getElementById("status-pill");
const messageStack = document.getElementById("message-stack");
const promptInput = document.getElementById("prompt-input");
const sendButton = document.getElementById("send-button");

const state = {
  model: modelSelect.value,
  messages: [],
  apiMessages: [],
  pending: false,
};

function render() {
  const hasConversation = state.messages.length > 0;
  pageShell.classList.toggle("is-empty", !hasConversation);
  statusPill.textContent = `当前会话 · ${state.model}`;
  messageStack.innerHTML = "";

  state.messages.forEach((message) => {
    if (message.role === "user") {
      renderUserMessage(message);
      return;
    }

    if (message.type === "list") {
      renderAssistantList(message);
      return;
    }

    renderAssistantDetail(message);
  });

  messageStack.scrollTop = messageStack.scrollHeight;
}

function renderUserMessage(message) {
  const template = document.getElementById("user-message-template");
  const fragment = template.content.cloneNode(true);
  fragment.querySelector(".user-bubble").textContent = message.content;
  messageStack.appendChild(fragment);
}

function renderAssistantList(message) {
  const template = document.getElementById("assistant-list-template");
  const fragment = template.content.cloneNode(true);
  const article = fragment.querySelector(".assistant-panel");

  fragment.querySelector(".assistant-title").textContent = message.title;
  fragment.querySelector(".assistant-summary").textContent = message.summary;
  fragment.querySelector(".assistant-followup").textContent = message.followup;

  const companyList = fragment.querySelector(".company-list");
  message.companies.forEach((company) => {
    companyList.appendChild(createCompanyCard(company));
  });

  const exportButton = fragment.querySelector(".export-button");
  exportButton.hidden = message.companies.length === 0;
  exportButton.addEventListener("click", () => exportCompanies(message.companies));

  messageStack.appendChild(article);
}

function renderAssistantDetail(message) {
  const template = document.getElementById("assistant-detail-template");
  const fragment = template.content.cloneNode(true);

  fragment.querySelector(".assistant-title").textContent = message.title;
  fragment.querySelector(".assistant-summary").textContent = message.summary;
  fragment.querySelector(".detail-judgement").textContent = message.judgement;

  const followupList = fragment.querySelector(".detail-followups");
  message.followups.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    followupList.appendChild(li);
  });

  messageStack.appendChild(fragment);
}

function createCompanyCard(company) {
  const card = document.createElement("section");
  card.className = "company-card";

  const head = document.createElement("div");
  head.className = "company-head";

  const name = document.createElement("h3");
  name.className = "company-name";
  name.textContent = company.name;
  head.appendChild(name);

  if (company.website) {
    const link = document.createElement("a");
    link.className = "company-link";
    link.href = company.website;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "官网";
    head.appendChild(link);
  } else {
    const muted = document.createElement("span");
    muted.className = "company-link-muted";
    muted.textContent = "官网待联网补充";
    head.appendChild(muted);
  }

  const reason = document.createElement("p");
  reason.className = "company-reason";
  reason.textContent = company.reason;

  const meta = document.createElement("p");
  meta.className = "company-meta";
  meta.textContent = `${company.city} · ${company.stage} · ${company.category}`;

  card.append(head, reason, meta);
  return card;
}

function exportCompanies(items) {
  const header = ["企业名称", "城市", "融资轮次", "标签", "推荐理由", "官网"];
  const rows = items.map((company) => [
    company.name,
    company.city,
    company.stage,
    company.category,
    company.reason,
    company.website || "",
  ]);

  const csv = [header, ...rows]
    .map((row) =>
      row
        .map((cell) => `"${String(cell).replaceAll("\"", "\"\"")}"`)
        .join(",")
    )
    .join("\n");

  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "探针资本项目库_邀约名单.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildAssistantMessage(payload) {
  if (payload.responseType === "detail") {
    return {
      role: "assistant",
      type: "detail",
      title: payload.title,
      summary: payload.summary,
      judgement: payload.judgement,
      followups: payload.followups || [],
    };
  }

  return {
    role: "assistant",
    type: "list",
    title: payload.title,
    summary: payload.summary,
    companies: payload.companies || [],
    followup: payload.followup || "",
  };
}

function createLoadingMessage() {
  return {
    role: "assistant",
    type: "detail",
    title: "正在检索项目库",
    summary: "系统正在检索 AI Search，并准备生成回答。",
    judgement: "请稍候，结果返回后会自动替换这里的内容。",
    followups: [],
  };
}

function createErrorMessage(errorText) {
  return {
    role: "assistant",
    type: "detail",
    title: "请求失败",
    summary: "后端没有返回可用结果。",
    judgement: errorText,
    followups: [
      "检查 .dev.vars 或 Cloudflare Secret 配置",
      "确认 wrangler dev 是否已启动",
      "如果只是联调 UI，可先把 USE_MOCK_BACKEND 设为 true",
    ],
  };
}

async function sendPrompt() {
  const content = promptInput.value.trim();
  if (!content || state.pending) {
    return;
  }

  const userMessage = { role: "user", content };
  state.messages.push(userMessage);
  state.apiMessages.push(userMessage);
  promptInput.value = "";
  resizeTextarea();

  const loadingMessage = createLoadingMessage();
  state.messages.push(loadingMessage);
  state.pending = true;
  sendButton.disabled = true;
  render();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: state.model,
        messages: state.apiMessages,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "请求失败。");
    }

    state.messages[state.messages.length - 1] = buildAssistantMessage(payload);
    state.apiMessages.push({
      role: "assistant",
      content: payload.historyText || payload.summary || payload.title,
    });
  } catch (error) {
    state.messages[state.messages.length - 1] = createErrorMessage(
      error instanceof Error ? error.message : "未知错误。"
    );
  } finally {
    state.pending = false;
    sendButton.disabled = false;
    render();
  }
}

function resizeTextarea() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 220)}px`;
}

modelSelect.addEventListener("change", (event) => {
  state.model = event.target.value;
  render();
});

sendButton.addEventListener("click", sendPrompt);
promptInput.addEventListener("input", resizeTextarea);
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
  }
});

render();
resizeTextarea();
