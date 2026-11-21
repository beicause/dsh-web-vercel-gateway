/**
 * Credential access for the gateway providers, through the harness credential
 * service and, without that service, the launch environment.
 *
 * Resolution is per operation and never cached: the credential store publishes
 * changes live, so a key edited while the harness runs reaches the next search
 * or fetch without a restart.
 * @module dsh-web-vercel-gateway/credential
 */

import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

/**
 * @typedef {import('@deepseek-ai/cordis').Context} Context
 */

/**
 * Read one credential reference's value.
 * @param {Context} ctx context providing the optional credential service.
 * @param {string} ref the reference to resolve.
 * @returns {Promise<string | undefined>} the value, or undefined when the reference has none.
 */
export async function resolveGatewayKey(ctx, ref) {
  if (!isCredentialRefName(ref)) return undefined
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(credentialRef(ref))
    const value = resolved === undefined ? undefined : resolved.value
    return value === undefined || value.length === 0 ? undefined : value
  }
  const ambient = launchEnvironmentOf(ctx).get(ref)
  return ambient === undefined || ambient.value.length === 0 ? undefined : ambient.value
}

/**
 * Report whether a credential reference has a value, without reading it into
 * this process's memory where the store can answer on its own.
 * @param {Context} ctx context providing the optional credential service.
 * @param {string} ref the reference to inspect.
 * @returns {Promise<boolean>} whether a value is configured; a store failure rejects.
 */
export async function gatewayKeyConfigured(ctx, ref) {
  if (!isCredentialRefName(ref)) return false
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) return (await credentials.describe(credentialRef(ref))).configured
  return (launchEnvironmentOf(ctx).get(ref)?.value.length ?? 0) > 0
}
