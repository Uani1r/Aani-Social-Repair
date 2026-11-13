// اختبارات وحدة لمسار فحص المراجع (mediaDb) — تعمل بـ tsx --test بلا شبكة:
// - صياغة شروط PostgREST لعمود المصفوفة media_urls بعدة روابط (شرط ov لكل رابط).
// - الاحتفاظ بنص استجابة الخطأ في restRequest وتصنيف فجوات المخطط.
// - Fail Closed: أي خطأ غير معروف يمنع الحذف، وفجوة المخطط وحدها تُتخطى لكل عمود.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  arrayOverlapCondition,
  buildMediaReferenceConditions,
  isMissingRelationError,
  isUnknownColumnError,
  MediaReferenceCheckError,
  postgrestValue,
  requireSuccessfulCheck,
  restRequest,
  textMatchCondition,
  mediaInActiveUse,
  normalizeMediaUrl,
} from "./mediaDb";

const CONFIG = { url: "https://example.supabase.co", serviceRoleKey: "service-key" };

type FakeResult = unknown[] | { status: number; body: string };

function stubSupabaseFetch(handler: (table: string, params: URLSearchParams) => FakeResult): {
  tables: string[];
  orParams: Map<string, string>;
  restore: () => void;
} {
  const tables: string[] = [];
  const orParams = new Map<string, string>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const table = url.pathname.split("/")[3] ?? "";
    tables.push(table);
    orParams.set(table, url.searchParams.get("or") ?? "");
    const result = handler(table, url.searchParams);
    if (Array.isArray(result)) {
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(result.body, { status: result.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    tables,
    orParams,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

/* ------------------------------------------------------------------ */
/* صياغة شروط PostgREST                                                */
/* ------------------------------------------------------------------ */

test('postgrestValue: القيم العادية تبقى كما هي والخاصة تُغلَّف باقتباس مضاعف', () => {
  assert.equal(postgrestValue('https://ik.imagekit.io/aani/u1/x.mp4'), 'https://ik.imagekit.io/aani/u1/x.mp4');
  assert.equal(postgrestValue('a,b'), '"a,b"');
  assert.equal(postgrestValue('a"b'), '"a""b"');
  assert.equal(postgrestValue('a(b)'), '"a(b)"');
});

test('arrayOverlapCondition: شرط ov مستقل لكل رابط على عمود المصفوفة', () => {
  const url = 'https://ik.imagekit.io/anisocial/aani/u1/video.mp4';
  assert.equal(arrayOverlapCondition('media_urls', url), `media_urls.ov.{${url}}`);
  // رابط يحتوي فاصلة يُغلَّف حتى لا تنكسر صيغة or=(...)
  assert.equal(
    arrayOverlapCondition('media_urls', 'https://ik.imagekit.io/anisocial/aani/u1/c,weird.mp4'),
    'media_urls.ov.{"https://ik.imagekit.io/anisocial/aani/u1/c,weird.mp4"}',
  );
});

test('textMatchCondition: ilike على الرابط كجزء من القيمة', () => {
  const url = 'https://ik.imagekit.io/anisocial/aani/u1/img.jpg';
  assert.equal(textMatchCondition('media_url', url), `media_url.ilike.*${url}*`);
});

test('فحص media_urls بعدة روابط: شرط ov لكل رابط على حدة — لا قائمة braces مجمعة', () => {
  const urls = [
    'https://ik.imagekit.io/anisocial/aani/u1/a.mp4',
    'https://ik.imagekit.io/anisocial/aani/u1/b.mp4',
    'https://ik.imagekit.io/anisocial/aani/u1/c,weird.mp4',
  ];
  const conditions = buildMediaReferenceConditions(urls, ['media_url', 'audio_url'], ['media_urls']);
  // لكل رابط: media_url + audio_url + media_urls = 3 شروط
  assert.equal(conditions.length, urls.length * 3);
  assert.equal(conditions[0], textMatchCondition('media_url', urls[0]));
  assert.equal(conditions[1], textMatchCondition('audio_url', urls[0]));
  assert.equal(conditions[2], arrayOverlapCondition('media_urls', urls[0]));

  // الشرطان ov مستقلان — لا تُجمع القيم في ov.{u1,u2} التي تنكسر داخل or=()
  const ovConditions = conditions.filter(condition => condition.includes('media_urls.ov.'));
  assert.equal(ovConditions.length, urls.length);
  assert.ok(ovConditions.every(condition => !condition.includes('a.mp4,b.mp4')));

  // الصيغة النهائية داخل or=() تبقى قابلة للتفسير: الفواصل تفصل شروطاً صحيحة فقط
  const orValue = `(${conditions.join(",")})`;
  assert.ok(orValue.includes('media_urls.ov.{https://ik.imagekit.io/anisocial/aani/u1/b.mp4}'));
  assert.ok(orValue.includes('media_urls.ov.{"https://ik.imagekit.io/anisocial/aani/u1/c,weird.mp4"}'));
});

/* ------------------------------------------------------------------ */
/* restRequest: نص الخطأ + تصنيف فجوات المخطط + Fail Closed            */
/* ------------------------------------------------------------------ */

test('restRequest يحتفظ بنص استجابة الخطأ ويصنف فجوة المخطط (42P01)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ code: "42P01", message: 'relation "public.profile_highlight_collections" does not exist' }),
      { status: 404, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const result = await restRequest(CONFIG, "GET", "profile_highlight_collections", { select: "id" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.ok(result.errorText.includes("does not exist"));
    assert.equal(isUnknownColumnError(result), true);
    // Fail Closed حتى مع فجوة المخطط: لا قائمة فارغة = آمن
    await assert.rejects(() => requireSuccessfulCheck(result), MediaReferenceCheckError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('نص الخطأ غير JSON (HTML/نص) يبقى متاحاً ويصنف فجوة مخطط', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("Could not find the 'cover_url' column of 'profile_highlight_collections' in the schema cache", {
      status: 400,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;
  try {
    const result = await restRequest(CONFIG, "GET", "profile_highlight_collections", { select: "id" });
    assert.equal(result.ok, false);
    assert.ok(result.errorText.includes("Could not find the '"));
    assert.equal(isUnknownColumnError(result), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('خطأ غير معروف (تصريح/500) لا يُصنف فجوة مخطط — Fail Closed يبقى قاتلاً', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "permission denied for table posts" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const result = await restRequest(CONFIG, "GET", "posts", { select: "id" });
    assert.equal(isUnknownColumnError(result), false);
    await assert.rejects(() => requireSuccessfulCheck(result), MediaReferenceCheckError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ------------------------------------------------------------------ */
/* mediaInActiveUse: تغطية كل الجداول + الفشل المغلق + فجوة المخطط      */
/* ------------------------------------------------------------------ */

const URL_A = 'https://ik.imagekit.io/anisocial/aani/user1/video-a.mp4';
const URL_B = 'https://ik.imagekit.io/anisocial/aani/user1/video-b.mp4';

test('mediaInActiveUse: بلا روابط ولا استبعاد → false بلا أي استعلام', async () => {
  const stub = stubSupabaseFetch(() => []);
  try {
    assert.equal(await mediaInActiveUse(CONFIG, []), false);
    assert.equal(stub.tables.length, 0);
  } finally {
    stub.restore();
  }
});

test('mediaInActiveUse: يستفسر عن كل جداول المراجع بشرط ov مستقل لكل رابط', async () => {
  const stub = stubSupabaseFetch(() => []);
  try {
    assert.equal(await mediaInActiveUse(CONFIG, [URL_A, URL_B]), false);
    const expectedTables = [
      'posts', 'stories', 'profile_highlights', 'profile_highlight_collections',
      'sounds', 'messages', 'profiles', 'media_assets',
    ];
    for (const table of expectedTables) {
      assert.ok(stub.tables.includes(table), `يجب فحص الجدول ${table}`);
    }
    const postsOr = stub.orParams.get('posts') ?? '';
    // شرط ov لكل رابط على حدة + rابط الصوت audio_url مغطى
    assert.ok(postsOr.includes(`media_urls.ov.{${URL_A}}`));
    assert.ok(postsOr.includes(`media_urls.ov.{${URL_B}}`));
    assert.ok(postsOr.includes(`audio_url.ilike.*${URL_A}*`));
    assert.ok(postsOr.includes(`media_url.ilike.*${URL_A}*`));
    // لا قائمة braces مجمعة بالفواصل
    assert.ok(!postsOr.includes(`${URL_A},${URL_B}`));
  } finally {
    stub.restore();
  }
});

test('mediaInActiveUse: أي جدول يرى الملف → مستخدم (true)', async () => {
  const stub = stubSupabaseFetch((table) => (table === 'messages' ? [{ id: 'm1' }] : []));
  try {
    assert.equal(await mediaInActiveUse(CONFIG, [URL_A]), true);
  } finally {
    stub.restore();
  }
});

test('mediaInActiveUse: فشل جدول (500) → استثناء Fail Closed، لا حذف', async () => {
  const stub = stubSupabaseFetch((table) =>
    table === 'sounds' ? { status: 500, body: '{"message":"internal error"}' } : []);
  try {
    await assert.rejects(() => mediaInActiveUse(CONFIG, [URL_A]), MediaReferenceCheckError);
  } finally {
    stub.restore();
  }
});

test('mediaInActiveUse: فجوة مخطط على عمود واحد (PGRST204) تُتخطى والباقي يُفحص', async () => {
  // profile_highlight_collections بلا عمود cover_url في هذه البيئة —
  // التخطي شرطاً شرطاً، وبقية الجداول تعود فارغة → false مع تسجيل التحذير
  const schemaGapBody = JSON.stringify({
    code: 'PGRST204',
    message: "Could not find the 'cover_url' column of 'profile_highlight_collections' in the schema cache",
  });
  const stub = stubSupabaseFetch((table) =>
    table === 'profile_highlight_collections'
      ? { status: 400, body: schemaGapBody }
      : []);
  try {
    assert.equal(await mediaInActiveUse(CONFIG, [URL_A]), false);
    assert.ok(stub.tables.includes('messages'));
    assert.ok(stub.tables.includes('media_assets'));
  } finally {
    stub.restore();
  }
});

test('تطبيع الروابط يزيل التزخرف قبل الفحص (?tr= / #t=)', () => {
  const base = 'https://ik.imagekit.io/anisocial/aani/u1/x.mp4';
  assert.equal(normalizeMediaUrl(`${base}?tr=w-400`), base);
  assert.equal(normalizeMediaUrl(`${base}#t=5,10`), base);
});

/* ------------------------------------------------------------------ */
/* تصنيف الجداول: أساسية (غيابها يوقف الحذف) مقابل اختيارية            */
/* ------------------------------------------------------------------ */

test('isMissingRelationError: يميز غياب الجدول عن غياب العمود', () => {
  const tableMissing = { status: 404, data: { code: "42P01", message: 'relation "public.posts" does not exist' } };
  const tableMissingRest = { status: 404, data: null, errorText: "Could not find the table 'profile_highlight_collections' in the schema cache" };
  const columnMissing = { status: 400, data: { code: "PGRST204", message: "Could not find the 'cover_url' column of 'profile_highlight_collections' in the schema cache" } };
  const pgColumnMissing = { status: 400, data: { code: "42703", message: "column posts.xyz does not exist" } };
  assert.equal(isMissingRelationError(tableMissing), true);
  assert.equal(isMissingRelationError(tableMissingRest), true);
  assert.equal(isMissingRelationError(columnMissing), false);
  assert.equal(isMissingRelationError(pgColumnMissing), false);
  assert.equal(isMissingRelationError({ status: 500, data: null }), false);
});

test('غياب جدول أساسي (posts) يوقف الحذف تماماً — استثناء وليس "غير مستخدم"', async () => {
  const stub = stubSupabaseFetch((table) =>
    table === 'posts'
      ? { status: 404, body: '{"code":"42P01","message":"relation \\"public.posts\\" does not exist"}' }
      : []);
  try {
    // الفحص يرمي استثناءً → المهمة تعود إلى pending → لا حذف
    await assert.rejects(() => mediaInActiveUse(CONFIG, [URL_A]), MediaReferenceCheckError);
  } finally {
    stub.restore();
  }
});

test('غياب الجدول الاختياري كاملاً (profile_highlight_collections) يُتخطى وفق السياسة', async () => {
  const stub = stubSupabaseFetch((table) =>
    table === 'profile_highlight_collections'
      ? { status: 404, body: '{"code":"PGRST205","message":"Could not find the table \'profile_highlight_collections\' in the schema cache"}' }
      : []);
  try {
    // الجدول الاختياري الوحيد — غيابه في بيئة بلا أبرز قصص يعني لا مراجع أصلاً
    assert.equal(await mediaInActiveUse(CONFIG, [URL_A]), false);
    // بقية الجداول الأساسية فُحصت فعلاً
    assert.ok(stub.tables.includes('posts'));
    assert.ok(stub.tables.includes('messages'));
    assert.ok(stub.tables.includes('media_assets'));
  } finally {
    stub.restore();
  }
});

test('غياب عمود في جدول أساسي يُتخطى شرطاً شرطاً والبقية تُفحص (posts.media_urls)', async () => {
  const stub = stubSupabaseFetch((table, params) => {
    if (table !== 'posts') return [];
    const orValue = params.get('or') ?? '';
    if (orValue.includes('media_urls')) {
      // or=() المجمعة تفشل بسبب عمود media_urls غير الموجود
      return { status: 400, body: '{"code":"PGRST204","message":"Could not find the \'media_urls\' column of \'posts\' in the schema cache"}' };
    }
    // فحص شرط واحد (media_url أو audio_url) يعمل
    return [];
  });
  try {
    assert.equal(await mediaInActiveUse(CONFIG, [URL_A]), false);
    // أُجري فحوص فردية بعد انكشاف غياب العمود
    const singleProbes = stub.tables.filter(name => name === 'posts').length;
    assert.ok(singleProbes > 1);
  } finally {
    stub.restore();
  }
});

/* ------------------------------------------------------------------ */
/* تطبيع الروابط (السياسة الموثقة في normalizeMediaUrl)                */
/* ------------------------------------------------------------------ */

test('روابط موقعة ومعاملات تحويل متعددة تُوحَّد — وروابط مختلفة فعلاً لا تتطابق', () => {
  const plain = 'https://ik.imagekit.io/anisocial/aani/u1/v.mp4';
  // توقيع/صلاحية/تحويل: نفس المورد (المسار هو الهوية) — للمقارنة فقط، لا للجلب
  assert.equal(normalizeMediaUrl(`${plain}?ik-s=f4a9&ik-t=1712345678&ik-ep=180`), plain);
  assert.equal(normalizeMediaUrl(`${plain}?tr=w-400&tr=q-auto`), plain);
  assert.equal(
    normalizeMediaUrl(`${plain}?ik-s=aaa`),
    normalizeMediaUrl(`${plain}?ik-s=bbb&expires=1999999999`),
  );
  // ملفات مختلفة فعلاً لا تُدمج أبداً
  assert.notEqual(
    normalizeMediaUrl('https://ik.imagekit.io/anisocial/aani/u1/a.mp4?tr=w-100'),
    normalizeMediaUrl('https://ik.imagekit.io/anisocial/aani/u1/b.mp4?tr=w-100'),
  );
});


/* ------------------------------------------------------------------ */
/* حمولة PostgREST الحقيقية: غياب جدول في الكاش كان يُسقط الخادم كاملاً  */
/* ------------------------------------------------------------------ */

// نفس جسم الاستجابة الذي أعادته قاعدة البيانات الحقيقية وأسقط عملية api-server.
const MISSING_OPTIONAL_TABLE_BODY = JSON.stringify({
  code: 'PGRST205',
  details: null,
  hint: null,
  message: "Could not find the table 'public.profile_highlight_collections' in the schema cache",
});

test('PGRST205 الحقيقي (لا رمز داخل message) يُصنَّف غياب جدول لا خطأ قاتلاً', () => {
  const result = { status: 404, data: JSON.parse(MISSING_OPTIONAL_TABLE_BODY) as unknown, errorText: MISSING_OPTIONAL_TABLE_BODY };
  assert.equal(isUnknownColumnError(result), true);
  assert.equal(isMissingRelationError(result), true);
  // غياب عمود لا يُصنَّف غياب جدول
  const columnGap = {
    status: 400,
    data: { code: 'PGRST204', message: "Could not find the 'cover_url' column of 'profile_highlight_collections' in the schema cache" },
    errorText: '',
  };
  assert.equal(isMissingRelationError(columnGap), false);
});

test('غياب الجدول الاختياري بالحمولة الحقيقية: تُتخطى الجداول الأساسية ولا حذف على الشك', async () => {
  const stub = stubSupabaseFetch((table) =>
    table === 'profile_highlight_collections'
      ? { status: 404, body: MISSING_OPTIONAL_TABLE_BODY }
      : []);
  try {
    assert.equal(await mediaInActiveUse(CONFIG, [URL_A]), false);
    assert.ok(stub.tables.includes('posts'));
    assert.ok(stub.tables.includes('messages'));
    assert.ok(stub.tables.includes('media_assets'));
  } finally {
    stub.restore();
  }
});

test('غياب جدول أساسي بالحمولة الحقيقية (PGRST205) يبقى Fail Closed', async () => {
  const stub = stubSupabaseFetch((table) =>
    table === 'sounds'
      ? {
          status: 404,
          body: JSON.stringify({
            code: 'PGRST205',
            details: null,
            hint: null,
            message: "Could not find the table 'public.sounds' in the schema cache",
          }),
        }
      : []);
  try {
    await assert.rejects(() => mediaInActiveUse(CONFIG, [URL_A]), MediaReferenceCheckError);
  } finally {
    stub.restore();
  }
});

test('فشل جدول لاحق لا يترك رفضاً غير معالجاً — كان يُسقط عملية Node.js', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  const stub = stubSupabaseFetch((table) => {
    if (table === 'profile_highlight_collections') return { status: 404, body: MISSING_OPTIONAL_TABLE_BODY };
    if (table === 'media_assets') return { status: 500, body: '{"message":"internal error"}' };
    return [];
  });
  try {
    // الجدول الاختياري (الرابع) يفشل بفجوة مخطط، والجدول الأساسي الأخير يفشل بـ 500:
    // لا يُنشأ وعد لجدول قبل بلوغه، فلا رفض معلّق بلا مُنتَظِر.
    await assert.rejects(() => mediaInActiveUse(CONFIG, [URL_A]), MediaReferenceCheckError);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(unhandled, []);
  } finally {
    stub.restore();
    process.off('unhandledRejection', onUnhandled);
  }
});
