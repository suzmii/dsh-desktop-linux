import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  listenerUrl,
  looksLikeDshWeb,
  parseSsListeners,
  probeDshWeb,
} from '../src/discovery.js'

const SS_OUTPUT = [
  'LISTEN 0      511     192.168.1.10:47827 0.0.0.0:*    users:(("node-MainThread",pid=825874,fd=21))',
  'LISTEN 0      50         127.0.0.1:30001 0.0.0.0:*    users:(("rustrover",pid=217067,fd=394))',
  'LISTEN 0      4096       0.0.0.0:5355      0.0.0.0:*    users:(("systemd-resolve",pid=900,fd=12))',
  'LISTEN 0      511            [::1]:3080       [::]:*    users:(("node",pid=4242,fd=7))',
  'LISTEN 0      511               *:9000            *:*',
].join('\n')

test('parseSsListeners extracts host, port, pid and process', () => {
  const listeners = parseSsListeners(SS_OUTPUT)
  assert.deepEqual(listeners[0], { host: '192.168.1.10', port: 47827, pid: 825874, process: 'node-MainThread' })
  assert.deepEqual(listeners[1], { host: '127.0.0.1', port: 30001, pid: 217067, process: 'rustrover' })
  assert.deepEqual(listeners[2], { host: '127.0.0.1', port: 5355, pid: 900, process: 'systemd-resolve' })
  assert.deepEqual(listeners[3], { host: '::1', port: 3080, pid: 4242, process: 'node' })
  assert.deepEqual(listeners[4], { host: '127.0.0.1', port: 9000, pid: null, process: null })
})

test('parseSsListeners ignores non-listening lines', () => {
  assert.deepEqual(parseSsListeners('ESTAB 0 0 1.2.3.4:80 5.6.7.8:12345'), [])
  assert.deepEqual(parseSsListeners(''), [])
})

test('listenerUrl brackets IPv6 and keeps IPv4 as-is', () => {
  assert.equal(listenerUrl({ host: '127.0.0.1', port: 3080 }), 'http://127.0.0.1:3080/')
  assert.equal(listenerUrl({ host: '::1', port: 3080 }), 'http://[::1]:3080/')
  assert.equal(listenerUrl({ host: '10.0.0.5', port: 47827 }), 'http://10.0.0.5:47827/')
})

test('looksLikeDshWeb recognises real dsh web command lines', () => {
  assert.equal(looksLikeDshWeb([
    '/usr/bin/node',
    '/home/u/.bun/install/global/node_modules/@deepseek-ai/dsh/lib/bin.js',
    'web',
    '--no-open',
    '--host',
    '192.168.1.10',
  ]), true)
  assert.equal(looksLikeDshWeb([
    'node',
    '/home/u/src/deepseek-harness/apps/cli/lib/bin.js',
    'web',
  ]), true)
})

test('looksLikeDshWeb rejects unrelated servers', () => {
  assert.equal(looksLikeDshWeb(['node', 'server/index.mjs']), false)
  assert.equal(looksLikeDshWeb(['node', 'src/server/main.ts']), false)
  assert.equal(looksLikeDshWeb(['node', '/opt/dsh-agent/server.js', 'serve']), false)
  assert.equal(looksLikeDshWeb([]), false)
})

/**
 * Start a one-route HTTP server for probe tests.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler - Route.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>} Running server.
 */
async function startServer(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  }
}

test('probeDshWeb recognises the authenticated dsh index', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<script>globalThis["__DSH_BOOT__"] = {}</script><title>DeepSeek Harness</title>')
  })
  try {
    const result = await probeDshWeb(`http://127.0.0.1:${server.port}/`)
    assert.equal(result.status, 200)
    assert.equal(result.isDsh, true)
    assert.equal(result.needsAuth, false)
    assert.equal(result.error, null)
  } finally {
    await server.close()
  }
})

test('probeDshWeb recognises the 401 authentication prompt', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
  })
  try {
    const result = await probeDshWeb(`http://127.0.0.1:${server.port}/`)
    assert.equal(result.status, 401)
    assert.equal(result.isDsh, true)
    assert.equal(result.needsAuth, true)
  } finally {
    await server.close()
  }
})

test('probeDshWeb reports non-dsh servers as not dsh', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>Some other app</title>')
  })
  try {
    const result = await probeDshWeb(`http://127.0.0.1:${server.port}/`)
    assert.equal(result.status, 200)
    assert.equal(result.isDsh, false)
  } finally {
    await server.close()
  }
})

test('probeDshWeb reports refused connections and invalid URLs', async () => {
  const refused = await probeDshWeb('http://127.0.0.1:1/', { timeoutMs: 500 })
  assert.equal(refused.status, null)
  assert.equal(refused.isDsh, false)
  assert.equal(typeof refused.error, 'string')

  const invalid = await probeDshWeb('not-a-url')
  assert.equal(invalid.error, 'invalid-url')
})
