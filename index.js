/**
 * Registers the Vercel AI Gateway web providers in `ctx.web` as
 * `vercel-deepseek-search` and `vercel-deepseek-fetch`.
 *
 * The gateway publishes DeepSeek Search and Fetch as gateway tools rather than
 * as REST endpoints, so each operation is one gateway language-model request
 * that forces exactly that tool call. `web.searchProvider` and
 * `web.fetchProvider` select the providers; both report themselves not ready
 * while their credential reference has no value, which hides the web tools
 * instead of failing every call.
 *
 * Errors thrown here are `@deepseek-ai/dsh-web`'s `WebError`, a `HarnessError`
 * subclass, so the harness reports their codes rather than `UNKNOWN`. That
 * requires the same module instance the harness loaded, which is why every
 * harness package is a peer dependency: the loader routes a bare import to the
 * installation's copy for a package the importing tree declares as a peer.
 * @module dsh-web-vercel-gateway
 */

import { WebError } from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import { gatewayKeyConfigured, resolveGatewayKey } from './src/credential.js'
import { VercelFetchProvider } from './src/fetch.js'
import { parseModels } from './src/gateway.js'
import { VercelSearchProvider } from './src/search.js'

/**
 * @typedef {import('@deepseek-ai/cordis').Context} Context
 * @typedef {import('./src/contracts.js').GatewaySettings} GatewaySettings
 * @typedef {import('./src/contracts.js').ProviderOptions} ProviderOptions
 */

/** Plugin name the loader reports. */
export const name = 'web-vercel-gateway'

/** The web seam this plugin registers providers in. */
export const inject = ['web']

/** Default gateway endpoint: the AI SDK protocol route that accepts provider-executed tools. */
const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai/language-model'

/**
 * Default models, in retry order. The gateway limits each model separately, so a
 * second model doubles the request budget; both entries answer a forced tool call
 * in a few seconds and both were measured against the live gateway. Cheap first,
 * because the fallback only runs when the gateway turns the first away.
 */
const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite, openai/gpt-4o-mini'

/** Default credential reference of the gateway key. */
const DEFAULT_API_KEY_ENV = 'AI_GATEWAY_API_KEY'

/** Default results per search, the DeepSeek Search default. */
const DEFAULT_COUNT = 10

/**
 * Default output-token floor. The gateway spends the model's output budget
 * before it runs the tool, so a small floor ends the stream with no tool result;
 * this value leaves room for the call plus the model's framing of it.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 2000

/** Default request bound; a search or fetch measured a few seconds against the gateway. */
const DEFAULT_TIMEOUT_MS = 60000

/** Settings of both providers; every field is live so a settings page edit applies without a remount. */
export const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL).description('Gateway endpoint that accepts provider-executed tools.').volatile(),
  model: z.string().default(DEFAULT_MODEL).description('Gateway models that perform the forced tool call, in retry order, separated by commas.').volatile(),
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV).role('credential-ref').description('Credential reference of the gateway key.').volatile(),
  count: z.number().step(1).min(1).max(50).default(DEFAULT_COUNT).description('Results requested per search.').volatile(),
  maxOutputTokens: z.number().step(1).min(256).default(DEFAULT_MAX_OUTPUT_TOKENS).description('Output-token floor of each gateway request.').volatile(),
  timeoutMs: z.number().step(1).min(1000).default(DEFAULT_TIMEOUT_MS).description('Time one gateway request may take.').volatile(),
})

/**
 * Register both providers over one live settings section.
 * @param {Context} ctx plugin context owning both registrations.
 * @param {GatewaySettings} config live settings, read once per operation.
 * @returns {void}
 */
export function apply(ctx, config) {
  /** @returns {ProviderOptions} the settings for the NEXT operation. */
  const options = () => ({
    baseURL: config.baseURL.get(),
    models: parseModels(config.model.get()),
    credentialRef: config.apiKeyEnv.get(),
    count: config.count.get(),
    maxOutputTokens: config.maxOutputTokens.get(),
    timeoutMs: config.timeoutMs.get(),
    WebError,
    resolveKey: (/** @type {string} */ ref) => resolveGatewayKey(ctx, ref),
    keyConfigured: (/** @type {string} */ ref) => gatewayKeyConfigured(ctx, ref),
  })
  const search = new VercelSearchProvider(options)
  const fetch = new VercelFetchProvider(options)
  ctx.web.registerSearchProvider({
    id: search.id,
    description: search.description,
    available: () => search.available(),
    ready: () => search.ready(),
    search: (request, signal) => search.search(request, signal),
  })
  ctx.web.registerFetchProvider({
    id: fetch.id,
    description: fetch.description,
    available: () => fetch.available(),
    ready: () => fetch.ready(),
    fetch: (request, signal) => fetch.fetch(request, signal),
  })
}
