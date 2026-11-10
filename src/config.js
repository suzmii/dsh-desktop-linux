/**
 * Persistent shell configuration.
 *
 * The shell keeps its own state (target URL, window bounds, tray behaviour) in
 * `$XDG_CONFIG_HOME/dsh-desktop-linux/config.json`. It never writes to
 * `$DSH_HOME`: the dsh side stays exactly as the user installed it.
 */
import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const APP_DIR_NAME = 'dsh-desktop-linux'
export const CONFIG_VERSION = 1

/** Default target of a stock `dsh web` launch. */
export const DEFAULT_URL = 'http://127.0.0.1:3080/'

/** @returns {object} A fresh configuration object. */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    /** Clean base URL of the dsh web server, or `null` to auto-detect on every start. */
    url: null,
    /** Mint a browser-session cookie from the local dsh credentials before loading. */
    autoAuth: true,
    /** Keep running in the tray when the window is closed. */
    closeToTray: true,
    /** Start with the window hidden (tray only); used by the autostart entry. */
    startHidden: false,
    /** Register an XDG autostart entry. */
    launchAtLogin: false,
    /** Remembered page zoom factor. */
    zoom: 1,
    /** Last window geometry; `null` until the first move/resize. */
    window: null,
  }
}

/**
 * Absolute path of the shell configuration file.
 * @param {NodeJS.ProcessEnv} env - Environment supplying XDG_CONFIG_HOME/HOME.
 * @returns {string} Configuration path.
 */
export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config')
  return join(base, APP_DIR_NAME, 'config.json')
}

/**
 * Merge untrusted config input onto defaults, dropping anything malformed.
 * @param {unknown} raw - Parsed JSON from disk or IPC.
 * @returns {object} A safe configuration object.
 */
export function sanitizeConfig(raw) {
  const config = defaultConfig()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return config
  const value = /** @type {Record<string, unknown>} */ (raw)

  if (typeof value.url === 'string') {
    const url = normalizeBaseUrl(value.url)
    if (url !== null) config.url = url
  }
  for (const key of ['autoAuth', 'closeToTray', 'startHidden', 'launchAtLogin']) {
    if (typeof value[key] === 'boolean') config[key] = value[key]
  }
  if (typeof value.zoom === 'number' && Number.isFinite(value.zoom)) {
    config.zoom = Math.min(Math.max(value.zoom, 0.5), 3)
  }
  if (value.window !== null && typeof value.window === 'object' && !Array.isArray(value.window)) {
    const win = /** @type {Record<string, unknown>} */ (value.window)
    const numbers = ['x', 'y', 'width', 'height'].every(key => Number.isFinite(win[key]))
    if (numbers) {
      config.window = {
        x: Math.round(/** @type {number} */ (win.x)),
        y: Math.round(/** @type {number} */ (win.y)),
        width: Math.max(Math.round(/** @type {number} */ (win.width)), 640),
        height: Math.max(Math.round(/** @type {number} */ (win.height)), 480),
        maximized: win.maximized === true,
      }
    }
  }
  return config
}

/**
 * Validate and canonicalize a dsh web base URL.
 *
 * The token issued by `dsh web` is a launch credential: it is accepted once at
 * the root and must not be persisted. Any `token` query parameter is dropped
 * and the path keeps its trailing slash so the SPA resolves relative URLs.
 * @param {string} input - User-provided URL.
 * @returns {string | null} Canonical clean URL, or `null` when invalid.
 */
export function normalizeBaseUrl(input) {
  let url
  try {
    url = new URL(String(input).trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  url.searchParams.delete('token')
  if (url.search === '?') url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url.href
}

/**
 * Whether both URLs share scheme + host + port.
 * @param {string} left - First URL.
 * @param {string} right - Second URL.
 * @returns {boolean} True when in-app navigation should stay in the window.
 */
export function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

/**
 * Load the shell configuration, falling back to defaults on any read error.
 * @param {string} file - Configuration path.
 * @returns {Promise<object>} Sanitized configuration.
 */
export async function loadConfig(file = configPath()) {
  try {
    return sanitizeConfig(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return defaultConfig()
  }
}

/**
 * Atomically persist the shell configuration.
 * @param {object} config - Configuration to write (sanitized first).
 * @param {string} file - Configuration path.
 * @returns {Promise<object>} The sanitized configuration that was written.
 */
export async function saveConfig(config, file = configPath()) {
  const sanitized = sanitizeConfig(config)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
  return sanitized
}
