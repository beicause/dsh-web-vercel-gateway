/**
 * Gateway transport tests: one forced tool call over a local server that speaks
 * the gateway's server-sent-event protocol.
 *
 * The server is local so the tests exercise framing, early exit, and failure
 * classification without a credential or network access.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { callGateway, SEARCH_TOOL } from '../src/gateway.js'

/** The seam's error shape, reproduced so this module needs no harness import. */
class FakeWebError extends Error {
  /**
   * @param {string} message the failure message.
   * @param {string} code the machine-routable failure class.
   * @param {ErrorOptions} [options] the chained cause.
   */
  constructor(message, code, options) {
    super(message, options)
    this.code = code
  }
}

/** Servers started by a test, closed when the file finishes. */
/** @type {import('node:http').Server[]} */
const servers = []
after(() => {
  for (const server of servers) server.close()
})

/**
 * Start a server whose answer the handler writes.
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} handler
 *   receives the request and the response it answers on.
 * @returns {Promise<string>} the endpoint URL.
 */
async function serve(handler) {
  const server = createServer((request, response) => {
    request.resume()
    handler(request, response)
  })
  servers.push(server)
  await new Promise((/** @type {(value?: unknown) => void} */ resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the test server has no port')
  return 'http://127.0.0.1:' + String(address.port) + '/v4/ai/language-model'
}

/**
 * Options of one call against an endpoint.
 * @param {string} baseURL endpoint to call.
 * @param {Partial<import('../src/contracts.js').GatewayRequestOptions>} [overrides] settings the test replaces.
 * @returns {import('../src/contracts.js').GatewayRequestOptions} the options of one call.
 */
const optionsFor = (baseURL, overrides = {}) => ({
  baseURL,
  model: 'test/model',
  apiKey: 'test-key',
  credentialRef: 'AI_GATEWAY_API_KEY',
  count: 10,
  maxOutputTokens: 2000,
  timeoutMs: 5000,
  WebError: FakeWebError,
  ...overrides,
})

/**
 * One SSE frame.
 * @param {unknown} event the event to serialize.
 * @returns {string} the frame text.
 */
const frame = (event) => 'data: ' + JSON.stringify(event) + '\n\n'

/**
 * The tool-result frame a successful answer carries.
 * @param {unknown} [result] the tool's payload.
 * @returns {string} the frame text.
 */
const resultFrame = (result = { results: [] }) => frame({
  type: 'tool-result',
  toolName: 'deepseek_search',
  toolType: 'deepseek_search',
  toolCallId: 'call-1',
  isError: false,
  providerExecuted: true,
  result,
})

/**
 * Send an event stream answer.
 * @param {import('node:http').ServerResponse} response the response to stream on.
 * @returns {{ write(text: string): unknown, end(): void }} the stream writer.
 */
function stream(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  return {
    write: (text) => response.write(text),
    end: () => response.end(),
  }
}

test('reads a tool result split across arbitrary chunk boundaries', async () => {
  const payload = frame({ type: 'stream-start', warnings: [] }) + resultFrame({ results: [{ url: 'https://example.com' }] })
  const baseURL = await serve((_request, response) => {
    const out = stream(response)
    // Three bytes at a time splits frames, JSON payloads, and the blank line
    // that ends one, which is what a real socket does at a boundary.
    for (let index = 0; index < payload.length; index += 3) out.write(payload.slice(index, index + 3))
    out.end()
  })
  const event = await callGateway(optionsFor(baseURL), { tool: SEARCH_TOOL, args: { query: 'q' } })
  assert.equal(event.type, 'tool-result')
  assert.deepEqual(event.result, { results: [{ url: 'https://example.com' }] })
})

test('stops reading at the tool result instead of draining the answer', async () => {
  let closedEarly = false
  const baseURL = await serve((_request, response) => {
    const out = stream(response)
    out.write(resultFrame())
    // A real answer keeps narrating the result; the client must not wait for it.
    const timer = setInterval(() => out.write(frame({ type: 'text-delta', id: '0', delta: 'x' })), 20)
    response.on('close', () => {
      closedEarly = true
      clearInterval(timer)
    })
  })
  const started = Date.now()
  const event = await callGateway(optionsFor(baseURL), { tool: SEARCH_TOOL, args: { query: 'q' } })
  assert.equal(event.type, 'tool-result')
  assert.ok(Date.now() - started < 2000, 'the call returned without waiting for the trailing text')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(closedEarly, 'the unread rest of the answer was cancelled')
})

test('skips a frame it cannot parse', async () => {
  const baseURL = await serve((_request, response) => {
    const out = stream(response)
    out.write('data: {not json\n\n')
    out.write('data:\n\n')
    out.write(resultFrame())
    out.end()
  })
  const event = await callGateway(optionsFor(baseURL), { tool: SEARCH_TOOL, args: { query: 'q' } })
  assert.equal(event.type, 'tool-result')
})

test('ignores a tool result for another tool', async () => {
  const baseURL = await serve((_request, response) => {
    const out = stream(response)
    out.write(frame({ type: 'tool-result', toolName: 'deepseek_fetch', result: {} }))
    out.write(resultFrame())
    out.end()
  })
  const event = await callGateway(optionsFor(baseURL), { tool: SEARCH_TOOL, args: { query: 'q' } })
  assert.equal(event.toolName, 'deepseek_search')
})

test('names the credential on 401', async () => {
  const baseURL = await serve((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Authentication failed.', type: 'authentication_error' } }))
  })
  await assert.rejects(
    callGateway(optionsFor(baseURL), { tool: SEARCH_TOOL, args: { query: 'q' } }),
    (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR'
      && error.message.includes('AI_GATEWAY_API_KEY')
      && error.message.includes('Authentication failed.'),
  )
})

test('names the model on 404', async () => {
  const baseURL = await serve((_request, response) => {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: "Model 'test/model' not found", type: 'model_not_found' } }))
  })
  await assert.rejects(
    callGateway(optionsFor(baseURL), { tool: SEARCH_TOOL, args: { query: 'q' } }),
    (/** @type {any} */ error) => error.message.includes('test/model') && error.message.includes('gemini-2.5-flash-lite'),
  )
})

test('reports rate limiting on 429', async () => {
  const baseURL = await serve((_request, response) => {
    response.writeHead(429)
    response.end('slow down')
  })
  await assert.rejects(
    callGateway(optionsFor(baseURL), { tool: SEARCH_TOOL, args: { query: 'q' } }),
    (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR' && error.message.includes('rate-limited'),
  )
})

test('reports a stream that never ran the tool, naming the token floor', async () => {
  const baseURL = await serve((_request, response) => {
    const out = stream(response)
    out.write(frame({ type: 'text-delta', id: '0', delta: 'I cannot do that.' }))
    out.write(frame({ type: 'finish', finishReason: { unified: 'length', raw: 'MAX_TOKENS' } }))
    out.end()
  })
  await assert.rejects(
    callGateway(optionsFor(baseURL), { tool: SEARCH_TOOL, args: { query: 'q' } }),
    (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR'
      && error.message.includes('maxOutputTokens')
      && error.message.includes('2000')
      && error.message.includes('I cannot do that.')
      && error.message.includes('length'),
  )
})

test('reports a stream error frame', async () => {
  const baseURL = await serve((_request, response) => {
    const out = stream(response)
    out.write(frame({ type: 'error', error: { message: 'upstream exploded' } }))
    out.end()
  })
  await assert.rejects(
    callGateway(optionsFor(baseURL), { tool: SEARCH_TOOL, args: { query: 'q' } }),
    (/** @type {any} */ error) => error.message.includes('upstream exploded'),
  )
})

test('maps caller cancellation to WEB_ABORTED', async () => {
  const baseURL = await serve(() => {
    // Never answers: the caller's cancellation is the only way out.
  })
  const controller = new AbortController()
  const pending = callGateway(optionsFor(baseURL), { tool: SEARCH_TOOL, args: { query: 'q' } }, controller.signal)
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, (/** @type {any} */ error) => error.code === 'WEB_ABORTED')
})

test('rejects a signal aborted before the call', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    callGateway(optionsFor('http://127.0.0.1:1/unused'), { tool: SEARCH_TOOL, args: { query: 'q' } }, controller.signal),
    (/** @type {any} */ error) => error.code === 'WEB_ABORTED',
  )
})

test('maps its own timeout to a described failure, not a cancellation', async () => {
  const baseURL = await serve(() => {
    // Never answers, so the module's own timer is what ends the call.
  })
  await assert.rejects(
    callGateway(optionsFor(baseURL, { timeoutMs: 100 }), { tool: SEARCH_TOOL, args: { query: 'q' } }),
    (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR' && error.message.includes('100ms'),
  )
})

test('reports an unreachable endpoint', async () => {
  await assert.rejects(
    callGateway(optionsFor('http://127.0.0.1:1/v4/ai/language-model'), { tool: SEARCH_TOOL, args: { query: 'q' } }),
    (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR' && error.message.includes('request failed'),
  )
})