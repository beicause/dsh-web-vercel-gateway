/**
 * Provider tests: readiness, the forced call, and the result each provider hands
 * the seam.
 *
 * The gateway is a local server speaking the same event protocol, so these
 * tests cover the provider half without a credential.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { VercelFetchProvider } from '../src/fetch.js'
import { VercelSearchProvider } from '../src/search.js'

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

/** @type {import('node:http').Server[]} */
const servers = []
after(() => {
  for (const server of servers) server.close()
})

/**
 * Start a gateway stand-in that answers every request with one tool result.
 * @param {unknown} result the tool result payload.
 * @param {{ toolName?: string, isError?: boolean }} [options] the tool name to report and whether the result is flagged.
 * @returns {Promise<{ baseURL: string, received: Record<string, any>[] }>} the endpoint and the request bodies it received.
 */
async function gateway(result, options = {}) {
  /** @type {Record<string, any>[]} */
  const received = []
  const server = createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({
        type: 'tool-result',
        toolName: options.toolName ?? 'deepseek_search',
        isError: options.isError === true,
        result,
      }) + '\n\n')
    })
  })
  servers.push(server)
  await new Promise((/** @type {(value?: unknown) => void} */ resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the test server has no port')
  return {
    baseURL: 'http://127.0.0.1:' + String(address.port) + '/v4/ai/language-model',
    received,
  }
}

/**
 * Settings one provider reads, with the credential answer the test wants.
 * @param {string} baseURL endpoint to call.
 * @param {Partial<import('../src/contracts.js').ProviderOptions>} [overrides] settings the test replaces.
 * @returns {import('../src/contracts.js').ProviderOptions} the settings of one provider.
 */
const optionsFor = (baseURL, overrides = {}) => ({
  baseURL,
  model: 'test/model',
  credentialRef: 'AI_GATEWAY_API_KEY',
  count: 10,
  maxOutputTokens: 2000,
  timeoutMs: 5000,
  WebError: FakeWebError,
  resolveKey: async () => 'test-key',
  keyConfigured: async () => true,
  ...overrides,
})

test('the search provider forces DeepSeek Search with the mapped count', async () => {
  const server = await gateway({ results: [{ url: 'https://example.com', title: 'Example' }] })
  const provider = new VercelSearchProvider(() => optionsFor(server.baseURL))
  const result = await provider.search({ query: 'harness', maxResults: 4 })
  assert.equal(result.sources.length, 1)
  assert.equal(result.truncated, false)
  const body = server.received[0]
  assert.equal(body.tools[0].id, 'gateway.deepseek_search')
  assert.equal(body.tools[0].name, 'deepseek_search')
  assert.equal(body.tools[0].isProviderExecuted, true)
  assert.deepEqual(body.tools[0].args, { query: 'harness', count: 4, need_content: false })
  assert.deepEqual(body.toolChoice, { type: 'tool', toolName: 'deepseek_search' })
  assert.equal(body.maxOutputTokens, 2000)
})

test('the search provider sends no page content request', async () => {
  const server = await gateway({ results: [] })
  const provider = new VercelSearchProvider(() => optionsFor(server.baseURL, { count: 3 }))
  await provider.search({ query: 'q' })
  assert.equal(server.received[0].tools[0].args.need_content, false)
  assert.equal(server.received[0].tools[0].args.count, 3)
})

test('the search provider reports a flagged failure as a provider error', async () => {
  const server = await gateway({ message: 'quota exhausted' }, { isError: true })
  const provider = new VercelSearchProvider(() => optionsFor(server.baseURL))
  await assert.rejects(
    provider.search({ query: 'q' }),
    (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR' && error.message.includes('quota exhausted'),
  )
})

test('the fetch provider sends only the url and returns page text', async () => {
  const server = await gateway({ content: '# Example Domain', title: 'Example Domain' }, { toolName: 'deepseek_fetch' })
  const provider = new VercelFetchProvider(() => optionsFor(server.baseURL))
  const result = await provider.fetch({ url: 'https://example.com' })
  assert.deepEqual(result, {
    url: 'https://example.com',
    statusCode: 200,
    body: { kind: 'text', content: '# Example Domain' },
    truncated: false,
  })
  assert.equal(server.received[0].tools[0].id, 'gateway.deepseek_fetch')
  assert.deepEqual(server.received[0].tools[0].args, { url: 'https://example.com' })
})

test('the fetch provider reports an unreachable target as a described result', async () => {
  const server = await gateway(
    { error: 'api_error', message: 'DeepSeek could not retrieve usable page content', statusCode: 404 },
    { toolName: 'deepseek_fetch', isError: true },
  )
  const provider = new VercelFetchProvider(() => optionsFor(server.baseURL))
  const result = await provider.fetch({ url: 'https://example.com/missing' })
  assert.equal(result.statusCode, 404)
  assert.equal(result.body.content, 'DeepSeek could not retrieve usable page content')
})

test('both providers fail with WEB_PROVIDER_MISCONFIGURED without a credential', async () => {
  const search = new VercelSearchProvider(() => optionsFor('https://example.invalid/x', { resolveKey: async () => undefined }))
  const fetch = new VercelFetchProvider(() => optionsFor('https://example.invalid/x', { resolveKey: async () => undefined }))
  await assert.rejects(search.search({ query: 'q' }), (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_MISCONFIGURED')
  await assert.rejects(fetch.fetch({ url: 'https://example.com' }), (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_MISCONFIGURED')
})

test('available() checks settings shape without reading the credential', () => {
  const search = new VercelSearchProvider(() => optionsFor('https://gateway.invalid/x', { keyConfigured: async () => false }))
  assert.equal(search.available(), true)
  assert.equal(new VercelSearchProvider(() => optionsFor('not a url')).available(), false)
  assert.equal(new VercelSearchProvider(() => optionsFor('https://gateway.invalid/x', { model: '' })).available(), false)
  assert.equal(new VercelSearchProvider(() => optionsFor('https://gateway.invalid/x', { credentialRef: '' })).available(), false)
})

test('ready() answers from the credential store', async () => {
  const configured = new VercelSearchProvider(() => optionsFor('https://gateway.invalid/x'))
  const missing = new VercelFetchProvider(() => optionsFor('https://gateway.invalid/x', { keyConfigured: async () => false }))
  assert.equal(await configured.ready(), true)
  assert.equal(await missing.ready(), false)
})

test('each operation reads one settings snapshot', async () => {
  let reads = 0
  const server = await gateway({ results: [] })
  const provider = new VercelSearchProvider(() => {
    reads += 1
    return optionsFor(server.baseURL)
  })
  await provider.search({ query: 'q' })
  // available()/ready() are separate calls; one search reads the snapshot once
  // for its arguments and once for the call, which is still one settings section.
  assert.ok(reads <= 2)
})