/**
 * Mapping tests: the gateway payloads this plugin accepts and the ones it refuses.
 *
 * The seam's contract decides what a valid payload is, so every case here is
 * about whether a malformed answer becomes a described error rather than a
 * half-filled result the model would read as fact.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapFetchPayload } from '../src/fetch.js'
import { mapSearchPayload, searchCount } from '../src/search.js'

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

/**
 * One DeepSeek Search result item, with the fields this package ignores.
 * @param {Record<string, unknown>} [overrides] fields the case replaces.
 * @returns {Record<string, unknown>} the item.
 */
const item = (overrides = {}) => ({
  url: 'https://example.com/a',
  title: 'Example',
  snippet: 'A snippet.',
  summary: 'A summary.',
  date: '2026-11-01T16:00:00+00:00',
  authority: 3,
  rerank_score: 2.6,
  site_icon: 'https://cdn.example.com/icon.png',
  site_name: 'Example',
  content: '',
  ...overrides,
})

test('mapSearchPayload maps the fields the seam can express', () => {
  const result = mapSearchPayload({ results: [item()] }, FakeWebError)
  assert.deepEqual(result, {
    sources: [{
      url: 'https://example.com/a',
      title: 'Example',
      snippet: 'A snippet.',
      summary: 'A summary.',
      publishedAt: '2026-11-01T16:00:00+00:00',
    }],
    truncated: false,
  })
})

test('mapSearchPayload drops empty fields instead of reporting them', () => {
  const result = mapSearchPayload({ results: [item({ title: '', summary: '', date: null })] }, FakeWebError)
  assert.deepEqual(result.sources, [{ url: 'https://example.com/a', snippet: 'A snippet.' }])
})

test('mapSearchPayload keeps a url with a numeric fragment', () => {
  const result = mapSearchPayload({ results: [item({ url: 'https://example.com/a#1' })] }, FakeWebError)
  assert.equal(result.sources[0].url, 'https://example.com/a#1')
})

test('mapSearchPayload refuses a payload without a results array', () => {
  for (const payload of [undefined, null, {}, { results: {} }, { results: 'none' }]) {
    assert.throws(() => mapSearchPayload(payload, FakeWebError), (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR')
  }
})

test('mapSearchPayload refuses a result without a usable url', () => {
  for (const bad of [{}, { url: '' }, { url: 7 }, 'text', null]) {
    assert.throws(() => mapSearchPayload({ results: [bad] }, FakeWebError), (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR')
  }
})

test('mapSearchPayload names the offending index', () => {
  assert.throws(
    () => mapSearchPayload({ results: [item(), { url: '' }] }, FakeWebError),
    (/** @type {any} */ error) => error.message.includes('search result 1'),
  )
})

test('searchCount lowers to a request bound and clamps to the tool range', () => {
  assert.equal(searchCount(10, undefined), 10)
  assert.equal(searchCount(10, 3), 3)
  assert.equal(searchCount(10, 40), 10)
  assert.equal(searchCount(0, undefined), 1)
  assert.equal(searchCount(80, undefined), 50)
  assert.equal(searchCount(80, 500), 50)
})

test('mapFetchPayload returns page text as a 200 result', () => {
  const result = mapFetchPayload({ content: '# Title', title: 'Title' }, { url: 'https://example.com' }, FakeWebError, false)
  assert.deepEqual(result, {
    url: 'https://example.com',
    statusCode: 200,
    body: { kind: 'text', content: '# Title' },
    truncated: false,
  })
})

test('mapFetchPayload reports a flagged failure with a status as a result', () => {
  const payload = { error: 'api_error', message: 'DeepSeek could not retrieve usable page content', statusCode: 404 }
  const result = mapFetchPayload(payload, { url: 'https://example.com/missing' }, FakeWebError, true)
  assert.equal(result.statusCode, 404)
  assert.equal(result.body.content, 'DeepSeek could not retrieve usable page content')
})

test('mapFetchPayload throws for a flagged failure without a status', () => {
  assert.throws(
    () => mapFetchPayload({ message: 'upstream refused' }, { url: 'https://example.com' }, FakeWebError, true),
    (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR' && error.message.includes('upstream refused'),
  )
})

test('mapFetchPayload refuses a success without page text', () => {
  for (const payload of [{}, { content: 42 }, { content: null }]) {
    assert.throws(
      () => mapFetchPayload(payload, { url: 'https://example.com' }, FakeWebError, false),
      (/** @type {any} */ error) => error.code === 'WEB_PROVIDER_ERROR',
    )
  }
})

test('mapFetchPayload accepts an empty page body', () => {
  const result = mapFetchPayload({ content: '' }, { url: 'https://example.com' }, FakeWebError, false)
  assert.equal(result.body.content, '')
})