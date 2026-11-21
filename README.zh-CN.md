# dsh-web-vercel-gateway

[English](README.md) · 简体中文

为 DeepSeek Harness 的 `ctx.web` 接口提供网页搜索与抓取，由 Vercel AI Gateway 的 DeepSeek Search 与 DeepSeek Fetch 工具执行。

## 为什么每次操作是一次模型请求

网关把 DeepSeek Search 与 DeepSeek Fetch 发布为 *gateway tool*，不是 REST 端点：`/v1/tools/search` 这类路径返回 404。要跑通它们，只能发一次语言模型请求，用 `toolChoice` 把工具钉死；因此每次操作都是一次网关模型调用，模型的唯一职责是把参数交给工具。

请求发往 `/v4/ai/language-model`，即说 AI SDK 自有线上协议的那条路由，而非 OpenAI 兼容的 `/v1/chat/completions`。后者虽然接受这些工具，却只把结果揉进模型输出的文字里：拿不到结构化载荷，`tool_choice` 也钉不住 gateway tool。

读取在第一条 `tool-result` 事件处停止。其后全是模型对结果的复述，而结果本插件已经拿到，所以流是被取消而不是读完——复述的 output token 也就一并省掉。实测在 `google/gemini-2.5-flash-lite` 上，一次搜索端到端 2.5–4.4 秒，一次抓取 1.2–3.9 秒。

## 两个 provider

| Provider id | 能力 | 结果 |
|---|---|---|
| `vercel-deepseek-search` | `ctx.web.search` | 排好序的来源；每项都有 `url`，工具返回时还有 `title` / `snippet` / `summary` / `publishedAt`。工具给的 `authority`、`rerank_score`、`site_icon`、`site_name` 以及每条结果的 `content` 被丢弃：接口表达不了它们。 |
| `vercel-deepseek-fetch` | `ctx.web.fetch` | 页面 Markdown，报为 HTTP 200。工具读不到的地址则报为带工具自身状态码的结果，因为接口把非 2xx 视作模型可读的结论，而不是抛出的失败。 |

## 设置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `https://ai-gateway.vercel.sh/v4/ai/language-model` | 接受 provider-executed 工具的网关路由。 |
| `model` | `google/gemini-2.5-flash-lite` | 执行被强制工具调用的模型。它必须支持工具调用，且对你的凭证可用。 |
| `apiKeyEnv` | `AI_GATEWAY_API_KEY` | 网关密钥的凭证引用，经 harness 凭证服务解析。 |
| `count` | `10` | 每次搜索请求的结果数，1–50。请求上更小的 `maxResults` 优先。 |
| `maxOutputTokens` | `2000` | output token 下限。网关先花 output 预算才去跑工具，所以下限太小会让流在拿到工具结果前就结束；16 个 token 即可复现该失败。 |
| `timeoutMs` | `60000` | 单次网关请求的时限。 |

所有字段都是 `volatile`，改设置对下一次操作生效，不必重新挂载插件。

## 凭证

把网关密钥放进凭证存储，例如 `$DSH_HOME/.credentials.yaml`：

```yaml
refs:
  AI_GATEWAY_API_KEY: vck_...
```

没有密钥时两个 provider 都报告自己未就绪，于是 `web_search` 与 `web_fetch` 被隐藏，而不是每次调用都失败。解析按操作进行且从不缓存，所以 harness 运行期间新增或替换的密钥，下一次调用就生效。

## 选中这两个 provider

bundle 只注册 provider，不替你选中。在 profile 自己的 patch 层写这两个 id，或在 **Web search and fetch** 设置页选择：

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: vercel-deepseek-search
    fetchProvider: vercel-deepseek-fetch
```

回滚就是把这两个值改回 `deepseek-search-api` 与 `deepseek-fetch-api`，profile 其他部分不动。

## 失败行为

| 情况 | 结果 |
|---|---|
| 401 / 403 | `WEB_PROVIDER_ERROR`，点名凭证引用与模型。 |
| 404 | `WEB_PROVIDER_ERROR`，点名模型，并给出网关确实提供的模型 id。 |
| 429 | `WEB_PROVIDER_ERROR`，点名限流。 |
| 流结束但没有工具结果 | `WEB_PROVIDER_ERROR`，点名 `maxOutputTokens` 及其当前值，并附上流的 finish reason 与模型尾部文字。 |
| 调用方取消 | `WEB_ABORTED`。 |
| 插件自身的 `timeoutMs` 到时 | `WEB_PROVIDER_ERROR`，说明超出的时限，绝不会当成取消。 |
| 没有凭证 | 操作照常进行时抛 `WEB_PROVIDER_MISCONFIGURED`。 |

错误是 `@deepseek-ai/dsh-web` 的 `WebError`，即 `HarnessError` 的子类，因此 harness 报出这些错误码而不是 `UNKNOWN`。所有 harness 包都是 peer dependency，正是为此：加载器会把「导入树在 peerDependencies 里声明过的包」的裸导入路由到安装树里那一份，而那才是 harness 用 `instanceof` 检查的实例。

## 开发

```sh
pnpm install                 # 开发依赖：typescript、@types/node、各 peer 包
pnpm typecheck               # 用 tsc --noEmit 检查带 JSDoc 类型的源码与测试
pnpm test                    # 全离线：本地服务扮成网关说同一套事件协议
AI_GATEWAY_API_KEY=vck_... pnpm smoke   # 真实跑一次搜索与一次抓取
```

源码是带 JSDoc 类型的 JavaScript，因此没有构建步骤：加载器导入的就是 `index.js`，`tsconfig.json` 只做检查。它的 `preserveSymlinks` 特意保持关闭——原因见该文件的注释。
