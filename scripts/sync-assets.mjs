/**
 * Keep the packaged app and tray icons in sync with the installed dsh web frontend.
 *
 * The shell ships no runtime of its own, so it cannot read dsh assets at runtime;
 * icons are generated once at build time. The whale glyphs in the dsh frontend are
 * transparent SVGs (`favicon.svg` for light panels, `favicon-dark.svg` for dark
 * ones); the old `icon-512.png` carried a white background tile, which looked like
 * a sticker in launchers and trays, so it is only a fallback now.
 */
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectory = join(root, 'build')
const trayDirectory = join(buildDirectory, 'tray')

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

/** Whether a binary is available on PATH. */
async function hasBinary(name) {
  try {
    await run('sh', ['-c', `command -v ${name}`])
    return true
  } catch {
    return false
  }
}

/** Render one SVG to a padded, transparent PNG at `size` px. */
async function renderTransparent(svg, size, destination, tools) {
  const scale = 4
  const canvas = size * scale
  const inset = Math.round(canvas * 0.92)
  const temp = `${destination}.${process.pid}.png`
  await run(tools.rsvg, ['-w', String(inset), '-h', String(inset), '-o', temp, svg])
  try {
    await run(tools.magick, [
      temp,
      '-background', 'none',
      '-gravity', 'center',
      '-extent', `${canvas}x${canvas}`,
      '-resize', `${size}x${size}`,
      destination,
    ])
  } finally {
    await rm(temp, { force: true })
  }
}

/** Generate icons from the frontend SVGs, or keep the committed fallbacks. */
async function main() {
  await mkdir(trayDirectory, { recursive: true })
  const dist = findFrontendDist()
  const lightSvg = dist === null ? null : join(dist, 'favicon.svg')
  const darkSvg = dist === null ? null : join(dist, 'favicon-dark.svg')
  const tools = { rsvg: 'rsvg-convert', magick: 'magick' }
  const canRender = lightSvg !== null && existsSync(lightSvg) && existsSync(darkSvg)
    && await hasBinary(tools.rsvg) && await hasBinary(tools.magick)

  if (canRender) {
    await renderTransparent(lightSvg, 512, join(buildDirectory, 'icon.png'), tools)
    await renderTransparent(lightSvg, 22, join(trayDirectory, 'tray-dark.png'), tools)
    await renderTransparent(darkSvg, 22, join(trayDirectory, 'tray-light.png'), tools)
    console.log(`icons: rendered transparent from ${dist}`)
    return
  }

  if (dist !== null && existsSync(join(dist, 'icon-512.png')) && !existsSync(join(buildDirectory, 'icon.png'))) {
    await copyFile(join(dist, 'icon-512.png'), join(buildDirectory, 'icon.png'))
    console.log(`icon: copied the opaque fallback from ${dist}`)
    return
  }
  if (existsSync(join(buildDirectory, 'icon.png')) && existsSync(join(trayDirectory, 'tray-dark.png'))) {
    console.log('icons: frontend or SVG tools missing, keeping the committed transparent icons')
    return
  }
  throw new Error('icon: no usable source found for build/icon.png')
}

await main()
