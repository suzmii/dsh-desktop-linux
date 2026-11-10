/**
 * XDG autostart entry for the shell.
 *
 * The entry starts the shell hidden (`--hidden`) so a login does not open a
 * window; the tray icon stays available. Only this shell's own file is written
 * or removed — nothing under `$DSH_HOME` is touched.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const AUTOSTART_FILE_NAME = 'dsh-desktop.desktop'

/**
 * Quote one Exec argument the way desktop files expect it.
 * @param {string} value - Absolute path or argument.
 * @returns {string} Quoted argument.
 */
export function quoteExecArgument(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Build the desktop entry text.
 * @param {{ exec: string[], icon: string }} options - Executable argv and icon path.
 * @returns {string} Desktop entry file contents.
 */
export function autostartEntry({ exec, icon }) {
  const command = exec.map(quoteExecArgument).join(' ')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=DSH Desktop',
    'Comment=Connect to a running dsh web server',
    `Exec=${command}`,
    `Icon=${icon}`,
    'Terminal=false',
    'StartupNotify=false',
    'Categories=Development;Utility;',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

/**
 * Path of this shell's autostart entry.
 * @param {NodeJS.ProcessEnv} env - Environment supplying XDG_CONFIG_HOME/HOME.
 * @returns {string} Absolute path.
 */
export function autostartPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config')
  return join(base, 'autostart', AUTOSTART_FILE_NAME)
}

/**
 * Install or remove the autostart entry.
 * @param {boolean} enabled - Desired state.
 * @param {{ env?: NodeJS.ProcessEnv, exec: string[], icon: string, file?: string }} options - Entry contents.
 * @returns {Promise<void>} Completion.
 */
export async function setAutostart(enabled, { env = process.env, exec, icon, file = autostartPath(env) }) {
  if (!enabled) {
    await rm(file, { force: true })
    return
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, autostartEntry({ exec, icon }), { mode: 0o644 })
}

/**
 * Read back the current entry, if present.
 * @param {NodeJS.ProcessEnv} env - Environment supplying XDG_CONFIG_HOME/HOME.
 * @returns {Promise<boolean>} True when the entry exists and is enabled.
 */
export async function isAutostartEnabled(env = process.env) {
  try {
    return !(await readFile(autostartPath(env), 'utf8')).includes('X-GNOME-Autostart-enabled=false')
  } catch {
    return false
  }
}
