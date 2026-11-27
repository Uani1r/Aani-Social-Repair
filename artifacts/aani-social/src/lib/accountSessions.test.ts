import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_SESSIONS_SIGN_OUT_FAILED_MESSAGE,
  ACCOUNT_SESSIONS_UNAVAILABLE_MESSAGE,
  describeUserAgent,
  loadAccountSessions,
  mapAccountSessions,
  readSessionsPayload,
  signOutOtherDevices,
  type SessionsClient,
} from './accountSessions';

const ROWS = [
  {
    id: 'session-old',
    user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1',
    ip: '203.0.113.9',
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-02T10:00:00Z',
    refreshed_at: '2026-01-03T10:00:00Z',
  },
  {
    id: 'session-current',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
    ip: '203.0.113.10',
    created_at: '2026-01-04T10:00:00Z',
    updated_at: '2026-01-05T10:00:00Z',
    refreshed_at: null,
  },
];

test('the device line names the browser and the platform', () => {
  assert.equal(describeUserAgent(ROWS[0].user_agent), 'Safari · iPhone');
  assert.equal(describeUserAgent(ROWS[1].user_agent), 'Chrome · macOS');
  assert.equal(describeUserAgent('Mozilla/5.0 (Linux; Android 14) Chrome/126.0'), 'Chrome · Android');
  assert.equal(describeUserAgent(null), 'جهاز غير معروف');
});

test('sessions are mapped without tokens and the current session is marked', () => {
  const sessions = mapAccountSessions(ROWS, 'session-current');

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map(session => session.id), ['session-current', 'session-old']);
  assert.equal(sessions[0].current, true);
  assert.equal(sessions[1].current, false);
  for (const session of sessions) {
    assert.deepEqual(Object.keys(session).sort(), ['createdAt', 'current', 'device', 'id', 'lastActiveAt']);
    assert.equal(JSON.stringify(session).includes('203.0.113'), false, 'the IP must not be shown');
  }
});

test('the last activity falls back to updated_at and then to created_at', () => {
  const [current, older] = mapAccountSessions(ROWS, 'session-current');
  assert.equal(current.lastActiveAt, '2026-01-05T10:00:00Z');
  assert.equal(older.lastActiveAt, '2026-01-03T10:00:00Z');
});

test('invalid rows are dropped instead of rendered', () => {
  const sessions = mapAccountSessions([
    null,
    { id: '' },
    { id: 'x', created_at: 'not a date' },
    { id: 'y', created_at: '2026-01-01T00:00:00Z', user_agent: null },
  ], null);

  assert.deepEqual(sessions.map(session => session.id), ['y']);
  assert.equal(sessions[0].device, 'جهاز غير معروف');
  assert.equal(sessions[0].current, false);
});

test('a payload that is not a list is unavailable, never an empty account', () => {
  assert.deepEqual(readSessionsPayload(null, null), {
    status: 'unavailable',
    message: ACCOUNT_SESSIONS_UNAVAILABLE_MESSAGE,
  });
  assert.deepEqual(readSessionsPayload({ sessions: [] }, null), {
    status: 'unavailable',
    message: ACCOUNT_SESSIONS_UNAVAILABLE_MESSAGE,
  });
  assert.deepEqual(readSessionsPayload([], null), { status: 'ok', sessions: [] });
});

type Options = { listError?: unknown; signOutError?: unknown; currentSessionId?: string | null };

function createClient(options: Options = {}): SessionsClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listSessions: async () => {
      calls.push('list');
      return { data: options.listError ? null : ROWS, error: options.listError ?? null };
    },
    signOutOthers: async () => {
      calls.push('signOutOthers');
      return { error: options.signOutError ?? null };
    },
    getCurrentSessionId: async () => {
      calls.push('currentSession');
      return options.currentSessionId === undefined ? 'session-current' : options.currentSessionId;
    },
  };
}

test('loading sessions marks the current one and never invents rows on failure', async () => {
  const client = createClient();
  const result = await loadAccountSessions(client);

  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.sessions[0].current, true);
  assert.deepEqual(client.calls, ['currentSession', 'list']);

  const failed = await loadAccountSessions(createClient({ listError: { message: 'boom' } }));
  assert.deepEqual(failed, { status: 'unavailable', message: ACCOUNT_SESSIONS_UNAVAILABLE_MESSAGE });
});

test('signing out the other devices verifies the current session survived', async () => {
  const client = createClient();
  const result = await signOutOtherDevices(client);

  assert.equal(result.ok, true);
  assert.deepEqual(client.calls, ['signOutOthers', 'currentSession']);
});

test('a failed sign-out, or a lost current session, never reports success', async () => {
  const failed = await signOutOtherDevices(createClient({ signOutError: { message: 'boom' } }));
  assert.deepEqual(failed, { ok: false, message: ACCOUNT_SESSIONS_SIGN_OUT_FAILED_MESSAGE });

  const lost = await signOutOtherDevices(createClient({ currentSessionId: null }));
  assert.deepEqual(lost, { ok: false, message: ACCOUNT_SESSIONS_SIGN_OUT_FAILED_MESSAGE });
});
