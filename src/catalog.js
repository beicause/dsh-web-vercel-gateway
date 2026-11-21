/**
 * Discovery of gateway models that can run a forced tool call.
 *
 * A model id written into this package goes stale: the gateway adds and retires
 * models continuously, and a retired id fails every search until a new release
 * ships. So the candidate list is read from the gateway's own catalogue instead,
 * filtered to what this plugin can actually use, and cached for a while.
 *
 * The catalogue is the public model list, which needs no credential and carries
 * no plan information: a model the credential's plan does not cover still
 * appears there and answers 403 when asked. That is why a refusal is remembered
 * rather than predicted, and why the walk is capped: a stale or hostile
 * catalogue must not turn one search into hundreds of requests.
 * @module dsh-web-vercel-gateway/catalog
 */

import { errorMessage, isRecord, nonEmpty } from './gateway.js'

/**
 * @typedef {import('./contracts.js').CatalogSettings} CatalogSettings
 * @typedef {import('./contracts.js').WebErrorConstructor} WebErrorConstructor
 */

/** How long a catalogue answer is reused before the gateway is asked again. */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000

/** Most models one operation tries; the rest of the catalogue is not a fallback list. */
export const MAX_CANDIDATES = 6

/**
 * Models to reach for first when nothing is pinned.
 *
 * These are a preference, not a requirement: each is chosen only while the
 * catalogue still lists it, so an id the gateway retires costs nothing beyond
 * dropping out of this list. They lead because the catalogue carries no latency
 * or quality signal — its cheapest entries are obscure models, and several of
 * those measured far slower than these two on a forced tool call.
 */
export const PREFERRED_MODELS = ['google/gemini-2.5-flash-lite', 'openai/gpt-4o-mini']

/**
 * The catalogue endpoint, derived from the configured endpoint's origin.
 * @param {string} baseURL the operation endpoint.
 * @returns {string} the catalogue endpoint of the same gateway.
 */
export function catalogURL(baseURL) {
  return new URL('/v1/models', baseURL).toString()
}

/**
 * The models this plugin can use, cheapest first.
 *
 * The filter keeps language models that advertise tool use and that the gateway
 * still serves. The order is price, then id, because the catalogue carries no
 * quality or latency signal: price is the one property that says something about
 * what a search costs, and a model that turns out to be unusable is remembered
 * and skipped, so the order only decides the first few requests of a process.
 *
 * A model priced at zero sorts last rather than being dropped. On a commercial
 * gateway a zero price marks a promotional or experimental model — several of
 * them answer a forced tool call far more slowly than a paid one, and some ignore
 * the forced call entirely — so they stay usable as a last resort without being
 * the first thing a search reaches for.
 * @param {unknown} payload the catalogue response body.
 * @returns {readonly string[]} usable model ids, cheapest first.
 * @throws {Error} when the payload is not the catalogue's answer.
 */
export function parseCatalog(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('the model catalogue has no data array')
  }
  /** @type {{ id: string, free: boolean, input: number, output: number }[]} */
  const usable = []
  for (const entry of payload.data) {
    if (!isRecord(entry)) continue
    const id = nonEmpty(entry.id)
    if (id === undefined) continue
    if (entry.type !== 'language') continue
    if (!Array.isArray(entry.tags) || !entry.tags.includes('tool-use')) continue
    if (entry.deprecated_at !== undefined && entry.deprecated_at !== null) continue
    const pricing = isRecord(entry.pricing) ? entry.pricing : undefined
    const input = pricing === undefined ? Number.NaN : Number(pricing.input)
    const output = pricing === undefined ? Number.NaN : Number(pricing.output)
    usable.push({
      id,
      free: !(input > 0),
      input: Number.isFinite(input) ? input : 0,
      output: Number.isFinite(output) ? output : 0,
    })
  }
  usable.sort((left, right) => Number(left.free) - Number(right.free)
    || left.input - right.input
    || left.output - right.output
    || left.id.localeCompare(right.id))
  return orderCandidates(usable.map(entry => entry.id), PREFERRED_MODELS)
}

/**
 * Put the preferred models in front, in their own order, keeping the rest as the
 * catalogue sorted them.
 * @param {readonly string[]} models the catalogue's order.
 * @param {readonly string[]} preferred ids to try first, when the catalogue still lists them.
 * @returns {readonly string[]} the order to walk.
 */
export function orderCandidates(models, preferred) {
  const available = new Set(models)
  const head = preferred.filter(model => available.has(model))
  const chosen = new Set(head)
  return [...head, ...models.filter(model => !chosen.has(model))]
}

/** A catalogue shared by both providers: one cached list and one record of refusals. */
export class ModelCatalog {
  /**
   * @param {() => CatalogSettings} readSettings the live settings, read at each
   *   ask so changing the endpoint or the timeout applies without a remount.
   */
  constructor(readSettings) {
    this.readSettings = readSettings
    /** @type {readonly string[] | undefined} */
    this.cached = undefined
    /** When the cached list was fetched, in epoch milliseconds. */
    this.cachedAt = 0
    /** @type {Map<string, number>} model id to the moment it refused, so a refusal ages out with the cache. */
    this.refused = new Map()
  }

  /** Forget the cached list and every refusal; the next ask fetches again. */
  invalidate() {
    this.cached = undefined
    this.cachedAt = 0
    this.refused.clear()
  }

  /**
   * Record that a model could not serve a request, so this process stops
   * choosing it. 403 and 404 are decisions the gateway makes about that id, and
   * a stream that ran without the tool says the model does not do agentic tool
   * calls. None of them is a transient condition, so none of them is retried.
   * @param {string} model the model that refused.
   */
  remember(model) {
    this.refused.set(model, Date.now())
  }

  /**
   * The models to try, cheapest first, without the ones this process already
   * saw refuse a request.
   * @param {AbortSignal} [signal] caller cancellation, forwarded to the fetch.
   * @returns {Promise<readonly string[]>} the candidate ids, at most MAX_CANDIDATES.
   * @throws {Error} the seam's WebError when the catalogue cannot be read and no
   *   model is pinned, because then there is nothing to ask.
   */
  async models(signal) {
    const settings = this.readSettings()
    const { WebError } = settings
    /** @type {readonly string[]} */
    let all
    if (this.cached !== undefined && Date.now() - this.cachedAt < CATALOG_TTL_MS) {
      all = this.cached
    } else {
      all = await this.fetchCatalog(settings, signal)
    }
    const now = Date.now()
    /** @type {string[]} */
    const usable = []
    for (const model of all) {
      const refusedAt = this.refused.get(model)
      if (refusedAt !== undefined && now - refusedAt < CATALOG_TTL_MS) continue
      usable.push(model)
      if (usable.length === MAX_CANDIDATES) break
    }
    if (usable.length === 0) {
      throw new WebError(
        'Vercel AI Gateway has no usable model left: the catalogue at ' + catalogURL(settings.baseURL)
          + ' lists none that this credential served, so set the model setting to an id it accepts',
        'WEB_PROVIDER_ERROR',
      )
    }
    return usable
  }

  /**
   * @param {{ baseURL: string, timeoutMs: number, WebError: WebErrorConstructor }} settings endpoint and error class.
   * @param {AbortSignal} [signal] caller cancellation.
   * @returns {Promise<readonly string[]>} every usable model, regardless of refusals.
   * @throws {Error} the seam's WebError when the catalogue cannot be read.
   */
  async fetchCatalog(settings, signal) {
    const url = catalogURL(settings.baseURL)
    const { WebError } = settings
    // The catalogue is one small JSON document, but it is fetched on the way to
    // a search the caller is waiting for, so it gets the same time bound rather
    // than an unbounded wait.
    const deadline = AbortSignal.timeout(settings.timeoutMs)
    const bounded = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    /** @type {Response} */
    let response
    try {
      response = await fetch(url, { headers: { accept: 'application/json' }, signal: bounded })
    } catch (error) {
      throw new WebError(
        'Vercel AI Gateway model catalogue at ' + url + ' could not be read: ' + errorMessage(error)
          + '. Set the model setting to an id the gateway serves to skip discovery',
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (!response.ok) {
      throw new WebError(
        'Vercel AI Gateway model catalogue at ' + url + ' answered HTTP ' + String(response.status)
          + '. Set the model setting to an id the gateway serves to skip discovery',
        'WEB_PROVIDER_ERROR',
      )
    }
    /** @type {unknown} */
    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new WebError(
        'Vercel AI Gateway model catalogue at ' + url + ' did not answer with JSON: ' + errorMessage(error),
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    /** @type {readonly string[]} */
    let models
    try {
      models = parseCatalog(payload)
    } catch (error) {
      throw new WebError(
        'Vercel AI Gateway model catalogue at ' + url + ' is not the shape this provider reads: '
          + errorMessage(error) + '. Set the model setting to an id the gateway serves to skip discovery',
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    this.cached = models
    this.cachedAt = Date.now()
    return models
  }
}
