/**
 * Catalogue tests: which models a release may use, how many are tried, and what
 * happens when the gateway's answer is unusable.
 *
 * The catalogue is served by a local server, so nothing here needs a credential
 * or reaches the gateway.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { ModelCatalog, MAX_CANDIDATES, PREFERRED_MODELS, catalogURL, orderCandidates, parseCatalog } from '../src/catalog.js'

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
 * Serve a catalogue body at /v1/models.
 * @param {unknown} payload the body to answer with, or a status to fail with.
 * @param {number} [status] HTTP status to answer with.
 * @returns {Promise<{ baseURL: string, requests: number }>} the endpoint and how often it was asked.
 */
async function catalogServer(payload, status = 200) {
  const state = { requests: 0 }
  const server = createServer((request, response) => {
    request.resume()
    if (!request.url?.endsWith('/v1/models')) {
      response.writeHead(404).end('not the catalogue')
      return
    }
    state.requests += 1
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
  servers.push(server)
  await new Promise((/** @type {(value?: unknown) => void} */ resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the test server has no port')
  return {
    baseURL: 'http://127.0.0.1:' + String(address.port) + '/v4/ai/language-model',
    get requests() { return state.requests },
  }
}

/**
 * One catalogue entry.
 * @param {string} id the model id.
 * @param {{ type?: string, tags?: string[], input?: string, output?: string, deprecated?: number }} [spec] the fields this test sets.
 * @returns {Record<string, unknown>} the entry.
 */
const entry = (id, spec = {}) => {
  /** @type {Record<string, unknown>} */
  const model = {
    id,
    type: spec.type ?? 'language',
    tags: spec.tags ?? ['tool-use'],
    pricing: { input: spec.input ?? '0.0000001', output: spec.output ?? '0.0000004' },
  }
  if (spec.deprecated !== undefined) model.deprecated_at = spec.deprecated
  return model
}

/**
 * Settings one catalogue reads.
 * @param {string} baseURL endpoint whose origin carries the catalogue.
 * @returns {{ baseURL: string, timeoutMs: number, WebError: typeof FakeWebError }} the settings.
 */
const settingsFor = (baseURL) => ({ baseURL, timeoutMs: 5000, WebError: FakeWebError })

test('the catalogue keeps language models that advertise tool use', () => {
  const models = parseCatalog({
    data: [
      entry('vendor/tools'),
      entry('vendor/plain', { tags: [] }),
      entry('vendor/vision', { tags: ['vision'] }),
      entry('vendor/embedding', { type: 'embedding' }),
      entry('vendor/image', { type: 'image', tags: ['image-generation'] }),
      entry('vendor/retired', { deprecated: 1798434300000 }),
    ],
  })
  assert.deepEqual(models, ['vendor/tools'])
})

test('the catalogue drops entries it cannot address', () => {
  const models = parseCatalog({
    data: [
      { id: '', type: 'language', tags: ['tool-use'], pricing: { input: '0.1', output: '0.2' } },
      { type: 'language', tags: ['tool-use'], pricing: { input: '0.1', output: '0.2' } },
      'vendor/nope',
      entry('vendor/ok'),
    ],
  })
  assert.deepEqual(models, ['vendor/ok'])
})

test('the catalogue orders by price and keeps free models last', () => {
  const models = parseCatalog({
    data: [
      entry('vendor/free', { input: '0', output: '0' }),
      entry('vendor/dear', { input: '0.00001', output: '0.00003' }),
      entry('vendor/cheap', { input: '0.0000001', output: '0.0000004' }),
      entry('vendor/mid', { input: '0.000001', output: '0.000002' }),
    ],
  })
  assert.deepEqual(models, ['vendor/cheap', 'vendor/mid', 'vendor/dear', 'vendor/free'])
})

test('the catalogue puts the preferred models ahead of cheaper ones', () => {
  const models = parseCatalog({
    data: [
      entry('vendor/cheap', { input: '0.00000001' }),
      entry('openai/gpt-4o-mini', { input: '0.0000015' }),
      entry('google/gemini-2.5-flash-lite', { input: '0.0000001' }),
      entry('vendor/mid', { input: '0.000002' }),
    ],
  })
  assert.deepEqual(models, [
    'google/gemini-2.5-flash-lite',
    'openai/gpt-4o-mini',
    'vendor/cheap',
    'vendor/mid',
  ])
})

test('ordering keeps only the preferred models the catalogue still lists', () => {
  assert.deepEqual(
    orderCandidates(['a', 'b', 'c'], ['gone', 'c', 'a']),
    ['c', 'a', 'b'],
  )
  assert.deepEqual(orderCandidates(['a'], []), ['a'])
})

test('a catalogue that is not the gateway shape is an error', () => {
  assert.throws(() => parseCatalog({}), /data array/)
  assert.throws(() => parseCatalog([]), /data array/)
})

test('the catalogue endpoint sits beside the operation endpoint', () => {
  assert.equal(catalogURL('https://ai-gateway.vercel.sh/v4/ai/language-model'), 'https://ai-gateway.vercel.sh/v1/models')
  assert.equal(catalogURL('http://127.0.0.1:1234/v4/ai/language-model'), 'http://127.0.0.1:1234/v1/models')
})

test('the catalogue is fetched once and reused', async () => {
  const server = await catalogServer({ data: [entry('vendor/a'), entry('vendor/b')] })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  const first = await catalog.models()
  const second = await catalog.models()
  assert.deepEqual(first, ['vendor/a', 'vendor/b'])
  assert.deepEqual(second, first)
  assert.equal(server.requests, 1)
})

test('a refused model is skipped and the fetch is not repeated', async () => {
  const server = await catalogServer({ data: [entry('vendor/a'), entry('vendor/b'), entry('vendor/c')] })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  assert.deepEqual(await catalog.models(), ['vendor/a', 'vendor/b', 'vendor/c'])
  catalog.remember('vendor/a')
  assert.deepEqual(await catalog.models(), ['vendor/b', 'vendor/c'])
  catalog.remember('vendor/b')
  assert.deepEqual(await catalog.models(), ['vendor/c'])
  assert.equal(server.requests, 1)
})

test('a prefetch serves the first operation without fetching again', async () => {
  const server = await catalogServer({ data: [entry('vendor/a'), entry('vendor/b')] })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  catalog.warm()
  assert.deepEqual(await catalog.models(), ['vendor/a', 'vendor/b'])
  assert.equal(server.requests, 1)
})

test('a prefetch that fails leaves the lazy path intact', async () => {
  const catalog = new ModelCatalog(() => settingsFor('http://127.0.0.1:1/v4/ai/language-model'))
  catalog.warm()
  await assert.rejects(catalog.models(), /could not be read/)
})

test('a prefetch failure is not an unhandled rejection', async () => {
  const catalog = new ModelCatalog(() => settingsFor('http://127.0.0.1:1/v4/ai/language-model'))
  catalog.warm()
  await new Promise((/** @type {(value?: unknown) => void} */ resolve) => setTimeout(resolve, 100))
})

test('a prefetch does not refetch while its answer is fresh', async () => {
  const server = await catalogServer({ data: [entry('vendor/a')] })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  await catalog.models()
  catalog.warm()
  await catalog.models()
  assert.equal(server.requests, 1)
})

test('concurrent first asks share one fetch', async () => {
  const server = await catalogServer({ data: [entry('vendor/a'), entry('vendor/b')] })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  const answers = await Promise.all([catalog.models(), catalog.models(), catalog.models()])
  assert.equal(server.requests, 1)
  for (const answer of answers) assert.deepEqual(answer, ['vendor/a', 'vendor/b'])
})

test('one caller cancelling leaves the shared fetch for the others', async () => {
  const server = await catalogServer({ data: [entry('vendor/a')] })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  const controller = new AbortController()
  const cancelled = catalog.models(controller.signal)
  const surviving = catalog.models()
  controller.abort(new Error('caller went away'))
  await assert.rejects(cancelled, /caller went away/)
  assert.deepEqual(await surviving, ['vendor/a'])
  assert.equal(server.requests, 1)
})

test('an aborted signal rejects without asking the catalogue', async () => {
  const server = await catalogServer({ data: [entry('vendor/a')] })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  const controller = new AbortController()
  controller.abort(new Error('already gone'))
  await assert.rejects(catalog.models(controller.signal), /already gone/)
  assert.equal(server.requests, 0)
})

test('an answer that arrives after invalidate() is not cached', async () => {
  /** @type {(value?: unknown) => void} */
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })
  let served = 0
  const server = createServer((request, response) => {
    request.resume()
    served += 1
    const body = served === 1
      ? { data: [entry('vendor/old')] }
      : { data: [entry('vendor/new')] }
    Promise.resolve(gate).then(() => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })
  servers.push(server)
  await new Promise((/** @type {(value?: unknown) => void} */ resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const baseURL = 'http://127.0.0.1:' + String(address.port) + '/v4/ai/language-model'

  const catalog = new ModelCatalog(() => settingsFor(baseURL))
  const stale = catalog.models()
  catalog.invalidate()
  release()
  assert.deepEqual(await stale, ['vendor/old'])
  assert.deepEqual(await catalog.models(), ['vendor/new'])
  assert.equal(served, 2)
})

test('a cached answer keeps serving after its read settles', async () => {
  const server = await catalogServer({ data: [entry('vendor/a')] })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  await catalog.models()
  assert.deepEqual(await catalog.models(), ['vendor/a'])
  assert.equal(server.requests, 1)
})

test('invalidate() fetches again and forgets refusals', async () => {
  const server = await catalogServer({ data: [entry('vendor/a'), entry('vendor/b')] })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  await catalog.models()
  catalog.remember('vendor/a')
  catalog.invalidate()
  assert.deepEqual(await catalog.models(), ['vendor/a', 'vendor/b'])
  assert.equal(server.requests, 2)
})

test('the candidate list is capped', async () => {
  const many = Array.from({ length: MAX_CANDIDATES + 4 }, (_unused, index) => entry('vendor/m' + String(index)))
  const server = await catalogServer({ data: many })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  assert.equal((await catalog.models()).length, MAX_CANDIDATES)
})

test('every model refusing is an error that names the catalogue', async () => {
  const server = await catalogServer({ data: [entry('vendor/a')] })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  catalog.remember('vendor/a')
  await assert.rejects(
    catalog.models(),
    (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR'
      && error.message.includes('/v1/models')
      && error.message.includes('no usable model'),
  )
})

test('an unreachable catalogue names the endpoint and the way out', async () => {
  const catalog = new ModelCatalog(() => settingsFor('http://127.0.0.1:1/v4/ai/language-model'))
  await assert.rejects(
    catalog.models(),
    (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR'
      && error.message.includes('/v1/models')
      && error.message.includes('model setting'),
  )
})

test('a failing catalogue status is reported', async () => {
  const server = await catalogServer({ error: 'nope' }, 500)
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  await assert.rejects(catalog.models(), /HTTP 500/)
})

test('a body that is not JSON is reported', async () => {
  const server = await catalogServer('<html>not json</html>')
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  await assert.rejects(catalog.models(), /did not answer with JSON/)
})

test('a JSON body of the wrong shape is reported', async () => {
  const server = await catalogServer({ models: [] })
  const catalog = new ModelCatalog(() => settingsFor(server.baseURL))
  await assert.rejects(catalog.models(), /not the shape this provider reads/)
})

test('the preference list is a hint, not a requirement', () => {
  assert.ok(PREFERRED_MODELS.length > 0)
  assert.deepEqual(orderCandidates(['vendor/a'], PREFERRED_MODELS), ['vendor/a'])
})
