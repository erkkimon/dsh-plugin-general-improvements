/**
 * Improvement 6: context guard — a large request that keeps failing at the transport level is compacted
 * a chunk at a time and retried, instead of being backed off until the turn dies.
 *
 * Why (2026-10-31, stabilitee): a 760k-token Claude Opus session failed every request with TRANSPORT
 * ("claude API request failed"). compaction-basic recovers only on CONTEXT_WINDOW_EXCEEDED, so llm-retry
 * backed off ten times per turn (~25 min) and every later "continue" died the same way. The session was
 * unusable even though its context window was not full.
 *
 * What it does: an `agent/request-error` listener, prepended so it runs before llm-retry. The first failure
 * of a step is left to llm-retry (a blip retries fine). From the second retryable failure on, when the
 * request is large, it compacts the OLDEST chunk of history (at most `chunkTokens`, so the summary
 * request itself stays small) through the mounted compaction service and asks the loop to retry. At most
 * `maxCompactionsPerStep` chunks per step; after that, or when anything is off, it delegates unchanged.
 *
 * Early compaction (agent/pre-step): above `earlyCompactTokens` (350k) the oldest history is compacted
 * down to `earlyTargetTokens` (250k) before the step. compaction-basic's own trigger sits at 80 % of the
 * window (~800k on 1M routes), and it lives inside each agent preset, so a profile patch cannot retune
 * it without replacing the preset's whole plugin list. This keeps healthy sessions small; the failure
 * path rescues one that is already too big.
 * @module dsh-plugin-general-improvements/context-guard
 */

/** Tunables; exported for the tests. Override any of them with the plugin row's `config.contextGuard`. */
export const GUARD_DEFAULTS = Object.freeze({
  /** Early compaction: before a step, a session above this is compacted (oldest first)... */
  earlyCompactTokens: 350000,
  /** ...until it is below this. Off when earlyCompactTokens is 0. */
  earlyTargetTokens: 250000,
  /** A request below this is not suspected of being too big to send. */
  largeRequestTokens: 250000,
  /** Failures within one step before the guard acts (the first is llm-retry's). */
  failuresBeforeCompact: 2,
  /** Upper bound of history one compaction summarizes, so the summary call is a small request. */
  chunkTokens: 120000,
  /** Chunks compacted per step at most; then llm-retry's own budget decides. */
  maxCompactionsPerStep: 4,
})

/**
 * Validate the plugin config and merge it over the defaults.
 * @param {{contextGuard?: Partial<typeof GUARD_DEFAULTS>}|undefined} config
 */
export function resolveGuardConfig(config) {
  const given = config?.contextGuard ?? {}
  for (const [key, value] of Object.entries(given)) {
    if (!(key in GUARD_DEFAULTS)) throw new Error(`general-improvements: unknown contextGuard key "${key}"`)
    if (!Number.isInteger(value) || value < 0) throw new Error(`general-improvements: contextGuard.${key} must be a non-negative integer`)
  }
  const merged = Object.freeze({ ...GUARD_DEFAULTS, ...given })
  if (merged.earlyCompactTokens > 0 && merged.earlyTargetTokens >= merged.earlyCompactTokens) {
    throw new Error('general-improvements: contextGuard.earlyTargetTokens must be below earlyCompactTokens')
  }
  return merged
}

/** Failure codes that may be a too-large request in disguise (the same set llm-retry retries). */
const TRANSIENT = new Set(['TRANSPORT', 'SERVER', 'TIMEOUT', 'EMPTY_RESPONSE'])

/**
 * The pure decision.
 * @param {{code: string, totalTokens: number, failures: number, compactionsThisStep: number}} facts
 * @param {typeof GUARD_DEFAULTS} [config]
 * @returns {boolean}
 */
export function shouldCompactOnFailure({ code, totalTokens, failures, compactionsThisStep }, config = GUARD_DEFAULTS) {
  return TRANSIENT.has(code)
    && totalTokens >= config.largeRequestTokens
    && failures >= config.failuresBeforeCompact
    && compactionsThisStep < config.maxCompactionsPerStep
}

/**
 * The oldest compactable span: from the first non-system node up to `chunkTokens`, ending on a node whose
 * successor is not a tool result (so a tool call is never separated from its result). Null when no span.
 * compactRegion re-validates the edges with the shipped tool-pairing helpers and rejects an unbalanced one.
 */
export function oldestChunk(session, measurement, chunkTokens) {
  const nodes = measurement.nodes
  if (nodes.length < 3) return null
  const first = session.eventAt(nodes[0].seq)?.type === 'system/message' ? 1 : 0
  let sum = 0
  let end = -1
  // keep at least the newest two nodes verbatim: the turn in flight needs them
  for (let i = first; i < nodes.length - 2; i += 1) {
    if (sum + nodes[i].tokens > chunkTokens && end >= first) break
    sum += nodes[i].tokens
    if (session.eventAt(nodes[i + 1].seq)?.type !== 'tool/result') end = i
  }
  if (end < first) return null
  return { start: nodes[first].seq, end: nodes[end].seq }
}

/**
 * Register the guard on a Cordis context. Services are looked up at event time, so the guard is a no-op
 * when no compaction backend or token meter is mounted.
 * @param {any} ctx
 * @param {typeof GUARD_DEFAULTS} [config]
 */
export function installContextGuard(ctx, config = GUARD_DEFAULTS) {
  /** session id → { turn, step, failures, compactions } */
  const steps = new Map()

  /** Compact the oldest chunks until the session is under `target`; at most maxCompactionsPerStep passes. */
  async function compactDownTo(agent, target, signal, why) {
    const lookup = (name) => agent.ctx?.get?.(name) ?? ctx.get(name)
    const compaction = lookup('compaction')
    const meter = lookup('tokenMeter')
    if (compaction?.compactRegion === undefined || meter === undefined) return 0
    let passes = 0
    let measurement = meter.measure(agent.session)
    const before = measurement.totalTokens
    while (measurement.totalTokens >= target && passes < config.maxCompactionsPerStep && !signal?.aborted) {
      const chunk = oldestChunk(agent.session, measurement, config.chunkTokens)
      if (chunk === null) break
      const generation = agent.session.surface.replaceGeneration
      await compaction.compactRegion(chunk.start, chunk.end, agent, signal)
      if (agent.session.surface.replaceGeneration <= generation) break
      passes += 1
      measurement = meter.measure(agent.session)
    }
    if (passes > 0) ctx.logger.info(`context guard (${why}): ${before} -> ${measurement.totalTokens} tokens in ${passes} pass(es)`)
    return passes
  }

  // Early compaction: keeps a long session far below the size where provider transports start failing.
  // Runs before the step's request is built; a failure only logs, the step always continues.
  if (config.earlyCompactTokens > 0) {
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      try {
        const meter = agent.ctx?.get?.('tokenMeter') ?? ctx.get('tokenMeter')
        if (!signal?.aborted && meter !== undefined && meter.measure(agent.session).totalTokens >= config.earlyCompactTokens) {
          await compactDownTo(agent, config.earlyTargetTokens, signal, 'early')
        }
      } catch (error) {
        ctx.logger.warn(`context guard: early compaction failed (${error?.message ?? error}); continuing the step`)
      }
      return next()
    })
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'assistant/message') steps.delete(session.id)
  })

  ctx.on('agent/request-error', async ({ agent, turn, step, failure, signal }, next) => {
    if (signal?.aborted) return next()
    const id = agent.session.id
    let s = steps.get(id)
    if (s === undefined || s.turn !== turn || s.step !== step) {
      s = { turn, step, failures: 0, compactions: 0 }
      steps.set(id, s)
    }
    s.failures += 1
    // The compaction backend lives inside the agent's preset (an isolated group), so the host context does
    // not see it; the agent's own context does. The token meter is host-plane but resolves either way.
    const lookup = (name) => agent.ctx?.get?.(name) ?? ctx.get(name)
    const compaction = lookup('compaction')
    const meter = lookup('tokenMeter')
    if (compaction?.compactRegion === undefined || meter === undefined) return next()
    try {
      const measurement = meter.measure(agent.session)
      if (!shouldCompactOnFailure({ code: failure?.code, totalTokens: measurement.totalTokens,
        failures: s.failures, compactionsThisStep: s.compactions }, config)) return next()
      const chunk = oldestChunk(agent.session, measurement, config.chunkTokens)
      if (chunk === null) return next()
      const generation = agent.session.surface.replaceGeneration
      const result = await compaction.compactRegion(chunk.start, chunk.end, agent, signal)
      if (signal?.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      s.compactions += 1
      ctx.logger.info(`context guard: ${failure.code} on a ${measurement.totalTokens}-token request; compacted seqs `
        + `${chunk.start}-${chunk.end} (${result?.shadowedSeqs?.length ?? '?'} nodes), retrying`)
      return { kind: 'retry' }
    } catch (error) {
      ctx.logger.warn(`context guard: compaction failed (${error?.message ?? error}); leaving the failure to llm-retry`)
      return next()
    }
  }, { prepend: true })
}
