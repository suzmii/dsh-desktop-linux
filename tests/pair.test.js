import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanPairingUrl, normalizePairingUrl, pairingQrSvg } from '../src/pair.js'

test('normalizePairingUrl preserves the launch token', () => {
  const url = normalizePairingUrl(' http://10.0.0.5:47827/?token=abc ')
  assert.equal(url, 'http://10.0.0.5:47827/?token=abc')
  const https = normalizePairingUrl('https://dsh.example/')
  assert.equal(https, 'https://dsh.example/')
})

test('normalizePairingUrl rejects unusable inputs', () => {
  assert.equal(normalizePairingUrl('file:///etc/passwd'), null)
  assert.equal(normalizePairingUrl('not a url'), null)
  assert.equal(normalizePairingUrl('http://user:pass@127.0.0.1:3080/'), null)
})

test('cleanPairingUrl drops the token for the long-lived address', () => {
  assert.equal(
    cleanPairingUrl('http://10.0.0.5:47827/?token=abc'),
    'http://10.0.0.5:47827/',
  )
  assert.equal(cleanPairingUrl('https://dsh.example/ui?token=abc&x=1'), 'https://dsh.example/ui?x=1')
  assert.equal(cleanPairingUrl('nope'), null)
})

test('pairingQrSvg renders a self-contained SVG', async () => {
  const svg = await pairingQrSvg('http://10.0.0.5:47827/?token=abc', { width: 240 })
  assert.match(svg, /^<svg[^>]*>/u)
  assert.match(svg, /width="240"/u)
  assert.equal(svg.includes('<script'), false)
})
