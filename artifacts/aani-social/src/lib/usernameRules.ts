/**
 * قواعد اسم المستخدم: مصدر واحد للواجهة والتعديل والدخول.
 *
 * الحد الأدنى قبل هذا الملف كان ثلاثة محارف في كل موضع (واجهة التسجيل، تعديل
 * الملف، الدخول باسم المستخدم، قيد قاعدة البيانات، والدالة الضيقة). صار هنا:
 * محرف واحد على الأقل، و32 على الأكثر، بنفس مجموعة المحارف المعتمدة سابقاً
 * (a-z و0-9 و_ و.) بلا مسافات ولا محارف أخرى. لا يُشترط حرف مع رقم، ولا حرف
 * في البداية، ولا ثلاثة محارف.
 *
 * القاعدة النافذة فعلياً هي قاعدة قاعدة البيانات (profiles_username_format_check
 * + المشغّل + الدوال)، وهذه نسخة العميل منها للتحقق الفوري فقط: الخادم يعيد
 * الفحص دائماً، والواجهة لا تمنح اسماً بلا تأكيد من الخادم.
 *
 * التطبيع: lowercase دائماً، وبلا @ في البداية، وبلا فراغات زائدة. لذلك
 * «User.Name» و«user.name» اسم واحد، والقيد الفريد على lower(username) يمنع
 * التكرار باختلاف حالة الأحرف.
 */

/** الحد الأدنى: محرف واحد (كان 3). */
export const USERNAME_MIN_LENGTH = 1;

/** الحد الأعلى: 32 محرفاً. */
export const USERNAME_MAX_LENGTH = 32;

/** المحارف المعتمدة في العرض والرسائل. */
export const USERNAME_ALLOWED_CHARACTERS = 'a-z 0-9 _ .';

/** الصيغة النهائية: 1–32 من المحارف المعتمدة، بأحرف صغيرة. */
export const USERNAME_PATTERN = /^[a-z0-9_.]{1,32}$/;

/**
 * فحص المحارف وحده (الطول يُفحص قبله) حتى تحمل الرسالة سبباً دقيقاً:
 * «أطول من المسموح» ليست «محرف غير مسموح».
 */
const USERNAME_CHARACTERS_PATTERN = /^[a-z0-9_.]+$/;

export const USERNAME_HINT =
  'من محرف واحد إلى 32 محرفاً: حروف إنجليزية (a-z) أو أرقام (0-9) أو نقطة أو شرطة سفلية، بلا مسافات.';

export const USERNAME_MESSAGES = {
  empty: 'أدخل اسم مستخدم.',
  tooLong: `اسم المستخدم لا يزيد عن ${USERNAME_MAX_LENGTH} محرفاً.`,
  invalidCharacters:
    'اسم المستخدم يقبل الحروف الإنجليزية والأرقام والنقطة والشرطة السفلية فقط، بلا مسافات أو محارف أخرى.',
  taken: 'اسم المستخدم مستخدم بالفعل. اختر اسماً آخر.',
  reserved: 'اسم المستخدم محجوز. اختر اسماً آخر.',
  blocked: 'اسم المستخدم غير متاح. اختر اسماً آخر.',
  available: 'اسم المستخدم متاح.',
  own: 'هذا اسم المستخدم الحالي لحسابك.',
  checkUnavailable: 'تعذر التحقق من توفر اسم المستخدم الآن. أعد المحاولة.',
} as const;

/** تطبيع الإدخال كما يُخزَّن: بلا @، بلا فراغات زائدة، بأحرف صغيرة. */
export function normalizeUsernameInput(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^@+/, '').trim().toLowerCase();
}

export type UsernameValidationCode = 'empty' | 'too_long' | 'invalid_characters';

export type UsernameValidation =
  | { ok: true; username: string }
  | { ok: false; code: UsernameValidationCode; message: string };

/**
 * تحقق واحد يُستدعى في التسجيل وإكمال الملف وتعديل اسم المستخدم والدخول.
 * `a` و`7` و`ab` و`12` و`123` واسم من 20 رقماً كلها صالحة.
 */
export function validateUsername(raw: unknown): UsernameValidation {
  const username = normalizeUsernameInput(raw);

  if (!username) {
    return { ok: false, code: 'empty', message: USERNAME_MESSAGES.empty };
  }

  if (username.length > USERNAME_MAX_LENGTH) {
    return { ok: false, code: 'too_long', message: USERNAME_MESSAGES.tooLong };
  }

  if (!USERNAME_CHARACTERS_PATTERN.test(username)) {
    return { ok: false, code: 'invalid_characters', message: USERNAME_MESSAGES.invalidCharacters };
  }

  return { ok: true, username };
}

/**
 * حالة الاسم في سجل الأسماء (`username_registry`). الحالة تأتي من الخادم
 * وحده عبر `aani_username_status`؛ لا تُشتق في الواجهة من قائمة محلية.
 *
 *   available — متاح للمطالبة به.
 *   reserved  — محجوز للإدارة، ولا يُمنح لمستخدم عادي.
 *   blocked   — ممنوع من الاستخدام.
 *   claimed   — مستخدم من حساب آخر.
 *   self      — مستخدم من الحساب الحالي (لا يُعامل كاسم محجوز لغيره).
 *   unknown   — لم يُتحقق (الخادم غير متاح أو الدالة غير مثبتة): لا ادعاء.
 */
export type UsernameRegistryState =
  | 'available'
  | 'reserved'
  | 'blocked'
  | 'claimed'
  | 'self'
  | 'unknown';

export const USERNAME_REGISTRY_STATES: readonly UsernameRegistryState[] = [
  'available',
  'reserved',
  'blocked',
  'claimed',
  'self',
  'unknown',
];

export function isUsernameRegistryState(value: unknown): value is UsernameRegistryState {
  return typeof value === 'string'
    && (USERNAME_REGISTRY_STATES as readonly string[]).includes(value);
}

/** هل يمكن اختيار هذا الاسم الآن؟ الحالة المجهولة لا تُعدّ إتاحة. */
export function isUsernameSelectable(state: UsernameRegistryState): boolean {
  return state === 'available' || state === 'self';
}

/** رسالة واحدة لكل حالة: متاحة، محجوزة، ممنوعة، مأخوذة، أو غير متحقق. */
export function usernameStateMessage(state: UsernameRegistryState): string {
  switch (state) {
    case 'available':
      return USERNAME_MESSAGES.available;
    case 'self':
      return USERNAME_MESSAGES.own;
    case 'claimed':
      return USERNAME_MESSAGES.taken;
    case 'reserved':
      return USERNAME_MESSAGES.reserved;
    case 'blocked':
      return USERNAME_MESSAGES.blocked;
    default:
      return USERNAME_MESSAGES.checkUnavailable;
  }
}

export type UsernameErrorLike = {
  code?: string | null;
  message?: string | null;
} | null | undefined;

/**
 * رسالة عربية لخطأ المطالبة بالاسم من قاعدة البيانات.
 * الدوال ترمي بأسباب مميزة (username reserved / blocked / invalid_username) أو
 * 23505 للتكرار، فلا يُعرض نص القاعدة الخام للمستخدم.
 */
export function describeUsernameClaimError(error: UsernameErrorLike): string {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '').toLowerCase();

  // الدالة غير مثبتة بعد: لا ادعاء نجاح ولا ادعاء إتاحة.
  if (code === '42883' || code === 'PGRST202' || message.includes('could not find the function')) {
    return USERNAME_MESSAGES.checkUnavailable;
  }
  if (message.includes('reserved')) return USERNAME_MESSAGES.reserved;
  if (message.includes('blocked') || message.includes('not available')) return USERNAME_MESSAGES.blocked;
  if (code === '23505' || message.includes('duplicate') || message.includes('already claimed')) {
    return USERNAME_MESSAGES.taken;
  }
  if (code === '22023' || message.includes('invalid_username') || message.includes('invalid username')) {
    return USERNAME_MESSAGES.invalidCharacters;
  }
  if (code === '42501' || message.includes('permission')) return USERNAME_MESSAGES.blocked;
  return USERNAME_MESSAGES.checkUnavailable;
}
