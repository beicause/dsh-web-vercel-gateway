# dsh-web-vercel-gateway

Web search and fetch for the DeepSeek Harness `ctx.web` seam, executed by Vercel AI Gateway's DeepSeek Search and DeepSeek Fetch tools.

## Why one model request per operation

The gateway publishes DeepSeek Search and DeepSeek Fetch as *gateway tools*, not as REST endpoints; `/v1/tools/search` and `/v1/tools/fetch` answer 404. The only way to run them is a language-model request on the gateway's AI SDK protocol route that pins the tool through `toolChoice`. Each request therefore costs one gateway model call, and the model's only job is to hand the arguments to the tool.

The request stops at the first `tool-result` event: the rest of the answer is the model narrating a result the provider already holds, so the stream is cancelled instead of drained. A search measured 2.5–4.4 s end to end and a fetch 1.2–3.9 s against `google/gemini-2.5-flash-lite`.

## Providers

| Provider id | Capability | Result |
|---|---|---|
| `vercel-deepseek-search` | `ctx.web.search` | Ranked sources; each carries `url`, and `title` / `snippet` / `summary` / `publishedAt` when the tool returns them. The tool's `authority`, `rerank_score`, `site_icon`, `site_name`, and per-result `content` are dropped: the seam cannot express them. |
| `vercel-deepseek-fetch` | `ctx.web.fetch` | The page as Markdown, reported as HTTP 200. A target the tool cannot read is reported as a result carrying the tool's own status, because the seam treats a non-2xx answer as an outcome the model reads rather than as a thrown failure. |

## Settings

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `https://ai-gateway.vercel.sh/v4/ai/language-model` | Gateway route that accepts provider-executed tools. |
| `model` | `google/gemini-2.5-flash-lite` | Model that performs the forced tool call. It must support tool calls and be available to your credential. |
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
| 401 / 403 | `WEB_PROVIDER_ERROR` naming the credential reference and the model. |
| 404 | `WEB_PROVIDER_ERROR` naming the model and a model id the gateway serves. |
| 429 | `WEB_PROVIDER_ERROR` naming rate limiting. |
| Stream ends without the tool result | `WEB_PROVIDER_ERROR` naming `maxOutputTokens` and its current value, with the stream's finish reason and trailing model text. |
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
```

The sources are JavaScript with JSDoc types, so there is no build step: `index.js` is what the
loader imports. `tsconfig.json` only checks them. Its `preserveSymlinks` stays off on purpose —
see the comment there.
