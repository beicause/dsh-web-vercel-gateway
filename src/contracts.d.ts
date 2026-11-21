/**
 * Structural contracts shared by this package's modules.
 *
 * Most types live as JSDoc next to the code they describe. The ones collected
 * here are those JSDoc states poorly or that several modules must agree on: the
 * settings snapshot a provider reads, the shape of one forced tool call, and the
 * constructor type of the seam's error class, which crosses a module boundary as
 * a value rather than as an import.
 *
 * This is a declaration module: it holds no runtime code and is imported only
 * for its types, as `import('./contracts.js').X`.
 */

export type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/**
 * The seam's error class as a value: the providers receive it instead of
 * importing it, so the instance they throw belongs to the module instance the
 * harness checks with `instanceof`. Naming the seam's own class here rather
 * than a structural equivalent keeps that identity visible to the typechecker;
 * a test may still pass its own class, because the harness class has no private
 * members and a subclass with a `code` field is assignable to it.
 */
export type WebErrorConstructor = typeof import('@deepseek-ai/dsh-web').WebError

/** One provider-executed gateway tool: the gateway id and the name the model must call. */
export interface GatewayTool {
  readonly id: string
  readonly name: string
}

/** One forced tool call: which tool to run and the arguments it receives. */
export interface GatewayOperation {
  readonly tool: GatewayTool
  readonly args: Record<string, unknown>
}

/** What the catalogue needs from the live settings. */
export interface CatalogSettings {
  readonly baseURL: string
  readonly timeoutMs: number
  readonly WebError: WebErrorConstructor
}

/** The candidate source a request consults when no model is pinned. */
export interface ModelCatalog {
  /**
   * The candidate ids, cheapest first, without the ones this process saw refuse.
   * Reads the gateway catalogue when its cached answer is stale.
   */
  models(signal?: AbortSignal): Promise<readonly string[]>
  /** Stop choosing a model for the life of the cached catalogue. */
  remember(model: string): void
}

/**
 * Everything one gateway request needs except the credential value: endpoint,
 * the models to try in order, the reference a diagnostic names, the token
 * floor, the time bound, the catalogue to fall back on, and the seam's error
 * class.
 *
 * Models are a list because the gateway rate-limits per model: a refused model
 * leaves the next one with its own budget. An empty list means discovery, not a
 * misconfiguration, because the ids a release writes down go stale while the
 * catalogue does not.
 */
export interface GatewayOptions {
  readonly baseURL: string
  readonly models: readonly string[]
  readonly catalog: ModelCatalog
  readonly credentialRef: string
  readonly count: number
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  readonly WebError: WebErrorConstructor
}

/** A gateway request, once the credential has been resolved. */
export interface GatewayRequestOptions extends GatewayOptions {
  readonly apiKey: string
}

/** The settings one provider reads at each operation, resolved from live config. */
export interface ProviderOptions extends GatewayOptions {
  /** Read the credential value; undefined when the reference has none. */
  resolveKey(ref: string): Promise<string | undefined>
  /** Report whether the reference has a value, without reading it where the store can answer. */
  keyConfigured(ref: string): Promise<boolean>
}

/** The tool-result event the gateway sends once the forced tool has run. */
export interface ToolResultEvent {
  readonly type: string
  readonly toolName?: string
  readonly result?: unknown
  readonly isError?: boolean
}

/** A source under construction, before it is handed over as a readonly `WebSearchSource`. */
export interface MutableSource {
  url: string
  title?: string
  snippet?: string
  summary?: string
  publishedAt?: string
}

/**
 * The live settings section the plugin row carries. Each field is a volatile
 * accessor, so an edit applies to the next operation instead of remounting the
 * plugin.
 */
export interface GatewaySettings {
  readonly baseURL: { get(): string }
  /** One model id, or several separated by commas or spaces; the order is the retry order. */
  readonly model: { get(): string }
  readonly apiKeyEnv: { get(): string }
  readonly count: { get(): number }
  readonly maxOutputTokens: { get(): number }
  readonly timeoutMs: { get(): number }
}
