import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BROWSER_COOKIE_VERSION,
  COOKIE_LIFETIME_MS,
  credentialsPath,
  decodeBase64Url,
  dshHome,
  encodeBase64Url,
  mintSessionCookie,
  parseBrowserSessionSecret,
  readBrowserSessionSecret,
  sessionCookieName,
  urlAuthority,
  verifySessionCookie,
} from '../src/auth.js'

const secret = randomBytes(32)

test('base64url helpers round-trip and reject malformed input', () => {
  const bytes = randomBytes(32)
  const encoded = encodeBase64Url(bytes)
  assert.deepEqual(decodeBase64Url(encoded), bytes)
  assert.equal(decodeBase64Url('a=b'), null)
  assert.equal(decodeBase64Url('abcde'), null)
})

test('dshHome and credentialsPath honour DSH_HOME', () => {
  assert.equal(dshHome({ DSH_HOME: '/tmp/dsh', HOME: '/home/u' }), '/tmp/dsh')
  assert.equal(dshHome({ HOME: '/home/u' }), '/home/u/.dsh')
  assert.equal(credentialsPath({ DSH_HOME: '/tmp/dsh' }), '/tmp/dsh/.credentials.yaml')
})

test('parseBrowserSessionSecret finds the browser-session record', () => {
  const yaml = [
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${encodeBase64Url(secret)}`,
    '  deepseek-account-platform/device:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ].join('\n')
  assert.deepEqual(parseBrowserSessionSecret(yaml), secret)
})

test('parseBrowserSessionSecret accepts quoted secrets and rejects invalid ones', () => {
  const quoted = [
    'records:',
    '  client-connection/browser-session:',
    '    payload:',
    `      secret: '${encodeBase64Url(secret)}'`,
  ].join('\n')
  assert.deepEqual(parseBrowserSessionSecret(quoted), secret)

  assert.equal(parseBrowserSessionSecret('records: {}'), null)
  assert.equal(parseBrowserSessionSecret([
    '  client-connection/browser-session:',
    '    payload:',
    '      secret: short',
  ].join('\n')), null)
})

test('readBrowserSessionSecret reads an actual credentials file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-shell-credentials-'))
  try {
    await writeFile(join(directory, '.credentials.yaml'), [
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
      `      secret: ${encodeBase64Url(secret)}`,
    ].join('\n'))
    assert.deepEqual(await readBrowserSessionSecret({ DSH_HOME: directory }), secret)
    assert.equal(await readBrowserSessionSecret({ DSH_HOME: join(directory, 'missing') }), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('mintSessionCookie produces the dsh v1 cookie format', () => {
  const cookie = mintSessionCookie(secret, { authority: '127.0.0.1:3080', issuedAt: 1_700_000_000_000 })
  assert.equal(cookie.name, 'dsh-auth-' + encodeBase64Url(
    createHash('sha256').update('127.0.0.1:3080').digest(),
  ))
  assert.match(cookie.value, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
  assert.equal(cookie.expiresAt - 1_700_000_000_000, COOKIE_LIFETIME_MS)
  assert.ok(COOKIE_LIFETIME_MS < 30 * 24 * 60 * 60 * 1000, 'must stay under the dsh default maximum')

  const payload = verifySessionCookie(cookie.value, secret)
  assert.equal(payload.version, BROWSER_COOKIE_VERSION)
  assert.equal(payload.authority, '127.0.0.1:3080')
  assert.equal(payload.issuedAt, 1_700_000_000_000)
  assert.equal(payload.expiresAt, cookie.expiresAt)
})

test('session cookies are authority-bound and tamper-evident', () => {
  const cookie = mintSessionCookie(secret, { authority: '127.0.0.1:3080' })
  const other = mintSessionCookie(secret, { authority: '127.0.0.1:3081' })
  assert.notEqual(cookie.name, other.name)
  assert.equal(verifySessionCookie(cookie.value, randomBytes(32)), null)
  const [version, body, signature] = cookie.value.split('.')
  assert.equal(verifySessionCookie(`${version}.${body}x.${signature}`, secret), null)
  assert.equal(verifySessionCookie('v1.only.two', secret), null)
})

test('urlAuthority normalizes the URL host and port', () => {
  assert.equal(urlAuthority('http://127.0.0.1:3080/'), '127.0.0.1:3080')
  assert.equal(urlAuthority('http://127.0.0.1/'), '127.0.0.1')
  assert.equal(urlAuthority('http://[::1]:3080/ui/'), '[::1]:3080')
})

test('mintSessionCookie rejects a malformed secret', () => {
  assert.throws(() => mintSessionCookie(Buffer.alloc(31), { authority: '127.0.0.1:3080' }))
  assert.throws(() => mintSessionCookie('not-a-buffer', { authority: '127.0.0.1:3080' }))
})
