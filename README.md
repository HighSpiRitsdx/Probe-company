# 探针资本项目库

## 本地开发

1. 安装依赖  
   `npm install`
2. 复制环境变量模板  
   `Copy-Item .dev.vars.example .dev.vars`
3. 启动本地开发  
   `npm run dev`

## 当前配置策略

仓库里只保留非敏感配置：

- `AI_SEARCH_NAME=dry-leaf-1402`
- `GEMINI_MODEL=gemini-3-flash-preview`
- `USE_MOCK_BACKEND=false`
- `ASSUME_RAG_READY=true`

敏感配置不要进仓库，只在 Cloudflare 上配置：

- `GEMINI_API_KEY`

## GitHub 自动部署到 Cloudflare

你把代码 push 到 GitHub 后，在 Cloudflare Workers 项目里完成两步：

1. 连接这个 GitHub 仓库
2. 在 `Settings -> Variables and Secrets` 中添加：
   - `GEMINI_API_KEY`

其余非敏感变量已经写在 [wrangler.jsonc](./wrangler.jsonc) 里，不需要再手动重复配置。

## 当前后端模式

现在默认：

- `USE_MOCK_BACKEND=false`
- `ASSUME_RAG_READY=true`

这表示：

- 前端会走真实 `/api/chat`
- 后端会按“RAG 已经准备好”处理流程继续生成回答
- 但会跳过真实 AI Search 检索，先用内置的假设检索结果顶住联调

如果你后续要切到真实 AI Search，只需要把 `ASSUME_RAG_READY` 改成 `false`。
