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
 * It complements the cordis.patch.yml row that lowers compaction-basic's pressure threshold for the
 * 1M-window routes: that keeps healthy sessions small, this rescues one that is already too big.
 * @module dsh-plugin-general-improvements/context-guard
 */

/** Tunables; exported for the tests. */
export const GUARD_DEFAULTS = Object.freeze({
  /** A request below this is not suspected of being too big to send. */
  largeRequestTokens: 250000,
  /** Failures within one step before the guard acts (the first is llm-retry's). */
  failuresBeforeCompact: 2,
  /** Upper bound of history one compaction summarizes, so the summary call is a small request. */
  chunkTokens: 120000,
  /** Chunks compacted per step at most; then llm-retry's own budget decides. */
  maxCompactionsPerStep: 4,
})

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
    const compaction = ctx.get('compaction')
    const meter = ctx.get('tokenMeter')
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
