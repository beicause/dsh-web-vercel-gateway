# dsh-web-vercel-gateway

[English](README.md) · 简体中文

为 DeepSeek Harness 的 `ctx.web` 接口提供网页搜索与抓取，由 Vercel AI Gateway 的 DeepSeek Search 与 DeepSeek Fetch 工具执行。

## 为什么每次操作是一次模型请求

网关把 DeepSeek Search 与 DeepSeek Fetch 发布为 *gateway tool*，不是 REST 端点：`/v1/tools/search` 这类路径返回 404。要跑通它们，只能发一次语言模型请求，用 `toolChoice` 把工具钉死；因此每次操作都是一次网关模型调用，模型的唯一职责是把参数交给工具。

请求发往 `/v4/ai/language-model`，即说 AI SDK 自有线上协议的那条路由，而非 OpenAI 兼容的 `/v1/chat/completions`。后者虽然接受这些工具，却只把结果揉进模型输出的文字里：拿不到结构化载荷，`tool_choice` 也钉不住 gateway tool。

读取在第一条 `tool-result` 事件处停止。其后全是模型对结果的复述，而结果本插件已经拿到，所以流是被取消而不是读完——复述的 output token 也就一并省掉。提示词明确要求模型不要在调用前后写字：缺了这句，模型有时会把工具调用两次，而第二次并不是更好的答案。实测在 `google/gemini-2.5-flash-lite` 上，一次搜索端到端 2.5–4.4 秒，一次抓取 1.2–3.9 秒。

## 由哪个模型执行

`model` 默认为空，空表示**自动发现**。写进包里的模型 id 无法长期正确：网关目录有 304 个声明支持工具调用的模型，还在不断增删，钉死的默认值在模型下架那天就会让每次搜索都失败，直到发布新版本。

自动发现读 `GET /v1/models`——AI SDK 官方文档自己用的那个端点——只保留满足本插件需要的条目：

| 保留条件 | 原因 |
|---|---|
| `type` 为 `"language"` | 搜索需要对话模型；目录里还有 embedding、图像、语音和重排模型。 |
| `tags` 含 `"tool-use"` | 请求钉的是一个 provider-executed 工具，不会调工具的模型永远不会回应它。 |
| 没有 `deprecated_at` | 已下架的 id 不该成为下一次请求的候选。 |

余下的条目按输入单价升序排列，但零价条目排在最后：在商业网关上零价标记的是推广期模型，实测其中好几个在强制工具调用上慢得多。一张偏好表——先 `google/gemini-2.5-flash-lite`，再 `openai/gpt-4o-mini`，即实测 1.2–4.4 秒的那两个——只要目录里还在，就被提到最前，所以起点既稳定又不是写死的。每次操作最多试 6 个候选。

目录不需要凭证，也不含套餐信息：套餐不覆盖的模型照样出现在里面，问到时才回 403。所以拒绝是记住的，不是预测的。

首次需要时花一次请求，之后连同所有拒绝记录一起复用六小时。在 `model` 里钉住模型则完全跳过发现，这一设置同时也是不想要发现时的覆盖手段。

## 网关拒绝时

免费套餐下网关按模型分别限流，所以换一个模型就有独立配额，可以接住前一个模型拒掉的请求。因此请求会按序走候选列表：

| 答案 | 换模型 | 原因 |
|---|---|---|
| 429 | 是 | 限流按模型算，下一个模型有独立配额。 |
| 403 | 是 | 套餐不覆盖该模型时，网关答 `no_providers_available`——免费套餐只覆盖一部分模型。 |
| 404 | 是 | 发现到的 id 可能在读目录之后、发请求之前被下架。 |
| 5xx | 是 | 瞬时故障或上游问题。 |
| 流里没有工具结果 | 是 | 模型拒绝了这次强制调用。 |
| 401 | 否 | 凭证本身被拒，换哪个模型都一样。 |

403、404 与「流里没有工具结果」都是网关对那个模型 id 的判定，所以会记住并让本进程不再选它——否则一个已下架的 id、或一个从不调工具的模型，会让每次搜索都白花一次请求。429、5xx 与超时说明不了模型本身的问题，不记。

两次尝试之间不等待。所有候选都被拒时，错误会点名每一个，并带上网关给出的等待秒数——网页工具卡住一个限流窗口那么久，比直接失败并告知何时重试更糟。

路由的版本号跟着 AI SDK 协议走，相邻两个版本同时在线：`/v3` 与 `/v4` 接受同一份请求体。所以配置的路由若返回 404 且响应体是网页而非 JSON——即平台对「没有任何部署匹配该路径」的回答——就先退回上一个版本再试一次，之后才算失败。更早的版本不试：网关对那些版本只回一份停止服务通知，而不是照常服务。

## 两个 provider

| Provider id | 能力 | 结果 |
|---|---|---|
| `vercel-deepseek-search` | `ctx.web.search` | 排好序的来源；每项都有 `url`，工具返回时还有 `title` / `snippet` / `summary` / `publishedAt`。工具给的 `authority`、`rerank_score`、`site_icon`、`site_name` 以及每条结果的 `content` 被丢弃：接口表达不了它们。 |
| `vercel-deepseek-fetch` | `ctx.web.fetch` | 页面 Markdown，报为 HTTP 200。工具读不到的地址则报为带工具自身状态码的结果，因为接口把非 2xx 视作模型可读的结论，而不是抛出的失败。 |

## 设置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `https://ai-gateway.vercel.sh/v4/ai/language-model` | 接受 provider-executed 工具的网关路由。 |
| `model` | *（空）* | 执行被强制工具调用的模型，按重试顺序排列，用逗号分隔。留空则从网关目录自动发现；填值即钉住并跳过发现。 |
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
| 401 | `WEB_PROVIDER_ERROR`，点名凭证引用。 |
| 403 或 404 且所有候选都被拒 | `WEB_PROVIDER_ERROR`，逐个点名模型，并说明是套餐限制还是已下架的 id。 |
| 404 且响应是网页、所有路由都试过 | `WEB_PROVIDER_ERROR`，点名 `baseURL` 与试过的路由，且不引用网页内容。 |
| 429 且所有候选都被拒 | `WEB_PROVIDER_ERROR`，逐个点名模型并附上网关给的 `retry-after` 秒数，不等待。 |
| 流结束但没有工具结果 | `WEB_PROVIDER_ERROR`，点名 `maxOutputTokens` 及其当前值，并附上流的 finish reason 与模型尾部文字。 |
| 目录读不到且没有钉住模型 | `WEB_PROVIDER_ERROR`，点名目录地址，并提示可在 `model` 里钉一个 id。 |
| 发现到的模型全都被拒 | `WEB_PROVIDER_ERROR`，点名目录，并提示可在 `model` 里钉一个 id。 |
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
AI_GATEWAY_API_KEY=vck_... AI_GATEWAY_MODEL=google/gemini-2.5-flash-lite pnpm smoke   # 跳过发现
```

源码是带 JSDoc 类型的 JavaScript，因此没有构建步骤：加载器导入的就是 `index.js`，`tsconfig.json` 只做检查。它的 `preserveSymlinks` 特意保持关闭——原因见该文件的注释。
