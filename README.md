# dsh-web-vercel-gateway

[简体中文](README.zh-CN.md) · English

Web search and fetch for the DeepSeek Harness `ctx.web` seam, executed by Vercel AI Gateway's DeepSeek Search and DeepSeek Fetch tools.

## Why one model request per operation

The gateway publishes DeepSeek Search and DeepSeek Fetch as *gateway tools*, not as REST endpoints: paths such as `/v1/tools/search` answer 404. The only way to run them is a language-model request that pins the tool through `toolChoice`, so each operation costs one gateway model call and the model's only job is to hand the arguments to the tool.

The request goes to `/v4/ai/language-model`, the route that speaks the AI SDK's own wire protocol rather than the OpenAI-compatible `/v1/chat/completions`. The OpenAI-compatible route accepts these tools but only folds their results into model text: the structured payload is not returned, and `tool_choice` cannot pin a gateway tool at all.

Reading stops at the first `tool-result` event. Everything after it is the model narrating a result this plugin already holds, so the stream is cancelled rather than drained, which also skips the output tokens for that narration. The prompt tells the model not to write around the call: without that instruction a model sometimes calls the tool twice, and the second call is not a better answer. A search measured 2.5–4.4 s end to end and a fetch 1.2–3.9 s against `google/gemini-2.5-flash-lite`.

## Which model runs the call

The `model` setting is empty by default, and empty means *discover*. An id written into this package cannot stay correct: the gateway lists 304 models that advertise tool use and adds and retires them continuously, so a pinned default fails every search the day it is retired, until a new release ships.

Discovery reads `GET /v1/models` — the endpoint AI SDK's own documentation uses — and keeps the entries that answer this plugin's needs:

| Kept | Why |
|---|---|
| `type: "language"` | A search needs a chat model; the catalogue also lists embeddings, images, speech, and rerankers. |
| `tags` contains `"tool-use"` | The request pins a provider-executed tool, so a model that cannot call tools never answers it. |
| `deprecated_at` absent | A retired id is not a candidate for the next request. |

The survivors are ordered price-ascending, except that zero-priced entries go last: on a commercial gateway a zero price marks the promotional models, several of which measured far slower on a forced tool call. A preference list — `google/gemini-2.5-flash-lite`, then `openai/gpt-4o-mini`, the two measured at 1.2–4.4 s — is moved to the front whenever the catalogue still lists it, so the starting point is stable without being hard-coded. At most six candidates are tried per operation.

The catalogue needs no credential and carries no plan information: a model the plan does not cover still appears there and answers 403 when asked. So a refusal is remembered rather than predicted.

Discovery costs one request the first time it is needed and is reused for six hours, together with every refusal. A model pinned in `model` skips discovery entirely, and the same setting also works as an override when discovery is unwelcome.

## When the gateway refuses

On the free plan the gateway limits each model separately, so a second model carries its own budget and can serve a request the first one refused. A request therefore walks the candidate list:

| Answer | Next model? | Why |
|---|---|---|
| 429 | Yes | The limit is per model; the next one has its own budget. |
| 403 | Yes | The gateway answers `no_providers_available` when the plan does not cover that model — the free plan reaches only a subset of the catalogue. |
| 404 | Yes | A discovered id can be retired between the catalogue read and the request. |
| 5xx | Yes | Transient or provider-side. |
| No tool result in the stream | Yes | The model declined the forced call. |
| 401 | No | The credential itself is rejected; no model changes that. |

403, 404, and a stream without the tool result are verdicts on that model id, so the id is remembered and this process stops choosing it — otherwise a retired id, or a model that never calls tools, would cost one request on every search. 429, 5xx, and timeouts say nothing about the model and are not remembered.

Nothing waits between attempts. When every candidate refuses, the error names each one and the delay the gateway asked for, because a web tool call that blocks for the length of a rate-limit window is worse than one that fails and says when to retry.

The route is versioned with the AI SDK protocol, and adjacent versions stay live at once: `/v3` and `/v4` accept the same request body. So a configured route that answers 404 with a web page instead of JSON — what the platform serves for a path no deployment matches — is retried one version back before it counts as a failure. Earlier versions are not tried; the gateway answers those with a retirement notice rather than serving them.

## Providers

| Provider id | Capability | Result |
|---|---|---|
| `vercel-deepseek-search` | `ctx.web.search` | Ranked sources; each carries `url`, and `title` / `snippet` / `summary` / `publishedAt` when the tool returns them. The tool's `authority`, `rerank_score`, `site_icon`, `site_name`, and per-result `content` are dropped: the seam cannot express them. |
| `vercel-deepseek-fetch` | `ctx.web.fetch` | The page as Markdown, reported as HTTP 200. A target the tool cannot read is reported as a result carrying the tool's own status, because the seam treats a non-2xx answer as an outcome the model reads rather than as a thrown failure. |

## Settings

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `https://ai-gateway.vercel.sh/v4/ai/language-model` | Gateway route that accepts provider-executed tools. |
| `model` | *(empty)* | Models that perform the forced tool call, in retry order, separated by commas. Empty discovers them from the gateway catalogue; a value pins them and skips discovery. |
| `apiKeyEnv` | `AI_GATEWAY_API_KEY` | Credential reference of the gateway key, resolved through the harness credential service. |
| `count` | `10` | Results requested per search, 1–50. A smaller `maxResults` on the request wins. |
| `maxOutputTokens` | `2000` | Output-token floor. The gateway spends output budget before running the tool, so a small floor ends the stream with no tool result; 16 tokens reproduces that failure. |
| `timeoutMs` | `60000` | Bound on one gateway request. |

Every field is `volatile`, so a settings edit applies to the next operation without remounting the plugin.

## Credential

Put the gateway key in the credential store, for example in `$DSH_HOME/.credentials.yaml`:

```yaml
refs:
  AI_GATEWAY_API_KEY: vck_...
```

Without a key both providers report themselves not ready, which hides `web_search` and `web_fetch` instead of failing every call. Resolution happens per operation and is never cached, so a key added or replaced while the harness runs reaches the next call.

## Selecting the providers

The bundle registers the providers; it does not select them. Set both ids in the profile's own patch layer, or pick them on the **Web search and fetch** settings page:

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: vercel-deepseek-search
    fetchProvider: vercel-deepseek-fetch
```

Reverting means setting those two values back to `deepseek-search-api` and `deepseek-fetch-api`; nothing else about the profile changes.

## Failure behaviour

| Condition | Result |
|---|---|
| 401 | `WEB_PROVIDER_ERROR` naming the credential reference. |
| 403 or 404, every candidate | `WEB_PROVIDER_ERROR` naming each model and the plan limit or the retired id. |
| 404 with a web page, every route | `WEB_PROVIDER_ERROR` naming `baseURL` and the routes tried, without quoting the page. |
| 429, every candidate | `WEB_PROVIDER_ERROR` naming each model and the `retry-after` delay, without waiting. |
| Stream ends without the tool result | `WEB_PROVIDER_ERROR` naming `maxOutputTokens` and its current value, with the stream's finish reason and trailing model text. |
| Catalogue unreadable, nothing pinned | `WEB_PROVIDER_ERROR` naming the catalogue URL and suggesting a pinned `model`. |
| Every discovered model already refused | `WEB_PROVIDER_ERROR` naming the catalogue and suggesting a pinned `model`. |
| Caller cancels | `WEB_ABORTED`. |
| The plugin's own `timeoutMs` elapses | `WEB_PROVIDER_ERROR` stating the elapsed bound, never a cancellation. |
| No credential | `WEB_PROVIDER_MISCONFIGURED` from an operation that runs anyway. |

Errors are `@deepseek-ai/dsh-web`'s `WebError`, a `HarnessError` subclass, so the harness reports these codes instead of `UNKNOWN`. Every harness package is a peer dependency for that reason: the loader routes a bare import of a package the importing tree declares as a peer to the installation's copy, which is the instance whose `instanceof` the harness checks.

## Development

```sh
pnpm install                 # dev dependencies: typescript, @types/node, the peer packages
pnpm typecheck               # tsc --noEmit over the JSDoc-typed sources and tests
pnpm test                    # offline: a local server speaks the event protocol
AI_GATEWAY_API_KEY=vck_... pnpm smoke   # one real search and one real fetch
AI_GATEWAY_API_KEY=vck_... AI_GATEWAY_MODEL=google/gemini-2.5-flash-lite pnpm smoke   # skip discovery
```

The sources are JavaScript with JSDoc types, so there is no build step: `index.js` is what the loader imports, and `tsconfig.json` only checks it. Its `preserveSymlinks` stays off on purpose — see the comment there.
