/** Command-line overrides for the shell process. */

/**
 * Read command-line overrides.
 * @param {string[]} argv - Process argv.
 * @returns {{ hidden: boolean, url: string | null, size: { width: number, height: number } | null }} Parsed options.
 */
export function parseArguments(argv) {
  let hidden = false
  let url = null
  let size = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--hidden') hidden = true
    else if (argument.startsWith('--url=')) url = argument.slice('--url='.length)
    else if (argument === '--url' && argv[index + 1] !== undefined) {
      url = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--size=')) {
      const match = /^(\d{3,5})x(\d{3,5})$/u.exec(argument.slice('--size='.length))
      if (match !== null) size = { width: Number(match[1]), height: Number(match[2]) }
    }
  }
  return { hidden, url, size }
}
