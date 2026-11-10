import assert from 'node:assert/strict'
import test from 'node:test'

import { parseArguments } from '../src/args.js'

test('parseArguments reads --hidden', () => {
  assert.deepEqual(parseArguments(['.', '--hidden']).hidden, true)
  assert.deepEqual(parseArguments(['.']).hidden, false)
})

test('parseArguments reads --url in both spellings', () => {
  assert.equal(parseArguments(['.', '--url=http://127.0.0.1:3080/']).url, 'http://127.0.0.1:3080/')
  assert.equal(parseArguments(['.', '--url', 'http://127.0.0.1:3080/']).url, 'http://127.0.0.1:3080/')
  assert.equal(parseArguments(['.']).url, null)
})

test('parseArguments reads --size and ignores malformed values', () => {
  assert.deepEqual(parseArguments(['.', '--size=390x844']).size, { width: 390, height: 844 })
  assert.equal(parseArguments(['.', '--size=390']).size, null)
  assert.equal(parseArguments(['.', '--size=axb']).size, null)
})

test('parseArguments ignores unrelated arguments', () => {
  assert.deepEqual(parseArguments(['.', '--no-sandbox', '--foo=bar']), { hidden: false, url: null, size: null })
})
