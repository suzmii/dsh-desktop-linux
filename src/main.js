/**
 * DSH Desktop (Linux) — attaches to a dsh web server you started yourself.
 *
 * The shell is intentionally thin: it never spawns, owns, or reconfigures dsh.
 * Startup is: discover a listening `dsh ... web` process → prove access with a
 * minted browser-session cookie → host that URL in a native window. Everything
 * else (tray, autostart, reconnect, zoom/bounds memory) is shell-local state
 * under `$XDG_CONFIG_HOME/dsh-desktop-linux`.
 */
import { BrowserWindow, Menu, Notification, app, clipboard, dialog, ipcMain, nativeImage, screen, session, shell as electronShell } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_URL, configPath, loadConfig, normalizeBaseUrl, sameOrigin, saveConfig } from './config.js'
import { credentialsPath, mintSessionCookie, readBrowserSessionSecret, urlAuthority } from './auth.js'
import { discoverDshWebUrls, probeDshWeb } from './discovery.js'
import { resolveTarget } from './attach.js'
import { setAutostart } from './autostart.js'
import { cleanPairingUrl, normalizePairingUrl, pairingQrSvg } from './pair.js'
import { parseArguments } from './args.js'
import { buildApplicationMenu } from './menu.js'
import { createTray } from './tray.js'
import { log, logPath } from './log.js'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const uiDirectory = join(here, 'ui')
const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(projectRoot, 'build', 'icon.png')

/** Retry interval while no dsh web server answers. */
const RETRY_INTERVAL_MS = 8000
/** Debounce for persisting window geometry. */
const GEOMETRY_DEBOUNCE_MS = 600

const state = {
  /** @type {ReturnType<typeof loadConfig> | null} */
  config: null,
  /** @type {BrowserWindow | null} */
  win: null,
  /** @type {{ tray: import('electron').Tray, refresh: () => void } | null} */
  tray: null,
  /** @type {BrowserWindow | null} */
  panel: null,
  /** @type {{ url: string, authenticated: boolean } | null} */
  target: null,
  /** @type {{ url: string, error: string | null }[]} */
  lastProbes: [],
  unavailable: false,
  retrying: false,
  retryAttempt: 0,
  /** @type {NodeJS.Timeout | null} */
  retryTimer: null,
  /** @type {NodeJS.Timeout | null} */
  geometryTimer: null,
  /** @type {NodeJS.Timeout | null} */
  zoomTimer: null,
  quitRequested: false,
  hiddenAtStartup: false,
  firstHideNoticeShown: false,
}

/* ── CLI options ────────────────────────────────────────────────────────── */

const options = parseArguments(process.argv.slice(1))

/* ── Configuration ──────────────────────────────────────────────────────── */

/** Persist the in-memory configuration. */
async function persistConfig() {
  try {
    state.config = await saveConfig(state.config)
  } catch (error) {
    await log(`config save failed: ${String(error)}`)
  }
}

/* ── Window ─────────────────────────────────────────────────────────────── */

/** Show and focus the main window. */
function showWindow() {
  if (state.win === null) return
  state.hiddenAtStartup = false
  if (state.win.isMinimized()) state.win.restore()
  state.win.show()
  state.win.focus()
  refreshShellChrome()
}

/** Hide the main window while the process keeps running. */
function hideWindow() {
  state.win?.hide()
  refreshShellChrome()
}

/** @returns {boolean} Whether the main window is currently visible. */
function isWindowVisible() {
  return state.win?.isVisible() ?? false
}

/**
 * Restore saved geometry, clamped to a currently attached display.
 * @param {ReturnType<typeof loadConfig>} config - Shell configuration.
 * @returns {Electron.BrowserWindowConstructorOptions} Window options.
 */
function windowOptions(config) {
  /** @type {Electron.BrowserWindowConstructorOptions} */
  const bounds = { width: 1440, height: 900 }
  if (config.window !== null) {
    const saved = config.window
    const visible = screen.getAllDisplays().some((display) => (
      saved.x < display.bounds.x + display.bounds.width
      && saved.x + saved.width > display.bounds.x
      && saved.y < display.bounds.y + display.bounds.height
      && saved.y + saved.height > display.bounds.y
    ))
    if (visible) {
      bounds.x = saved.x
      bounds.y = saved.y
    }
    bounds.width = saved.width
    bounds.height = saved.height
  }
  if (options.size !== null) {
    bounds.width = options.size.width
    bounds.height = options.size.height
  }
  return {
    ...bounds,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'DSH Desktop',
    backgroundColor: '#151517',
    icon: iconPath,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  }
}

/** Create the main window and wire navigation, close, and geometry behaviour. */
function createWindow() {
  const win = new BrowserWindow(windowOptions(state.config))
  state.win = win

  win.once('ready-to-show', () => {
    if (!state.hiddenAtStartup) win.show()
    if (state.config.window?.maximized === true) win.maximize()
  })

  win.on('close', (event) => {
    if (state.quitRequested) return
    if (state.config.closeToTray && state.tray !== null) {
      event.preventDefault()
      hideWindow()
      notifyFirstHide()
    } else {
      app.quit()
    }
  })

  win.on('resize', scheduleGeometrySave)
  win.on('move', scheduleGeometrySave)
  win.on('maximize', scheduleGeometrySave)
  win.on('unmaximize', scheduleGeometrySave)
  win.on('show', refreshShellChrome)
  win.on('hide', refreshShellChrome)

  win.webContents.on('will-navigate', (event, url) => {
    if (state.target !== null && sameOrigin(url, state.target.url)) return
    event.preventDefault()
    void openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('zoom-changed', scheduleZoomSave)
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return
    void log(`did-fail-load ${errorCode} ${errorDescription} ${validatedUrl}`)
    if (!state.unavailable) void onNavigationFailed()
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  return win
}

/** Show the one-time "still running in the tray" notice. */
function notifyFirstHide() {
  if (state.firstHideNoticeShown) return
  state.firstHideNoticeShown = true
  try {
    new Notification({
      title: 'DSH Desktop 仍在托盘运行',
      body: '任务不会中断；点托盘图标可重新打开窗口，右键托盘菜单可退出。',
      icon: nativeImage.createFromPath(iconPath),
    }).show()
  } catch (error) {
    void log(`notification failed: ${String(error)}`)
  }
}

/** Debounced window geometry persistence. */
function scheduleGeometrySave() {
  if (state.geometryTimer !== null) clearTimeout(state.geometryTimer)
  state.geometryTimer = setTimeout(() => {
    state.geometryTimer = null
    if (state.win === null || state.win.isDestroyed() || state.win.isFullScreen()) return
    const maximized = state.win.isMaximized()
    const bounds = maximized && state.config.window !== null
      ? { x: state.config.window.x, y: state.config.window.y, width: state.config.window.width, height: state.config.window.height }
      : state.win.getBounds()
    state.config.window = { ...bounds, maximized }
    void persistConfig()
  }, GEOMETRY_DEBOUNCE_MS)
}

/** Debounced page-zoom persistence. */
function scheduleZoomSave() {
  if (state.zoomTimer !== null) clearTimeout(state.zoomTimer)
  state.zoomTimer = setTimeout(() => {
    state.zoomTimer = null
    if (state.win === null || state.win.isDestroyed()) return
    const factor = state.win.webContents.getZoomFactor()
    if (!Number.isFinite(factor) || Math.abs(factor - state.config.zoom) < 0.001) return
    state.config.zoom = factor
    void persistConfig()
  }, 400)
}

/* ── Attach ─────────────────────────────────────────────────────────────── */

/**
 * Candidate URLs in priority order: CLI override, configured URL, discovered
 * dsh listeners, then the stock `dsh web` default.
 * @returns {Promise<string[]>} Candidate base URLs.
 */
async function collectCandidates() {
  const candidates = []
  if (options.url !== null) {
    const normalized = normalizeBaseUrl(options.url)
    if (normalized !== null) candidates.push(normalized)
  }
  if (state.config.url !== null) candidates.push(state.config.url)
  try {
    candidates.push(...await discoverDshWebUrls())
  } catch (error) {
    await log(`discovery failed: ${String(error)}`)
  }
  candidates.push(DEFAULT_URL)
  return [...new Set(candidates)]
}

/**
 * Install the minted session cookie for one target authority.
 * @param {string} url - Target base URL.
 * @param {{ name: string, value: string, expirationDate?: number } | null} cookie - Cookie material.
 * @returns {Promise<void>} Completion.
 */
async function installCookie(url, cookie) {
  if (cookie === null) return
  try {
    await session.defaultSession.cookies.set({
      url,
      name: cookie.name,
      value: cookie.value,
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: cookie.expirationDate,
    })
  } catch (error) {
    await log(`cookie install failed: ${String(error)}`)
  }
}

/**
 * Load a resolved target into the main window and surface the result.
 * @param {{ url: string, cookie: { name: string, value: string, expirationDate?: number } | null, authenticated?: boolean }} target - Accepted target.
 * @returns {Promise<boolean>} Whether the page loaded.
 */
async function applyTarget(target) {
  const win = state.win
  if (win === null) return false
  await installCookie(target.url, target.cookie)
  state.unavailable = false
  state.retryAttempt = 0
  state.lastProbes = []
  stopRetryTimer()
  try {
    await win.loadURL(target.url)
  } catch (error) {
    await log(`load failed ${target.url}: ${String(error)}`)
    return false
  }
  if (win.isDestroyed()) return false
  win.webContents.setZoomFactor(state.config.zoom)
  state.target = { url: target.url, authenticated: target.authenticated !== false }
  win.setTitle('DSH Desktop')
  if (!state.hiddenAtStartup) win.show()
  refreshShellChrome()
  await log(`attached ${target.url}`)

  if (target.authenticated === false) {
    await showAuthRequired()
  }
  return true
}

/**
 * Attach to an already-running dsh web server.
 * @param {{ reason?: string, silent?: boolean }} [context] - Call context.
 * @returns {Promise<boolean>} Whether a server was attached.
 */
async function attach({ reason = 'startup', silent = false } = {}) {
  if (state.config === null) return false
  if (state.retrying) return false
  state.retrying = true
  try {
    const candidates = await collectCandidates()
    const secret = state.config.autoAuth ? await readBrowserSessionSecret() : null
    const resolved = await resolveTarget({ candidates, secret, autoAuth: state.config.autoAuth })
    await log(`attach(${reason}): ${resolved.ready ? `ready ${resolved.url}` : `failed (${resolved.kind}) ${candidates.join(', ')}`}`)

    if (resolved.ready) {
      const applied = await applyTarget(resolved)
      if (applied) return true
      await showUnavailable([{ url: resolved.url, error: 'load-failed' }])
      return false
    }
    if (resolved.kind === 'auth-required') {
      state.target = null
      await showAuthRequired()
      return false
    }
    const probes = resolved.probes
    if (state.unavailable && silent) {
      state.lastProbes = probes
      notifyRetryStatus(`第 ${state.retryAttempt} 次重试：还没有找到回应 dsh 的本地端口。`)
      return false
    }
    await showUnavailable(probes)
    return false
  } finally {
    state.retrying = false
  }
}

/* ── Failure and auth UI ────────────────────────────────────────────────── */

/** @returns {number} Seconds until the next automatic retry. */
function retrySeconds() {
  return Math.round(RETRY_INTERVAL_MS / 1000)
}

/**
 * Push a retry status line to the unavailable page.
 * @param {string} message - Human-readable status.
 */
function notifyRetryStatus(message) {
  state.win?.webContents.send('shell:retry-status', {
    attempt: state.retryAttempt,
    nextRetryMs: RETRY_INTERVAL_MS,
    message,
  })
}

/** Start the periodic reconnect loop used while no server answers. */
function startRetryTimer() {
  stopRetryTimer()
  state.retryTimer = setInterval(() => {
    if (state.quitRequested) return
    state.retryAttempt += 1
    void attach({ reason: 'retry', silent: true })
  }, RETRY_INTERVAL_MS)
}

/** Stop the periodic reconnect loop. */
function stopRetryTimer() {
  if (state.retryTimer !== null) {
    clearInterval(state.retryTimer)
    state.retryTimer = null
  }
}

/**
 * Show the local "no server" page.
 * @param {{ url: string, error: string | null }[]} probes - Attempted candidates.
 * @returns {Promise<void>} Completion.
 */
async function showUnavailable(probes) {
  const win = state.win
  if (win === null || win.isDestroyed()) return
  state.unavailable = true
  state.target = null
  state.lastProbes = probes
  try {
    await win.loadFile(join(uiDirectory, 'unavailable.html'))
  } catch (error) {
    await log(`unavailable page failed: ${String(error)}`)
  }
  if (!win.isVisible() && !state.hiddenAtStartup) win.show()
  notifyRetryStatus(`正在自动重连（每 ${retrySeconds()} 秒一次）…`)
  startRetryTimer()
  refreshShellChrome()
}

/** Open the token prompt when automatic authentication did not suffice. */
async function showAuthRequired() {
  state.unavailable = true
  state.target = null
  try {
    await state.win?.loadFile(join(uiDirectory, 'unavailable.html'))
  } catch {
    // The panel below is still the useful surface.
  }
  if (state.win !== null && !state.win.isVisible()) state.win.show()
  openPanel('auth')
  startRetryTimer()
}

/**
 * Exchange a tokenized `dsh web:` URL for the session cookie, then remember the
 * clean URL. The token is never persisted.
 * @param {string} rawUrl - URL printed by dsh web (may carry `?token=`).
 * @returns {Promise<{ ok: boolean, error?: string }>} Result of the exchange.
 */
async function submitAuth(rawUrl) {
  if (state.win === null) return { ok: false, error: '窗口不可用' }
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, error: '地址格式不正确' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '只支持 http/https 地址' }
  }
  try {
    await state.win.loadURL(parsed.href)
  } catch {
    return { ok: false, error: '无法连接该地址' }
  }
  const text = await readPageHead()
  if (text.includes('dsh web authentication required')) {
    return { ok: false, error: '验证失败：token 无效，或该地址不是 dsh web' }
  }
  const clean = normalizeBaseUrl(state.win.webContents.getURL())
  if (clean === null) return { ok: false, error: 'dsh web 返回的地址无法解析' }
  state.config.url = clean
  state.target = { url: clean, authenticated: true }
  state.unavailable = false
  state.retryAttempt = 0
  stopRetryTimer()
  await persistConfig()
  closePanel()
  state.win.webContents.setZoomFactor(state.config.zoom)
  state.win.show()
  refreshShellChrome()
  await log(`token exchange ok ${clean}`)
  return { ok: true }
}

/** @returns {Promise<string>} First part of the hosted page's visible text. */
async function readPageHead() {
  if (state.win === null || state.win.isDestroyed()) return ''
  try {
    return await state.win.webContents.executeJavaScript(
      'document.body ? String(document.body.innerText || "").slice(0, 400) : ""',
      true,
    )
  } catch {
    return ''
  }
}

/** React to a main-frame load failure by falling back to the reconnect page. */
async function onNavigationFailed() {
  if (state.quitRequested || state.unavailable) return
  const url = state.target?.url ?? null
  if (url === null) return
  await log(`navigation failed, falling back to reconnect page for ${url}`)
  await showUnavailable([{ url, error: 'load-failed' }])
}

/* ── Panels (settings / auth) ───────────────────────────────────────────── */

/**
 * Open a modal panel page.
 * @param {'settings' | 'auth' | 'pair'} kind - Panel to show.
 */
function openPanel(kind) {
  closePanel()
  const parent = state.win ?? undefined
  const panel = new BrowserWindow({
    width: 620,
    height: kind === 'settings' ? 700 : kind === 'pair' ? 760 : 470,
    parent,
    modal: parent !== undefined,
    show: false,
    resizable: kind === 'settings',
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: kind === 'settings' ? 'DSH Desktop 设置' : kind === 'pair' ? '手机 / 平板配对' : '需要 dsh web 访问凭据',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  state.panel = panel
  panel.once('ready-to-show', () => panel.show())
  panel.on('closed', () => {
    if (state.panel === panel) state.panel = null
  })
  const page = kind === 'settings' ? 'settings.html' : kind === 'pair' ? 'pair.html' : 'auth.html'
  void panel.loadFile(join(uiDirectory, page))
}

/** Close the currently open panel, if any. */
function closePanel() {
  if (state.panel === null) return
  const panel = state.panel
  state.panel = null
  if (!panel.isDestroyed()) panel.close()
}

/* ── Shell chrome: menu + tray ──────────────────────────────────────────── */

/**
 * Apply one settings change and persist it.
 * @param {object} patch - Fields to change.
 * @returns {Promise<void>} Completion.
 */
async function applyConfigPatch(patch) {
  state.config = { ...state.config, ...patch }
  await persistConfig()
  refreshShellChrome()
}

/** Rebuild the application menu and tray menu so checkboxes reflect state. */
function refreshShellChrome() {
  if (state.config === null) return
  const actions = {
    reconnect: () => { void attach({ reason: 'menu' }) },
    openSettings: () => openPanel('settings'),
    openPairing: () => openPanel('pair'),
    openInBrowser: () => { void openInBrowser() },
    openLogs: () => { void electronShell.openPath(logPath()) },
    quit: () => quitApp(),
    launchAtLogin: state.config.launchAtLogin,
    setLaunchAtLogin: (enabled) => { void toggleAutostart(enabled) },
    about: () => { void showAbout() },
  }
  Menu.setApplicationMenu(buildApplicationMenu(actions))
  state.tray?.refresh()
}

/** Create the tray icon, tolerating desktops without a tray implementation. */
function createShellTray() {
  try {
    state.tray = createTray({
      iconPath,
      actions: {
        isWindowVisible,
        showWindow,
        hideWindow,
        reconnect: () => { void attach({ reason: 'tray' }) },
        openSettings: () => openPanel('settings'),
        openPairing: () => openPanel('pair'),
        openInBrowser: () => { void openInBrowser() },
        quit: () => quitApp(),
        launchAtLogin: state.config.launchAtLogin,
        setLaunchAtLogin: (enabled) => { void toggleAutostart(enabled) },
      },
    })
  } catch (error) {
    state.tray = null
    void log(`tray unavailable: ${String(error)}`)
  }
}

/**
 * Enable or disable the XDG autostart entry.
 * @param {boolean} enabled - Desired state.
 * @returns {Promise<void>} Completion.
 */
async function toggleAutostart(enabled) {
  try {
    await setAutostart(enabled, {
      exec: app.isPackaged ? [process.execPath, '--hidden'] : [process.execPath, projectRoot, '--hidden'],
      icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : iconPath,
    })
    await applyConfigPatch({ launchAtLogin: enabled })
  } catch (error) {
    await log(`autostart failed: ${String(error)}`)
    dialog.showErrorBox('无法修改开机自启', String(error))
  }
}

/* ── Shell actions ──────────────────────────────────────────────────────── */

/** Open the current target in the system browser. */
async function openInBrowser() {
  if (state.target === null) {
    await dialog.showMessageBox({
      type: 'info',
      title: '还没有连接',
      message: '当前没有已连接的 dsh web',
      detail: '先启动 dsh web 并让壳连上，或使用「重新连接」。',
    })
    return
  }
  await electronShell.openExternal(state.target.url)
}

/**
 * Open a URL outside the hosted origin without the shell session.
 * @param {string} url - Destination.
 * @returns {Promise<void>} Completion.
 */
async function openExternal(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      await electronShell.openExternal(url)
    }
  } catch {
    // Ignore malformed navigation targets.
  }
}

/** Show the About dialog with the shell and target facts. */
async function showAbout() {
  await dialog.showMessageBox(state.win ?? undefined, {
    type: 'info',
    title: '关于 DSH Desktop (Linux)',
    message: `DSH Desktop (Linux) ${app.getVersion()}`,
    detail: [
      '一个只连接已运行 dsh web 的轻量壳，不打包、不启动 dsh。',
      `目标：${state.target?.url ?? '尚未连接'}`,
      `配置：${configPath()}`,
      `dsh 凭据：${credentialsPath()}`,
      `日志：${logPath()}`,
    ].join('\n'),
    buttons: ['好'],
  })
}

/** Quit the whole application (window close may only hide). */
function quitApp() {
  state.quitRequested = true
  stopRetryTimer()
  app.quit()
}

/* ── IPC ────────────────────────────────────────────────────────────────── */

/**
 * Accept IPC only from the shell's own local pages.
 * @param {Electron.IpcMainEvent | Electron.IpcMainInvokeEvent} event - IPC event.
 * @returns {boolean} Whether the sender is a shell page.
 */
function isShellSender(event) {
  const url = event.senderFrame?.url ?? ''
  return url.startsWith('file:///') && /\/ui\/(settings|auth|pair|unavailable)\.html$/u.test(url)
}

/**
 * Build the state payload the shell pages read.
 * @returns {Promise<object>} Shell state.
 */
async function shellState() {
  return {
    config: state.config,
    target: state.target,
    version: app.getVersion(),
    configPath: configPath(),
    credentialsPath: credentialsPath(),
    credentialsAvailable: (await readBrowserSessionSecret()) !== null,
    probes: state.lastProbes,
  }
}

/** Register IPC handlers used by the local shell pages. */
function registerIpc() {
  ipcMain.handle('shell:state', async (event) => (isShellSender(event) ? shellState() : null))
  ipcMain.handle('shell:save-settings', async (event, value) => {
    if (!isShellSender(event)) return { ok: false, error: '未授权' }
    let url = null
    if (typeof value?.url === 'string' && value.url.trim() !== '') {
      const raw = value.url.trim()
      let hasToken = false
      try {
        hasToken = new URL(raw).searchParams.has('token')
      } catch {
        return { ok: false, error: '地址格式不正确（需要 http:// 或 https://）' }
      }
      if (hasToken) {
        const exchanged = await submitAuth(raw)
        if (!exchanged.ok) return { ok: false, error: exchanged.error }
        url = state.config.url
      } else {
        url = normalizeBaseUrl(raw)
        if (url === null) return { ok: false, error: '地址格式不正确（需要 http:// 或 https://）' }
      }
    }
    await applyConfigPatch({
      url,
      autoAuth: value?.autoAuth === true,
      closeToTray: value?.closeToTray === true,
      startHidden: value?.startHidden === true,
    })
    if (typeof value?.launchAtLogin === 'boolean' && value.launchAtLogin !== state.config.launchAtLogin) {
      await toggleAutostart(value.launchAtLogin)
    }
    closePanel()
    await attach({ reason: 'settings' })
    return { ok: true }
  })
  ipcMain.handle('shell:detect', async (event) => {
    if (!isShellSender(event)) return { candidates: [], error: '未授权' }
    try {
      const discovered = await discoverDshWebUrls()
      const secret = await readBrowserSessionSecret()
      const candidates = []
      for (const url of discovered) {
        const cookie = secret === null ? null : mintSessionCookie(secret, { authority: urlAuthority(url) })
        const result = await probeDshWeb(url, cookie === null ? {} : { cookie: `${cookie.name}=${cookie.value}` })
        if (result.isDsh) candidates.push(url)
      }
      return { candidates, error: null }
    } catch (error) {
      return { candidates: [], error: String(error) }
    }
  })
  ipcMain.handle('shell:submit-auth', async (event, url) => {
    if (!isShellSender(event)) return { ok: false, error: '未授权' }
    return submitAuth(String(url))
  })
  ipcMain.handle('pair:generate', async (event, rawUrl) => {
    if (!isShellSender(event)) return { ok: false, error: '未授权' }
    const url = normalizePairingUrl(String(rawUrl))
    if (url === null) return { ok: false, error: '请粘贴 dsh 打印的 http(s) 地址' }
    if (!new URL(url).searchParams.has('token')) return { ok: false, error: '这个地址没有 token；配对地址必须带 ?token=…' }
    try {
      const svg = await pairingQrSvg(url)
      return { ok: true, url, svg, cleanUrl: cleanPairingUrl(url) }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })
  ipcMain.handle('pair:copy', (event, text) => {
    if (!isShellSender(event)) return false
    clipboard.writeText(String(text))
    return true
  })
  ipcMain.on('shell:retry', (event) => {
    if (!isShellSender(event)) return
    void attach({ reason: 'retry' })
  })
  ipcMain.on('shell:open-settings', (event) => {
    if (!isShellSender(event)) return
    openPanel('settings')
  })
  ipcMain.on('shell:open-logs', (event) => {
    if (!isShellSender(event)) return
    void electronShell.openPath(logPath())
  })
  ipcMain.on('shell:quit', (event) => {
    if (!isShellSender(event)) return
    quitApp()
  })
  ipcMain.on('panel:close', (event) => {
    if (!isShellSender(event)) return
    closePanel()
  })
}

/* ── Session policy ─────────────────────────────────────────────────────── */

/** Allow only the hosted dsh origin to use browser capabilities it needs. */
function configureSession() {
  const trusted = () => state.target !== null
  const allowed = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'media', 'fullscreen', 'pointerLock'])
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    if (trusted() && allowed.has(permission)) callback(true)
    else callback(false)
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => trusted() && allowed.has(permission))
  session.defaultSession.on('will-download', (event, item) => {
    const suggested = item.getFilename() || 'download'
    const savePath = dialog.showSaveDialogSync(state.win ?? undefined, { defaultPath: suggested })
    if (savePath === undefined) {
      event.preventDefault()
      item.cancel()
      return
    }
    item.setSavePath(savePath)
  })
}

/* ── Startup ────────────────────────────────────────────────────────────── */

/** Smoke mode used by the verification script: attach, capture, exit. */
async function runSmoke() {
  const shot = process.env.DSH_DESKTOP_SMOKE_SHOT
  if (shot === undefined || shot === '') return
  const ok = await attach({ reason: 'smoke' })
  await new Promise(resolve => setTimeout(resolve, Number(process.env.DSH_DESKTOP_SMOKE_DELAY_MS ?? 6000)))
  let text = null
  try {
    const image = await state.win.webContents.capturePage()
    await mkdir(dirname(shot), { recursive: true })
    await writeFile(shot, image.toPNG())
    text = (await readPageHead()).slice(0, 160)
  } catch (error) {
    await log(`smoke capture failed: ${String(error)}`)
  }
  process.stdout.write(`${JSON.stringify({
    ok,
    title: state.win?.getTitle() ?? null,
    url: state.win?.webContents.getURL() ?? null,
    text,
  })}\n`)
  app.exit(ok ? 0 : 1)
}

/** Boot the shell. */
async function main() {
  app.setName('DSH Desktop')
  state.config = await loadConfig()
  state.hiddenAtStartup = options.hidden || state.config.startHidden
  configureSession()
  registerIpc()
  createWindow()
  createShellTray()
  refreshShellChrome()
  await log(`shell start ${app.getVersion()} hidden=${String(state.hiddenAtStartup)}`)

  app.on('before-quit', () => {
    state.quitRequested = true
    stopRetryTimer()
  })
  app.on('window-all-closed', () => {
    if (!state.quitRequested && state.config.closeToTray === false) app.quit()
  })
  app.on('second-instance', () => showWindow())

  if (process.env.DSH_DESKTOP_SMOKE_SHOT !== undefined) {
    await runSmoke()
    return
  }
  await attach({ reason: 'startup' })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(main).catch(async (error) => {
    await log(`fatal startup error: ${String(error)}`)
    dialog.showErrorBox('DSH Desktop 启动失败', String(error))
    app.exit(1)
  })
}
