/**
 * Minimal file log for a desktop process that has no terminal attached.
 *
 * Lives under `$XDG_STATE_HOME/dsh-desktop-linux/shell.log`; rotates once at
 * 1 MiB so a long-running tray process cannot grow it without bound.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const MAX_BYTES = 1024 * 1024

/**
 * Resolve the shell log path.
 * @param {NodeJS.ProcessEnv} env - Environment supplying XDG_STATE_HOME/HOME.
 * @returns {string} Absolute log path.
 */
export function logPath(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state')
  return join(base, 'dsh-desktop-linux', 'shell.log')
}

/**
 * Append one timestamped line, rotating the file when it grows past the cap.
 * @param {string} message - Line to record.
 * @param {string} [file] - Log path override.
 * @returns {Promise<void>} Completion; logging never rejects.
 */
export async function log(message, file = logPath()) {
  const line = `${new Date().toISOString()} ${message}\n`
  try {
    await mkdir(dirname(file), { recursive: true })
    try {
      const info = await stat(file)
      if (info.size > MAX_BYTES) await rename(file, `${file}.1`)
    } catch {
      // A missing log is the normal first-write case.
    }
    await appendFile(file, line, { mode: 0o600 })
  } catch {
    // Diagnostics must never break the shell.
  }
}
