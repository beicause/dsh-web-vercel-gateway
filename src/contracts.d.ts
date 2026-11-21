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
 * importing it, so the instance they throw is the one the harness checks with
 * `instanceof`. The shape is structural rather than the seam's own class type,
 * which also lets the offline tests pass a local class and keep every harness
 * package out of their import graph.
 */
export type WebErrorConstructor = new (
  message: string,
  code: string,
  options?: ErrorOptions,
) => Error & { readonly code: string }

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

/**
 * Everything one gateway request needs except the credential value: endpoint,
 * model, the reference a diagnostic names, the token floor, the time bound, and
 * the seam's error class.
 */
export interface GatewayOptions {
  readonly baseURL: string
  readonly model: string
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
  readonly model: { get(): string }
  readonly apiKeyEnv: { get(): string }
  readonly count: { get(): number }
  readonly maxOutputTokens: { get(): number }
  readonly timeoutMs: { get(): number }
}
