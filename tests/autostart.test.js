import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  autostartEntry,
  autostartPath,
  isAutostartEnabled,
  quoteExecArgument,
  setAutostart,
} from '../src/autostart.js'

test('quoteExecArgument quotes paths with spaces and leaves safe tokens alone', () => {
  assert.equal(quoteExecArgument('/usr/bin/dsh-desktop'), '/usr/bin/dsh-desktop')
  assert.equal(quoteExecArgument('/opt/DSH Desktop/dsh-desktop'), '"/opt/DSH Desktop/dsh-desktop"')
  assert.equal(quoteExecArgument('--hidden'), '--hidden')
})

test('autostartEntry is a valid XDG autostart desktop file', () => {
  const entry = autostartEntry({ exec: ['/usr/bin/dsh-desktop', '--hidden'], icon: '/usr/share/icons/dsh.png' })
  assert.match(entry, /^\[Desktop Entry\]/u)
  assert.match(entry, /^Type=Application$/mu)
  assert.match(entry, /^Exec=\/usr\/bin\/dsh-desktop --hidden$/mu)
  assert.match(entry, /^Icon=\/usr\/share\/icons\/dsh\.png$/mu)
  assert.match(entry, /^X-GNOME-Autostart-enabled=true$/mu)
  assert.match(entry, /^Terminal=false$/mu)
})

test('autostartPath honours XDG_CONFIG_HOME', () => {
  assert.equal(
    autostartPath({ XDG_CONFIG_HOME: '/tmp/xdg', HOME: '/home/u' }),
    '/tmp/xdg/autostart/dsh-desktop.desktop',
  )
})

test('setAutostart writes and removes the entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-shell-autostart-'))
  const env = { XDG_CONFIG_HOME: directory, HOME: directory }
  try {
    await setAutostart(true, { env, exec: ['/usr/bin/dsh-desktop', '--hidden'], icon: '/tmp/icon.png' })
    const file = join(directory, 'autostart', 'dsh-desktop.desktop')
    assert.match(await readFile(file, 'utf8'), /--hidden/u)
    assert.equal(await isAutostartEnabled(env), true)
    await setAutostart(false, { env, exec: [], icon: '' })
    assert.equal(await isAutostartEnabled(env), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
