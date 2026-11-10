/**
 * Phone/tablet pairing: turn the credential URL printed by `dsh web` into a QR
 * code the mobile browser can open once.
 *
 * The launch token in that URL is single-use: opening it exchanges the token for
 * a 30-day signed session cookie bound to the host:port authority. The phone's
 * browser keeps that cookie, so after the first scan the clean URL alone works
 * until the cookie expires — the shell never stores the token.
 */
import QRCode from 'qrcode'

/**
 * Validate a URL meant for a mobile browser.
 *
 * Unlike the desktop target URL, a pairing URL must keep its `?token=`
 * parameter: that token is what the phone exchanges for its own cookie.
 * @param {string} input - Pasted URL.
 * @returns {string | null} Canonical URL, or `null` when unusable.
 */
export function normalizePairingUrl(input) {
  let url
  try {
    url = new URL(String(input).trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  return url.href
}

/**
 * Render a pairing URL as an inline SVG QR code.
 * @param {string} url - Canonical pairing URL.
 * @param {{ width?: number }} [options] - Pixel width of the rendered code.
 * @returns {Promise<string>} SVG markup.
 */
export async function pairingQrSvg(url, { width = 360 } = {}) {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    width,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111ff', light: '#ffffffff' },
  })
}

/**
 * The clean URL a phone should bookmark/install after the first exchange.
 * @param {string} pairingUrl - Tokenized pairing URL.
 * @returns {string | null} URL without `?token=`.
 */
export function cleanPairingUrl(pairingUrl) {
  let url
  try {
    url = new URL(pairingUrl)
  } catch {
    return null
  }
  url.searchParams.delete('token')
  return url.href
}
