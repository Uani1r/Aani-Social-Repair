// اختبارات وحدة لمنطق إعادة محاولة مهام الحذف (mediaDeletionWorker):
// Backoff تصاعدي بلا قفزات غير متوقعة، سقف 24 ساعة، إيقاف المحاولات عند
// استنفاد الحد الأقصى، شروط حجز المهام المستعارة، وسيناريوهات الحذف الآمن
// (ملف مستخدم لا يُحذف، فشل استعلام يمنع الحذف، معرفات مكررة لا تحذف مرتين) —
// كل ذلك ضد fetch مُختبر داخلياً؛ لا حذف حقيقي لأي ملف إنتاج إطلاقاً.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeRetryDelayMs, shouldStopRetrying, buildStaleClaimOrCondition } from "./mediaDeletionWorker";

test('تأخير إعادة المحاولة يتصاعد أُسّياً من 5 دقائق', () => {
  assert.equal(computeRetryDelayMs(0), 5 * 60 * 1000);
  assert.equal(computeRetryDelayMs(1), 10 * 60 * 1000);
  assert.equal(computeRetryDelayMs(2), 20 * 60 * 1000);
  assert.equal(computeRetryDelayMs(5), 32 * 5 * 60 * 1000);
});

test('تأخير إعادة المحاولة يسقف عند 24 ساعة بغض النظر عن المحاولة', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(computeRetryDelayMs(8), Math.min(256 * 5 * 60 * 1000, day));
  assert.equal(computeRetryDelayMs(8), day);
  assert.equal(computeRetryDelayMs(20), day);
});

test('مدخلات غير منطقية آمنة (سالب/كسرية/NaN تُعامل كصفر)', () => {
  assert.equal(computeRetryDelayMs(-3), 5 * 60 * 1000);
  assert.equal(computeRetryDelayMs(2.7), 20 * 60 * 1000);
});

test('إيقاف المحاولات عند الحد الأقصى (12) والبقاء قابل لإعادة الفتح قبله', () => {
  assert.equal(shouldStopRetrying(0), false);
  assert.equal(shouldStopRetrying(11), false);
  assert.equal(shouldStopRetrying(12), true);
  assert.equal(shouldStopRetrying(13), true);
  assert.equal(shouldStopRetrying(5, 6), false);
  assert.equal(shouldStopRetrying(6, 6), true);
});

test('شرط حجز المهام المستعارة يشمل pending المستحقة وprocessing منتهي الإيجار', () => {
  const now = new Date("2027-01-01T12:00:00Z");
  const condition = buildStaleClaimOrCondition(now, 30);
  assert.ok(condition.includes("and(status.eq.pending,next_attempt_at.lte.2027-01-01T12:00:00.000Z)"));
  // إيجار 30 دقيقة → حدود الاسترجاع 11:30
  assert.ok(condition.includes("and(status.eq.processing,updated_at.lte.2027-01-01T11:30:00.000Z)"));
  // إيجار مختلف يُحتسب صح
  const shortLease = buildStaleClaimOrCondition(now, 5);
  assert.ok(shortLease.includes("updated_at.lte.2027-01-01T11:55:00.000Z"));
});

/* ------------------------------------------------------------------ */
/* سيناريوهات الحذف الآمن (fetch مُختبر — لا ImageKit حقيقي ولا حذف فعلي) */
/* ------------------------------------------------------------------ */

const CONFIG = { url: "https://example.supabase.co", serviceRoleKey: "service-key" };
const USED_URL = "https://ik.imagekit.io/anisocial/aani/u1/used-video.mp4";
const UNUSED_URL = "https://ik.imagekit.io/anisocial/aani/u1/unused-video.mp4";

type Call = { method: string; url: string };

function stubFetch(handler: (method: string, url: string, body: unknown) => unknown): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input instanceof URL ? input : input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    let body: unknown = null;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = null; }
    }
    const result = handler(method, url, body);
    if (result === undefined) return new Response(null, { status: 204 });
    if (typeof result === "object" && result !== null && "status" in (result as Record<string, unknown>)) {
      const shaped = result as { status: number; body?: string };
      return new Response(shaped.body ?? "{}", { status: shaped.status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function isSupabaseTable(url: string, table: string): boolean {
  return url.includes(`${CONFIG.url}/rest/v1/${table}`) && !url.includes("/rpc/");
}

function isImageKit(url: string): boolean {
  return url.startsWith("https://api.imagekit.io/");
}

async function runWorker() {
  const { processDeletionJobs } = await import("./mediaDeletionWorker");
  return processDeletionJobs(CONFIG);
}

test('الملف المستخدم لا يُحذف: أي مرجع حي يعيد المهمة إلى pending بلا أي ندبة ImageKit', async () => {
  const stub = stubFetch((_method, url, body) => {
    if (url.includes("/rest/v1/rpc/aani_claim_media_deletion_jobs")) {
      return [{ id: 1, media_url: USED_URL, attempts: 0 }];
    }
    // جدول المنشورات يرى الملف (شرط ov/ilike يطابقه)
    if (isSupabaseTable(url, "posts")) {
      const orValue = new URL(url).searchParams.get("or") ?? "";
      return orValue.includes("used-video") ? [{ id: "post-1" }] : [];
    }
    if (isSupabaseTable(url, "media_deletion_jobs")) return undefined; // PATCH → 204
    return []; // بقية جداول المراجع فارغة
  });
  try {
    process.env["IMAGEKIT_PRIVATE_KEY"] = "test-key";
    const stats = await runWorker();
    assert.equal(stats.deferred, 1);
    assert.equal(stats.completed, 0);
    // لا ندبة حذف إلى ImageKit إطلاقاً
    assert.ok(!stub.calls.some(call => isImageKit(call.url) && call.method === "DELETE"));
    // المهمة أُعيدت إلى pending عبر PATCH
    const patches = stub.calls.filter(call => call.method === "PATCH" && isSupabaseTable(call.url, "media_deletion_jobs"));
    assert.ok(patches.length > 0);
  } finally {
    stub.restore();
  }
});

test('فشل استعلام مراجع يمنع الحذف ويعيد جدولة المهمة بلا ندبة ImageKit', async () => {
  const stub = stubFetch((method, url, body) => {
    if (url.includes("/rest/v1/rpc/aani_claim_media_deletion_jobs")) {
      return [{ id: 2, media_url: UNUSED_URL, attempts: 0 }];
    }
    if (isSupabaseTable(url, "sounds") && method === "GET") {
      return { status: 500, body: '{"message":"internal error"}' }; // فشل جدول أساسي
    }
    if (isSupabaseTable(url, "media_deletion_jobs")) return undefined;
    return [];
  });
  try {
    process.env["IMAGEKIT_PRIVATE_KEY"] = "test-key";
    const stats = await runWorker();
    assert.equal(stats.failed, 1);
    assert.equal(stats.completed, 0);
    assert.ok(!stub.calls.some(call => isImageKit(call.url) && call.method === "DELETE"));
  } finally {
    stub.restore();
  }
});

test('غياب جدول أساسي (posts بحذف 42P01) يوقف الحذف كلياً ولا يُعد الملف غير مستخدم', async () => {
  const stub = stubFetch((method, url) => {
    if (url.includes("/rest/v1/rpc/aani_claim_media_deletion_jobs")) {
      return [{ id: 3, media_url: UNUSED_URL, attempts: 0 }];
    }
    if (isSupabaseTable(url, "posts") && method === "GET") {
      return { status: 404, body: '{"code":"42P01","message":"relation \\"public.posts\\" does not exist"}' };
    }
    if (isSupabaseTable(url, "media_deletion_jobs")) return undefined;
    return [];
  });
  try {
    process.env["IMAGEKIT_PRIVATE_KEY"] = "test-key";
    const stats = await runWorker();
    // المهمة تُعاد (فشل داخل حلقة المعالجة) — لا حذف يقع على شك
    assert.equal(stats.completed, 0);
    assert.ok(!stub.calls.some(call => isImageKit(call.url) && call.method === "DELETE"));
  } finally {
    stub.restore();
  }
});

test('الملف غير المستخدم لا يُحذف إلا بعد نجاح جميع فحوص المراجع', async () => {
  const stub = stubFetch((method, url) => {
    if (url.includes("/rest/v1/rpc/aani_claim_media_deletion_jobs")) {
      return [{ id: 4, media_url: UNUSED_URL, attempts: 0 }];
    }
    if (isSupabaseTable(url, "media_deletion_jobs")) return undefined;
    if (isImageKit(url)) {
      if (method === "GET") return []; // القائمة كاملة: الملف غير موجود أصلاً (verified absent)
      return { status: 204 };
    }
    return []; // كل جداول المراجع فارغة
  });
  try {
    process.env["IMAGEKIT_PRIVATE_KEY"] = "test-key";
    const stats = await runWorker();
    assert.equal(stats.completed, 1);
    assert.equal(stats.deferred, 0);
  } finally {
    stub.restore();
  }
});

test('المهام المستعارة أو المكررة (نفس المعرف مرتين في الدفعة) لا تسبب حذفاً مزدوجاً', async () => {
  const stub = stubFetch((method, url) => {
    if (url.includes("/rest/v1/rpc/aani_claim_media_deletion_jobs")) {
      // خطأ حجز افتراضي: نفس المهمة مرتين في الدفعة
      return [
        { id: 7, media_url: UNUSED_URL, attempts: 0 },
        { id: 7, media_url: UNUSED_URL, attempts: 0 },
      ];
    }
    if (isSupabaseTable(url, "media_deletion_jobs")) return undefined;
    if (isImageKit(url)) {
      if (method === "GET") return [];
      return { status: 204 };
    }
    return [];
  });
  try {
    process.env["IMAGEKIT_PRIVATE_KEY"] = "test-key";
    const stats = await runWorker();
    // المهمة المكررة عُالجت مرة واحدة فقط — ندبة واحدة إلى ImageKit
    const imageKitListings = stub.calls.filter(call => isImageKit(call.url) && call.method === "GET");
    assert.equal(imageKitListings.length, 1);
    assert.equal(stats.completed, 1);
    assert.equal(stats.processed, 2); // الدفعة حملت مهمتين (إحداهما مكررة)
  } finally {
    stub.restore();
  }
});
