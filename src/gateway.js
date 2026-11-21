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

/** Prompt text of the request: the tool call is forced, so the turn only has to be one the model may answer. */
const PROMPT_TEXT = 'Run the tool.'

/** Most trailing model text kept for the diagnostic of a stream that produced no tool result. */
const FRAGMENT_MAX_CHARS = 300

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
 * Build the request headers of one gateway call.
 * @param {GatewayRequestOptions} options endpoint, model, and credential value.
 * @returns {Record<string, string>} the headers, including the protocol and model-selection headers.
 */
function requestHeaders(options) {
  return {
    authorization: 'Bearer ' + options.apiKey,
    'ai-gateway-protocol-version': PROTOCOL_VERSION,
    'ai-gateway-auth-method': 'api-key',
    'ai-language-model-specification-version': SPECIFICATION_VERSION,
    'ai-language-model-id': options.model,
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
 * The gateway's own message from an error body, when the body carries one.
 * @param {string} text the response body text.
 * @returns {string | undefined} the message, or undefined when the body has none.
 */
function gatewayMessage(text) {
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(text)
    if (!isRecord(parsed)) return nonEmpty(text.trim())
    const nested = isRecord(parsed.error) ? parsed.error : undefined
    return nonEmpty(typeof parsed.error === 'string' ? parsed.error : undefined)
      ?? nonEmpty(nested === undefined ? undefined : nested.message)
      ?? nonEmpty(parsed.message)
  } catch {
    return nonEmpty(text.trim())
  }
}

/**
 * Turn one non-2xx answer into a failure that names the setting to change.
 * @param {GatewayOptions} options endpoint, model, and credential settings the request used.
 * @param {WebErrorConstructor} WebError the seam's error class.
 * @param {number} status HTTP status of the answer.
 * @param {string} text its body text.
 * @returns {Error} the error to throw.
 */
function httpFailure(options, WebError, status, text) {
  const detail = gatewayMessage(text)
  const suffix = detail === undefined ? '' : ': ' + detail
  const label = String(status)
  if (status === 401 || status === 403) {
    return new WebError(
      'Vercel AI Gateway rejected the credential (HTTP ' + label + '). Check that the '
        + options.credentialRef + ' credential is valid and may use the model "'
        + options.model + '"' + suffix,
      'WEB_PROVIDER_ERROR',
    )
  }
  if (status === 404) {
    return new WebError(
      'Vercel AI Gateway found no model "' + options.model + '" (HTTP 404). Set the model '
        + 'setting to an id the gateway serves, such as "google/gemini-2.5-flash-lite"' + suffix,
      'WEB_PROVIDER_ERROR',
    )
  }
  if (status === 429) {
    return new WebError(
      'Vercel AI Gateway rate-limited the request (HTTP 429); retry later or lower the request rate' + suffix,
      'WEB_PROVIDER_ERROR',
    )
  }
  return new WebError('Vercel AI Gateway request failed (HTTP ' + label + ')' + suffix, 'WEB_PROVIDER_ERROR')
}

/**
 * The failure for a stream that ended without the forced tool call, naming what
 * to change: a low output-token floor stops the gateway before the tool result,
 * and a model without tool support never produces one.
 * @param {GatewayOptions} options token floor and model the request used.
 * @param {WebErrorConstructor} WebError the seam's error class.
 * @param {string | undefined} fragment trailing model text, when the stream produced any.
 * @param {string | undefined} reason the stream's finish reason, when it reported one.
 * @returns {Error} the error to throw.
 */
function missingResult(options, WebError, fragment, reason) {
  const tail = (fragment === undefined ? '' : '; model text: ' + fragment)
    + (reason === undefined ? '' : '; finish reason: ' + reason)
  return new WebError(
    'Vercel AI Gateway finished without running the tool on model "' + options.model
      + '". Raise the maxOutputTokens setting (currently ' + String(options.maxOutputTokens)
      + ') or choose a model that supports tool calls' + tail,
    'WEB_PROVIDER_ERROR',
  )
}

/**
 * Read one server-sent-event stream until the forced tool result arrives.
 * @param {Response} response the streaming answer.
 * @param {GatewayOptions} options settings the diagnostics name.
 * @param {GatewayOperation} operation tool identity the result must carry.
 * @param {WebErrorConstructor} WebError the seam's error class.
 * @returns {Promise<ToolResultEvent>} the tool-result event.
 */
async function readToolResult(response, options, operation, WebError) {
  if (response.body === null) throw missingResult(options, WebError, undefined, undefined)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  /** @type {string[]} */
  const text = []
  let pending = ''
  /** @type {string | undefined} */
  let reason
  /** @type {string | undefined} */
  let streamError
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload.length === 0) continue
        /** @type {unknown} */
        let event
        try {
          event = JSON.parse(payload)
        } catch {
          // A frame this module cannot read carries nothing it needs: the tool
          // result arrives as its own complete frame.
          continue
        }
        if (!isRecord(event)) continue
        if (event.type === 'tool-result' && event.toolName === operation.tool.name) {
          return /** @type {ToolResultEvent} */ (/** @type {unknown} */ (event))
        }
        if (event.type === 'text-delta' && typeof event.delta === 'string') text.push(event.delta)
        if (event.type === 'finish' && isRecord(event.finishReason)) {
          reason = nonEmpty(event.finishReason.unified) ?? nonEmpty(event.finishReason.raw)
        }
        if (event.type === 'error') streamError = gatewayMessage(JSON.stringify(event))
      }
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
  throw missingResult(options, WebError, fragment, reason)
}

/**
 * Run one gateway request that forces a provider-executed tool call.
 * @param {GatewayRequestOptions} options endpoint, model, credential, token floor, and timeout.
 * @param {GatewayOperation} operation tool identity and its arguments.
 * @param {AbortSignal} [signal] caller cancellation, forwarded to the request; omitted means none.
 * @returns {Promise<ToolResultEvent>} the tool-result event, whose payload the caller decodes.
 * @throws {Error} the seam's WebError: WEB_ABORTED when the caller cancels, and
 *   WEB_PROVIDER_ERROR for every other failure, including this module's timeout.
 */
export async function callGateway(options, operation, signal) {
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
      response = await fetch(options.baseURL, {
        method: 'POST',
        redirect: 'error',
        headers: requestHeaders(options),
        body: JSON.stringify(requestBody(options, operation)),
        signal: controller.signal,
      })
    } catch (error) {
      if (cancelled()) throw aborted(signal?.reason)
      if (timedOut) throw timeoutFailure(error, 'answer')
      throw new WebError('Vercel AI Gateway request failed: ' + errorMessage(error), 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) {
      let body = ''
      try {
        body = await response.text()
      } catch {
        // The status alone still identifies the failure.
      }
      if (cancelled()) throw aborted(signal?.reason)
      throw httpFailure(options, WebError, response.status, body)
    }
    try {
      return await readToolResult(response, options, operation, WebError)
    } catch (error) {
      if (error instanceof WebError) throw error
      if (cancelled()) throw aborted(signal?.reason)
      if (timedOut) throw timeoutFailure(error, 'finish')
      throw new WebError('Vercel AI Gateway stream failed: ' + errorMessage(error), 'WEB_PROVIDER_ERROR', { cause: error })
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}