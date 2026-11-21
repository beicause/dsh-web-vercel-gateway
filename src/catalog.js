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

/**
 * Settle with `promise`, or reject as soon as `signal` aborts.
 *
 * The promise itself keeps running: it is shared, and another operation may be
 * waiting on the same answer.
 * @template T
 * @param {Promise<T>} promise the work to wait for.
 * @param {AbortSignal} signal cancellation of this wait only.
 * @returns {Promise<T>} the promise's outcome, or the abort.
 */
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    /** @param {Event} _event the abort event. */
    const onAbort = (_event) => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
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
    /**
     * The fetch already in progress, if any. A cold start has no answer yet, so
     * two operations arriving together would otherwise both read the catalogue
     * and pay for it twice.
     * @type {Promise<readonly string[]> | undefined}
     */
    this.pending = undefined
    /**
     * Bumped by invalidate(), so a read that started before it knows its answer
     * is no longer wanted.
     */
    this.generation = 0
    /** @type {Map<string, number>} model id to the moment it refused, so a refusal ages out with the cache. */
    this.refused = new Map()
  }

  /**
   * Forget the cached list and every refusal. A read already in flight is
   * abandoned rather than cached, so its answer cannot land after the decision
   * to forget it.
   */
  invalidate() {
    this.generation += 1
    this.cached = undefined
    this.cachedAt = 0
    this.pending = undefined
    this.refused.clear()
  }

  /**
   * Start the catalogue read, or join the one already running, and let the
   * shared promise clear itself once it settles.
   *
   * Both the prefetch and every operation go through here: sharing one promise
   * is what keeps a cold start from reading the same document twice, and
   * clearing it on settle is what lets a later read — after the cached answer
   * expires, or after a failure — actually happen.
   * @returns {Promise<readonly string[]>} the catalogue's usable ids.
   */
  start() {
    if (this.pending !== undefined) return this.pending
    const generation = this.generation
    /** @type {Promise<readonly string[]>} */
    const started = this.fetchCatalog(this.readSettings(), generation)
      .finally(() => { if (this.pending === started) this.pending = undefined })
    this.pending = started
    return started
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
   * Read the catalogue ahead of the first operation, so that operation does not
   * pay for it.
   *
   * This runs when the plugin mounts, which is why it never rejects and never
   * reports: a gateway that is unreachable, a credential that has not been added
   * yet, or a process that never searches must all leave mounting exactly as it
   * was. A failure here costs nothing, because the next operation asks again.
   * @returns {void}
   */
  warm() {
    if (this.cached !== undefined && Date.now() - this.cachedAt < CATALOG_TTL_MS) return
    // The promise stays shared with whoever asks next, so it must keep rejecting
    // for them; this handler only stops a failed prefetch nobody awaited from
    // becoming an unhandled rejection.
    this.start().catch(() => {})
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
      // One read answers every caller that arrives while it runs. The shared
      // read ignores a caller's signal — one cancellation must not throw away
      // an answer another operation is waiting for — so this caller instead
      // stops waiting when its own signal fires.
      const pending = this.start()
      all = signal === undefined ? await pending : await raceAbort(pending, signal)
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
   * @param {number} generation the invalidation generation this read was started in.
   * @returns {Promise<readonly string[]>} every usable model, regardless of refusals.
   * @throws {Error} the seam's WebError when the catalogue cannot be read.
   */
  async fetchCatalog(settings, generation) {
    const url = catalogURL(settings.baseURL)
    const { WebError } = settings
    // The catalogue is one small JSON document, but it is fetched on the way to
    // a search the caller is waiting for, so it gets the same time bound rather
    // than an unbounded wait.
    const bounded = AbortSignal.timeout(settings.timeoutMs)
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
    // An answer that arrives after invalidate() describes a catalogue the
    // caller already chose to forget.
    if (generation === this.generation) {
      this.cached = models
      this.cachedAt = Date.now()
    }
    return models
  }
}
