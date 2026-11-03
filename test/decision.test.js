/**
 * Unit tests for the parts of the Host half that do not need a running Host:
 * the id guard, the decision table, and the activity wording.
 *
 * Run with `node --test` from the plugin directory.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DECISIONS, SESSION_ID, decide, describeActivity, guarded, pruneStaleArchives, readJsonBody } from '../index.js'

test('SESSION_ID accepts the two real shapes and nothing else', () => {
  assert.ok(SESSION_ID.test('session-10ebbe25-3f39-4165-8a52-f7933ab22d13'))
  assert.ok(SESSION_ID.test('99af1ae5-9373-4c32-99ec-8b207ce7ec2f'))
  // Traversal, absolute paths, empty and short values must never reach join().
  assert.ok(!SESSION_ID.test('../session-10ebbe25-3f39-4165-8a52-f7933ab22d13'))
  assert.ok(!SESSION_ID.test('session-../../etc/passwd'))
  assert.ok(!SESSION_ID.test('/etc/passwd'))
  assert.ok(!SESSION_ID.test(''))
  assert.ok(!SESSION_ID.test('session-123'))
})

test('decide refuses a Session with any activity before looking at the files', () => {
  assert.equal(decide({
    activity: [{ kind: 'turn' }],
    inAccount: true,
    directories: 1,
    archivedEntry: false,
    pinnedEntry: false,
    live: true,
  }), 'refuse-running')
  // Every family counts, not just a turn.
  for (const kind of ['subagent', 'job', 'schedule']) {
    assert.equal(decide({ activity: [{ kind }], inAccount: true, directories: 1 }), 'refuse-running')
  }
})

test('decide deletes a Session that has an account slot or files', () => {
  const base = { activity: [], archivedEntry: false, pinnedEntry: false, live: false }
  assert.equal(decide({ ...base, inAccount: true, directories: 0 }), 'delete')
  assert.equal(decide({ ...base, inAccount: false, directories: 2 }), 'delete')
})

test('decide treats a session-less trace as leftover, and nothing at all as not-found', () => {
  const base = { activity: [], inAccount: false, directories: 0, archivedEntry: false, pinnedEntry: false, live: false }
  assert.equal(decide(base), 'not-found')
  assert.equal(decide({ ...base, archivedEntry: true }), 'leftover')
  assert.equal(decide({ ...base, pinnedEntry: true }), 'leftover')
  assert.equal(decide({ ...base, live: true }), 'leftover')
})

test('decide only ever returns a known decision', () => {
  for (const activity of [[], [{ kind: 'turn' }]]) {
    for (const inAccount of [true, false]) {
      for (const directories of [0, 1]) {
        for (const archivedEntry of [true, false]) {
          const decision = decide({ activity, inAccount, directories, archivedEntry, pinnedEntry: false, live: false })
          assert.ok(DECISIONS.includes(decision), `${decision} is not a known decision`)
        }
      }
    }
  }
})

test('describeActivity names families once, in order, and caps the line', () => {
  assert.equal(describeActivity([{ kind: 'turn' }]), '进行中的回合')
  assert.equal(describeActivity([{ kind: 'turn' }, { kind: 'turn' }]), '进行中的回合')
  assert.equal(
    describeActivity([{ kind: 'turn' }, { kind: 'job' }, { kind: 'subagent' }]),
    '进行中的回合、后台任务、子代理',
  )
  // A family this build does not know falls through to its raw key.
  assert.equal(describeActivity([{ kind: 'plugin-work' }]), 'plugin-work')
  // An empty report still reads as a sentence.
  assert.equal(describeActivity([]), '工作')
  assert.equal(
    describeActivity([{ kind: 'turn' }, { kind: 'job' }, { kind: 'schedule' }, { kind: 'subagent' }]),
    '进行中的回合、后台任务、定时提醒',
  )
})

test('guarded refuses to run the route when the connection service says no', async () => {
  let ran = false
  const ctx = {
    get: (name) => (name === 'connection' ? { authorizeIndex: () => false } : undefined),
  }
  const handler = guarded(ctx, async () => { ran = true })
  const response = fakeResponse()
  await handler(fakeRequest(), response)
  assert.equal(ran, false)
  assert.equal(response.status, undefined, 'the auth service owns the response when it refuses')
})

test('guarded runs the route once authenticated', async () => {
  let ran = false
  const ctx = {
    get: (name) => (name === 'connection' ? { authorizeIndex: () => true } : undefined),
  }
  await guarded(ctx, async () => { ran = true })(fakeRequest(), fakeResponse())
  assert.equal(ran, true)
})

test('guarded answers JSON when the route throws', async () => {
  const ctx = { get: () => undefined }
  const response = fakeResponse()
  await guarded(ctx, async () => { throw new Error('boom') })(fakeRequest(), response)
  assert.equal(response.status, 500)
  assert.equal(JSON.parse(response.body).error, 'internal')
})

/** Minimal node:http response stand-in that records what the handler wrote. */
function fakeResponse() {
  return {
    statusCode: undefined,
    body: '',
    get status() { return this.statusCode },
    setHeader() {},
    end(chunk) {
      this.statusCode ??= 200
      this.body += chunk ?? ''
    },
  }
}

function fakeRequest() {
  return { method: 'POST', url: '/api/dsh-session-delete/delete', headers: {} }
}

test('pruneStaleArchives drops only ids the process cannot reach and that have no files', async () => {
  const unarchived = []
  const registry = {
    archivedSessionIds: [
      'session-11111111-1111-1111-1111-111111111111', // unknown, no files → prune
      'session-22222222-2222-2222-2222-222222222222', // still reachable → keep
      'session-33333333-3333-3333-3333-333333333333', // unknown but has files → keep
      'not-a-session-id', // malformed → untouched
    ],
    unarchiveSession: async (id) => { unarchived.push(id) },
  }
  const { pruned } = await pruneStaleArchives({ get: () => undefined }, {
    registry,
    known: new Set(['session-22222222-2222-2222-2222-222222222222']),
    directories: (id) => (id.endsWith('3333-333333333333') ? ['/tmp/x'] : []),
  })
  assert.deepEqual(pruned, ['session-11111111-1111-1111-1111-111111111111'])
  assert.deepEqual(unarchived, pruned)
})

test('pruneStaleArchives is a no-op without a registry', async () => {
  assert.deepEqual(await pruneStaleArchives({ get: () => undefined }), { pruned: [] })
})

test('pruneStaleArchives does nothing when no reachability source could be read', async () => {
  const registry = {
    archivedSessionIds: ['session-44444444-4444-4444-4444-444444444444'],
    unarchiveSession: async () => { throw new Error('should not be called') },
  }
  // A ctx with no agents, no sessions and no query index: every source throws.
  const ctx = {
    get: (name) => {
      if (name === 'workspaceRegistry') return registry
      throw new Error(`no ${name}`)
    },
  }
  assert.deepEqual(await pruneStaleArchives(ctx), { pruned: [], skipped: 'no-source' })
})

test('an oversized body is refused with 413 before the route runs', async () => {
  let ran = false
  const handler = guarded({ get: () => undefined }, async (request) => {
    ran = true
    // Drain like the real route does; readJsonBody must throw on the giant chunk.
    await readJsonBody(request)
  })
  const response = fakeResponse()
  await handler(hugeRequest(17 * 1024), response)
  assert.equal(ran, true)
  assert.equal(response.status, 413)
  assert.equal(JSON.parse(response.body).error, 'payload-too-large')
})

/** A request body stream that reports one chunk larger than the cap. */
function hugeRequest(bytes) {
  return {
    method: 'POST',
    url: '/api/dsh-session-delete/delete',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(bytes, 0x61)
    },
  }
}
