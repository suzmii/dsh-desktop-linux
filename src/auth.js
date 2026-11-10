/**
 * Browser-session authentication for an externally started `dsh web`.
 *
 * `dsh web` prints a URL carrying a per-process launch token; opening it once
 * exchanges the token for a signed, authority-bound cookie. The shell cannot
 * read that token (it lives only in the terminal that started the server), so
 * it mints the same cookie directly from the persistent signing secret that the
 * dsh Host keeps in `$DSH_HOME/.credentials.yaml`.
 *
 * The cookie format mirrors `@deepseek-ai/dsh-client-connection`:
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, body))
 *   payload = { version: 1, authority, issuedAt, expiresAt }
 *
 * The dsh Host rejects a cookie whose lifetime exceeds its configured maximum
 * (30 days by default), so the minted lifetime stays below that.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Host-local cookie name prefix of the dsh web session cookie. */
export const COOKIE_PREFIX = 'dsh-auth-'
/** Payload version of the browser (as opposed to API) session cookie. */
export const BROWSER_COOKIE_VERSION = 1
/** Lifetime kept under the dsh default maximum of 30 days. */
export const COOKIE_LIFETIME_MS = 29 * 24 * 60 * 60 * 1000

/**
 * Resolve the dsh home directory.
 * @param {NodeJS.ProcessEnv} env - Environment supplying DSH_HOME/HOME.
 * @returns {string} Absolute dsh home.
 */
export function dshHome(env = process.env) {
  return env.DSH_HOME || join(env.HOME || homedir(), '.dsh')
}

/**
 * Path of the credentials file holding the browser-session signing secret.
 * @param {NodeJS.ProcessEnv} env - Environment supplying DSH_HOME/HOME.
 * @returns {string} Absolute credentials path.
 */
export function credentialsPath(env = process.env) {
  return join(dshHome(env), '.credentials.yaml')
}

/**
 * Extract the `client-connection/browser-session` secret from credentials YAML.
 *
 * The file is written by dsh as a small YAML document; only this one record is
 * needed, so a targeted scan avoids a YAML dependency.
 * @param {string} text - Credentials file contents.
 * @returns {Buffer | null} 32-byte signing secret, or `null` when absent/invalid.
 */
export function parseBrowserSessionSecret(text) {
  const lines = String(text).split(/\r?\n/u)
  const start = lines.findIndex(line => /^\s*(?:'|")?client-connection\/browser-session(?:'|")?\s*:\s*$/u.test(line))
  if (start === -1) return null
  const startIndent = (lines[start].match(/^\s*/u) ?? [''])[0].length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const indent = (line.match(/^\s*/u) ?? [''])[0].length
    if (indent <= startIndent && line.trim() !== '') break
    const match = line.match(/^\s*secret\s*:\s*(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/u)
    if (match === null) continue
    const encoded = match[1] ?? match[2] ?? match[3]
    if (encoded === undefined) return null
    const secret = decodeBase64Url(encoded)
    if (secret === null || secret.byteLength !== 32) return null
    return secret
  }
  return null
}

/**
 * Read the signing secret from a credentials file.
 * @param {NodeJS.ProcessEnv} env - Environment supplying DSH_HOME/HOME.
 * @returns {Promise<Buffer | null>} 32-byte secret, or `null` when unavailable.
 */
export async function readBrowserSessionSecret(env = process.env) {
  try {
    return parseBrowserSessionSecret(await readFile(credentialsPath(env), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Authority (host:port, default ports omitted) of a URL, as dsh binds cookies.
 * @param {string} url - Base URL.
 * @returns {string} Cookie audience.
 */
export function urlAuthority(url) {
  const parsed = new URL(url)
  return parsed.host
}

/**
 * Derive the session cookie name for one authority.
 * @param {string} authority - `host:port` audience.
 * @returns {string} Cookie name.
 */
export function sessionCookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/**
 * Mint one browser-session cookie value.
 * @param {Buffer} secret - 32-byte signing secret.
 * @param {{ authority: string, issuedAt?: number, lifetimeMs?: number }} options - Cookie audience and lifetime.
 * @returns {{ name: string, value: string, expiresAt: number, authority: string }} Cookie material.
 */
export function mintSessionCookie(secret, { authority, issuedAt, lifetimeMs = COOKIE_LIFETIME_MS }) {
  if (!Buffer.isBuffer(secret) || secret.byteLength !== 32) throw new Error('session secret must be 32 bytes')
  const issued = issuedAt ?? Date.now()
  const expiresAt = issued + lifetimeMs
  const body = encodeBase64Url(Buffer.from(JSON.stringify({
    version: BROWSER_COOKIE_VERSION,
    authority,
    issuedAt: issued,
    expiresAt,
  }), 'utf8'))
  const signature = createHmac('sha256', secret).update(body).digest()
  return {
    name: sessionCookieName(authority),
    value: `v${BROWSER_COOKIE_VERSION}.${body}.${encodeBase64Url(signature)}`,
    expiresAt,
    authority,
  }
}

/**
 * Verify a minted cookie value, mirroring the Host check (used by tests).
 * @param {string} value - Cookie value.
 * @param {Buffer} secret - 32-byte signing secret.
 * @returns {null | { version: number, authority: string, issuedAt: number, expiresAt: number }} Payload.
 */
export function verifySessionCookie(value, secret) {
  const parts = String(value).split('.')
  if (parts.length !== 3) return null
  const [version, body, encodedSignature] = parts
  const actual = decodeBase64Url(encodedSignature)
  if (actual === null) return null
  const expected = createHmac('sha256', secret).update(body).digest()
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return null
  const decoded = decodeBase64Url(body)
  if (decoded === null) return null
  let payload
  try {
    payload = JSON.parse(decoded.toString('utf8'))
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  if (payload.version !== Number(String(version).replace(/^v/u, ''))) return null
  const { authority, issuedAt, expiresAt } = payload
  if (typeof authority !== 'string' || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null
  return { version: payload.version, authority, issuedAt, expiresAt }
}

/** @param {Buffer|string} value - Bytes to encode. @returns {string} base64url text. */
export function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Strict base64url decoder.
 * @param {string} value - Encoded text.
 * @returns {Buffer | null} Decoded bytes, or `null` when malformed.
 */
export function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return null
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : null
}
