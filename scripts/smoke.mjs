/**
 * One real search and one real fetch against the configured gateway.
 *
 * Not part of the test suite: it needs a credential and the network, and it
 * reports timings that only matter when judging whether the gateway path is
 * still worth using.
 */
import { VercelFetchProvider } from '../src/fetch.js'
import { parseModels } from '../src/gateway.js'
import { VercelSearchProvider } from '../src/search.js'

/** The seam's error shape, so this script needs no harness import. */
class WebError extends Error {
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

const apiKey = process.env.AI_GATEWAY_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  console.error('AI_GATEWAY_API_KEY is not set; nothing to smoke-test.')
  process.exit(1)
}

/** @returns {import('../src/contracts.js').ProviderOptions} settings of one operation. */
const options = () => ({
  baseURL: process.env.AI_GATEWAY_BASE_URL ?? 'https://ai-gateway.vercel.sh/v4/ai/language-model',
  models: parseModels(process.env.AI_GATEWAY_MODEL ?? 'google/gemini-2.5-flash-lite, openai/gpt-4o-mini'),
  credentialRef: 'AI_GATEWAY_API_KEY',
  count: 3,
  maxOutputTokens: 2000,
  timeoutMs: 60000,
  WebError,
  resolveKey: async () => apiKey,
  keyConfigured: async () => true,
})

/**
 * A timer that reports its label when called.
 * @param {string} label what the timer measures.
 * @returns {() => void} a function that prints the elapsed time.
 */
const started = (label) => {
  const at = Date.now()
  return () => console.log(label + ' in ' + String(Date.now() - at) + 'ms')
}

const searchDone = started('search')
const search = await new VercelSearchProvider(options).search({ query: 'DeepSeek Harness dsh web search provider', maxResults: 3 })
searchDone()
console.log('  sources: ' + String(search.sources.length) + ', truncated: ' + String(search.truncated))
for (const source of search.sources) console.log('  - ' + source.url)

const fetchDone = started('fetch')
const page = await new VercelFetchProvider(options).fetch({ url: 'https://example.com' })
fetchDone()
console.log('  status: ' + String(page.statusCode) + ', characters: ' + String(page.body.content.length))
console.log('  head: ' + JSON.stringify(page.body.content.slice(0, 120)))
