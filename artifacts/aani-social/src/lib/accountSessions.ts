/**
 * جلسات الحساب والأجهزة — عرض مقروء وإبطال الجلسات الأخرى.
 *
 * القواعد:
 * - البيانات من دالة `aani_account_sessions` المحمية على الخادم (تقرأ
 *   `auth.sessions` لهوية الجلسة وحدها). لا وصول مباشر لمخطط `auth` من العميل،
 *   ولا تُعرض رموز جلسة أو عناوين داخلية أو بيانات مستخدم آخر.
 * - «تسجيل الخروج من الأجهزة الأخرى» عبر `signOut({ scope: 'others' })` الرسمية،
 *   ثم التحقق من بقاء الجلسة الحالية قبل إظهار النجاح.
 * - لا تُدَّعى إمكانية إبطال جلسة واحدة بعينها: واجهة Supabase المعتمدة لا
 *   توفرها، والواجهة تقول ذلك صراحةً.
 */

export const ACCOUNT_SESSIONS_UNAVAILABLE_MESSAGE =
  'تعذر تحميل جلسات الحساب الآن. حاول مجددًا.';
export const ACCOUNT_SESSIONS_SIGN_OUT_FAILED_MESSAGE =
  'تعذر تسجيل الخروج من الأجهزة الأخرى. حاول مجددًا.';
export const ACCOUNT_SESSIONS_SINGLE_REVOKE_LIMITATION =
  'لا يمكن إبطال جلسة واحدة بعينها من هنا؛ تطبيق Supabase لا يوفر ذلك. الإجراء المتاح هو تسجيل الخروج من جميع الأجهزة الأخرى.';
export const ACCOUNT_SESSIONS_SIGNED_OUT_MESSAGE =
  'تم تسجيل الخروج من جميع الأجهزة الأخرى، وجلستك الحالية ما زالت قائمة.';

export type AccountSessionRow = {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  updated_at: string;
  refreshed_at: string | null;
  /** تُحسب على الخادم بمقارنة معرّف الجلسة بمعرّف طلب JWT الحالي. */
  is_current?: boolean;
};

export type AccountSessionView = {
  id: string;
  device: string;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
};

/** وصف مقروء للمتصفح والنظام من وكيل المستخدم — بلا كشف أي سر. */
export function describeUserAgent(userAgent: string | null | undefined): string {
  const value = String(userAgent ?? '');
  if (!value.trim()) return 'جهاز غير معروف';

  const browser = /Edg\//i.test(value)
    ? 'Edge'
    : /OPR\/|Opera/i.test(value)
      ? 'Opera'
      : /Chrome\//i.test(value)
        ? 'Chrome'
        : /Firefox\//i.test(value)
          ? 'Firefox'
          : /Safari\//i.test(value)
            ? 'Safari'
            : 'متصفح غير معروف';

  const platform = /iPhone/i.test(value)
    ? 'iPhone'
    : /iPad/i.test(value)
      ? 'iPad'
      : /Android/i.test(value)
        ? 'Android'
        : /Windows/i.test(value)
          ? 'Windows'
          : /Macintosh|Mac OS X/i.test(value)
            ? 'macOS'
            : /Linux/i.test(value)
              ? 'Linux'
              : 'نظام غير معروف';

  return `${browser} · ${platform}`;
}

function readTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? value : null;
}

/** يحوّل صفوف الخادم إلى عرض آمن: بلا رموز، والجلسة الحالية مميَّزة. */
export function mapAccountSessions(
  rows: unknown,
  currentSessionId: string | null,
): AccountSessionView[] {
  if (!Array.isArray(rows)) return [];
  const sessions: AccountSessionView[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Partial<AccountSessionRow>;
    if (typeof record.id !== 'string' || !record.id) continue;
    const createdAt = readTimestamp(record.created_at);
    if (!createdAt) continue;
    const lastActiveAt =
      readTimestamp(record.refreshed_at) ?? readTimestamp(record.updated_at) ?? createdAt;
    sessions.push({
      id: record.id,
      device: describeUserAgent(record.user_agent),
      createdAt,
      lastActiveAt,
      current: record.is_current === true
        || (Boolean(currentSessionId) && record.id === currentSessionId),
    });
  }
  return sessions.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
}

export type SessionsRead =
  | { status: 'ok'; sessions: AccountSessionView[] }
  | { status: 'unavailable'; message: string };

/** يقرأ نتيجة دالة الجلسات المحمية. */
export function readSessionsPayload(
  payload: unknown,
  currentSessionId: string | null,
): SessionsRead {
  if (!Array.isArray(payload)) {
    return { status: 'unavailable', message: ACCOUNT_SESSIONS_UNAVAILABLE_MESSAGE };
  }
  return { status: 'ok', sessions: mapAccountSessions(payload, currentSessionId) };
}

export type SessionsClient = {
  listSessions: () => Promise<{ data: unknown; error: unknown }>;
  signOutOthers: () => Promise<{ error: unknown }>;
  getCurrentSessionId: () => Promise<string | null>;
};

export type SessionsOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string };

/** تحميل الجلسات: لا نجاح بلا مصفوفة صالحة من الخادم. */
export async function loadAccountSessions(
  client: SessionsClient,
): Promise<SessionsRead> {
  const currentSessionId = await client.getCurrentSessionId();
  const { data, error } = await client.listSessions();
  if (error) return { status: 'unavailable', message: ACCOUNT_SESSIONS_UNAVAILABLE_MESSAGE };
  return readSessionsPayload(data, currentSessionId);
}

/**
 * تسجيل الخروج من جميع الأجهزة الأخرى، ثم التحقق أن الجلسة الحالية ما زالت
 * قائمة قبل إظهار النجاح.
 */
export async function signOutOtherDevices(
  client: SessionsClient,
): Promise<SessionsOutcome> {
  const { error } = await client.signOutOthers();
  if (error) return { ok: false, message: ACCOUNT_SESSIONS_SIGN_OUT_FAILED_MESSAGE };

  const currentSessionId = await client.getCurrentSessionId();
  if (!currentSessionId) return { ok: false, message: ACCOUNT_SESSIONS_SIGN_OUT_FAILED_MESSAGE };

  return { ok: true, message: ACCOUNT_SESSIONS_SIGNED_OUT_MESSAGE };
}
