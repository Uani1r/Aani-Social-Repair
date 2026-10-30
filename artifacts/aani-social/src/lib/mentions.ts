/**
 * أدوات المنشن (الإشارة إلى المستخدمين) داخل التعليقات.
 *
 * يُحفظ المنشن في النص بصيغة `@username` ليمكن استخراجه وربطه بالمستخدم،
 * لكن العرض لا يُظهر رمز @ إطلاقاً — يظهر الاسم فقط.
 */

export type MentionQuery = {
  /** النص المكتوب بعد الإشارة (أو الكلمة الحالية) */
  query: string;
  /** موضع بداية الكلمة الحالية في النص */
  start: number;
  /** موضع المؤشر (نهاية الكلمة الحالية) */
  end: number;
};

const MENTION_REGEX = /[@#]([A-Za-z0-9_.\u0600-\u06FF]{1,32})/g;
const TOKEN_CHARS = /[A-Za-z0-9_.\u0600-\u06FF]/;

/** يعيد قائمة أسماء المستخدمين المذكورين في النص (أحرف صغيرة، بدون تكرار) */
export const extractMentions = (text: string): string[] => {
  const found = new Set<string>();

  for (const match of text.matchAll(MENTION_REGEX)) {
    const token = match[1]?.trim();
    if (token) found.add(token.toLowerCase());
  }

  return Array.from(found);
};

/** يحذف رموز المنشن من النص (احتياطي للعرض والبحث) */
export const stripMentionSymbols = (text: string): string =>
  text.replace(MENTION_REGEX, "$1");

/** يعيد تعبيراً نظامياً جديداً لتحليل النص في واجهة العرض */
export const createMentionRegex = (): RegExp => new RegExp(MENTION_REGEX.source, "g");

/**
 * يحدّد الكلمة التي يكتبها المستخدم عند المؤشر: تُستخدم لعرض الاقتراحات
 * عند كتابة @ أو # أو عند بداية كتابة اسم شخص.
 */
export const findActiveMention = (text: string, caret: number): MentionQuery | null => {
  const safeCaret = Math.max(0, Math.min(caret, text.length));

  let start = safeCaret;
  while (start > 0 && TOKEN_CHARS.test(text[start - 1])) start -= 1;

  const token = text.slice(start, safeCaret);
  if (!token) return null;

  const hasSymbol = token.startsWith("@") || token.startsWith("#");
  const query = hasSymbol ? token.slice(1) : token;

  if (!query) return hasSymbol ? { query: "", start, end: safeCaret } : null;
  if (!hasSymbol && query.length < 2) return null;

  return { query, start, end: safeCaret };
};
