/**
 * مزامنة كتم المحادثات مع Supabase.
 *
 * الكتم لم يبقَ في localStorage: مصدر الحقيقة هو الجدول
 * public.message_conversation_settings لكل مستخدم، بمفتاح مركّب
 * (user_id, other_user_id). التثبيت والأرشفة يبقيان محليين في
 * `aani_message_preferences_<userId>` ولا يمسّهما هذا الملف.
 *
 * هذا الملف مستقل عن React وعن متصفح حقيقي: كل قراءة أو كتابة تمرّ عبر
 * بوّابة (gateway) تُحقن، فتُختبر منطقية المزامنة عبر `tsx --test` بلا
 * شبكة وبلا قاعدة بيانات.
 */

export const CONVERSATION_SETTINGS_TABLE = 'message_conversation_settings';
/** المفتاح المركّب المستخدم في upsert حتى لا يتكرر الصف. */
export const CONVERSATION_SETTINGS_PAIR_CONFLICT = 'user_id,other_user_id';
export const CONVERSATION_SETTINGS_COLUMNS = 'user_id, other_user_id, is_muted, updated_at';

export type ConversationSettingRow = {
  user_id: string;
  other_user_id: string;
  is_muted: boolean;
  updated_at: string | null;
};

export interface ConversationSettingsGateway {
  /** صفوف هذا المستخدم فقط، كما هي في القاعدة. */
  listSettings: (viewerId: string) => Promise<ConversationSettingRow[]>;
  /** إدراج الصفوف الناقصة فقط (ignoreDuplicates): لا يستبدل قيمة موجودة. */
  insertMissingSettings: (rows: ConversationSettingRow[]) => Promise<void>;
  /** حفظ قيمة الكتم لصف واحد بالمفتاح المركّب. */
  saveSetting: (row: ConversationSettingRow) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
}

export function legacyPreferencesKey(userId: string): string {
  return `aani_message_preferences_${userId}`;
}

/** يقرأ mutedIds القديمة من التخزين المحلي لهذا المستخدم (بلا مفاتيح أخرى). */
export function readLegacyMutedIds(userId: string): string[] {
  if (!userId || typeof window === 'undefined') return [];
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(legacyPreferencesKey(userId)) || '{}');
    if (!isRecord(stored)) return [];
    return readIdList(stored.mutedIds);
  } catch {
    return [];
  }
}

/**
 * يفصل التفضيلات المحلية عن mutedIds: التثبيت والأرشفة يعودان كما هما،
 * ومفتاح الكتم وحده يُحذف بعد نجاح الترحيل إلى القاعدة.
 */
export function preferencesWithoutLegacyMute(raw: unknown): {
  preferences: Record<string, unknown>;
  removedLegacyMute: boolean;
} {
  const source = isRecord(raw) ? raw : {};
  const preferences: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'mutedIds') continue;
    preferences[key] = value;
  }
  return { preferences, removedLegacyMute: 'mutedIds' in source };
}

export function clearLegacyMutedIds(userId: string): void {
  if (!userId || typeof window === 'undefined') return;
  try {
    const key = legacyPreferencesKey(userId);
    const stored: unknown = JSON.parse(window.localStorage.getItem(key) || '{}');
    const { preferences } = preferencesWithoutLegacyMute(stored);
    window.localStorage.setItem(key, JSON.stringify(preferences));
  } catch {
    /* التخزين المحلي غير متاح */
  }
}

export function normalizeConversationSettingRow(value: unknown): ConversationSettingRow | null {
  if (!isRecord(value)) return null;
  const userId = value.user_id;
  const otherUserId = value.other_user_id;
  if (typeof userId !== 'string' || !userId || typeof otherUserId !== 'string' || !otherUserId) return null;
  return {
    user_id: userId,
    other_user_id: otherUserId,
    // لا تُقرأ القيمة إلا true صريحة: أي شكل آخر يعني «غير مكتومة».
    is_muted: value.is_muted === true,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : null,
  };
}

/** صفوف المستخدم الحالي وحدها: صف أي مستخدم آخر لا يغيّر حالته أبداً. */
export function settingsRowsForViewer(rows: unknown, viewerId: string): ConversationSettingRow[] {
  if (!Array.isArray(rows) || !viewerId) return [];
  return rows.flatMap((item): ConversationSettingRow[] => {
    const row = normalizeConversationSettingRow(item);
    if (!row || row.user_id !== viewerId) return [];
    return [row];
  });
}

export function mutedContactIdsFromSettings(rows: unknown, viewerId: string): Set<string> {
  const muted = new Set<string>();
  for (const row of settingsRowsForViewer(rows, viewerId)) {
    if (row.is_muted && row.other_user_id !== viewerId) muted.add(row.other_user_id);
  }
  return muted;
}

/** هل جاء التحديث أقدم من القيمة المعروضة؟ الأقدم لا يُطبَّق (لا تراجع للخلف). */
export function isStaleSettingUpdate(
  previousUpdatedAt: string | null | undefined,
  nextUpdatedAt: string | null | undefined,
): boolean {
  const before = previousUpdatedAt ? Date.parse(previousUpdatedAt) : Number.NaN;
  const after = nextUpdatedAt ? Date.parse(nextUpdatedAt) : Number.NaN;
  if (Number.isNaN(before) || Number.isNaN(after)) return false;
  return after < before;
}

/** هل التغيير أحدث من لحظة بدء قراءة؟ يقارن updated_at بالوقت المرجعي. */
export function isSettingNewerThan(
  updatedAt: string | null | undefined,
  reference: string | null | undefined,
): boolean {
  const value = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  const base = reference ? Date.parse(reference) : Number.NaN;
  if (Number.isNaN(value) || Number.isNaN(base)) return false;
  return value > base;
}

export function settingRow(
  viewerId: string,
  contactId: string,
  isMuted: boolean,
  updatedAt: string,
): ConversationSettingRow {
  return { user_id: viewerId, other_user_id: contactId, is_muted: isMuted, updated_at: updatedAt };
}

/**
 * الصفوف المحلية القديمة التي لا سجل لها في القاعدة فقط.
 *
 * وجود أي سجل للمحادثة — ولو `is_muted = false` — يعني أن القاعدة أحدث من
 * التخزين المحلي، فلا يُكتب فوقه بقيمة قديمة `true`.
 */
export function legacyMuteRowsToInsert(
  existingRows: unknown,
  viewerId: string,
  legacyMutedIds: string[],
  updatedAt: string,
): ConversationSettingRow[] {
  const known = new Set(settingsRowsForViewer(existingRows, viewerId).map(row => row.other_user_id));
  const seen = new Set<string>();
  const rows: ConversationSettingRow[] = [];
  for (const contactId of legacyMutedIds) {
    if (!contactId || contactId === viewerId || known.has(contactId) || seen.has(contactId)) continue;
    seen.add(contactId);
    rows.push(settingRow(viewerId, contactId, true, updatedAt));
  }
  return rows;
}

type SettingsQueryResult = { data: unknown; error?: unknown };

interface SettingsTableApi {
  select: (columns: string) => {
    eq: (column: string, value: string) => PromiseLike<SettingsQueryResult>;
  };
  upsert: (
    rows: ConversationSettingRow[] | ConversationSettingRow,
    options: { onConflict: string; ignoreDuplicates?: boolean },
  ) => PromiseLike<{ error?: unknown }>;
}

/** الحد الأدنى المطلوب من عميل Supabase، فلا يعتمد الملف على نوعه الكامل. */
export interface ConversationSettingsClient {
  from: (table: string) => unknown;
}

function settingsTable(client: ConversationSettingsClient): SettingsTableApi {
  return client.from(CONVERSATION_SETTINGS_TABLE) as SettingsTableApi;
}

function throwIfError(error: unknown): void {
  if (error) throw error;
}

export function createConversationSettingsGateway(
  client: ConversationSettingsClient,
): ConversationSettingsGateway {
  return {
    async listSettings(viewerId) {
      if (!viewerId) return [];
      const { data, error } = await settingsTable(client)
        .select(CONVERSATION_SETTINGS_COLUMNS)
        .eq('user_id', viewerId);
      throwIfError(error);
      return settingsRowsForViewer(data, viewerId);
    },
    async insertMissingSettings(rows) {
      if (rows.length === 0) return;
      // ignoreDuplicates: صف موجود (ولو is_muted = false) لا يُستبدل بقيمة قديمة.
      const { error } = await settingsTable(client).upsert(rows, {
        onConflict: CONVERSATION_SETTINGS_PAIR_CONFLICT,
        ignoreDuplicates: true,
      });
      throwIfError(error);
    },
    async saveSetting(row) {
      const { error } = await settingsTable(client).upsert(row, {
        onConflict: CONVERSATION_SETTINGS_PAIR_CONFLICT,
      });
      throwIfError(error);
    },
  };
}

export interface ConversationMuteSetResult {
  ok: boolean;
  /** القيمة المعتمدة بعد المحاولة: عند الفشل تبقى الحالة السابقة. */
  muted: boolean;
  error?: unknown;
}

export interface ConversationMuteStoreOptions {
  viewerId: string;
  gateway: ConversationSettingsGateway;
  /** قراءة الكتم القديم من التخزين المحلي لهذا الجهاز. */
  readLegacyMutedIds?: () => string[];
  /** إزالة mutedIds المحلية بعد نجاح الترحيل (التثبيت والأرشفة يبقيان). */
  clearLegacyMutedIds?: () => void;
  now?: () => string;
}

export interface ConversationMuteStore {
  mutedIds: () => ReadonlySet<string>;
  subscribe: (listener: (mutedIds: ReadonlySet<string>) => void) => () => void;
  /** تحميل إعدادات المستخدم ثم ترحيل الكتم القديم مرة واحدة. */
  initialize: () => Promise<{ ok: boolean; imported: number; error?: unknown }>;
  /** إعادة القراءة من القاعدة (العودة إلى الواجهة أو استعادة الشبكة). */
  resync: () => Promise<{ ok: boolean; error?: unknown }>;
  /** تطبيق صف Realtime واحد؛ يعيد false إن لم يكن صف هذا المستخدم. */
  applyRealtimeRow: (value: unknown) => boolean;
  setMuted: (contactId: string, muted: boolean) => Promise<ConversationMuteSetResult>;
  dispose: () => void;
}

export function createConversationMuteStore(
  options: ConversationMuteStoreOptions,
): ConversationMuteStore {
  const { viewerId, gateway } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const rows = new Map<string, { isMuted: boolean; updatedAt: string | null }>();
  const listeners = new Set<(mutedIds: ReadonlySet<string>) => void>();
  const pendingSaves = new Map<string, Promise<unknown>>();
  // كتم قديم لم يصل بعد إلى القاعدة: يُعرض مؤقتاً ويُعاد الاستيراد لاحقاً.
  let legacyPending = new Set<string>();
  let snapshot: ReadonlySet<string> = new Set();
  let disposed = false;

  const computeSnapshot = (): Set<string> => {
    const muted = new Set<string>();
    rows.forEach((row, contactId) => {
      if (row.isMuted) muted.add(contactId);
    });
    legacyPending.forEach(contactId => {
      if (!rows.has(contactId)) muted.add(contactId);
    });
    return muted;
  };

  const publish = (): void => {
    if (disposed) return;
    const next = computeSnapshot();
    const unchanged = next.size === snapshot.size && [...next].every(id => snapshot.has(id));
    snapshot = next;
    if (unchanged) return;
    listeners.forEach(listener => {
      try {
        listener(next);
      } catch {
        /* مستمع معطوب لا يوقف الباقي */
      }
    });
  };

  // كل قراءة (initialize أو resync) تأخذ رقماً متزايداً قبل أن تنتظر الشبكة:
  // نتيجة قراءة بدأت قبل قراءة أخرى لا تُطبَّق حتى لو وصلت بعدها.
  let readToken = 0;

  /**
   * تطبيق نتيجة قراءة واحدة.
   *
   * لا يستبدل الحالة كاملة: صف تغيّر بعد بدء هذه القراءة (Realtime أو حفظ
   * محلي) يبقى كما هو، فلا تُنزل قيمة أحدث إلى قيمة أقدم.
   */
  const applyReadResult = (
    list: ConversationSettingRow[],
    startedAt: string,
    token: number,
  ): boolean => {
    // قراءة أحدث بدأت: هذه النتيجة قديمة، فلا تغيّر الحالة.
    if (disposed || token !== readToken) return false;
    const next = new Map<string, { isMuted: boolean; updatedAt: string | null }>();
    for (const row of list) {
      if (!row.other_user_id || row.other_user_id === viewerId) continue;
      next.set(row.other_user_id, { isMuted: row.is_muted, updatedAt: row.updated_at });
    }
    // صف تغيّر بعد بدء القراءة يبقى حتى لو غاب عن نتيجتها أو جاءت بقيمة أقدم.
    rows.forEach((current, contactId) => {
      const fromRead = next.get(contactId);
      if (!fromRead) {
        if (isSettingNewerThan(current.updatedAt, startedAt)) next.set(contactId, current);
        return;
      }
      if (isStaleSettingUpdate(current.updatedAt, fromRead.updatedAt)) next.set(contactId, current);
    });
    rows.clear();
    next.forEach((value, contactId) => rows.set(contactId, value));
    legacyPending = new Set([...legacyPending].filter(contactId => !rows.has(contactId)));
    publish();
    return true;
  };

  const clearLegacy = (): void => {
    if (!options.clearLegacyMutedIds) return;
    try {
      options.clearLegacyMutedIds();
    } catch {
      /* التخزين المحلي غير متاح: يبقى القديم حتى المحاولة التالية */
    }
  };

  const readLegacy = (): string[] => {
    if (!options.readLegacyMutedIds) return [];
    try {
      return options.readLegacyMutedIds();
    } catch {
      return [];
    }
  };

  const importLegacyMutedIds = async (list: ConversationSettingRow[]): Promise<number> => {
    if (!options.readLegacyMutedIds) return 0;
    const legacyMutedIds = readLegacy();
    const toInsert = legacyMuteRowsToInsert(list, viewerId, legacyMutedIds, now());
    if (toInsert.length === 0) {
      // كل ما في التخزين له سجل في القاعدة (أو لا شيء): الترحيل اكتمل.
      if (legacyMutedIds.length > 0) clearLegacy();
      return 0;
    }
    try {
      await gateway.insertMissingSettings(toInsert);
    } catch {
      // لا يُمسح القديم ولا يُفقد: يُعرض مكتوماً ويُعاد الاستيراد في المرة القادمة.
      toInsert.forEach(row => legacyPending.add(row.other_user_id));
      publish();
      return 0;
    }
    if (disposed) return 0;
    toInsert.forEach(row => {
      legacyPending.delete(row.other_user_id);
      rows.set(row.other_user_id, { isMuted: row.is_muted, updatedAt: row.updated_at });
    });
    publish();
    // لا تُحذف mutedIds المحلية إلا بعد نجاح الكتابة في القاعدة.
    clearLegacy();
    return toInsert.length;
  };

  const saveMuted = async (
    contactId: string,
    muted: boolean,
  ): Promise<ConversationMuteSetResult> => {
    const previous = rows.get(contactId);
    const previousMuted = previous?.isMuted ?? false;
    if (disposed) return { ok: false, muted: previousMuted };
    // تحديث متفائل: تُعرض الحالة فوراً، وتُعاد الحالة السابقة عند أي فشل.
    rows.set(contactId, { isMuted: muted, updatedAt: previous?.updatedAt ?? null });
    legacyPending.delete(contactId);
    publish();
    const updatedAt = now();
    try {
      await gateway.saveSetting(settingRow(viewerId, contactId, muted, updatedAt));
      if (!disposed) {
        rows.set(contactId, { isMuted: muted, updatedAt });
        publish();
      }
      return { ok: true, muted };
    } catch (error) {
      if (!disposed) {
        if (previous) rows.set(contactId, previous);
        else rows.delete(contactId);
        publish();
      }
      return { ok: false, muted: previousMuted, error };
    }
  };

  return {
    mutedIds: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    async initialize() {
      const startedAt = now();
      const token = ++readToken;
      let list: ConversationSettingRow[];
      try {
        list = await gateway.listSettings(viewerId);
      } catch (error) {
        // فشل القاعدة لا يمسح ما هو معروض ولا يمنع التطبيق من العمل.
        return { ok: false, imported: 0, error };
      }
      if (disposed) return { ok: false, imported: 0 };
      applyReadResult(list, startedAt, token);
      // الترحيل يُنفَّذ حتى لو أُهملت نتيجة القراءة لصالح قراءة أحدث:
      // الإدراج بـignoreDuplicates لا يغيّر أي قيمة موجودة.
      const imported = await importLegacyMutedIds(list);
      return { ok: true, imported };
    },
    async resync() {
      const startedAt = now();
      const token = ++readToken;
      let list: ConversationSettingRow[];
      try {
        list = await gateway.listSettings(viewerId);
      } catch (error) {
        return { ok: false, error };
      }
      if (disposed) return { ok: false };
      // نتيجة resync أقدم لا تتغلب على قراءة أحدث ولا على تحديث Realtime أحدث.
      applyReadResult(list, startedAt, token);
      return { ok: true };
    },
    applyRealtimeRow(value) {
      const row = normalizeConversationSettingRow(value);
      // صف مستخدم آخر (أو صف بلا معرّفين) لا يغيّر حالة هذا المستخدم.
      if (disposed || !row || row.user_id !== viewerId || row.other_user_id === viewerId) return false;
      const current = rows.get(row.other_user_id);
      if (current && isStaleSettingUpdate(current.updatedAt, row.updated_at)) return false;
      rows.set(row.other_user_id, { isMuted: row.is_muted, updatedAt: row.updated_at });
      legacyPending.delete(row.other_user_id);
      publish();
      return true;
    },
    async setMuted(contactId, muted) {
      if (!contactId || contactId === viewerId) {
        return { ok: false, muted: rows.get(contactId)?.isMuted ?? false };
      }
      // طلبان متعارضان للمحادثة نفسها يُنفَّذان بالتتابع: الطلب الثاني ينتظر
      // الأول، فلا يصل إلى القاعدة طلبان بترتيب معاكس لحالة الواجهة.
      const previous = pendingSaves.get(contactId) ?? Promise.resolve();
      const task = previous.catch(() => undefined).then(() => saveMuted(contactId, muted));
      const tail = task.then(() => undefined, () => undefined);
      pendingSaves.set(contactId, tail);
      try {
        return await task;
      } catch (error) {
        // لا رفض غير معالَج إلى الواجهة: الفشل يعود كنتيجة مع الحالة السابقة.
        return { ok: false, muted: rows.get(contactId)?.isMuted ?? false, error };
      } finally {
        if (pendingSaves.get(contactId) === tail) pendingSaves.delete(contactId);
      }
    },
    dispose() {
      disposed = true;
      listeners.clear();
      pendingSaves.clear();
      legacyPending = new Set();
    },
  };
}
