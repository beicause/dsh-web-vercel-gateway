/**
 * One Vercel AI Gateway language-model request that forces a single
 * provider-executed tool call and returns that call's result.
 *
 * The gateway exposes DeepSeek Search and Fetch only as gateway tools: no REST
 * endpoint runs either on its own, so a search or a fetch costs one model
 * request. The request pins the tool through toolChoice, so the model's only job
 * is to hand the arguments to it, and reading stops at the first tool-result
 * event: everything after it is the model narrating a result this module
 * already holds.
 *
 * Two failures are worth another attempt rather than an error. A rate-limited
 * or failed gateway call is retried on the next configured model, because the
 * gateway limits per model, so a second model has its own budget. A route that
 * answers 404 with a web page instead of JSON has been retired, and the previous
 * protocol version of the same route is tried in its place. Neither retry waits:
 * a web tool call that blocks for the length of a rate-limit window is worse
 * than one that fails and says when to retry.
 *
 * This module imports nothing. The caller supplies the seam's WebError class, so
 * the provider packages stay free of bare imports and resolve no module copy of
 * their own; an error thrown here is then an instance of the class the harness
 * checks with instanceof.
 * @module dsh-web-vercel-gateway/gateway
 */

/**
 * @typedef {import('./contracts.js').GatewayOptions} GatewayOptions
 * @typedef {import('./contracts.js').GatewayOperation} GatewayOperation
 * @typedef {import('./contracts.js').GatewayRequestOptions} GatewayRequestOptions
 * @typedef {import('./contracts.js').ToolResultEvent} ToolResultEvent
 * @typedef {import('./contracts.js').WebErrorConstructor} WebErrorConstructor
 */

/**
 * The outcome of one request: the tool result, a failure worth another model, or
 * a route that no longer exists.
 *
 * `permanent` tells the two kinds of failure apart. A permanent one is a
 * decision the gateway makes about that model id — the plan does not cover it,
 * the id is gone, or the model will not run a forced tool call — so it is worth
 * remembering and skipping rather than trying again on the next operation. The
 * other kind is a rate limit, a server fault, or a timeout, which says nothing
 * about the model itself.
 * @typedef {{ kind: 'result', event: ToolResultEvent }
 *   | { kind: 'retry', error: Error, permanent?: boolean, retryAfterSeconds?: number }
 *   | { kind: 'stale-route' }} AttemptOutcome
 */

/** Provider-executed search tool: the gateway id and the model-facing name it must be called by. */
export const SEARCH_TOOL = { id: 'gateway.deepseek_search', name: 'deepseek_search' }

/** Provider-executed fetch tool: the gateway id and the model-facing name it must be called by. */
export const FETCH_TOOL = { id: 'gateway.deepseek_fetch', name: 'deepseek_fetch' }

/** Gateway protocol version this module speaks. */
const PROTOCOL_VERSION = '0.0.1'

/** Language-model specification version this module sends. */
const SPECIFICATION_VERSION = '4'

/** Identity sent as user-agent; the gateway records it against the request. */
const USER_AGENT = 'deepseek-harness-web-vercel-gateway'

/**
 * Prompt text of the request. The tool call is forced, so the turn only has to
 * be one the model may answer; the instructions keep the model from spending
 * output tokens before the call and from narrating or repeating it afterwards,
 * which is what a stream without a tool result is diagnosed from.
 */
const PROMPT_TEXT = 'Call the tool now with the given arguments. Do not write any text before or'
  + ' after the call. Do not repeat or summarise the tool result. Do not call any other tool.'

/** Most trailing model text kept for the diagnostic of a stream that produced no tool result. */
const FRAGMENT_MAX_CHARS = 300

/** Most gateway response text kept for a failure message. */
const DETAIL_MAX_CHARS = 300

/** The versioned language-model route, whose number is the protocol version it speaks. */
const ROUTE_PATTERN = /\/v(\d+)\/ai\/language-model$/

/** Oldest route this module falls back to; earlier versions answer with a retirement notice. */
const OLDEST_ROUTE_VERSION = 3

/**
 * Whether a value is a JSON object rather than an array or a primitive.
 * @param {unknown} value candidate value.
 * @returns {value is Record<string, unknown>} true for a plain object.
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The message of a thrown value.
 * @param {unknown} error the thrown value.
 * @returns {string} its message, or the value stringified.
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A string with content, or undefined for an absent or empty value.
 * @param {unknown} value candidate string.
 * @returns {string | undefined} the value when it has content.
 */
export function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Split the model setting into the ordered candidate list a request walks.
 *
 * One field rather than a list field keeps existing single-model settings
 * working unchanged, and the order is the retry order, so the cheapest model
 * goes first and the fallback only runs when the gateway turns the first away.
 * @param {string} text the model setting: one id, or several separated by commas or spaces.
 * @returns {readonly string[]} the ids, in order, without blanks or repeats.
 */
export function parseModels(text) {
  /** @type {string[]} */
  const models = []
  for (const part of text.split(/[,\s]+/)) {
    const model = part.trim()
    if (model.length === 0 || models.includes(model)) continue
    models.push(model)
  }
  return models
}

/**
 * The routes to try, in order: the configured one and, when it is a versioned
 * language-model route, the previous protocol version.
 *
 * The gateway keeps adjacent protocol versions live at once, and the request
 * body is the same for both, so a retired route degrades to its predecessor
 * instead of failing until this plugin ships a new default. Earlier versions
 * are not tried: the gateway answers those with a retirement notice rather than
 * serving them.
 * @param {string} baseURL the configured endpoint.
 * @returns {readonly string[]} the endpoints to try, in order.
 */
export function candidateRoutes(baseURL) {
  const match = ROUTE_PATTERN.exec(baseURL)
  if (match === null || match.index === undefined) return [baseURL]
  const version = Number(match[1])
  if (!Number.isInteger(version) || version <= OLDEST_ROUTE_VERSION) return [baseURL]
  const previous = baseURL.slice(0, match.index) + '/v' + String(version - 1) + '/ai/language-model'
  return [baseURL, previous]
}

/**
 * Whether an answer says the route itself is gone: a 404 carrying a web page
 * rather than the gateway's JSON error body, which is how the platform serves a
 * path that no deployment matches.
 * @param {number} status HTTP status of the answer.
 * @param {string} text its body text.
 * @returns {boolean} true when the answer is a page, not the gateway's own error.
 */
function isRetiredRoute(status, text) {
  return status === 404 && text.trimStart().startsWith('<')
}

/**
 * Whether another model may answer after this status.
 *
 * 403 is retried because the gateway answers it with `no_providers_available`
 * when the credential's plan does not cover that model, which says nothing about
 * the next model; 404 joins it because a discovered id can be retired between
 * the catalogue read and the request. A credential the gateway rejects outright
 * is a 401, and no model changes that. 429 and 5xx are per-model or transient, so
 * the next model has its own chance.
 * @param {number} status HTTP status of the answer.
 * @returns {boolean} true when another model may still answer.
 */
function isRetryableStatus(status) {
  return status === 403 || status === 404 || status === 429 || status >= 500
}

/**
 * Whether a status is the gateway's verdict on that model id rather than a
 * condition that may pass.
 * @param {number} status HTTP status of the answer.
 * @returns {boolean} true when the model itself is the problem.
 */
function isPermanentRefusal(status) {
  return status === 403 || status === 404
}

/**
 * The delay the gateway asks for, in whole seconds.
 * @param {Headers} headers headers of a rate-limited answer.
 * @returns {number | undefined} the delay, when the answer names one.
 */
function retryAfterSeconds(headers) {
  const raw = headers.get('retry-after') ?? headers.get('x-ratelimit-reset-requests')
  if (raw === null) return undefined
  const value = raw.trim()
  // `retry-after` is seconds by definition, but the sibling rate-limit header
  // writes durations with a unit (`42ms`), where reading the number alone would
  // report a wait a thousand times too long.
  const duration = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i.exec(value)
  if (duration !== null) {
    const amount = Number.parseFloat(duration[1])
    const unit = (duration[2] ?? 's').toLowerCase()
    if (!Number.isFinite(amount) || amount < 0) return undefined
    const seconds = unit === 'ms' ? amount / 1000 : unit === 'm' ? amount * 60 : amount
    return Math.ceil(seconds)
  }
  // An HTTP date is also allowed here; its distance from now is the wait.
  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  const seconds = (at - Date.now()) / 1000
  return seconds <= 0 ? undefined : Math.ceil(seconds)
}

/**
 * Build the request headers of one gateway call.
 * @param {GatewayRequestOptions} options endpoint and credential value.
 * @param {string} model the model this attempt asks for.
 * @returns {Record<string, string>} the headers, including the protocol and model-selection headers.
 */
function requestHeaders(options, model) {
  return {
    authorization: 'Bearer ' + options.apiKey,
    'ai-gateway-protocol-version': PROTOCOL_VERSION,
    'ai-gateway-auth-method': 'api-key',
    'ai-language-model-specification-version': SPECIFICATION_VERSION,
    'ai-language-model-id': model,
    'ai-language-model-streaming': 'true',
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
  }
}

/**
 * Build the request body that forces one provider-executed tool call.
 * @param {GatewayRequestOptions} options token floor of the request.
 * @param {GatewayOperation} operation tool identity and its arguments.
 * @returns {Record<string, unknown>} the body sent as JSON.
 */
function requestBody(options, operation) {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: PROMPT_TEXT }] }],
    tools: [{
      type: 'provider',
      id: operation.tool.id,
      name: operation.tool.name,
      args: operation.args,
      isProviderExecuted: true,
    }],
    toolChoice: { type: 'tool', toolName: operation.tool.name },
    maxOutputTokens: options.maxOutputTokens,
  }
}

/**
 * A response body as one short line, for a failure message.
 *
 * A body that is a web page is dropped whole: the route diagnostic already says
 * what happened, and a page of markup says nothing a reader can act on.
 * @param {string} text the response body text.
 * @returns {string | undefined} the body when it is short text, otherwise undefined.
 */
function clampDetail(text) {
  if (text.trimStart().startsWith('<')) return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return undefined
  return flat.length > DETAIL_MAX_CHARS ? flat.slice(0, DETAIL_MAX_CHARS) + '...' : flat
}

/**
 * The gateway's own message from an error body, when the body carries one.
 * @param {string} text the response body text.
 * @returns {string | undefined} the message, or undefined when the body has none.
 */
function gatewayMessage(text) {
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(text)
    if (!isRecord(parsed)) return clampDetail(text)
    const nested = isRecord(parsed.error) ? parsed.error : undefined
    return nonEmpty(typeof parsed.error === 'string' ? parsed.error : undefined)
      ?? nonEmpty(nested === undefined ? undefined : nested.message)
      ?? nonEmpty(parsed.message)
  } catch {
    return clampDetail(text)
  }
}

/**
 * Turn one non-2xx answer into a failure that names the setting to change.
 * @param {GatewayOptions} options endpoint and credential settings the request used.
 * @param {string} model the model this attempt asked for.
 * @param {WebErrorConstructor} WebError the seam's error class.
 * @param {number} status HTTP status of the answer.
 * @param {string} text its body text.
 * @returns {Error} the error to throw or report.
 */
function httpFailure(options, model, WebError, status, text) {
  const detail = gatewayMessage(text)
  const suffix = detail === undefined ? '' : ': ' + detail
  const label = String(status)
  if (status === 401) {
    return new WebError(
      'Vercel AI Gateway rejected the credential (HTTP 401). Check that the '
        + options.credentialRef + ' credential is valid' + suffix,
      'WEB_PROVIDER_ERROR',
    )
  }
  if (status === 403) {
    return new WebError(
      'Vercel AI Gateway does not offer model "' + model + '" to this credential (HTTP 403); '
        + 'the plan may not cover it' + suffix,
      'WEB_PROVIDER_ERROR',
    )
  }
  if (status === 404) {
    return new WebError(
      'Vercel AI Gateway found no model "' + model + '" (HTTP 404), so the gateway no longer '
        + 'serves that id' + suffix,
      'WEB_PROVIDER_ERROR',
    )
  }
  if (status === 429) {
    return new WebError(
      'Vercel AI Gateway rate-limited model "' + model + '" (HTTP 429)' + suffix,
      'WEB_PROVIDER_ERROR',
    )
  }
  return new WebError('Vercel AI Gateway request failed (HTTP ' + label + ')' + suffix, 'WEB_PROVIDER_ERROR')
}

/**
 * The failure for a route the gateway no longer serves.
 * @param {WebErrorConstructor} WebError the seam's error class.
 * @param {readonly string[]} routes the routes that were tried.
 * @returns {Error} the error to throw.
 */
function retiredRoute(WebError, routes) {
  return new WebError(
    'Vercel AI Gateway answered HTTP 404 with a web page instead of JSON for '
      + routes.map(route => '"' + route + '"').join(' and ')
      + ', so the route is gone. The gateway versions this route with the AI SDK protocol; '
      + 'set the baseURL setting to a route it serves, or leave it at the default',
    'WEB_PROVIDER_ERROR',
  )
}

/**
 * The failure for a stream that ended without the forced tool call, naming what
 * to change: a low output-token floor stops the gateway before the tool result,
 * and a model without tool support never produces one.
 * @param {GatewayOptions} options token floor the request used.
 * @param {string} model the model this attempt asked for.
 * @param {WebErrorConstructor} WebError the seam's error class.
 * @param {string | undefined} fragment trailing model text, when the stream produced any.
 * @param {string | undefined} reason the stream's finish reason, when it reported one.
 * @returns {Error} the error to throw.
 */
function missingResult(options, model, WebError, fragment, reason) {
  const tail = (fragment === undefined ? '' : '; model text: ' + fragment)
    + (reason === undefined ? '' : '; finish reason: ' + reason)
  const error = new WebError(
    'Vercel AI Gateway finished without running the tool on model "' + model
      + '". Raise the maxOutputTokens setting (currently ' + String(options.maxOutputTokens)
      + ') or choose a model that supports tool calls' + tail,
    'WEB_PROVIDER_ERROR',
  )
  // A model that answers without the forced call does so every time, which is
  // what makes it a candidate to skip rather than to try again later.
  return markUnusable(error)
}

/**
 * Mark an error as the gateway's verdict on that model id, so the caller can
 * stop offering the id instead of failing every operation on it.
 * @template {Error} T
 * @param {T} error the error to mark.
 * @returns {T} the same error, marked.
 */
function markUnusable(error) {
  return Object.assign(error, { modelUnusable: true })
}

/**
 * Whether an error came from a model the gateway cannot run this tool on.
 * @param {unknown} error the thrown value.
 * @returns {boolean} true when the model, not the request, is the problem.
 */
function isUnusableModel(error) {
  return isRecord(error) ? error.modelUnusable === true : false
}

/**
 * Read one server-sent-event stream until the forced tool result arrives.
 *
 * Only the first matching result is returned. A model that ignores the
 * instruction to stop may call the tool again, and the later result is not a
 * better answer to the request this module made.
 * @param {Response} response the streaming answer.
 * @param {GatewayOptions} options settings the diagnostics name.
 * @param {string} model the model this attempt asked for.
 * @param {GatewayOperation} operation tool identity the result must carry.
 * @param {WebErrorConstructor} WebError the seam's error class.
 * @returns {Promise<ToolResultEvent>} the tool-result event.
 */
async function readToolResult(response, options, model, operation, WebError) {
  if (response.body === null) throw missingResult(options, model, WebError, undefined, undefined)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  /** @type {string[]} */
  const text = []
  let pending = ''
  /** @type {string | undefined} */
  let reason
  /** @type {string | undefined} */
  let streamError
  /**
   * Read one line of the stream, recording what it carries.
   * @param {string} line raw line text, without its terminator.
   * @returns {ToolResultEvent | undefined} the tool result, when this line carried it.
   */
  const readLine = (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return undefined
    const payload = trimmed.slice(5).trim()
    if (payload.length === 0) return undefined
    /** @type {unknown} */
    let event
    try {
      event = JSON.parse(payload)
    } catch {
      // A frame this module cannot read carries nothing it needs: the tool
      // result arrives as its own complete frame.
      return undefined
    }
    if (!isRecord(event)) return undefined
    if (event.type === 'tool-result' && event.toolName === operation.tool.name) {
      return /** @type {ToolResultEvent} */ (/** @type {unknown} */ (event))
    }
    if (event.type === 'text-delta' && typeof event.delta === 'string') text.push(event.delta)
    if (event.type === 'finish' && isRecord(event.finishReason)) {
      reason = nonEmpty(event.finishReason.unified) ?? nonEmpty(event.finishReason.raw)
    }
    if (event.type === 'error') streamError = gatewayMessage(JSON.stringify(event))
    return undefined
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
        const found = readLine(line)
        if (found !== undefined) return found
      }
    }
    // A stream that ends mid-line still ends: its last frame counts, because a
    // gateway closing the connection right after the result leaves no newline.
    pending += decoder.decode()
    if (pending.length > 0) {
      const found = readLine(pending)
      if (found !== undefined) return found
    }
  } finally {
    // Stopping at the result leaves the rest of the stream unread on purpose;
    // cancelling releases the connection instead of draining text nobody uses.
    await reader.cancel().catch(() => undefined)
  }
  if (streamError !== undefined) {
    throw new WebError('Vercel AI Gateway reported an error: ' + streamError, 'WEB_PROVIDER_ERROR')
  }
  const fragment = text.length === 0 ? undefined : text.join('').slice(-FRAGMENT_MAX_CHARS)
  throw missingResult(options, model, WebError, fragment, reason)
}

/**
 * Run one request on one model and one route.
 * @param {GatewayRequestOptions} options endpoint, credential, token floor, and timeout.
 * @param {string} model the model to ask for.
 * @param {string} route the endpoint to call.
 * @param {GatewayOperation} operation tool identity and its arguments.
 * @param {AbortSignal} [signal] caller cancellation, forwarded to the request; omitted means none.
 * @returns {Promise<AttemptOutcome>} the result, or why another attempt may help.
 * @throws {Error} the seam's WebError: WEB_ABORTED when the caller cancels, and
 *   WEB_PROVIDER_ERROR for every failure no retry can fix, including this
 *   module's own timeout.
 */
async function attemptOnce(options, model, route, operation, signal) {
  const { WebError } = options
  /** @param {unknown} cause */
  const aborted = (cause) => new WebError('Vercel AI Gateway request aborted', 'WEB_ABORTED', { cause })
  if (signal?.aborted === true) throw aborted(signal.reason)
  /**
   * Whether the caller has cancelled. Read through a function because the check
   * above narrows `signal.aborted` to false for the rest of this body, while a
   * cancellation arriving during the request must still be seen.
   * @returns {boolean} true once the caller's signal is aborted.
   */
  const cancelled = () => signal?.aborted === true
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  const forward = () => { controller.abort() }
  signal?.addEventListener('abort', forward, { once: true })
  /**
   * @param {unknown} error
   * @param {string} phase
   * @returns {Error}
   */
  const timeoutFailure = (error, phase) => new WebError(
    'Vercel AI Gateway did not ' + phase + ' within ' + String(options.timeoutMs)
      + 'ms; raise the timeoutMs setting or retry',
    'WEB_PROVIDER_ERROR',
    { cause: error },
  )
  try {
    /** @type {Response} */
    let response
    try {
      response = await fetch(route, {
        method: 'POST',
        redirect: 'error',
        headers: requestHeaders(options, model),
        body: JSON.stringify(requestBody(options, operation)),
        signal: controller.signal,
      })
    } catch (error) {
      // The timeout is this module's own decision and is checked first: once the
      // timer fired, an abort that lands a moment later must not relabel a
      // timeout as the caller's cancellation.
      if (timedOut) throw timeoutFailure(error, 'answer')
      if (cancelled()) throw aborted(signal?.reason)
      throw new WebError('Vercel AI Gateway request failed: ' + errorMessage(error), 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) {
      let body = ''
      try {
        body = await response.text()
      } catch {
        // The status alone still identifies the failure.
      }
      if (timedOut) throw timeoutFailure(new Error('the gateway answered ' + String(response.status)), 'answer')
      if (cancelled()) throw aborted(signal?.reason)
      if (isRetiredRoute(response.status, body)) return { kind: 'stale-route' }
      const error = httpFailure(options, model, WebError, response.status, body)
      if (!isRetryableStatus(response.status)) throw error
      return {
        kind: 'retry',
        error,
        permanent: isPermanentRefusal(response.status),
        retryAfterSeconds: retryAfterSeconds(response.headers),
      }
    }
    try {
      return { kind: 'result', event: await readToolResult(response, options, model, operation, WebError) }
    } catch (error) {
      // A stream that ran without the tool is that model declining the forced
      // call, so the next candidate gets the request rather than the caller
      // getting an error the settings cannot fix.
      if (isUnusableModel(error)) {
        return { kind: 'retry', error: /** @type {Error} */ (error), permanent: true }
      }
      if (error instanceof WebError) throw error
      if (timedOut) throw timeoutFailure(error, 'finish')
      if (cancelled()) throw aborted(signal?.reason)
      throw new WebError('Vercel AI Gateway stream failed: ' + errorMessage(error), 'WEB_PROVIDER_ERROR', { cause: error })
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

/**
 * The candidate list, read from the catalogue when no model is pinned.
 *
 * Discovery waits on a signal that is not its own — a prefetch shared with other
 * operations — so a cancellation arrives there as the raw reason rather than as
 * this seam's error. Mapping it here is what keeps a cancelled first search
 * reporting WEB_ABORTED like every other cancelled request, instead of leaking a
 * DOMException the harness cannot classify.
 * @param {GatewayRequestOptions} options endpoint, catalogue, and error class.
 * @param {AbortSignal} [signal] caller cancellation.
 * @returns {Promise<readonly string[]>} the candidates to walk.
 * @throws {Error} the seam's WebError: WEB_ABORTED when the caller cancels.
 */
async function discoverModels(options, signal) {
  const { WebError } = options
  try {
    return await options.catalog.models(signal)
  } catch (error) {
    if (signal?.aborted === true) {
      throw new WebError('Vercel AI Gateway request aborted', 'WEB_ABORTED', { cause: signal.reason })
    }
    if (error instanceof WebError) throw error
    throw new WebError('Vercel AI Gateway model list could not be read: ' + errorMessage(error), 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * The failure after every candidate model refused the request.
 * @param {WebErrorConstructor} WebError the seam's error class.
 * @param {{ model: string, error: Error }[]} failures the failures, in the order they happened.
 * @param {number | undefined} delaySeconds the delay the gateway asked for, when it named one.
 * @returns {Error} the error to throw.
 */
function exhaustedFailure(WebError, failures, delaySeconds) {
  const wait = delaySeconds === undefined
    ? ''
    : ' Retry after ' + String(delaySeconds) + 's; this provider does not wait on its own.'
  if (failures.length === 1) {
    const only = failures[0]
    if (wait.length === 0) return only.error
    return new WebError(only.error.message + '.' + wait, 'WEB_PROVIDER_ERROR', { cause: only.error })
  }
  return new WebError(
    'Vercel AI Gateway refused every configured model ('
      + failures.map(failure => '"' + failure.model + '": ' + failure.error.message).join('; ')
      + ').' + wait,
    'WEB_PROVIDER_ERROR',
  )
}

/**
 * Run one gateway request that forces a provider-executed tool call.
 *
 * The candidate list is the configured one, or — when the setting names nothing —
 * whatever the catalogue currently offers. Either way a model the gateway
 * rejects permanently is reported to the catalogue, so this process stops
 * spending a request on it.
 * @param {GatewayRequestOptions} options endpoint, models, credential, token floor, and timeout.
 * @param {GatewayOperation} operation tool identity and its arguments.
 * @param {AbortSignal} [signal] caller cancellation, forwarded to the request; omitted means none.
 * @returns {Promise<ToolResultEvent>} the tool-result event, whose payload the caller decodes.
 * @throws {Error} the seam's WebError: WEB_ABORTED when the caller cancels, and
 *   WEB_PROVIDER_ERROR for every other failure, including this module's timeout.
 */
export async function callGateway(options, operation, signal) {
  const { WebError } = options
  const models = options.models.length > 0
    ? options.models
    : await discoverModels(options, signal)
  const routes = candidateRoutes(options.baseURL)
  let routeIndex = 0
  /** @type {number | undefined} */
  let delaySeconds
  /** @type {{ model: string, error: Error }[]} */
  const failures = []
  for (const model of models) {
    for (;;) {
      const outcome = await attemptOnce(options, model, routes[routeIndex], operation, signal)
      if (outcome.kind === 'result') return outcome.event
      if (outcome.kind === 'stale-route') {
        // A retired route says nothing about the model, so the same model is
        // asked again on the previous protocol version before it counts as a
        // failed model.
        if (routeIndex + 1 < routes.length) {
          routeIndex += 1
          continue
        }
        throw retiredRoute(WebError, routes)
      }
      if (outcome.permanent === true) options.catalog.remember(model)
      // Several models can each name a wait; the longest one is what a caller
      // who retries once must actually observe.
      if (outcome.retryAfterSeconds !== undefined) {
        delaySeconds = delaySeconds === undefined
          ? outcome.retryAfterSeconds
          : Math.max(delaySeconds, outcome.retryAfterSeconds)
      }
      failures.push({ model, error: outcome.error })
      break
    }
  }
  throw exhaustedFailure(WebError, failures, delaySeconds)
}
