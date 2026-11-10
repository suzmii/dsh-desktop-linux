import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import { resolveTarget } from '../src/attach.js'
import { verifySessionCookie } from '../src/auth.js'

const secret = randomBytes(32)

/**
 * Build a probe stub answering from a URL → result map.
 * @param {Record<string, { status: number | null, isDsh: boolean, needsAuth: boolean, error?: string | null }>} answers - Answers by URL.
 * @param {object[]} seen - Receives each probe call.
 * @returns {(url: string, options: object) => Promise<object>} Probe stub.
 */
function stubProbe(answers, seen = []) {
  return async (url, options) => {
    seen.push({ url, options })
    const answer = answers[url] ?? { status: null, isDsh: false, needsAuth: false, error: 'ECONNREFUSED' }
    return { bodyHead: '', error: null, ...answer }
  }
}

test('resolveTarget prefers the first candidate that accepts the minted cookie', async () => {
  const seen = []
  const result = await resolveTarget({
    candidates: ['http://127.0.0.1:3080/', 'http://10.0.0.5:47827/'],
    secret,
    probe: stubProbe({
      'http://127.0.0.1:3080/': { status: 401, isDsh: true, needsAuth: true },
      'http://10.0.0.5:47827/': { status: 200, isDsh: true, needsAuth: false },
    }, seen),
  })
  assert.equal(result.ready, true)
  assert.equal(result.url, 'http://10.0.0.5:47827/')
  assert.equal(result.authenticated, true)
  assert.equal(seen.length, 2)
  assert.equal(typeof seen[0].options.cookie, 'string', 'the first probe carries a cookie too')
  assert.match(seen[1].options.cookie, /^dsh-auth-[A-Za-z0-9_-]+=v1\./u)

  const cookieValue = seen[1].options.cookie.split('=').slice(1).join('=')
  const payload = verifySessionCookie(cookieValue, secret)
  assert.equal(payload.authority, '10.0.0.5:47827')
  assert.equal(result.cookie.name.startsWith('dsh-auth-'), true)
})

test('resolveTarget reports auth-required when only dsh 401s answered', async () => {
  const result = await resolveTarget({
    candidates: ['http://127.0.0.1:3080/', 'http://127.0.0.1:3081/'],
    secret,
    probe: stubProbe({
      'http://127.0.0.1:3081/': { status: 401, isDsh: true, needsAuth: true },
    }),
  })
  assert.equal(result.ready, false)
  assert.equal(result.kind, 'auth-required')
  assert.equal(result.url, 'http://127.0.0.1:3081/')
})

test('resolveTarget reports every probe when nothing answers dsh', async () => {
  const result = await resolveTarget({
    candidates: ['http://127.0.0.1:3080/', 'http://127.0.0.1:3081/'],
    secret,
    probe: stubProbe({}),
  })
  assert.equal(result.ready, false)
  assert.equal(result.kind, 'not-found')
  assert.equal(result.probes.length, 2)
  assert.equal(result.probes[0].error, 'ECONNREFUSED')
})

test('resolveTarget probes without a cookie when autoAuth is off', async () => {
  const seen = []
  const result = await resolveTarget({
    candidates: ['http://127.0.0.1:3080/'],
    secret,
    autoAuth: false,
    probe: stubProbe({ 'http://127.0.0.1:3080/': { status: 200, isDsh: true, needsAuth: false } }, seen),
  })
  assert.equal(result.ready, true)
  assert.equal(result.cookie, null)
  assert.equal(result.authenticated, true)
  assert.deepEqual(seen[0].options, {})
})

test('resolveTarget survives a missing signing secret', async () => {
  const seen = []
  const result = await resolveTarget({
    candidates: ['http://127.0.0.1:3080/'],
    secret: null,
    probe: stubProbe({ 'http://127.0.0.1:3080/': { status: 401, isDsh: true, needsAuth: true } }, seen),
  })
  assert.equal(result.ready, false)
  assert.equal(result.kind, 'auth-required')
  assert.deepEqual(seen[0].options, {})
})

test('resolveTarget deduplicates candidates and keeps priority order', async () => {
  const seen = []
  await resolveTarget({
    candidates: ['http://127.0.0.1:3080/', 'http://127.0.0.1:3080/', 'http://127.0.0.1:3081/'],
    secret,
    probe: stubProbe({}, seen),
  })
  assert.deepEqual(seen.map(entry => entry.url), ['http://127.0.0.1:3080/', 'http://127.0.0.1:3081/'])
})
