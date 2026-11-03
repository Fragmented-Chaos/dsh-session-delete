/**
 * Session delete — Host half.
 *
 * DSH ships no delete for a Session: `sessionController` and `sessions` only
 * create, rename, fork and cancel, and the Workspace registry only archives. So
 * the closest thing to a delete is "archive it, then remove its files":
 *
 *   1. refuse a Session with work in flight — the user stops it first, because
 *      silently killing a running turn is how work disappears;
 *   2. archive it. Archiving is the only *durable* way to keep the row out of
 *      the sidebar: the row survives on the Host (a live Session cannot be
 *      disposed by a plugin), so a refresh re-lists anything that was only
 *      removed from the client's view, while an archived row stays hidden by
 *      the default filter;
 *   3. remove the Session's directories under $DSH_HOME/sessions;
 *   4. announce `api-session/removed` so the row leaves every surface now rather
 *      than after the next refresh, and drop the pin entry.
 *
 * The archive entry itself is swept on the next start (`pruneStaleArchives`):
 * once the files are gone nothing can open that Session, so the entry is pure
 * residue by then.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { appendFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'session-delete'
export const inject = ['webServer']

const ROUTE = '/api/dsh-session-delete/delete'
const STATE_ROUTE = '/api/dsh-session-delete/state'

/** Keep the diagnostics log bounded; it is append-only and never read back. */
const LOG_MAX_BYTES = 512 * 1024

/**
 * `session-<uuid>` for a normal Session, a bare `<uuid>` for a subagent Session;
 * the character class is what blocks a path-traversal attempt, so no `/`, `.` or
 * `\` can reach `join()`.
 */
export const SESSION_ID = /^(?:session-)?[0-9a-f][0-9a-f-]{19,}$/i

/** What the route does with one request. */
export const DECISIONS = /** @type {const} */ (
  ['refuse-running', 'not-found', 'leftover', 'delete']
)

/**
 * Decide what to do with one Session from the facts the route collected.
 *
 * Pulled out of the route because it is the only part with branching that a test
 * can pin down without a Host: every step after it is I/O.
 * @param facts - activity families, Workspace account, on-disk directories, registry entries, live copy.
 * @returns one of {@link DECISIONS}.
 */
export function decide(facts) {
  if ((facts.activity ?? []).length > 0) return 'refuse-running'
  if (!facts.inAccount && (facts.directories ?? 0) === 0) {
    const trace = facts.archivedEntry || facts.pinnedEntry || facts.live
    return trace ? 'leftover' : 'not-found'
  }
  return 'delete'
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function writeJson(response, status, body) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

/** A delete request carries one id; anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 16 * 1024

/** One route-level failure that has its own status code. */
export class RouteError extends Error {
  /** @param status - HTTP status to answer with. @param code - stable error code. @param message - human text. */
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    // Refuse before buffering an unbounded body into memory.
    if (size > MAX_BODY_BYTES) throw new RouteError(413, 'payload-too-large', '请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Every `sessions/<cwd-slug>/<sessionId>` directory on disk for this Session. */
export function findSessionDirectories(sessionId) {
  const root = join(dshHome(), 'sessions')
  const found = []
  if (!existsSync(root)) return found
  for (const cwdDir of readdirSync(root)) {
    const target = join(root, cwdDir, sessionId)
    if (existsSync(target)) found.push(target)
  }
  return found
}

/** Remove the directories found above; a failure is reported per path, never thrown. */
export function removeSessionDirectories(paths) {
  const removed = []
  for (const target of paths) {
    try {
      rmSync(target, { recursive: true, force: true })
      removed.push(target)
    } catch (error) {
      // Keep going: one unreadable copy must not block the others.
      removed.push(`${target} (failed: ${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return removed
}

/**
 * Ask the same waterfall the shipped archive dialog asks:
 * `workspace/session-activity` reports the turn, subagents, jobs and reminders
 * still alive for a Session.
 *
 * Do not probe the Agent registry instead. `agents.get(id)` keeps returning a
 * handle for an idle Session that some surface still holds open, so "an Agent
 * exists" says nothing about whether work is running — a live-handle test
 * refuses every delete. A throwing provider fails open: refusing every delete
 * would be worse than the narrow window this covers.
 */
async function readActivity(ctx, sessionId) {
  try {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return Array.isArray(activity) ? activity : []
  } catch {
    return []
  }
}

/** Turn the reported families into the one line the dialog shows. */
export function describeActivity(activity) {
  const labels = { turn: '进行中的回合', subagent: '子代理', job: '后台任务', schedule: '定时提醒' }
  const seen = []
  for (const entry of activity) {
    const family = labels[entry?.kind] ?? String(entry?.kind ?? '工作')
    if (!seen.includes(family)) seen.push(family)
  }
  return seen.length === 0 ? '工作' : seen.slice(0, 3).join('、')
}

/**
 * One line per attempt in `$DSH_HOME/session-delete.log`: what the activity
 * waterfall said and what the route decided. The dialog can only show one
 * message and a delete has no undo, so the reason a Session survived has to be
 * readable after the fact.
 */
export async function logAttempt(record) {
  const path = join(dshHome(), 'session-delete.log')
  try {
    try {
      if (statSync(path).size > LOG_MAX_BYTES) await rename(path, `${path}.1`)
    } catch { /* no log yet, nothing to rotate */ }
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    /* diagnostics only: never fail a delete over its own log line */
  }
}

/**
 * Tell every open surface this Session is gone, the way the Host does when it
 * disposes one.
 *
 * The Host drops a row by emitting `api-session/removed` on `session/disposed`,
 * and that disposal belongs to whoever created the Session — no plugin can
 * trigger it. Archiving alone would leave the row in the archive view until the
 * next refresh; the event is what makes it leave now. It touches no runtime
 * state.
 */
function announceRemoved(ctx, sessionId) {
  try {
    ctx.emit?.('api-session/removed', sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * Every Session id this process can still reach: a live Agent, a live Session, or
 * a row in the session-query index the sidebar reads.
 *
 * A deleted Session keeps its archive entry on purpose (that entry is what hides
 * the row from the default filter), so "prune everything archived without files"
 * would un-hide exactly what was just deleted: the files are gone while the Host
 * still holds the Session live and the index still lists it.
 */
export async function knownSessionIds(ctx) {
  const known = new Set()
  let sources = 0
  try {
    const agents = ctx.get('agents', false)?.list?.()
    if (Array.isArray(agents)) sources += 1
    for (const agent of agents ?? []) known.add(String(agent?.id ?? ''))
  } catch { /* no agent registry: rely on the other two sources */ }
  try {
    const sessions = ctx.get('sessions', false)?.list?.()
    if (Array.isArray(sessions)) sources += 1
    for (const session of sessions ?? []) known.add(String(session?.id ?? ''))
  } catch { /* no live session store */ }
  try {
    const query = ctx.get('sessionQuery', false)
    const rows = await query?.listSessions?.(new AbortController().signal)
    const list = Array.isArray(rows) ? rows : (rows?.sessions ?? [])
    sources += 1
    for (const row of list) known.add(String(row?.sessionId ?? row?.id ?? row?.header?.id ?? ''))
  } catch { /* no query index: the live sources still cover this process */ }
  known.delete('')
  return { ids: known, complete: sources > 0 }
}

/**
 * Drop archive entries whose Session no longer exists anywhere: the residue of a
 * delete from an earlier run, once the app rebuilt its list from disk.
 *
 * Only ids this process cannot reach and that have no directories are pruned, so
 * a reload cannot un-hide a Session deleted in the same run.
 * @param ctx - plugin context.
 * @param overrides - test seams for the registry and the reachable-id set.
 * @returns the pruned ids.
 */
export async function pruneStaleArchives(ctx, overrides = {}) {
  const registry = overrides.registry ?? ctx.get('workspaceRegistry', false)
  if (!registry || !Array.isArray(registry.archivedSessionIds)) return { pruned: [] }
  const derived = overrides.known !== undefined
    ? { ids: overrides.known, complete: true }
    : await knownSessionIds(ctx)
  // Fail closed: if no source could be read, every archived id looks unreachable
  // and the sweep would un-hide Sessions that are merely not visible right now.
  if (!derived.complete) return { pruned: [], skipped: 'no-source' }
  const known = derived.ids
  const directoriesOf = overrides.directories ?? findSessionDirectories
  const pruned = []
  for (const raw of registry.archivedSessionIds) {
    const sessionId = String(raw)
    if (!SESSION_ID.test(sessionId)) continue
    if (known.has(sessionId)) continue
    if (directoriesOf(sessionId).length > 0) continue
    try {
      await registry.unarchiveSession?.(sessionId)
      pruned.push(sessionId)
    } catch {
      /* keep the entry: a failed write is not a reason to lose track of it */
    }
  }
  return { pruned }
}

/**
 * Authenticate one request and answer every outcome as JSON.
 * @param ctx - plugin context.
 * @param handle - the route body.
 * @returns the web-server handler.
 */
export function guarded(ctx, handle) {
  /**
   * Plugin routes sit outside the shell's page gate: an `exact` route registered
   * here is matched before the authenticated index/API mux, so without this check
   * a request with no browser cookie would be served. Ask the connection service
   * for the same answer the page gets. A composition without that service cannot
   * have been given a cookie either, so it fails open.
   */
  const authorized = (request, response) => {
    const connection = ctx.get('connection', false)
    if (typeof connection?.authorizeIndex !== 'function') return true
    return connection.authorizeIndex(request, response) === true
  }

  return async (request, response) => {
    try {
      if (!authorized(request, response)) return
      await handle(request, response)
    } catch (error) {
      if (error instanceof RouteError) {
        writeJson(response, error.status, { ok: false, error: error.code, message: error.message })
        return
      }
      // An unhandled throw reaches the client as a bare 400 with no body, and the
      // delete may already be half done: always answer with the reason.
      writeJson(response, 500, {
        ok: false,
        error: 'internal',
        message: '删除过程中发生错误',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

export function apply(ctx) {
  const logger = ctx.logger ?? console

  // Startup sweep: archive entries whose files are gone cannot be opened, and a
  // delete made in an earlier run leaves exactly that.
  ctx.effect(() => {
    void pruneStaleArchives(ctx).then(({ pruned }) => {
      if (pruned.length > 0) logger.info?.(`session-delete: pruned ${pruned.length} stale archive entr${pruned.length === 1 ? 'y' : 'ies'}`)
    })
  })

  /** The delete route. */
  const deleteRoute = async (request, response) => {
    if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
      writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }

    const body = await readJsonBody(request)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!SESSION_ID.test(sessionId)) {
      writeJson(response, 400, { ok: false, error: 'invalid-session-id' })
      return
    }

    const activity = await readActivity(ctx, sessionId)
    const registry = ctx.get('workspaceRegistry', false)

    // `dryRun` answers the only question that can refuse a delete without
    // removing anything: the probe a caller (or a test) uses.
    if (body?.dryRun === true) {
      writeJson(response, 200, {
        ok: true,
        dryRun: true,
        sessionId,
        activity: activity.map((entry) => entry?.kind ?? 'other'),
        wouldRefuse: activity.length > 0,
        reason: activity.length > 0 ? describeActivity(activity) : undefined,
        directories: findSessionDirectories(sessionId).length,
      })
      return
    }

    // A Session with work in flight is NOT deleted and NOT stopped: the user
    // stops it themselves and comes back.
    if (activity.length > 0) {
      await logAttempt({
        at: new Date().toISOString(),
        sessionId,
        decision: 'refuse-running',
        activity: activity.map((entry) => entry?.kind ?? 'other'),
      })
      writeJson(response, 409, {
        ok: false,
        error: 'session-running',
        message: `会话仍在运行（${describeActivity(activity)}），请先停止后再删除`,
        activity: activity.map((entry) => entry?.kind ?? 'other'),
      })
      return
    }

    if (!registry || typeof registry.list !== 'function') {
      writeJson(response, 503, {
        ok: false,
        error: 'registry-unavailable',
        message: '工作区注册表不可用，未执行删除',
      })
      return
    }

    const directories = findSessionDirectories(sessionId)
    const inAccount = (registry.list?.() ?? []).some((workspace) =>
      Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId))
    const archivedEntry = (registry.archivedSessionIds ?? []).includes(sessionId)
    const pinnedEntry = (registry.pinnedSessionIds ?? []).includes(sessionId)
    const live = ctx.get('sessions', false)?.get?.(sessionId) !== undefined

    const decision = decide({ activity, inAccount, directories: directories.length, archivedEntry, pinnedEntry, live })

    if (decision === 'not-found') {
      await logAttempt({ at: new Date().toISOString(), sessionId, decision, directories })
      writeJson(response, 404, { ok: false, error: 'not-found', message: '会话不存在，可能已被删除' })
      return
    }

    if (decision === 'leftover') {
      // Files and account slot are already gone; what still names the Session is
      // a stale archive/pin entry or the Host's live copy. Clear it.
      const cleared = await clearRegistryEntries(registry, sessionId, { archivedEntry, pinnedEntry })
      const announced = announceRemoved(ctx, sessionId)
      await logAttempt({ at: new Date().toISOString(), sessionId, decision, activity: [], announced, cleared })
      writeJson(response, 200, { ok: true, sessionId, leftover: true, announced, cleared, removed: [] })
      return
    }

    // 1. Archive first: this is the durable hide, and it also clears the current
    //    selection when this Session is the one on screen.
    try {
      await registry.archiveSession(sessionId)
    } catch (error) {
      await logAttempt({
        at: new Date().toISOString(),
        sessionId,
        decision: 'archive-failed',
        detail: error instanceof Error ? error.message : String(error),
      })
      writeJson(response, 500, {
        ok: false,
        error: 'archive-failed',
        message: '暂时无法从列表中移除该会话，未执行删除',
        detail: error instanceof Error ? error.message : String(error),
      })
      return
    }

    // 2. Drop the files. A row that outlives its log is exactly the ghost the
    //    archived state hides meanwhile.
    const removed = removeSessionDirectories(directories)
    const failed = removed.filter((path) => path.includes(' (failed: '))
    if (failed.length > 0) {
      await logAttempt({ at: new Date().toISOString(), sessionId, decision: 'remove-failed', removed })
      writeJson(response, 500, {
        ok: false,
        error: 'remove-failed',
        message: '部分目录删除失败，请稍后重试',
        removed,
      })
      return
    }

    // 3. Take the row off every surface now instead of at the next refresh.
    const announced = announceRemoved(ctx, sessionId)
    if (!announced) logger.warn?.(`session-delete: could not announce removal of ${sessionId}`)

    // 4. Archive drops the pin in the same write; nothing else to clear.
    const cleared = { archived: true, pinned: pinnedEntry }

    logger.info?.(`session-delete: ${sessionId} removed=${removed.length} announced=${announced}`)
    await logAttempt({
      at: new Date().toISOString(),
      sessionId,
      decision: 'deleted',
      activity: [],
      announced,
      cleared,
      removed,
    })
    writeJson(response, 200, { ok: true, sessionId, announced, cleared, removed })
  }

  /**
   * Read-only probe: what this Host currently believes about every Session it can
   * see, plus the rows the session-query index still holds. Development aid, kept
   * behind the same authentication as the delete route.
   */
  const stateRoute = async (_request, response) => {
    const registry = ctx.get('workspaceRegistry', false)
    const agents = ctx.get('agents', false)
    let liveAgents = []
    try {
      liveAgents = (agents?.list?.() ?? []).map((agent) => ({
        id: String(agent?.id ?? agent?.sessionId ?? ''),
        status: agent?.status ?? null,
      }))
    } catch (error) {
      liveAgents = [{ id: '', status: 'list-failed', error: String(error) }]
    }
    const sessionIds = (registry?.list?.() ?? []).flatMap((workspace) =>
      [...(workspace.sessionIds ?? [])].map(String))
    const activity = {}
    for (const id of sessionIds) activity[id] = (await readActivity(ctx, id)).map((entry) => entry?.kind ?? 'other')
    let indexed = []
    try {
      const query = ctx.get('sessionQuery', false)
      const rows = await query?.listSessions?.(new AbortController().signal)
      const list = Array.isArray(rows) ? rows : (rows?.sessions ?? [])
      indexed = list.map((row) => String(row?.sessionId ?? row?.id ?? row?.header?.id ?? ''))
    } catch (error) {
      indexed = [`list-failed: ${String(error)}`]
    }
    writeJson(response, 200, {
      ok: true,
      liveAgents,
      sessions: sessionIds.length,
      archived: [...(registry?.archivedSessionIds ?? [])].map(String),
      indexed,
      busy: Object.entries(activity).filter(([, kinds]) => kinds.length > 0).map(([id, kinds]) => ({ id, kinds })),
    })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: guarded(ctx, deleteRoute) }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: STATE_ROUTE, handler: guarded(ctx, stateRoute) }))
}

/** Drop the registry bookkeeping a delete should leave nothing of. */
async function clearRegistryEntries(registry, sessionId, { archivedEntry, pinnedEntry }) {
  const cleared = { archived: false, pinned: false }
  if (archivedEntry) {
    try {
      await registry.unarchiveSession?.(sessionId)
      cleared.archived = true
    } catch { /* the row is still announced away */ }
  }
  if (pinnedEntry) {
    try {
      await registry.unpinSession?.(sessionId)
      cleared.pinned = true
    } catch { /* a stale pin only affects ordering */ }
  }
  return cleared
}
