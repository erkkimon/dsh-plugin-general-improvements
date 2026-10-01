/**
 * dsh-plugin-general-improvements — host half.
 *
 * Improvement 1: sidebar attention marks.
 * Improvement 4: environment context (user, host, Wi-Fi, location) for the model.
 *
 *  - A session projection (`improvementsAttention`) folds every `turn/end`
 *    event and remembers the LAST turn that did not end well (LLM error,
 *    interrupted by a host crash, blocked by a hook, max-tokens, aborted by
 *    something other than the user). The value rides the ordinary
 *    projection wire, so the Web client sees it live for every listed
 *    session — not only the open one.
 *  - A tiny JSON flag store (`$DSH_HOME/storages/dsh-plugin-general-improvements/session-flags.json`)
 *    keeps the manual state: "error mark cleared up to seq N" and "marked
 *    unread". Nothing in here expires on its own; only the user clears it.
 *  - Two HTTP routes on the dsh web server give the client the complete
 *    picture (including cold sessions that were never checkpointed with the
 *    new projection key) and accept flag updates.
 *
 * @module dsh-plugin-general-improvements
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import path from 'node:path'

export const ATTENTION_KEY = 'improvementsAttention'
// v2: a turn that ends well (or is stopped on purpose) now clears `lastError`,
// so the mark only reflects the LAST turn. Bumping the version makes the
// durable projection cache refold old sessions with the new rule.
const STATE_VERSION = 2
const ROUTE_PREFIX = '/general-improvements'

// ---------------------------------------------------------------------------
// Attention fold (shared by the live projection and the cold backfill)
// ---------------------------------------------------------------------------

/**
 * Turn-end reasons that mean "the user or the parent agent stopped it on
 * purpose" — nothing to flag.
 */
const BENIGN_ABORTS = new Set(['user', 'parent'])

/** @returns {{ lastError: null }} */
function initialAttention() {
  return { lastError: null }
}

/** Human-readable one-liner for a non-ok turn end. */
function describeReason(reason) {
  switch (reason?.kind) {
    case 'error': {
      const err = reason.error ?? {}
      const code = typeof err.code === 'string' && err.code !== 'UNKNOWN' ? `[${err.code}] ` : ''
      return `${code}${typeof err.message === 'string' ? err.message : 'LLM error'}`
    }
    case 'interrupted':
      return 'Turn was interrupted (host stopped or crashed mid-turn)'
    case 'blocked':
      return 'Turn was blocked before the next step (hook or driver rejected it)'
    case 'max-tokens':
      return 'Model hit its output token limit'
    case 'aborted': {
      const cause = reason.reason?.kind
      if (cause === 'hook') {
        const why = reason.reason?.reason
        return `Aborted by a hook${typeof why === 'string' && why !== '' ? `: ${why}` : ''}`
      }
      return `Aborted (${typeof cause === 'string' ? cause : 'unknown cause'})`
    }
    default:
      return `Turn ended abnormally (${String(reason?.kind)})`
  }
}

/** Is this `turn/end` reason worth a red mark? */
function needsAttention(reason) {
  const kind = reason?.kind
  if (kind === 'completed' || kind === undefined) return false
  if (kind === 'aborted') return !BENIGN_ABORTS.has(reason.reason?.kind)
  return true
}

/**
 * Fold one session event into the attention state. Returns the SAME
 * reference when the event is not interesting (projection contract).
 */
function applyAttention(state, event) {
  if (event.type !== 'turn/end') return state
  const reason = event.data?.reason
  // Only the LAST turn counts: a turn that ended well (or was stopped on
  // purpose) wipes an older failure.
  if (!needsAttention(reason)) return state.lastError === null ? state : initialAttention()
  return {
    lastError: {
      kind: String(reason.kind),
      message: describeReason(reason).slice(0, 2000),
      seq: event.seq,
      time: typeof event.time === 'number' ? event.time : null,
      turn: typeof event.data.turn === 'number' ? event.data.turn : null,
    },
  }
}

/**
 * Minimal `parse` contract the projection registry needs (it only ever calls
 * `schema.parse(value)`), so the plugin does not depend on zod being
 * resolvable from its own directory.
 */
const attentionSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object') throw new TypeError('improvementsAttention: state must be an object')
    const e = value.lastError
    if (e === null || e === undefined) return { lastError: null }
    if (typeof e !== 'object' || typeof e.kind !== 'string' || typeof e.message !== 'string' || !Number.isSafeInteger(e.seq)) {
      throw new TypeError('improvementsAttention: malformed lastError')
    }
    return value
  },
}

// ---------------------------------------------------------------------------
// Flag store
// ---------------------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

class FlagStore {
  constructor(file) {
    this.file = file
    /** @type {Record<string, { clearedSeq: number, clearedAt: number, unread: boolean }>} */
    this.flags = {}
    this.loaded = this.load()
    this.writeQueue = Promise.resolve()
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8')
      const data = JSON.parse(raw)
      if (data && typeof data === 'object' && data.flags && typeof data.flags === 'object') this.flags = data.flags
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`[dsh-plugin-general-improvements] cannot read ${this.file}: ${error?.message ?? error}`)
    }
  }

  get(id) {
    return this.flags[id] ?? { clearedSeq: -1, clearedAt: 0, unread: false }
  }

  set(id, patch) {
    const next = { ...this.get(id), ...patch }
    if (next.clearedSeq === -1 && next.clearedAt === 0 && !next.unread) delete this.flags[id]
    else this.flags[id] = next
    this.persist()
    return this.get(id)
  }

  /** Drop flags of sessions that no longer exist (called after a listing). */
  prune(existingIds) {
    let changed = false
    for (const id of Object.keys(this.flags)) {
      if (!existingIds.has(id)) {
        delete this.flags[id]
        changed = true
      }
    }
    if (changed) this.persist()
  }

  persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ version: 1, flags: this.flags }, null, 2))
      await rename(tmp, this.file)
    }).catch((error) => {
      console.warn(`[dsh-plugin-general-improvements] cannot write ${this.file}: ${error?.message ?? error}`)
    })
    return this.writeQueue
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(value))
}


// ---------------------------------------------------------------------------
// Improvement 4: environment context
// ---------------------------------------------------------------------------

/** Re-send an unchanged environment this often, so a stale location's age stays honest. */
const ENV_REFRESH_MS = 30 * 60 * 1000
/** A location report older than this is not worth telling the model about. */
const LOCATION_MAX_AGE_MS = 12 * 60 * 60 * 1000
const WIFI_TTL_MS = 60 * 1000
const ENV_SOURCE = 'general-improvements/environment'

/** Who and where the agent runs; static for the life of the process. */
function identity() {
  let user = process.env.USER ?? ''
  try { user = userInfo().username } catch { /* keep env value */ }
  return { user, host: hostname() }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (error, stdout) => resolve(error ? '' : String(stdout).trim()))
  })
}

/** Does this machine have a Wi-Fi radio at all? Cheap sysfs check, cached. */
let hasWifi
async function hostHasWifi() {
  if (hasWifi !== undefined) return hasWifi
  try {
    const names = await readdir('/sys/class/net')
    let found = false
    for (const name of names) {
      try { await readdir(`/sys/class/net/${name}/wireless`); found = true; break } catch { /* not wireless */ }
    }
    hasWifi = found
  } catch {
    hasWifi = false
  }
  return hasWifi
}

let wifiCache = { at: 0, value: null }
/** SSID the DSH host itself is joined to, or null (no radio / not associated / no tool). */
async function hostWifiName() {
  if (Date.now() - wifiCache.at < WIFI_TTL_MS) return wifiCache.value
  let value = null
  if (await hostHasWifi()) {
    value = (await run('iwgetid', ['-r'])) || null
    if (value === null) {
      const out = await run('nmcli', ['-t', '-f', 'active,ssid', 'dev', 'wifi'])
      const line = out.split('\n').find((l) => l.startsWith('yes:'))
      // `nmcli -t` backslash-escapes ':' and '\' inside a field.
      if (line) value = line.slice(4).replace(/\\([:\\])/g, '$1') || null
    }
  }
  wifiCache = { at: Date.now(), value }
  return value
}

/** Latest report from a browser, held in memory only (never written to disk by this plugin). */
class ClientContext {
  constructor() { this.report = null }

  /** @param {unknown} body */
  set(body) {
    if (body === null || typeof body !== 'object') throw new TypeError('body must be an object')
    if (body.clear === true) { this.report = null; return }
    const lat = Number(body.lat)
    const lon = Number(body.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new TypeError('lat/lon out of range')
    }
    const accuracy = Number(body.accuracy)
    const net = body.network !== null && typeof body.network === 'object' ? body.network : {}
    this.report = {
      lat,
      lon,
      accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null,
      network: {
        type: typeof net.type === 'string' ? net.type.slice(0, 20) : null,
        effectiveType: typeof net.effectiveType === 'string' ? net.effectiveType.slice(0, 20) : null,
      },
      device: typeof body.device === 'string' ? body.device.slice(0, 20) : null,
      at: Date.now(),
    }
  }

  fresh() {
    if (this.report === null) return null
    return Date.now() - this.report.at > LOCATION_MAX_AGE_MS ? null : this.report
  }
}

function formatAge(ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`
}

/**
 * The model-facing text and a key that changes only when a fact changes
 * (coordinates rounded to ~11 m, no ages), so an unchanged environment is not
 * repeated on every step.
 */
async function environmentText(clientContext) {
  const { user, host } = identity()
  const wifi = await hostWifiName()
  const loc = clientContext.fresh()
  const lines = [`Agent runs as user "${user}" on host "${host}".`]
  const keyParts = [user, host, wifi ?? '']
  if (wifi !== null) lines.push(`That host is connected to the Wi-Fi network "${wifi}".`)
  if (loc !== null) {
    const coords = `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`
    const acc = loc.accuracy === null ? '' : ` (accuracy ±${loc.accuracy} m)`
    const device = loc.device === null ? 'the user\'s browser' : `the user's ${loc.device} browser`
    lines.push(`User location as reported by ${device} ${formatAge(Date.now() - loc.at)}: ${coords}${acc}. This is where the user is, not necessarily where the host is.`)
    const netBits = [loc.network.type, loc.network.effectiveType].filter(Boolean)
    if (netBits.length > 0) lines.push(`The user's browser reports its network as: ${netBits.join(', ')}. (Browsers do not expose a Wi-Fi network name.)`)
    keyParts.push(coords, netBits.join('/'))
  }
  return { text: lines.join('\n'), key: keyParts.join('|') }
}

/** A frozen plugin user message, built without importing dsh-llm (not resolvable from this directory). */
function environmentMessage(text) {
  const message = {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: ENV_SOURCE, form: 'snapshot', sections: [{ name: 'environment', text }] },
    id: randomUUID(),
  }
  const freeze = (value) => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value)
      for (const child of Object.values(value)) freeze(child)
    }
    return value
  }
  return freeze(message)
}

function installEnvironmentContext(ctx) {
  const clientContext = new ClientContext()
  /** sessionId → { key, at } of the last injection into that session. */
  const lastInjected = new Map()

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/context`,
    async handler(req, res) {
      if (req.method === 'GET') {
        const { text } = await environmentText(clientContext)
        return sendJson(res, 200, { text, reported: clientContext.report !== null })
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        clientContext.set(JSON.parse((await readBody(req)).toString('utf8') || '{}'))
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 400, { error: error?.message ?? String(error) })
      }
    },
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    try {
      const { text, key } = await environmentText(clientContext)
      const sessionId = agent.session.id
      const last = lastInjected.get(sessionId)
      if (last !== undefined && last.key === key && Date.now() - last.at < ENV_REFRESH_MS) return decision
      lastInjected.set(sessionId, { key, at: Date.now() })
      return { ...decision, messages: [...decision.messages, environmentMessage(text)] }
    } catch (error) {
      // Environment context is a nicety: never fail a model step over it.
      console.warn(`[dsh-plugin-general-improvements] environment context skipped: ${error?.message ?? error}`)
      return decision
    }
  }, { prepend: true })
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx) {
  installEnvironmentContext(ctx)

  const store = new FlagStore(path.join(dshHome(), 'storages', 'general-improvements', 'session-flags.json'))

  // 1. Live projection: every listed session carries `projectionValues.improvementsAttention`.
  ctx.sessionProjections.register({
    key: ATTENTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema: attentionSchema,
    init: () => initialAttention(),
    apply: applyAttention,
    wire: {
      viewSchema: attentionSchema,
      view: (state) => state,
    },
  })

  /**
   * Cold sessions (not attached in this process) were possibly never
   * checkpointed with our key, so the wire cannot serve them. Fold their log
   * once and memoize; a session that becomes live again is served from the
   * registry instead, and its memo is dropped.
   * @type {Map<string, Promise<object|null>>}
   */
  const coldMemo = new Map()
  ctx.on('session/created', (session) => {
    coldMemo.delete(session.id)
  })

  function coldAttention(id) {
    let pending = coldMemo.get(id)
    if (pending === undefined) {
      pending = ctx.sessionQuery.readSession(id).then((loaded) => {
        let state = initialAttention()
        for (const event of loaded.events) state = applyAttention(state, event)
        return state
      }).catch((error) => {
        console.warn(`[dsh-plugin-general-improvements] cannot fold cold session ${id}: ${error?.message ?? error}`)
        coldMemo.delete(id)
        return null
      })
      coldMemo.set(id, pending)
    }
    return pending
  }

  async function attentionFor(id) {
    const live = ctx.sessions.get(id)
    if (live !== undefined) {
      const state = ctx.sessionProjections.stateOf(live, ATTENTION_KEY)
      return state ?? initialAttention()
    }
    return coldAttention(id)
  }

  /** Everything the client needs to draw marks for every listed session. */
  async function fullState(signal) {
    await store.loaded
    const records = await ctx.sessionQuery.listSessions(signal)
    const ids = new Set(records.map((record) => record.header.id))
    store.prune(ids)
    const attention = {}
    await Promise.all(records.map(async (record) => {
      const state = await attentionFor(record.header.id)
      if (state?.lastError) attention[record.header.id] = state.lastError
    }))
    return { flags: store.flags, attention }
  }

  // 2. Routes.
  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/state`,
    async handler(req, res) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        sendJson(res, 200, await fullState())
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? String(error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/flags`,
    async handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = decodeURIComponent(url.pathname.slice(`${ROUTE_PREFIX}/flags/`.length))
      if (req.method === 'GET' && id === '') {
        await store.loaded
        return sendJson(res, 200, { flags: store.flags })
      }
      if (req.method !== 'POST' || id === '') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        await store.loaded
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const patch = {}
        if (body.clear === true) {
          const state = await attentionFor(id)
          patch.clearedSeq = state?.lastError?.seq ?? -1
          patch.clearedAt = Date.now()
        }
        if (typeof body.unread === 'boolean') patch.unread = body.unread
        const flags = store.set(id, patch)
        sendJson(res, 200, { id, flags })
      } catch (error) {
        sendJson(res, 400, { error: error?.message ?? String(error) })
      }
    },
  })
}

export const inject = ['agents', 'sessionProjections', 'sessionQuery', 'sessions', 'webServer']
