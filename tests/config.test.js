import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_URL,
  configPath,
  defaultConfig,
  loadConfig,
  normalizeBaseUrl,
  sameOrigin,
  sanitizeConfig,
  saveConfig,
} from '../src/config.js'

test('normalizeBaseUrl strips the launch token and keeps the path', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3080/?token=abc'), 'http://127.0.0.1:3080/')
  assert.equal(normalizeBaseUrl(' http://10.0.0.5:47827/ui?token=abc '), 'http://10.0.0.5:47827/ui/')
  assert.equal(normalizeBaseUrl('https://example.test/dsh'), 'https://example.test/dsh/')
})

test('normalizeBaseUrl rejects non-http and userinfo URLs', () => {
  assert.equal(normalizeBaseUrl('file:///etc/passwd'), null)
  assert.equal(normalizeBaseUrl('not a url'), null)
  assert.equal(normalizeBaseUrl('http://user:pass@127.0.0.1:3080/'), null)
  assert.equal(normalizeBaseUrl(''), null)
})

test('sanitizeConfig keeps valid fields and drops malformed ones', () => {
  const config = sanitizeConfig({
    version: 99,
    url: 'http://127.0.0.1:3080/?token=leak',
    autoAuth: false,
    closeToTray: 'yes',
    launchAtLogin: true,
    zoom: 99,
    window: { x: 10, y: 20, width: 1000, height: 700, maximized: true },
  })
  assert.equal(config.url, 'http://127.0.0.1:3080/')
  assert.equal(config.autoAuth, false)
  assert.equal(config.closeToTray, true, 'invalid types fall back to defaults')
  assert.equal(config.launchAtLogin, true)
  assert.equal(config.zoom, 3, 'zoom is clamped')
  assert.deepEqual(config.window, { x: 10, y: 20, width: 1000, height: 700, maximized: true })
})

test('sanitizeConfig rejects a window below the minimum size', () => {
  const config = sanitizeConfig({ window: { x: 0, y: 0, width: 100, height: 100 } })
  assert.equal(config.window.width, 640)
  assert.equal(config.window.height, 480)
})

test('defaultConfig points at the stock dsh web port', () => {
  assert.equal(defaultConfig().url, null)
  assert.equal(DEFAULT_URL, 'http://127.0.0.1:3080/')
})

test('configPath honours XDG_CONFIG_HOME', () => {
  assert.equal(
    configPath({ XDG_CONFIG_HOME: '/tmp/xdg', HOME: '/home/u' }),
    '/tmp/xdg/dsh-desktop-linux/config.json',
  )
  assert.equal(configPath({ HOME: '/home/u' }), '/home/u/.config/dsh-desktop-linux/config.json')
})

test('saveConfig/loadConfig round-trips atomically with 0600 permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-shell-config-'))
  const file = join(directory, 'config.json')
  try {
    await saveConfig({ ...defaultConfig(), url: 'http://127.0.0.1:3080/', closeToTray: false }, file)
    const loaded = await loadConfig(file)
    assert.equal(loaded.url, 'http://127.0.0.1:3080/')
    assert.equal(loaded.closeToTray, false)
    const text = await readFile(file, 'utf8')
    assert.match(text, /"url": "http:\/\/127\.0\.0\.1:3080\/"/u)
    const { stat } = await import('node:fs/promises')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('loadConfig falls back to defaults for unreadable or invalid JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-shell-config-bad-'))
  try {
    const invalid = join(directory, 'config.json')
    await writeFile(invalid, '{ not json')
    assert.deepEqual(await loadConfig(invalid), defaultConfig())

    const missing = join(directory, 'does-not-exist.json')
    assert.deepEqual(await loadConfig(missing), defaultConfig())
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('sameOrigin compares scheme, host and port', () => {
  assert.equal(sameOrigin('http://127.0.0.1:3080/a', 'http://127.0.0.1:3080/b'), true)
  assert.equal(sameOrigin('http://127.0.0.1:3080/', 'http://127.0.0.1:3081/'), false)
  assert.equal(sameOrigin('https://a.test/', 'http://a.test/'), false)
  assert.equal(sameOrigin('nope', 'http://a.test/'), false)
})
