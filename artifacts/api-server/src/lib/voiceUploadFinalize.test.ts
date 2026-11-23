import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  VOICE_DELETION_ENQUEUE_ATTEMPTS,
  VOICE_LEDGER_ATTEMPTS,
  finalizeVoiceUpload,
  type VoiceFinalizeEvent,
} from './voiceUploadFinalize';

const URL = 'https://ik.imagekit.io/anisocial/aani/user-1/messages/msg-1.m4a';

interface Recorder {
  ledger: number;
  enqueued: number;
  deleted: number;
  events: VoiceFinalizeEvent[];
}

function createDeps(options: {
  ledgerFails?: boolean;
  ledgerFailsOnce?: boolean;
  enqueueFails?: boolean;
  liveReference?: boolean | 'throws';
}) {
  const calls: Recorder = { ledger: 0, enqueued: 0, deleted: 0, events: [] };
  const deps = {
    async recordLedger() {
      calls.ledger += 1;
      if (options.ledgerFails) throw new Error('ledger down');
      if (options.ledgerFailsOnce && calls.ledger === 1) throw new Error('transient');
    },
    async enqueueDeletion() {
      calls.enqueued += 1;
      if (options.enqueueFails) throw new Error('outbox down');
    },
    async hasLiveReference() {
      if (options.liveReference === 'throws') throw new Error('reference check failed');
      return options.liveReference === true;
    },
    async deleteUnreferenced() {
      calls.deleted += 1;
    },
    wait: async () => undefined,
    log: (event: VoiceFinalizeEvent) => { calls.events.push(event); },
  };
  return { calls, deps };
}

test('success is only reported after the ledger write succeeds', async () => {
  const { calls, deps } = createDeps({});
  const outcome = await finalizeVoiceUpload(URL, deps);

  assert.deepEqual(outcome, { ok: true });
  assert.equal(calls.ledger, 1);
  assert.equal(calls.enqueued, 0);
  assert.equal(calls.deleted, 0);
});

test('a transient ledger failure is retried before reporting success', async () => {
  const { calls, deps } = createDeps({ ledgerFailsOnce: true });
  const outcome = await finalizeVoiceUpload(URL, deps);

  assert.deepEqual(outcome, { ok: true });
  assert.equal(calls.ledger, 2);
});

test('ImageKit success + ledger failure schedules the file instead of leaving an unrecorded orphan', async () => {
  const { calls, deps } = createDeps({ ledgerFails: true });
  const outcome = await finalizeVoiceUpload(URL, deps);

  // لا نجاح للعميل
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'ledger-failed-cleaned');
  // حُوِّل الملف إلى سجل حذف معروف (طابور) بدل ي
  assert.equal(calls.enqueued, 1);
  // ولم يُحذف حذفاً أعمى
  assert.equal(calls.deleted, 0);
  assert.equal(calls.events.includes('ledger-failed'), true);
  assert.equal(calls.events.includes('deletion-enqueued'), true);
});

test('when the outbox is also down, an explicitly unreferenced file is deleted', async () => {
  const { calls, deps } = createDeps({ ledgerFails: true, enqueueFails: true, liveReference: false });
  const outcome = await finalizeVoiceUpload(URL, deps);

  assert.equal(outcome.ok === false && outcome.reason, 'ledger-failed-cleaned');
  assert.equal(calls.enqueued, VOICE_DELETION_ENQUEUE_ATTEMPTS);
  assert.equal(calls.deleted, 1);
});

test('a file with a live reference is never deleted', async () => {
  const { calls, deps } = createDeps({ ledgerFails: true, enqueueFails: true, liveReference: true });
  const outcome = await finalizeVoiceUpload(URL, deps);

  assert.equal(outcome.ok === false && outcome.reason, 'ledger-failed-referenced');
  assert.equal(calls.deleted, 0);
});

test('if the reference check cannot be proven, nothing is deleted and the risk is reported', async () => {
  const { calls, deps } = createDeps({ ledgerFails: true, enqueueFails: true, liveReference: 'throws' });
  const outcome = await finalizeVoiceUpload(URL, deps);

  assert.equal(outcome.ok === false && outcome.reason, 'ledger-failed-orphan-risk');
  assert.equal(calls.deleted, 0);
  assert.equal(calls.events.includes('orphan-risk'), true);
});

test('the ledger write is bounded, not retried forever', async () => {
  const { calls, deps } = createDeps({ ledgerFails: true });
  await finalizeVoiceUpload(URL, deps);

  assert.equal(calls.ledger, VOICE_LEDGER_ATTEMPTS);
  assert.equal(VOICE_LEDGER_ATTEMPTS, 3);
});

test('the route reports success only through the finalizer', () => {
  const route = readFileSync(fileURLToPath(new URL('../../routes/mediaVoice.ts', import.meta.url)), 'utf8');

  assert.equal(route.includes('finalizeVoiceUpload('), true);
  // لا ابتلاع لفشل الـledger ثم متابعة النجاح
  assert.equal(route.includes('Voice upload ledger write failed'), false);
  assert.equal(/catch\s*\([^)]*\)\s*\{\s*\n?\s*logger\.warn\([^)]*ledger/i.test(route), false);
  // الفشل يعيد 502 صريحاً قبل أي استجابة نجاح
  assert.equal(route.includes('if (!finalized.ok)'), true);
  assert.equal(route.includes('502'), true);
});
