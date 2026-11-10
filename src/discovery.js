/**
 * Locate a dsh web server that is already running on this machine.
 *
 * Discovery is two-staged and read-only:
 *   1. `ss -H -tlnp` lists listening TCP sockets, and `/proc/<pid>/cmdline`
 *      tells whether a socket belongs to a `dsh ... web` process;
 *   2. a plain HTTP probe of the socket root (never through a proxy) checks
 *      whether it answers as a dsh web Host — either with the authenticated
 *      index or with the Host's 401 authentication prompt.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Body marker served by the dsh web index. */
const INDEX_MARKER = /__DSH_[A-Z_]+|--dsh-boot|DeepSeek Harness/u
/** Body served by the dsh Host when the browser cookie is missing. */
const UNAUTHORIZED_MARKER = /dsh web authentication required/u

/**
 * Parse `ss -H -tlnp` output into listening addresses.
 * @param {string} text - Command output.
 * @returns {{ host: string, port: number, pid: number | null, process: string | null }[]} Listeners.
 */
export function parseSsListeners(text) {
  const listeners = []
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line.includes('LISTEN')) continue
    const fields = line.trim().split(/\s+/u)
    const local = fields[3]
    if (local === undefined) continue
    const at = local.lastIndexOf(':')
    if (at === -1) continue
    const rawHost = local.slice(0, at)
    const port = Number(local.slice(at + 1))
    if (!Number.isInteger(port) || port <= 0) continue
    const pidMatch = line.match(/pid=(\d+)/u)
    const processMatch = line.match(/\(\("([^"]+)"/u)
    const pid = pidMatch === null ? null : Number(pidMatch[1])
    const process = processMatch === null ? null : processMatch[1]
    const host = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost
    if (host === '' || host === '*' || host === '0.0.0.0' || host === '::') {
      // Wildcard listeners answer on loopback too.
      listeners.push({ host: '127.0.0.1', port, pid, process })
      continue
    }
    listeners.push({ host, port, pid, process })
  }
  return listeners
}

/**
 * Decide whether a process command line is a dsh web host.
 * @param {string[]} argv - NUL-split argv of the process.
 * @returns {boolean} True for `dsh ... web` style hosts.
 */
export function looksLikeDshWeb(argv) {
  const args = argv.filter(Boolean)
  if (args.length === 0) return false
  if (!args.some(arg => arg === 'web' || arg.startsWith('web=') || arg.startsWith('web '))) return false
  const joined = args.join(' ')
  return /@deepseek-ai\/dsh|deepseek-harness|(?:^|[\\/])dsh(?:[\\/]|$)/u.test(joined)
}

/**
 * Build the base URL of one listener.
 * @param {{ host: string, port: number }} listener - Listening socket.
 * @returns {string} HTTP base URL.
 */
export function listenerUrl({ host, port }) {
  const bracketed = host.includes(':') ? `[${host}]` : host
  return `http://${bracketed}:${port}/`
}

/**
 * Probe one candidate and classify what answered.
 *
 * Uses `node:http` directly so the probe can never be routed through an
 * environment proxy: dsh binds a concrete interface and a proxied request
 * would answer for the wrong peer.
 * @param {string} url - Candidate base URL.
 * @param {{ cookie?: string, timeoutMs?: number }} [options] - Optional session cookie.
 * @returns {Promise<{ status: number | null, isDsh: boolean, needsAuth: boolean, error: string | null, bodyHead: string }>} Probe result.
 */
export function probeDshWeb(url, { cookie, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      resolve({ status: null, isDsh: false, needsAuth: false, error: 'invalid-url', bodyHead: '' })
      return
    }
    const headers = { accept: 'text/html,application/xhtml+xml' }
    if (cookie !== undefined) headers.cookie = cookie
    const request = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request({
      protocol: parsed.protocol,
      hostname: parsed.hostname.replace(/^\[|\]$/gu, ''),
      port: parsed.port,
      path: `${parsed.pathname === '' ? '/' : parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers,
      timeout: timeoutMs,
      // A self-signed local TLS listener would otherwise need trust management;
      // dsh web is plain HTTP by default and this shell never relaxes TLS.
      rejectUnauthorized: true,
    }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        if (size < 8192) {
          chunks.push(chunk)
          size += chunk.length
        }
      })
      res.on('end', () => {
        const bodyHead = Buffer.concat(chunks).toString('utf8').slice(0, 4096)
        const status = res.statusCode ?? null
        const isDsh = status !== null && (INDEX_MARKER.test(bodyHead) || UNAUTHORIZED_MARKER.test(bodyHead))
        resolve({
          status,
          isDsh,
          needsAuth: status === 401 && UNAUTHORIZED_MARKER.test(bodyHead),
          error: null,
          bodyHead,
        })
      })
      res.on('error', () => resolve({ status: null, isDsh: false, needsAuth: false, error: 'response-error', bodyHead: '' }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (error) => {
      resolve({ status: null, isDsh: false, needsAuth: false, error: error.code ?? error.message, bodyHead: '' })
    })
    req.end()
  })
}

/**
 * Read the command line of one process.
 * @param {number} pid - Process id.
 * @returns {Promise<string[]>} NUL-split argv, empty when unreadable.
 */
export async function readProcessArgv(pid) {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\u0000').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Discover local dsh web candidates from listening sockets.
 * @param {{ readArgv?: (pid: number) => Promise<string[]> }} [options] - Injection points for tests.
 * @returns {Promise<string[]>} Candidate base URLs, best effort, ordered by port.
 */
export async function discoverDshWebUrls({ readArgv = readProcessArgv } = {}) {
  let output = ''
  try {
    output = (await execFileAsync('ss', ['-H', '-tlnp'], { timeout: 4000 })).stdout
  } catch {
    return []
  }
  const matches = new Map()
  for (const listener of parseSsListeners(output)) {
    if (listener.pid === null) continue
    const argv = await readArgv(listener.pid)
    if (!looksLikeDshWeb(argv)) continue
    const url = listenerUrl(listener)
    if (!matches.has(url)) matches.set(url, listener.port)
  }
  return [...matches.entries()].sort((a, b) => a[1] - b[1]).map(([url]) => url)
}
