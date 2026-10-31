// Improvement 6: a large request that keeps failing at the transport level gets compacted and retried.
//
// Background (2026-10-31, stabilitee): a 760k-token Claude Opus session failed every request with
// TRANSPORT ("claude API request failed"), not with a context-overflow code. compaction-basic only
// recovers on CONTEXT_WINDOW_EXCEEDED, so llm-retry backed off ten times per turn and the session was dead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { installContextGuard, shouldCompactOnFailure, GUARD_DEFAULTS, resolveGuardConfig } from '../lib/context-guard.js'

test('compacts only a large request after repeated retryable failures, a bounded number of times per step', () => {
  const base = { code: 'TRANSPORT', totalTokens: 760000, failures: 2, compactionsThisStep: 0 }
  assert.equal(shouldCompactOnFailure(base), true)
  assert.equal(shouldCompactOnFailure({ ...base, failures: 1 }), false, 'the first failure is left to llm-retry')
  assert.equal(shouldCompactOnFailure({ ...base, totalTokens: 50000 }), false, 'a small request is not the cause')
  assert.equal(shouldCompactOnFailure({ ...base, code: 'AUTH' }), false, 'a non-transient failure is not ours')
  assert.equal(shouldCompactOnFailure({ ...base, compactionsThisStep: GUARD_DEFAULTS.maxCompactionsPerStep }), false,
    'bounded per step')
  for (const code of ['TRANSPORT', 'SERVER', 'TIMEOUT', 'EMPTY_RESPONSE']) {
    assert.equal(shouldCompactOnFailure({ ...base, code }), true, code)
  }
})

test('the large-request bar sits well under the 1M window and above everyday sessions', () => {
  assert.ok(GUARD_DEFAULTS.largeRequestTokens >= 150000 && GUARD_DEFAULTS.largeRequestTokens <= 400000)
  assert.equal(GUARD_DEFAULTS.failuresBeforeCompact, 2)
  assert.ok(GUARD_DEFAULTS.chunkTokens <= GUARD_DEFAULTS.largeRequestTokens, 'one summary request is never itself large')
})

/**
 * A fake session: system head, then alternating user/assistant/tool nodes of `perNode` tokens each.
 * compactRegion replaces [start..end] with one small summary node, like compaction-basic does.
 */
function fakeSession(count, perNode) {
  const types = ['system/message']
  for (let i = 1; i < count; i += 1) types.push(['user/message', 'assistant/message', 'tool/result'][i % 3])
  const events = new Map(types.map((type, i) => [i + 1, { type, tokens: i === 0 ? 1000 : perNode }]))
  let next = count + 1
  return {
    id: 's1',
    surface: { nodes: [...events.keys()], replaceGeneration: 0 },
    eventAt: (seq) => events.get(seq),
    _events: events,
    _replace(start, end) {
      const nodes = this.surface.nodes
      const i = nodes.indexOf(start); const j = nodes.indexOf(end)
      events.set(next, { type: 'user/message', tokens: 2000 })
      nodes.splice(i, j - i + 1, next)
      next += 1
      this.surface.replaceGeneration += 1
    },
  }
}

/** A fake Cordis ctx with just the hooks the guard uses. */
function fakeCtx(session, { compactThrows = null, noCompaction = false } = {}) {
  const listeners = {}
  const regions = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on(name, fn, opts) { (listeners[name] ??= []).push({ fn, opts }) },
    get(name) {
      if (name === 'tokenMeter') {
        return { measure: (s) => {
          const nodes = s.surface.nodes.map((seq) => ({ seq, tokens: s.eventAt(seq).tokens }))
          return { nodes, totalTokens: nodes.reduce((a, n) => a + n.tokens, 0) }
        } }
      }
      if (name === 'compaction' && !noCompaction) {
        return {
          async compactRegion(start, end, agent) {
            regions.push([start, end])
            if (compactThrows) throw compactThrows
            agent.session._replace(start, end)
            return { shadowedSeqs: [start, end] }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, listeners, regions }
}

const ac = new AbortController()
const fail = (a, step = 1) => ({ agent: a, turn: 1, step, failure: { code: 'TRANSPORT', message: 'x' }, signal: ac.signal })
const next = () => Promise.resolve('delegated')

test('listener: first failure delegates, second compacts the oldest chunk and retries', async () => {
  const session = fakeSession(91, 8000)              // ~721k tokens
  const { ctx, listeners, regions } = fakeCtx(session)
  installContextGuard(ctx)
  const { fn, opts } = listeners['agent/request-error'][0]
  assert.equal(opts?.prepend, true, 'must run before llm-retry swallows the failure into a backoff')
  const a = { session }
  assert.equal(await fn(fail(a), next), 'delegated')
  assert.deepEqual(await fn(fail(a), next), { kind: 'retry' })
  assert.equal(regions.length, 1)
  const [start, end] = regions[0]
  assert.equal(start, 2, 'the system head is never compacted')
  assert.notEqual(session.eventAt(end + 1)?.type, 'tool/result', 'the cut never separates a tool result from its call')
  const shadowed = (end - start + 1) * 8000
  assert.ok(shadowed <= GUARD_DEFAULTS.chunkTokens && shadowed >= GUARD_DEFAULTS.chunkTokens / 2, String(shadowed))
})

test('listener: repeated failures compact chunk by chunk, at most maxCompactionsPerStep per step', async () => {
  const session = fakeSession(151, 8000)             // ~1.2M tokens
  const { ctx, listeners, regions } = fakeCtx(session)
  installContextGuard(ctx)
  const fn = listeners['agent/request-error'][0].fn
  const a = { session }
  await fn(fail(a), next)
  for (let k = 0; k < GUARD_DEFAULTS.maxCompactionsPerStep; k += 1) assert.deepEqual(await fn(fail(a), next), { kind: 'retry' })
  assert.equal(await fn(fail(a), next), 'delegated')
  assert.equal(regions.length, GUARD_DEFAULTS.maxCompactionsPerStep)
})

test('listener: a successful reply resets the count', async () => {
  const session = fakeSession(91, 8000)
  const { ctx, listeners, regions } = fakeCtx(session)
  installContextGuard(ctx)
  const fn = listeners['agent/request-error'][0].fn
  const onEvent = listeners['session/event'][0].fn
  const a = { session }
  await fn(fail(a), next)
  onEvent(session, { type: 'assistant/message' })
  assert.equal(await fn(fail(a, 2), next), 'delegated')
  assert.deepEqual(regions, [])
})

test('listener: small sessions, failed compactions and a missing service fall through to llm-retry', async () => {
  for (const [session, opts] of [[fakeSession(10, 8000), {}], [fakeSession(91, 8000), { compactThrows: new Error('boom') }],
    [fakeSession(91, 8000), { noCompaction: true }]]) {
    const { ctx, listeners } = fakeCtx(session, opts)
    installContextGuard(ctx)
    const fn = listeners['agent/request-error'][0].fn
    const a = { session }
    await fn(fail(a), next)
    assert.equal(await fn(fail(a), next), 'delegated', JSON.stringify(opts))
  }
})

test('listener: services are found through the agent context (the preset-isolated compaction backend)', async () => {
  const session = fakeSession(91, 8000)
  const { ctx, listeners, regions } = fakeCtx(session)
  const agentGet = ctx.get
  ctx.get = (name) => name === 'compaction' ? undefined : agentGet(name)   // the host cannot see it
  installContextGuard(ctx)
  const fn = listeners['agent/request-error'][0].fn
  const a = { session, ctx: { get: agentGet } }
  await fn(fail(a), next)
  assert.deepEqual(await fn(fail(a), next), { kind: 'retry' })
  assert.equal(regions.length, 1)
})

test('listener: an aborted turn is never compacted', async () => {
  const session = fakeSession(91, 8000)
  const { ctx, listeners, regions } = fakeCtx(session)
  installContextGuard(ctx)
  const fn = listeners['agent/request-error'][0].fn
  const dead = new AbortController(); dead.abort()
  const a = { session }
  await fn({ ...fail(a), signal: dead.signal }, next)
  assert.equal(await fn({ ...fail(a), signal: dead.signal }, next), 'delegated')
  assert.deepEqual(regions, [])
})

test('early compaction: a step over earlyCompactTokens compacts the oldest chunks down to the target', async () => {
  const session = fakeSession(61, 8000)              // ~481k tokens
  const { ctx, listeners, regions } = fakeCtx(session)
  installContextGuard(ctx)
  const fn = listeners['agent/pre-step'][0].fn
  const decision = { kind: 'continue', messages: [] }
  assert.equal(await fn({ agent: { session }, signal: ac.signal }, () => Promise.resolve(decision)), decision)
  const total = session.surface.nodes.reduce((a, s) => a + session.eventAt(s).tokens, 0)
  assert.ok(total < GUARD_DEFAULTS.earlyCompactTokens, `${total} left`)
  assert.ok(total >= GUARD_DEFAULTS.earlyTargetTokens - GUARD_DEFAULTS.chunkTokens, 'does not over-compact')
  assert.ok(regions.length >= 1 && regions.length <= GUARD_DEFAULTS.maxCompactionsPerStep)
  assert.equal(regions[0][0], 2, 'oldest first, system head kept')
})

test('early compaction: below the threshold nothing happens, and failures never block the step', async () => {
  const small = fakeSession(30, 8000)                // ~233k
  const a = fakeCtx(small); installContextGuard(a.ctx)
  const decision = { kind: 'continue', messages: [] }
  assert.equal(await a.listeners['agent/pre-step'][0].fn({ agent: { session: small }, signal: ac.signal }, () => Promise.resolve(decision)), decision)
  assert.deepEqual(a.regions, [])
  const big = fakeSession(61, 8000)
  const b = fakeCtx(big, { compactThrows: new Error('boom') }); installContextGuard(b.ctx)
  assert.equal(await b.listeners['agent/pre-step'][0].fn({ agent: { session: big }, signal: ac.signal }, () => Promise.resolve(decision)), decision)
})

test('config: plugin config overrides the defaults, unknown keys are rejected', () => {
  assert.deepEqual(resolveGuardConfig(undefined), GUARD_DEFAULTS)
  assert.equal(resolveGuardConfig({ contextGuard: { earlyCompactTokens: 5000, earlyTargetTokens: 3000, chunkTokens: 1000, largeRequestTokens: 4000 } }).earlyCompactTokens, 5000)
  assert.throws(() => resolveGuardConfig({ contextGuard: { nope: 1 } }), /unknown/)
  assert.throws(() => resolveGuardConfig({ contextGuard: { earlyTargetTokens: 999999 } }), /below/)
})
