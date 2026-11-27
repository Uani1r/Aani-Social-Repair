import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConversationMuteStore,
  legacyMuteRowsToInsert,
  mutedContactIdsFromSettings,
  preferencesWithoutLegacyMute,
  settingRow,
  settingsRowsForViewer,
  type ConversationSettingRow,
  type ConversationSettingsGateway,
} from './messagesConversationSettings';

const VIEWER = 'viewer';
const OTHER_USER = 'other-user';
const CONTACT_B = 'contact-b';
const CONTACT_C = 'contact-c';
const EARLIER = '2026-11-27T09:00:00.000Z';
const NOW = '2026-11-27T12:00:00.000Z';

type FakeGatewayOptions = {
  rows?: ConversationSettingRow[];
  failList?: unknown;
  failInsert?: unknown;
  failSave?: unknown;
  saveDelayMs?: number;
};

type FakeGateway = {
  gateway: ConversationSettingsGateway;
  saves: ConversationSettingRow[];
  inserts: ConversationSettingRow[][];
  rows: ConversationSettingRow[];
  listCalls: () => number;
  maxConcurrentSaves: () => number;
};

function pairKey(row: { user_id: string; other_user_id: string }): string {
  return `${row.user_id}:${row.other_user_id}`;
}

function createFakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
  const rows: ConversationSettingRow[] = [...(options.rows ?? [])];
  const saves: ConversationSettingRow[] = [];
  const inserts: ConversationSettingRow[][] = [];
  let listCalls = 0;
  let activeSaves = 0;
  let maxConcurrentSaves = 0;

  const gateway: ConversationSettingsGateway = {
    async listSettings(viewerId) {
      listCalls += 1;
      if (options.failList) throw options.failList;
      return settingsRowsForViewer(rows, viewerId);
    },
    async insertMissingSettings(newRows) {
      if (options.failInsert) throw options.failInsert;
      inserts.push(newRows.map(row => ({ ...row })));
      // ignoreDuplicates: الصف الموجود لا يُستبدل.
      for (const row of newRows) {
        if (!rows.some(existing => pairKey(existing) === pairKey(row))) rows.push({ ...row });
      }
    },
    async saveSetting(row) {
      saves.push({ ...row });
      activeSaves += 1;
      maxConcurrentSaves = Math.max(maxConcurrentSaves, activeSaves);
      try {
        if (options.saveDelayMs) {
          await new Promise(resolve => setTimeout(resolve, options.saveDelayMs));
        }
        if (options.failSave) throw options.failSave;
        const index = rows.findIndex(existing => pairKey(existing) === pairKey(row));
        if (index >= 0) rows[index] = { ...row };
        else rows.push({ ...row });
      } finally {
        activeSaves -= 1;
      }
    },
  };

  return {
    gateway,
    saves,
    inserts,
    rows,
    listCalls: () => listCalls,
    maxConcurrentSaves: () => maxConcurrentSaves,
  };
}

test('تحميل الإعدادات يجلب صفّ المستخدم الحالي وحده', async () => {
  const fake = createFakeGateway({
    rows: [
      { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: true, updated_at: NOW },
      { user_id: OTHER_USER, other_user_id: VIEWER, is_muted: true, updated_at: NOW },
      { user_id: VIEWER, other_user_id: CONTACT_C, is_muted: false, updated_at: NOW },
    ],
  });
  const store = createConversationMuteStore({ viewerId: VIEWER, gateway: fake.gateway });

  const result = await store.initialize();

  assert.equal(result.ok, true);
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);
  store.dispose();
});

test('لا يُستبدل سجل is_muted=false بقيمة محلية قديمة', async () => {
  const fake = createFakeGateway({
    rows: [{ user_id: VIEWER, other_user_id: CONTACT_B, is_muted: false, updated_at: NOW }],
  });
  let legacy = [CONTACT_B, CONTACT_C];
  let cleared = 0;
  const store = createConversationMuteStore({
    viewerId: VIEWER,
    gateway: fake.gateway,
    now: () => NOW,
    readLegacyMutedIds: () => [...legacy],
    clearLegacyMutedIds: () => {
      cleared += 1;
      legacy = [];
    },
  });

  const result = await store.initialize();

  assert.equal(result.imported, 1);
  assert.equal(fake.inserts.length, 1);
  const inserted = fake.inserts[0];
  assert.ok(inserted);
  assert.deepEqual(inserted.map(row => row.other_user_id), [CONTACT_C]);
  assert.equal(inserted[0]?.is_muted, true);
  // السجل الموجود (false) لم يتغيّر، فلا يعود الكتم إلى جهاز آخر.
  assert.equal(fake.rows.find(row => row.other_user_id === CONTACT_B)?.is_muted, false);
  assert.deepEqual([...store.mutedIds()], [CONTACT_C]);
  assert.equal(cleared, 1);
  store.dispose();
});

test('استيراد الإعدادات القديمة يحدث مرة واحدة دون تكرار', async () => {
  const fake = createFakeGateway();
  let legacy = [CONTACT_C];
  let cleared = 0;
  const store = createConversationMuteStore({
    viewerId: VIEWER,
    gateway: fake.gateway,
    now: () => NOW,
    readLegacyMutedIds: () => [...legacy],
    clearLegacyMutedIds: () => {
      cleared += 1;
      legacy = [];
    },
  });

  const first = await store.initialize();
  const second = await store.initialize();

  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(fake.inserts.length, 1);
  assert.equal(cleared, 1);
  assert.deepEqual([...store.mutedIds()], [CONTACT_C]);
  store.dispose();
});

test('الكتم وإلغاء الكتم يُحفظان ويُكتب is_muted=false لا حذفاً', async () => {
  const fake = createFakeGateway();
  const store = createConversationMuteStore({
    viewerId: VIEWER,
    gateway: fake.gateway,
    now: () => NOW,
  });

  const muted = await store.setMuted(CONTACT_B, true);
  assert.equal(muted.ok, true);
  assert.equal(muted.muted, true);
  assert.deepEqual(fake.saves[0], settingRow(VIEWER, CONTACT_B, true, NOW));
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);

  const unmuted = await store.setMuted(CONTACT_B, false);
  assert.equal(unmuted.ok, true);
  assert.equal(unmuted.muted, false);
  assert.deepEqual(fake.saves[1], settingRow(VIEWER, CONTACT_B, false, NOW));
  // الصف يبقى في القاعدة بقيمة false حتى لا تستورد أجهزة أخرى كتماً قديماً.
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.rows[0]?.is_muted, false);
  assert.deepEqual([...store.mutedIds()], []);
  store.dispose();
});

test('تحديث Realtime يصل إلى صاحب الإعداد فقط', async () => {
  const fake = createFakeGateway();
  const store = createConversationMuteStore({ viewerId: VIEWER, gateway: fake.gateway });
  await store.initialize();

  const otherUserRow = store.applyRealtimeRow({
    user_id: OTHER_USER,
    other_user_id: VIEWER,
    is_muted: true,
    updated_at: NOW,
  });
  assert.equal(otherUserRow, false);
  assert.deepEqual([...store.mutedIds()], []);

  const applied = store.applyRealtimeRow({
    user_id: VIEWER,
    other_user_id: CONTACT_C,
    is_muted: true,
    updated_at: NOW,
  });
  assert.equal(applied, true);
  assert.deepEqual([...store.mutedIds()], [CONTACT_C]);

  const stale = store.applyRealtimeRow({
    user_id: VIEWER,
    other_user_id: CONTACT_C,
    is_muted: false,
    updated_at: EARLIER,
  });
  assert.equal(stale, false);
  assert.deepEqual([...store.mutedIds()], [CONTACT_C]);

  const invalid = store.applyRealtimeRow(null);
  assert.equal(invalid, false);
  store.dispose();
});

test('إعادة المزامنة بعد العودة إلى الواجهة أو انقطاع الاتصال', async () => {
  const fake = createFakeGateway();
  const store = createConversationMuteStore({ viewerId: VIEWER, gateway: fake.gateway });
  await store.initialize();
  assert.deepEqual([...store.mutedIds()], []);

  fake.rows.push({
    user_id: VIEWER,
    other_user_id: CONTACT_C,
    is_muted: true,
    updated_at: NOW,
  });
  const result = await store.resync();

  assert.equal(result.ok, true);
  assert.deepEqual([...store.mutedIds()], [CONTACT_C]);

  // فشل القراءة لا يمسح الحالة المعروضة.
  const failing = createConversationMuteStore({
    viewerId: VIEWER,
    gateway: createFakeGateway({ failList: new Error('offline') }).gateway,
  });
  const failed = await failing.resync();
  assert.equal(failed.ok, false);
  assert.deepEqual([...failing.mutedIds()], []);
  store.dispose();
  failing.dispose();
});

test('تبديل الحساب لا يسرّب إعدادات المستخدم السابق', async () => {
  const fakeA = createFakeGateway({
    rows: [{ user_id: 'viewer-a', other_user_id: CONTACT_B, is_muted: true, updated_at: NOW }],
  });
  const storeA = createConversationMuteStore({ viewerId: 'viewer-a', gateway: fakeA.gateway });
  await storeA.initialize();
  assert.deepEqual([...storeA.mutedIds()], [CONTACT_B]);

  const fakeB = createFakeGateway();
  const storeB = createConversationMuteStore({ viewerId: 'viewer-b', gateway: fakeB.gateway });
  await storeB.initialize();
  assert.deepEqual([...storeB.mutedIds()], []);

  // صف المستخدم السابق لا يغيّر حالة المستخدم الجديد والعكس.
  assert.equal(storeB.applyRealtimeRow({
    user_id: 'viewer-a',
    other_user_id: CONTACT_B,
    is_muted: true,
    updated_at: NOW,
  }), false);
  assert.equal(storeA.applyRealtimeRow({
    user_id: 'viewer-b',
    other_user_id: CONTACT_B,
    is_muted: false,
    updated_at: NOW,
  }), false);
  assert.deepEqual([...storeA.mutedIds()], [CONTACT_B]);
  assert.deepEqual([...storeB.mutedIds()], []);

  storeA.dispose();
  storeB.dispose();
  // بعد التخلص لا يعود التحديث المتأخر يعدّل الحالة.
  assert.equal(storeA.applyRealtimeRow({
    user_id: 'viewer-a',
    other_user_id: CONTACT_C,
    is_muted: true,
    updated_at: NOW,
  }), false);
});

test('فشل الحفظ لا يظهر نجاحاً ويعيد الحالة السابقة', async () => {
  const fake = createFakeGateway({
    rows: [{ user_id: VIEWER, other_user_id: CONTACT_B, is_muted: true, updated_at: NOW }],
    failSave: new Error('network down'),
  });
  const store = createConversationMuteStore({ viewerId: VIEWER, gateway: fake.gateway });
  await store.initialize();

  const result = await store.setMuted(CONTACT_B, false);

  assert.equal(result.ok, false);
  assert.equal(result.error instanceof Error, true);
  // الحالة السابقة تبقى معروضة، ولا يُعلن نجاح كاذب.
  assert.equal(result.muted, true);
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);

  const newContact = await store.setMuted(CONTACT_C, true);
  assert.equal(newContact.ok, false);
  assert.equal(newContact.muted, false);
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);
  store.dispose();
});

test('طلب متزامن متعارض للمحادثة نفسها يُنفَّذ بالتتابع', async () => {
  const fake = createFakeGateway({ saveDelayMs: 10 });
  const store = createConversationMuteStore({ viewerId: VIEWER, gateway: fake.gateway });
  await store.initialize();

  const results = await Promise.all([
    store.setMuted(CONTACT_B, true),
    store.setMuted(CONTACT_B, false),
  ]);

  assert.equal(results[0]?.ok, true);
  assert.equal(results[1]?.ok, true);
  assert.deepEqual(fake.saves.map(row => row.is_muted), [true, false]);
  // لا يصل طلبان متعارضان إلى القاعدة في الوقت نفسه.
  assert.equal(fake.maxConcurrentSaves(), 1);
  assert.deepEqual([...store.mutedIds()], []);
  store.dispose();
});

test('التثبيت والأرشفة يبقيان محليين ولا يمسّهما ترحيل الكتم', () => {
  const raw = { pinnedIds: [CONTACT_B], archivedIds: [CONTACT_C], mutedIds: [CONTACT_B] };
  const { preferences, removedLegacyMute } = preferencesWithoutLegacyMute(raw);

  assert.equal(removedLegacyMute, true);
  assert.deepEqual(preferences.pinnedIds, [CONTACT_B]);
  assert.deepEqual(preferences.archivedIds, [CONTACT_C]);
  assert.equal('mutedIds' in preferences, false);

  const untouched = preferencesWithoutLegacyMute({ pinnedIds: [], archivedIds: [CONTACT_C] });
  assert.equal(untouched.removedLegacyMute, false);
  assert.deepEqual(untouched.preferences.archivedIds, [CONTACT_C]);
});

test('الصفوف القديمة لا تُنشئ سجلاً لصاحب الإعداد ولا تكراراً', () => {
  const rows = legacyMuteRowsToInsert(
    [{ user_id: VIEWER, other_user_id: CONTACT_C, is_muted: false, updated_at: NOW }],
    VIEWER,
    [VIEWER, CONTACT_B, CONTACT_B, CONTACT_C],
    NOW,
  );

  assert.deepEqual(rows.map(row => row.other_user_id), [CONTACT_B]);
  assert.equal(rows[0]?.user_id, VIEWER);
  assert.equal(rows[0]?.is_muted, true);
});

test('مجموعة الكتم تُشتق من is_muted فقط', () => {
  const muted = mutedContactIdsFromSettings([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: true, updated_at: NOW },
    { user_id: VIEWER, other_user_id: CONTACT_C, is_muted: false, updated_at: NOW },
    { user_id: OTHER_USER, other_user_id: VIEWER, is_muted: true, updated_at: NOW },
  ], VIEWER);

  assert.deepEqual([...muted], [CONTACT_B]);
});


/* ------------------------------------------------------------------ */
/* ترتيب نتائج القراءة مع تحديثات Realtime                             */
/* ------------------------------------------------------------------ */

const READ_STARTED_AT = '2026-11-27T12:00:00.000Z';
const LATER = '2026-11-27T12:30:00.000Z';

type DeferredList = {
  promise: Promise<ConversationSettingRow[]>;
  resolve: (rows: ConversationSettingRow[]) => void;
};

function createDeferredList(): DeferredList {
  let resolve!: (rows: ConversationSettingRow[]) => void;
  const promise = new Promise<ConversationSettingRow[]>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

/** بوّابة قراءة يدوية: كل listSettings ينتظر حتى يحرره الاختبار بالترتيب. */
function createManualGateway() {
  const requests: DeferredList[] = [];
  const gateway: ConversationSettingsGateway = {
    listSettings: () => {
      const deferred = createDeferredList();
      requests.push(deferred);
      return deferred.promise;
    },
    insertMissingSettings: async () => {},
    saveSetting: async () => {},
  };
  const request = (index: number): DeferredList => {
    const deferred = requests[index];
    assert.ok(deferred, `القراءة رقم ${index} يجب أن تكون قد بدأت`);
    return deferred;
  };
  return { gateway, requests, request };
}

test('نتيجة قراءة قديمة لا تستبدل تحديث Realtime أحدث وصل أثناءها', async () => {
  const manual = createManualGateway();
  const store = createConversationMuteStore({
    viewerId: VIEWER,
    gateway: manual.gateway,
    now: () => READ_STARTED_AT,
  });

  const resyncing = store.resync();
  // Realtime أحدث يصل قبل أن تنتهي القراءة.
  assert.equal(store.applyRealtimeRow({
    user_id: VIEWER,
    other_user_id: CONTACT_B,
    is_muted: true,
    updated_at: LATER,
  }), true);
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);

  // القراءة القديمة تعود بقيمة أقدم للصف نفسه.
  manual.request(0).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: false, updated_at: EARLIER },
  ]);
  const result = await resyncing;

  assert.equal(result.ok, true);
  // الحالة الأحدث من Realtime باقية، ولم تُنزل إلى قيمة القراءة الأقدم.
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);
  store.dispose();
});

test('Realtime أثناء initialize يبقى بعد انتهاء الاستعلام', async () => {
  const manual = createManualGateway();
  const store = createConversationMuteStore({
    viewerId: VIEWER,
    gateway: manual.gateway,
    now: () => READ_STARTED_AT,
  });

  const initializing = store.initialize();
  // صف لم تعرفه القراءة الجارية، وصل بعد بدئها.
  assert.equal(store.applyRealtimeRow({
    user_id: VIEWER,
    other_user_id: CONTACT_C,
    is_muted: true,
    updated_at: LATER,
  }), true);

  manual.request(0).resolve([]);
  const result = await initializing;

  assert.equal(result.ok, true);
  assert.deepEqual([...store.mutedIds()], [CONTACT_C]);
  store.dispose();
});

test('نتيجة resync أقدم لا تتغلب على نتيجة قراءة أحدث', async () => {
  const manual = createManualGateway();
  const store = createConversationMuteStore({
    viewerId: VIEWER,
    gateway: manual.gateway,
    now: () => READ_STARTED_AT,
  });

  const olderRead = store.resync();
  const newerRead = store.resync();
  assert.equal(manual.requests.length, 2);

  // الأحدث ينتهي أولاً.
  manual.request(1).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_C, is_muted: true, updated_at: LATER },
  ]);
  await newerRead;
  assert.deepEqual([...store.mutedIds()], [CONTACT_C]);

  // الأقدم ينتهي أخيراً بقيمة مختلفة، فلا يُطبَّق.
  manual.request(0).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: true, updated_at: EARLIER },
  ]);
  const olderResult = await olderRead;
  assert.equal(olderResult.ok, true);
  assert.deepEqual([...store.mutedIds()], [CONTACT_C]);
  store.dispose();
});


test('استيراد الكتم القديم لا يستبدل صفاً أحدث وصل من Realtime', async () => {
  let releaseInsert!: () => void;
  const insertGate = new Promise<void>(resolve => {
    releaseInsert = resolve;
  });
  const insertedRows: ConversationSettingRow[] = [];
  const gateway: ConversationSettingsGateway = {
    listSettings: async () => [],
    insertMissingSettings: async rows => {
      insertedRows.push(...rows);
      await insertGate;
    },
    saveSetting: async () => {},
  };
  let legacy = [CONTACT_B];
  const store = createConversationMuteStore({
    viewerId: VIEWER,
    gateway,
    now: () => READ_STARTED_AT,
    readLegacyMutedIds: () => [...legacy],
    clearLegacyMutedIds: () => {
      legacy = [];
    },
  });

  const initializing = store.initialize();
  // انتظر حتى يبدأ الإدراج بعد نتيجة القراءة الفارغة.
  for (let attempt = 0; attempt < 10 && insertedRows.length === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0]?.is_muted, true);

  // Realtime يقول إن المحادثة غير مكتومة الآن، وهو أحدث من صف الاستيراد.
  assert.equal(store.applyRealtimeRow({
    user_id: VIEWER,
    other_user_id: CONTACT_B,
    is_muted: false,
    updated_at: LATER,
  }), true);

  releaseInsert();
  await initializing;

  // لا يعود الكتم القديم إلى الواجهة رغم قبول القاعدة لصف الاستيراد.
  assert.deepEqual([...store.mutedIds()], []);
  store.dispose();
});


/* ------------------------------------------------------------------ */
/* تداخل القراءة مع الحفظ المحلي المتفائل                              */
/* ------------------------------------------------------------------ */

type GatedRead = {
  viewerId: string;
  resolve: (rows: ConversationSettingRow[]) => void;
};

type GatedSave = {
  row: ConversationSettingRow;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

/** بوّابة قراءة وحفظ يدوية: كل طلب ينتظر حتى يحرره الاختبار. */
function createGatedGateway() {
  const reads: GatedRead[] = [];
  const saves: GatedSave[] = [];
  const gateway: ConversationSettingsGateway = {
    listSettings: viewerId => new Promise<ConversationSettingRow[]>(resolve => {
      reads.push({ viewerId, resolve });
    }),
    insertMissingSettings: async () => {},
    saveSetting: row => new Promise<void>((resolve, reject) => {
      saves.push({ row, resolve, reject });
    }),
  };
  const read = (index: number): GatedRead => {
    const request = reads[index];
    assert.ok(request, `القراءة رقم ${index} يجب أن تكون قد بدأت`);
    return request;
  };
  const save = (index: number): GatedSave => {
    const request = saves[index];
    assert.ok(request, `الحفظ رقم ${index} يجب أن يكون قد بدأ`);
    return request;
  };
  /** يُفرّغ المهام الميكروية حتى يصل الحفظ إلى بوّابته. */
  const settle = async (): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
  return { gateway, reads, saves, read, save, settle };
}

test('التحديث المتفائل لا تُلغيه نتيجة قراءة بدأت قبله أو أثناءه', async () => {
  const gated = createGatedGateway();
  const store = createConversationMuteStore({
    viewerId: VIEWER,
    gateway: gated.gateway,
    now: () => READ_STARTED_AT,
  });

  // قراءة أولى تُحمّل صف القاعدة الحالي (غير مكتومة).
  const loading = store.initialize();
  gated.read(0).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: false, updated_at: EARLIER },
  ]);
  await loading;
  assert.deepEqual([...store.mutedIds()], []);

  // resync يبدأ، ثم الكتم يُنفَّذ قبل أن ينتهي.
  const resyncing = store.resync();
  const muting = store.setMuted(CONTACT_B, true);
  await gated.settle();
  assert.equal(gated.saves.length, 1);
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);

  // نتيجة القراءة القديمة تعود قبل اكتمال الحفظ، فلا تستبدل التحديث المتفائل.
  gated.read(1).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: false, updated_at: EARLIER },
  ]);
  await resyncing;
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);

  // نجاح الحفظ يُثبّت القيمة الجديدة.
  gated.save(0).resolve();
  const result = await muting;
  assert.equal(result.ok, true);
  assert.equal(result.muted, true);
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);
  store.dispose();
});

test('فشل الحفظ بعد تداخل القراءة يرجّع الحالة دون قيمة متفائلة عالقة', async () => {
  const gated = createGatedGateway();
  const store = createConversationMuteStore({
    viewerId: VIEWER,
    gateway: gated.gateway,
    now: () => READ_STARTED_AT,
  });

  const loading = store.initialize();
  gated.read(0).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: false, updated_at: EARLIER },
  ]);
  await loading;
  assert.deepEqual([...store.mutedIds()], []);

  const resyncing = store.resync();
  const muting = store.setMuted(CONTACT_B, true);
  await gated.settle();
  assert.equal(gated.saves.length, 1);

  // القراءة القديمة تصل قبل اكتمال الحفظ: التحديث المتفائل يبقى.
  gated.read(1).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: false, updated_at: EARLIER },
  ]);
  await resyncing;
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);

  // فشل الحفظ: تراجع إلى قيمة القاعدة، ولا قيمة متفائلة عالقة.
  gated.save(0).reject(new Error('offline'));
  const result = await muting;
  assert.equal(result.ok, false);
  assert.equal(result.muted, false);
  assert.deepEqual([...store.mutedIds()], []);

  // قراءة لاحقة تؤكد أن الحالة المعروضة هي حالة القاعدة.
  const reloading = store.resync();
  gated.read(2).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: false, updated_at: EARLIER },
  ]);
  await reloading;
  assert.deepEqual([...store.mutedIds()], []);
  store.dispose();
});


/* ------------------------------------------------------------------ */
/* الترتيب المعاكس: الحفظ ينجح أولاً ثم تعود القراءة القديمة            */
/* ------------------------------------------------------------------ */

test('قراءة بدأت قبل الحفظ لا تستبدل الكتم بعد نجاح الحفظ', async () => {
  const gated = createGatedGateway();
  const store = createConversationMuteStore({
    viewerId: VIEWER,
    gateway: gated.gateway,
    now: () => READ_STARTED_AT,
  });

  const loading = store.initialize();
  gated.read(0).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: false, updated_at: READ_STARTED_AT },
  ]);
  await loading;
  assert.deepEqual([...store.mutedIds()], []);

  // القراءة القديمة تبدأ قبل الحفظ وتبقى معلّقة.
  const resyncing = store.resync();

  // الحفظ يكتمل بنجاح قبل أن تعود القراءة.
  const muting = store.setMuted(CONTACT_B, true);
  await gated.settle();
  gated.save(0).resolve();
  const muteResult = await muting;
  assert.equal(muteResult.ok, true);
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);

  // القراءة القديمة تعود بـ false و updated_at مساوٍ تماماً لوقت الحفظ.
  gated.read(1).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: false, updated_at: READ_STARTED_AT },
  ]);
  await resyncing;

  // لا تعود القيمة القديمة: الكتم يبقى.
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);
  store.dispose();
});

test('قراءة بدأت قبل إلغاء الكتم لا تعيد الكتم بعد نجاحه', async () => {
  const gated = createGatedGateway();
  const store = createConversationMuteStore({
    viewerId: VIEWER,
    gateway: gated.gateway,
    now: () => READ_STARTED_AT,
  });

  const loading = store.initialize();
  gated.read(0).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: true, updated_at: READ_STARTED_AT },
  ]);
  await loading;
  assert.deepEqual([...store.mutedIds()], [CONTACT_B]);

  const resyncing = store.resync();

  const unmuting = store.setMuted(CONTACT_B, false);
  await gated.settle();
  gated.save(0).resolve();
  const unmuteResult = await unmuting;
  assert.equal(unmuteResult.ok, true);
  assert.deepEqual([...store.mutedIds()], []);

  // القراءة القديمة تعود بـ true و updated_at مساوٍ تماماً لوقت الحفظ.
  gated.read(1).resolve([
    { user_id: VIEWER, other_user_id: CONTACT_B, is_muted: true, updated_at: READ_STARTED_AT },
  ]);
  await resyncing;

  // لا يعود الكتم القديم.
  assert.deepEqual([...store.mutedIds()], []);
  store.dispose();
});
