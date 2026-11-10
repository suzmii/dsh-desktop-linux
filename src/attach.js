/**
 * Attach decision: pick a reachable dsh web server and prove access to it.
 *
 * The shell never starts, stops, or reconfigures dsh. It only decides which
 * already-running server to host, and whether the persisted browser-session
 * secret can mint a cookie for that authority.
 */
import { mintSessionCookie, urlAuthority } from './auth.js'
import { probeDshWeb } from './discovery.js'

/**
 * @typedef {object} ReadyTarget
 * @property {true} ready
 * @property {string} url - Clean base URL.
 * @property {{ name: string, value: string } | null} cookie - Cookie to install, if any.
 * @property {boolean} authenticated - True when the probe answered the authenticated index.
 *
 * @typedef {object} AuthRequiredTarget
 * @property {false} ready
 * @property {string} url
 * @property {'auth-required'} kind
 *
 * @typedef {object} MissingTarget
 * @property {false} ready
 * @property {'not-found'} kind
 * @property {{ url: string, error: string | null }[]} probes - Everything that was tried.
 */

/**
 * Try every candidate and return the first usable one.
 *
 * A candidate that answers the dsh 401 prompt is still a dsh web server: when
 * no candidate accepts the minted cookie, that URL is reported so the caller can
 * ask for the tokenized URL printed by `dsh web`.
 * @param {{ candidates: string[], secret?: Buffer | null, autoAuth?: boolean, probe?: typeof probeDshWeb }} options - Candidates and signing material.
 * @returns {Promise<ReadyTarget | AuthRequiredTarget | MissingTarget>} Resolution result.
 */
export async function resolveTarget({ candidates, secret = null, autoAuth = true, probe = probeDshWeb }) {
  const unique = [...new Set(candidates.filter(Boolean))]
  const probes = []
  let authRequired = null
  for (const url of unique) {
    const cookie = autoAuth && secret !== null ? mintSessionCookie(secret, { authority: urlAuthority(url) }) : null
    const result = await probe(url, cookie === null ? {} : { cookie: `${cookie.name}=${cookie.value}` })
    probes.push({ url, error: result.error ?? (result.status === null ? 'unreachable' : `status ${result.status}`) })
    if (result.isDsh && result.status === 200 && !result.needsAuth) {
      return {
        ready: true,
        url,
        cookie: cookie === null ? null : { name: cookie.name, value: cookie.value, expirationDate: cookie.expiresAt / 1000 },
        authenticated: true,
      }
    }
    if (result.needsAuth) {
      authRequired ??= { url, cookie }
      continue
    }
    if (result.isDsh && result.status !== null && result.status < 400) {
      return {
        ready: true,
        url,
        cookie: cookie === null ? null : { name: cookie.name, value: cookie.value, expirationDate: cookie.expiresAt / 1000 },
        authenticated: false,
      }
    }
  }
  if (authRequired !== null) return { ready: false, kind: 'auth-required', url: authRequired.url }
  return { ready: false, kind: 'not-found', probes }
}
