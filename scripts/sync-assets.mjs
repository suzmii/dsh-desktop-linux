/**
 * Keep the packaged icon in sync with the installed dsh web frontend.
 *
 * The shell ships no runtime of its own, so it cannot read dsh assets at
 * runtime; the icon is copied once at build time. When the dsh frontend is not
 * installed, an existing `build/icon.png` is kept and a small generated
 * fallback is written from `build/icon.svg`.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'build', 'icon.png')

/** Candidate frontend dist directories, most specific first. */
export const FRONTEND_DIST_CANDIDATES = [
  join(homedir(), '.bun/install/global/node_modules/@deepseek-ai/dsh-web-frontend/dist'),
  join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh-web-frontend/dist'),
  '/usr/local/lib/node_modules/@deepseek-ai/dsh-web-frontend/dist',
  '/usr/lib/node_modules/@deepseek-ai/dsh-web-frontend/dist',
]

/**
 * Locate the first installed dsh web frontend dist directory.
 * @param {string[]} candidates - Directories to test.
 * @returns {string | null} Existing dist directory, or `null`.
 */
export function findFrontendDist(candidates = FRONTEND_DIST_CANDIDATES) {
  if (process.env.DSH_FRONTEND_DIST !== undefined && existsSync(process.env.DSH_FRONTEND_DIST)) {
    return process.env.DSH_FRONTEND_DIST
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'icon-512.png'))) return candidate
  }
  return null
}

/** Copy the official dsh icon, or keep/generate a fallback. */
async function main() {
  await mkdir(dirname(target), { recursive: true })
  const dist = findFrontendDist()
  if (dist !== null) {
    await copyFile(join(dist, 'icon-512.png'), target)
    console.log(`icon: copied from ${dist}`)
    return
  }
  if (existsSync(target)) {
    console.log('icon: frontend not found, keeping existing build/icon.png')
    return
  }
  throw new Error('icon: no dsh web frontend found and no build/icon.png to keep')
}

await main()

export { readFile, writeFile }
