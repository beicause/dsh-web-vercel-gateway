/**
 * The Vercel AI Gateway search provider: one gateway request per search, whose
 * forced DeepSeek Search call returns ranked results.
 *
 * A search here costs one model request, which is the whole reason this
 * provider exists: the gateway publishes DeepSeek Search as a gateway tool, not
 * as a REST endpoint.
 * @module dsh-web-vercel-gateway/search
 */

import { SEARCH_TOOL, callGateway, isRecord, nonEmpty } from './gateway.js'

/**
 * @typedef {import('./contracts.js').ProviderOptions} ProviderOptions
 * @typedef {import('./contracts.js').WebErrorConstructor} WebErrorConstructor
 * @typedef {import('./contracts.js').WebSearchRequest} WebSearchRequest
 * @typedef {import('./contracts.js').WebSearchResult} WebSearchResult
 * @typedef {import('./contracts.js').WebSearchSource} WebSearchSource
 * @typedef {import('./contracts.js').MutableSource} MutableSource
 */

/** Stable id the provider registers under in the search registry. */
export const VERCEL_SEARCH_PROVIDER_ID = 'vercel-deepseek-search'

/** DeepSeek Search result-count bounds; a request outside them is refused by the tool. */
const COUNT_MIN = 1
const COUNT_MAX = 50

/** Picker description: what this provider suits and what it costs. */
const DESCRIPTION = {
  en: "Searches through Vercel AI Gateway's DeepSeek Search tool. Each search is one gateway model request, so it bills through the gateway and needs an AI_GATEWAY_API_KEY credential.",
  zh: '经 Vercel AI Gateway 的 DeepSeek Search 工具搜索。每次搜索都是一次网关模型请求，因此按网关计费，并需要 AI_GATEWAY_API_KEY 凭证。',
}

/**
 * Map one DeepSeek Search payload to the seam's result shape.
 *
 * Fields this module does not map are dropped deliberately: authority,
 * rerank_score, site_icon, site_name, and content carry the tool's own ranking
 * and page copy, none of which the seam can express. An empty string is an
 * absent field, because the seam renders an empty excerpt as no excerpt.
 * @param {unknown} payload the tool result's payload.
 * @param {WebErrorConstructor} WebError the seam's error class.
 * @returns {WebSearchResult} the search result, without the per-request source cap applied.
 * @throws the seam's WebError: WEB_PROVIDER_ERROR when the payload is not the tool's answer.
 */
export function mapSearchPayload(payload, WebError) {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new WebError('Vercel AI Gateway returned no search results array', 'WEB_PROVIDER_ERROR')
  }
  /** @type {WebSearchSource[]} */
  const sources = payload.results.map((/** @type {unknown} */ item, /** @type {number} */ index) => {
    if (!isRecord(item)) {
      throw new WebError('Vercel AI Gateway returned search result ' + String(index) + ' that is not an object', 'WEB_PROVIDER_ERROR')
    }
    const url = nonEmpty(item.url)
    if (url === undefined) {
      throw new WebError('Vercel AI Gateway returned search result ' + String(index) + ' without a url', 'WEB_PROVIDER_ERROR')
    }
    /** @type {MutableSource} */
    const source = { url }
    const title = nonEmpty(item.title)
    const snippet = nonEmpty(item.snippet)
    const summary = nonEmpty(item.summary)
    const publishedAt = nonEmpty(item.date)
    if (title !== undefined) source.title = title
    if (snippet !== undefined) source.snippet = snippet
    if (summary !== undefined) source.summary = summary
    if (publishedAt !== undefined) source.publishedAt = publishedAt
    return source
  })
  return { sources, truncated: false }
}

/**
 * The result count to ask for: the configured count, lowered to a smaller
 * request bound, and clamped to what DeepSeek Search accepts.
 * @param {number} configured the count setting.
 * @param {number | undefined} maxResults the caller's bound, when it set one.
 * @returns {number} the count to send.
 */
export function searchCount(configured, maxResults) {
  const wanted = maxResults === undefined ? configured : Math.min(configured, maxResults)
  return Math.min(COUNT_MAX, Math.max(COUNT_MIN, wanted))
}

/**
 * The tool's own failure text, for a result the gateway flagged as an error.
 * @param {unknown} result the flagged payload.
 * @returns {string} its message, or a stable fallback.
 */
function searchFailureMessage(result) {
  if (isRecord(result)) {
    const message = nonEmpty(result.message) ?? nonEmpty(result.error)
    if (message !== undefined) return message
  }
  return 'the tool reported an error without a message'
}

/** A search provider over one live settings section. */
export class VercelSearchProvider {
  /**
   * @param {() => ProviderOptions} resolveOptions reads the options for the
   *   NEXT search, once at its entry, so one search never mixes two settings
   *   sections.
   */
  constructor(resolveOptions) {
    /** Stable id this provider registers under. */
    this.id = VERCEL_SEARCH_PROVIDER_ID
    /** Picker description. */
    this.description = DESCRIPTION
    /** @type {() => ProviderOptions} */
    this.resolveOptions = resolveOptions
  }

  /**
   * Whether the settings could address a gateway at all. An empty model list is
   * addressable: it asks the catalogue instead of naming an id, and this check
   * must not reach the network to learn the same thing.
   * @returns {boolean} whether a request has somewhere to go.
   */
  available() {
    const options = this.resolveOptions()
    return options.credentialRef.length > 0 && URL.canParse(options.baseURL)
  }

  /** @returns {Promise<boolean>} whether the credential reference has a value. */
  ready() {
    const options = this.resolveOptions()
    return options.keyConfigured(options.credentialRef)
  }

  /**
   * @param {WebSearchRequest} request the query and the caller's result bound.
   * @param {AbortSignal} [signal] caller cancellation; omitted means no cancellation.
   * @returns {Promise<WebSearchResult>} the ranked sources.
   */
  async search(request, signal) {
    const options = this.resolveOptions()
    const apiKey = await options.resolveKey(options.credentialRef)
    if (apiKey === undefined) {
      throw new options.WebError(
        'No ' + options.credentialRef + ' credential is configured for the Vercel AI Gateway search provider',
        'WEB_PROVIDER_MISCONFIGURED',
      )
    }
    const event = await callGateway({ ...options, apiKey }, {
      tool: SEARCH_TOOL,
      args: { query: request.query, count: searchCount(options.count, request.maxResults), need_content: false },
    }, signal)
    if (event.isError === true) {
      throw new options.WebError(
        'DeepSeek Search failed: ' + searchFailureMessage(event.result),
        'WEB_PROVIDER_ERROR',
      )
    }
    return mapSearchPayload(event.result, options.WebError)
  }
}