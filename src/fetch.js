/**
 * The Vercel AI Gateway fetch provider: one gateway request per page, whose
 * forced DeepSeek Fetch call returns the page as Markdown.
 *
 * A fetch here costs one model request, the same trade as the search provider:
 * the gateway publishes DeepSeek Fetch as a gateway tool only.
 * @module dsh-web-vercel-gateway/fetch
 */

import { FETCH_TOOL, callGateway, isRecord, nonEmpty } from './gateway.js'

/**
 * @typedef {import('./contracts.js').ProviderOptions} ProviderOptions
 * @typedef {import('./contracts.js').WebErrorConstructor} WebErrorConstructor
 * @typedef {import('./contracts.js').WebFetchRequest} WebFetchRequest
 * @typedef {import('./contracts.js').WebFetchResult} WebFetchResult
 */

/** Stable id the provider registers under in the fetch registry. */
export const VERCEL_FETCH_PROVIDER_ID = 'vercel-deepseek-fetch'

/** Picker description: what this provider suits and what it cannot do. */
const DESCRIPTION = {
  en: "Fetches pages through Vercel AI Gateway's DeepSeek Fetch tool. Each fetch is one gateway model request, so it bills through the gateway and needs an AI_GATEWAY_API_KEY credential; unreachable and private addresses fail.",
  zh: '经 Vercel AI Gateway 的 DeepSeek Fetch 工具获取页面。每次获取都是一次网关模型请求，因此按网关计费，并需要 AI_GATEWAY_API_KEY 凭证；无法访问的地址和内网地址会失败。',
}

/**
 * Map one DeepSeek Fetch payload to the seam's result shape.
 *
 * The tool reports neither the target's status nor a final URL, so a successful
 * call is the requested page retrieved: the seam sees HTTP 200. A flagged
 * failure that still names a status becomes a descriptive result instead of a
 * throw, because the seam treats a non-2xx answer as an outcome the model reads.
 * @param {unknown} payload the tool result's payload.
 * @param {WebFetchRequest} request the fetch request, whose URL the result reports.
 * @param {WebErrorConstructor} WebError the seam's error class.
 * @param {boolean} isError whether the gateway flagged the call as failed.
 * @returns {WebFetchResult} the fetch result.
 * @throws the seam's WebError: WEB_PROVIDER_ERROR when a success carries no page text.
 */
export function mapFetchPayload(payload, request, WebError, isError) {
  if (isError === true) {
    const status = isRecord(payload) && typeof payload.statusCode === 'number' ? payload.statusCode : undefined
    const message = isRecord(payload)
      ? nonEmpty(payload.message) ?? nonEmpty(payload.error)
      : undefined
    if (status !== undefined) {
      return {
        url: request.url,
        statusCode: status,
        body: { kind: 'text', content: message ?? '' },
        truncated: false,
      }
    }
    throw new WebError(
      'DeepSeek Fetch failed: ' + (message ?? 'the tool reported an error without a message'),
      'WEB_PROVIDER_ERROR',
    )
  }
  const content = isRecord(payload) ? payload.content : undefined
  if (typeof content !== 'string') {
    throw new WebError('Vercel AI Gateway returned no page content', 'WEB_PROVIDER_ERROR')
  }
  return { url: request.url, statusCode: 200, body: { kind: 'text', content }, truncated: false }
}

/** A fetch provider over one live settings section. */
export class VercelFetchProvider {
  /**
   * @param {() => ProviderOptions} resolveOptions reads the options for the
   *   NEXT fetch, once at its entry, so one fetch never mixes two settings
   *   sections.
   */
  constructor(resolveOptions) {
    /** Stable id this provider registers under. */
    this.id = VERCEL_FETCH_PROVIDER_ID
    /** Picker description. */
    this.description = DESCRIPTION
    /** @type {() => ProviderOptions} */
    this.resolveOptions = resolveOptions
  }

  /** @returns {boolean} whether the settings could address a gateway at all. */
  available() {
    const options = this.resolveOptions()
    return options.credentialRef.length > 0 && options.models.length > 0 && URL.canParse(options.baseURL)
  }

  /** @returns {Promise<boolean>} whether the credential reference has a value. */
  ready() {
    const options = this.resolveOptions()
    return options.keyConfigured(options.credentialRef)
  }

  /**
   * @param {WebFetchRequest} request the URL to retrieve.
   * @param {AbortSignal} [signal] caller cancellation; omitted means no cancellation.
   * @returns {Promise<WebFetchResult>} the retrieved page, or a described failure.
   */
  async fetch(request, signal) {
    const options = this.resolveOptions()
    const apiKey = await options.resolveKey(options.credentialRef)
    if (apiKey === undefined) {
      throw new options.WebError(
        'No ' + options.credentialRef + ' credential is configured for the Vercel AI Gateway fetch provider',
        'WEB_PROVIDER_MISCONFIGURED',
      )
    }
    const event = await callGateway({ ...options, apiKey }, {
      tool: FETCH_TOOL,
      args: { url: request.url },
    }, signal)
    return mapFetchPayload(event.result, request, options.WebError, event.isError === true)
  }
}