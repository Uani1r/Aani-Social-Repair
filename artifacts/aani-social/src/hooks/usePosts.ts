import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { decoratePost, hydratePostRows, useInteractionsVersion } from '@/lib/interactions';
import { handleAppError } from '@/lib/appErrors';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { normalizePostMetadata, type Post, type PostRow, type Profile } from '@/lib/types';
import { resolvePostMediaUrls } from '@/lib/postMedia';
import { registerContentRefreshRequest } from '@/lib/contentRefresh';
import {
  clearPendingReelsBatch,
  getPendingReelsBatch,
  setPendingReelsBatch,
  shouldDeferReelsBatch,
} from '@/lib/reelsBatches';

// ذاكرة مؤقتة على مستوى الوحدة (بديل Keep-Alive/staleTime):
// عند التنقل بين التبويبات (الرئيسية/الريلز/الملف الشخصي) تُركَّب
// الشاشة من جديد لكنها تُهيَّأ فوراً من هذه الذاكرة بلا شاشة
// Skeleton، مع تحديث صامت في الخلفية. الشاشة لا تُصفَّر إلا عند
// السحب للتحديث القسري (Pull to Refresh) أو عند النشر/الريبوست.
// المفتاح يشمل المستخدم الحالي، فلا تتشارك الحسابات مدخلات الذاكرة.
const postsCache = new Map<string, Post[]>();
// جيل مستقل لكل مفتاح: طلب أقدم لنفس المفتاح لا يستبدل نتيجة طلب أحدث منه.
const postsCacheGeneration = new Map<string, number>();
// وقت آخر دفعة ريلز ناجحة لكل مفتاح: يمنع طلبًا جديدًا عند كل إعادة تركيب
// للشاشة. لا يُستخدم إلا لمفتاح الريلز، ولا يمسّ منطق Feed.
const postsCacheTimestamp = new Map<string, number>();
const REELS_CACHE_TTL_MS = 5 * 60 * 1000;

interface RepostRow {
  post_id: string;
  user_id: string;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPostsPermissionError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const code = typeof value.code === 'string' ? value.code : '';
  const message = typeof value.message === 'string' ? value.message : '';
  return code === '42501' || /permission denied for table posts|row-level security.*posts|posts.*row-level security/i.test(message);
}

/**
 * العمود الذي رفض PostgREST الاستعلام بسببه، من بين الأعمدة المطلوبة فعلاً.
 * يغطي صيغ الرسائل المختلفة:
 *   column posts.likes_count does not exist
 *   column "likes_count" of relation "posts" does not exist
 *   Could not find the 'likes_count' column of 'posts' in the schema cache
 * يُستخدم لتقليص قائمة الأعمدة بدل فشل الاستعلام بالكامل.
 */
function missingSelectColumn(value: unknown, candidates: string[]): string | null {
  if (!isRecord(value)) return null;
  const code = typeof value.code === 'string' ? value.code : '';
  const message = typeof value.message === 'string' ? value.message : '';
  if (code !== '42703' && code !== 'PGRST204') return null;
  // الأطول أولاً حتى لا يُقرأ sound_trim_start على أنه trim_start
  return [...candidates]
    .sort((first, second) => second.length - first.length)
    .find(column => message.includes(column)) || null;
}

function normalizePostRow(value: unknown): PostRow | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.user_id !== 'string'
    || typeof value.created_at !== 'string') {
    return null;
  }

  const mediaUrls = Array.isArray(value.media_urls)
    ? (value.media_urls as unknown[]).filter((url: unknown): url is string => typeof url === 'string')
    : null;

  return {
    id: value.id,
    user_id: value.user_id,
    content: typeof value.content === 'string' ? value.content : '',
    post_metadata: normalizePostMetadata(value.post_metadata),
    media_url: typeof value.media_url === 'string' ? value.media_url : null,
    media_urls: mediaUrls,
    media_asset_id: typeof value.media_asset_id === 'string' ? value.media_asset_id : null,
    type: value.type === 'photo' || value.type === 'reel' ? value.type : 'text',
    display_order: typeof value.display_order === 'number' ? value.display_order : 0,
    destination: value.destination === 'reels' ? 'reels' : 'feed',
    visibility: value.visibility === 'private' ? 'private' : 'public',
    hide_likes: value.hide_likes === true,
    hide_comments: value.hide_comments === true,
    comment_privacy: value.comment_privacy === 'followers' || value.comment_privacy === 'custom'
      ? value.comment_privacy
      : 'public',
    created_at: value.created_at,
    // حقول الصوت: تُحمل من الصف لأن عناصر الواجهة (شريط الصوت) تعتمد عليها
    ...(typeof value.audio_url === 'string' || value.audio_url === null ? { audio_url: value.audio_url } : {}),
    ...(typeof value.audio_title === 'string' || value.audio_title === null ? { audio_title: value.audio_title } : {}),
    ...(typeof value.sound_id === 'string' || value.sound_id === null ? { sound_id: value.sound_id } : {}),
    ...(typeof value.sound_trim_start === 'number' || value.sound_trim_start === null ? { sound_trim_start: value.sound_trim_start } : {}),
    ...(typeof value.sound_trim_end === 'number' || value.sound_trim_end === null ? { sound_trim_end: value.sound_trim_end } : {}),
    ...(typeof value.reposter_id === 'string' || value.reposter_id === null
      ? { reposter_id: value.reposter_id }
      : {}),
  };
}

function normalizePostRows(value: unknown): PostRow[] {
  if (!Array.isArray(value)) return [];

  return (value as unknown[])
    .map(normalizePostRow)
    .filter((post): post is PostRow => post !== null);
}

async function normalizePostRowsWithVisibility(value: unknown): Promise<PostRow[]> {
  const posts = await resolvePostMediaUrls(normalizePostRows(value));
  if (posts.length === 0) return posts;

  try {
    const { data, error } = await supabase
      .from('posts')
      .select('id, visibility, hide_likes, hide_comments, comment_privacy')
      .in('id', posts.map(post => post.id));
    if (error || !Array.isArray(data)) return posts;

    const settingsById = new Map<string, Partial<PostRow>>();
    (data as unknown[]).forEach((row: unknown) => {
      if (!isRecord(row) || typeof row.id !== 'string') return;
      settingsById.set(row.id, {
        visibility: row.visibility === 'private' ? 'private' : 'public',
        hide_likes: row.hide_likes === true,
        hide_comments: row.hide_comments === true,
        comment_privacy: row.comment_privacy === 'followers' || row.comment_privacy === 'custom'
          ? row.comment_privacy
          : 'public',
      });
    });

    return posts.map(post => ({
      ...post,
      ...settingsById.get(post.id),
    }));
  } catch {
    // Keep the feed usable when the visibility migration has not been applied yet.
    return posts;
  }
}

function normalizeRepostRows(value: unknown): RepostRow[] {
  if (!Array.isArray(value)) return [];

  return (value as unknown[]).flatMap((item: unknown) => {
    if (!isRecord(item) || typeof item.post_id !== 'string' || typeof item.created_at !== 'string') return [];
    return [{
      post_id: item.post_id,
      user_id: typeof item.user_id === 'string' ? item.user_id : '',
      created_at: item.created_at,
    }];
  });
}

function normalizePostProfile(value: unknown): Profile | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;

  return {
    id: value.id,
    username: typeof value.username === 'string' ? value.username : '',
    full_name: typeof value.full_name === 'string' ? value.full_name : '',
    display_name: typeof value.display_name === 'string' || value.display_name === null
      ? value.display_name
      : undefined,
    avatar_url: typeof value.avatar_url === 'string' ? value.avatar_url : null,
    bio: typeof value.bio === 'string' ? value.bio : '',
  };
}

function profileMap(value: unknown): Map<string, Profile> {
  const profiles = new Map<string, Profile>();
  if (!Array.isArray(value)) return profiles;

  (value as unknown[]).forEach((item: unknown) => {
    const profile = normalizePostProfile(item);
    if (profile) profiles.set(profile.id, profile);
  });
  return profiles;
}

function fallbackProfile(id: string, fullName: string): Profile {
  return { id, username: '', full_name: fullName, avatar_url: null, bio: '' };
}

/**
 * يجلب إعادات النشر العامة لوجهة ما، ويُميّز بين الفراغ الصحيح والفشل الحقيقي:
 *   * مصفوفة — وقد تكون فارغة — إذا نجح الاستعلام فعلاً ولا توجد إعادات نشر
 *     مطابقة أو مرئية. الفراغ هنا نتيجة صحيحة وليس فشلاً.
 *   * null عند فشل حقيقي: خطأ في استعلام reposts، أو خطأ في استعلام posts بعد
 *     كل محاولات تقليص الأعمدة، أو استثناء غير متوقع.
 *
 * التمييز مهم لمسار الريلز الشخصي: فشل الجلب يجب أن يُعيد المسار الزمني
 * بالكامل، أما القائمة الفارغة فلا.
 */
async function fetchGlobalRepostsStrict(destination: 'feed' | 'reels'): Promise<Post[] | null> {
  try {
    const { data: repostData, error: repostError } = await supabase
      .from('reposts')
      .select('post_id, user_id, created_at')
      .order('created_at', { ascending: false })
      .limit(40);
    if (repostError) return null;

    const repostRows = normalizeRepostRows(repostData).filter(row => row.user_id);
    if (repostRows.length === 0) return [];

    // سقف صارم: أول 40 معرفاً فقط — لا سحب لمئات المنشورات المعاد نشرها دفعة واحدة
    const postIds = Array.from(new Set(repostRows.map(row => row.post_id))).slice(0, 40);
    // نفس منطق استعلام الريلز: تقليص الأعمدة عند عمود مفقود ثم (*) كحل أخير
    let repostColumns = [
      'id', 'user_id', 'content', 'post_metadata', 'media_url', 'media_urls',
      'media_asset_id', 'type', 'destination', 'visibility', 'created_at',
      'likes_count', 'comments_count', 'reposts_count', 'shares_count',
      'comments_disabled', 'audio_url', 'audio_title', 'sound_id',
      'sound_trim_start', 'sound_trim_end', 'trim_start', 'trim_end',
      'hide_likes', 'hide_comments', 'comment_privacy',
    ];
    const fetchRepostPosts = (columns: string) => supabase
      .from('posts')
      .select(columns)
      .in('id', postIds)
      .limit(40);
    let result = await fetchRepostPosts(repostColumns.join(', '));
    for (let attempt = 0; attempt < 10 && result.error; attempt += 1) {
      const missingColumn = missingSelectColumn(result.error, repostColumns);
      if (!missingColumn) break;
      console.warn('[posts] عمود مفقود في جدول posts — أُعيد استعلام الريبوست بدونه', missingColumn);
      repostColumns = repostColumns.filter(column => column !== missingColumn);
      result = await fetchRepostPosts(repostColumns.join(', '));
    }
    if (result.error) {
      console.warn('[posts] فشل استعلام الريبوست بالأعمدة الصريحة — إعادة المحاولة بكل الأعمدة (*)', result.error);
      result = await fetchRepostPosts('*');
    }
    const { data: postData, error: postsError } = result;
    if (postsError) return null;

    const originalPosts = (await normalizePostRowsWithVisibility(postData)).filter(post =>
      post.visibility === 'public'
      && (destination === 'reels'
        ? post.type === 'reel' || post.destination === 'reels'
        : post.destination === 'feed'),
    );
    const postsById = new Map(originalPosts.map(post => [post.id, post] as const));
    const visibleReposts = repostRows.filter(row => postsById.has(row.post_id));
    if (visibleReposts.length === 0) return [];

    const profileIds = Array.from(new Set([
      ...originalPosts.map(post => post.user_id),
      ...visibleReposts.map(repost => repost.user_id),
    ]));
    const { data: profileData } = await supabase
      .from('profiles')
      .select('id, username, full_name, display_name, avatar_url, gender')
      .in('id', profileIds);
    const profiles = profileMap(profileData);

    return visibleReposts.flatMap((repost): Post[] => {
      const post = postsById.get(repost.post_id);
      if (!post) return [];
      return [{
        ...post,
        author: profiles.get(post.user_id) || fallbackProfile(post.user_id, ''),
        reposter_id: repost.user_id,
        reposted_at: repost.created_at,
        repost_attribution: profiles.get(repost.user_id) || fallbackProfile(repost.user_id, ''),
        likes: [],
        comments: [],
      }];
    });
  } catch {
    return null;
  }
}

/**
 * الغلاف المستخدم في المسار الزمني (الرئيسية وتبويب الريلز): يحافظ على السلوك
 * الحالي بلا أي تغيير — الفشل يُعامل كقائمة فارغة فلا تُكسر الصفحة.
 */
async function fetchGlobalReposts(destination: 'feed' | 'reels'): Promise<Post[]> {
  return (await fetchGlobalRepostsStrict(destination)) ?? [];
}

export async function hydratePostInteractions(
  posts: Post[],
  currentUserId: string,
): Promise<Post[]> {
  return hydratePostRows(posts, currentUserId);
}

// =====================================================================
// المرحلة 4-B: ترتيب الرئيسية من دالة get_personalized_feed
// =====================================================================
// الدالة على Supabase تُعيد ترتيباً فقط (post_id, reposter_id, reposted_at,
// rank_position). صفوف المنشورات تبقى من جدول posts عبر نفس آليات التجهيز
// الحالية، فلا شكل بيانات جديد ولا استبدال لصفوف posts ببيانات RPC.
// أي فشل هنا يُعيد null فيعود المسار الزمني الحالي كما هو (fallback).
// =====================================================================

/** أقصى عدد عناصر يطلبه الـRPC، وأقصى مرشحين قبل الترتيب. */
const PERSONALIZED_FEED_LIMIT = 40;
const PERSONALIZED_FEED_CANDIDATES = 160;
/** مهلة قصوى لاستدعاء الـRPC قبل الانتقال إلى المسار الزمني (ms). */
const PERSONALIZED_FEED_TIMEOUT_MS = 6000;
/**
 * سقف مدة التشخيص المُبلَّغ عنها (ms) — يطابق سقف الخادم في
 * /api/feed-diagnostics، فلا يُرفض الملخص لزمن شاذ.
 */
const MAX_DIAGNOSTIC_DURATION_MS = 120000;
/**
 * أعمدة المنشورات في المسار الشخصي — نفس قائمة المسار الزمني للرئيسية،
 * بلا display_order (خاصة بالملف الشخصي).
 */
const PERSONALIZED_POST_COLUMNS = [
  'id', 'user_id', 'content', 'post_metadata', 'media_url', 'media_urls',
  'media_asset_id', 'type', 'destination', 'visibility', 'created_at',
  'likes_count', 'comments_count', 'reposts_count', 'shares_count',
  'comments_disabled', 'audio_url', 'audio_title', 'sound_id',
  'sound_trim_start', 'sound_trim_end', 'trim_start', 'trim_end',
  'hide_likes', 'hide_comments', 'comment_privacy',
];

/** صف واحد من نتيجة get_personalized_feed بعد التحقق. */
type PersonalizedFeedRow = {
  post_id: string;
  reposter_id: string | null;
  reposted_at: string | null;
  rank_position: number;
};

/**
 * يتحقق من صفوف الـRPC: post_id نص غير فارغ، rank_position رقم منتهٍ،
 * reposter_id و reposted_at إمّا null أو نص. يمنع تكرار post_id ويحتفظ
 * بترتيب rank_position تصاعدياً. أي صف لا يطابق يُسقَط.
 */
function normalizePersonalizedFeedRows(value: unknown): PersonalizedFeedRow[] {
  if (!Array.isArray(value)) return [];

  const byPostId = new Map<string, PersonalizedFeedRow>();
  (value as unknown[]).forEach((item: unknown) => {
    if (!isRecord(item)) return;
    const postId = item.post_id;
    const rank = item.rank_position;
    if (typeof postId !== 'string' || !postId) return;
    if (typeof rank !== 'number' || !Number.isFinite(rank)) return;
    const reposterId = typeof item.reposter_id === 'string' && item.reposter_id
      ? item.reposter_id
      : null;
    const repostedAt = typeof item.reposted_at === 'string' && item.reposted_at
      ? item.reposted_at
      : null;
    const row: PersonalizedFeedRow = {
      post_id: postId,
      reposter_id: reposterId,
      reposted_at: repostedAt,
      rank_position: rank,
    };
    // عند تكرار post_id نُبقي أفضل ترتيب (الأصغر) — لا صفوف مكررة في النتيجة.
    const existing = byPostId.get(postId);
    if (!existing || row.rank_position < existing.rank_position) byPostId.set(postId, row);
  });

  return [...byPostId.values()].sort((first, second) => first.rank_position - second.rank_position);
}

/**
 * يرفض الوعد بعد المهلة، ليبقى المسار الشخصي محكوماً بزمن.
 * `label` هو نص خطأ المهلة فقط (لا سلوك)، فبقي الافتراضي كما هو للرئيسية.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label = 'personalized feed timeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(label)), timeoutMs);
    promise.then(
      value => { window.clearTimeout(timer); resolve(value); },
      error => { window.clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * يجلب صفوف المنشورات بمعرّفاتها، بنفس آلية الأعمدة الحالية: قائمة صريحة،
 * ثم تقليص عند أول عمود مفقود (42703/PGRST204)، ثم (*) كحل أخير.
 * يُعيد null عند فشل الجلب كاملاً ليتولّى المسار الزمني الأمر.
 */
async function fetchPersonalizedPostRows(postIds: string[]): Promise<unknown[] | null> {
  const buildQuery = (selected: string) => supabase
    .from('posts')
    .select(selected)
    .in('id', postIds)
    .limit(PERSONALIZED_FEED_LIMIT);

  let columns = [...PERSONALIZED_POST_COLUMNS];
  let result = await buildQuery(columns.join(', '));
  for (let attempt = 0; attempt < 10 && result.error; attempt += 1) {
    const missingColumn = missingSelectColumn(result.error, columns);
    if (!missingColumn) break;
    console.warn('[feed] عمود مفقود في جدول posts — أُعيد استعلام الترتيب الشخصي بدونه', missingColumn);
    columns = columns.filter(column => column !== missingColumn);
    result = await buildQuery(columns.join(', '));
  }
  if (result.error) {
    console.warn('[feed] فشل استعلام الترتيب الشخصي بالأعمدة الصريحة — إعادة المحاولة بكل الأعمدة (*)', {
      code: result.error.code,
      message: result.error.message,
    });
    result = await buildQuery('*');
  }
  if (result.error || !Array.isArray(result.data)) return null;
  return result.data as unknown[];
}

/** حالات نتيجة محاولة الترتيب الشخصي — مطابقة لما يقبله /api/feed-diagnostics. */
type FeedRankingOutcome =
  | 'personalized_success'
  | 'rpc_error'
  | 'rpc_timeout'
  /** خطأ غير متوقع بعد نجاح الـRPC: تطبيع أو جلب منشورات أو ملفات أو تجهيز. */
  | 'feed_processing_failed'
  | 'rpc_empty_or_invalid'
  | 'posts_fetch_failed'
  | 'no_usable_posts'
  | 'incomplete_match'
  | 'hydration_failed'
  /** تجهيز التفاعلات أعاد نفس المصفوفة: فشل داخلي ابتلعته hydratePostRows. */
  | 'hydration_incomplete'
  /** تجهيز التفاعلات لم يُشغَّل أصلاً (بلا جلسة أو بلا منشورات). ليس فشلاً. */
  | 'hydration_skipped';

/** ملخص تشخيصي واحد لكل محاولة تحديث للرئيسية. أعداد وزمن فقط، بلا محتوى. */
type FeedRankingDiagnostic = {
  operationId: string;
  outcome: FeedRankingOutcome;
  rpcRows: number;
  requestedPosts: number;
  matchedPosts: number;
  durationMs: number;
  /**
   * سبب الانتقال الفعلي إلى الجلب الزمني، أو null إن لم يحدث انتقال.
   * منفصل عن outcome عن قصد: فشل التجهيز لا يعود إلى الزمني في هذا الإصدار،
   * فيُسجَّل outcome = hydration_incomplete مع fallbackReason = null.
   */
  fallbackReason: FeedRankingOutcome | null;
};

/** معرّف عشوائي للعملية يربط سجلات المحاولة الواحدة في Render. */
function newDiagnosticOperationId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // نسقط إلى المولّد اليدوي أدناه
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

/**
 * يُرسل ملخصاً تشخيصياً إلى /api/feed-diagnostics ليُكتب في سجلات الخادم.
 *
 * غير حاجب تماماً: لا يُنتظر، ولا يرمي، ولا يؤثر على المحرك أو الـfallback.
 * الحمولة أعداد وزمن ومعرّفات حالة فقط — بلا محتوى منشور ولا معرّف حساب ولا
 * رابط وسائط ولا رمز جلسة (الرمز يبقى في ترويسة الطلب فقط).
 */
function reportFeedDiagnostic(diagnostic: FeedRankingDiagnostic): void {
  void (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      // بلا جلسة لا إرسال: نقطة التشخيص ترفض الطلب غير الموثّق أصلاً.
      if (!accessToken) return;
      await fetch('/api/feed-diagnostics', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation_id: diagnostic.operationId,
          outcome: diagnostic.outcome,
          rpc_rows: diagnostic.rpcRows,
          requested_posts: diagnostic.requestedPosts,
          matched_posts: diagnostic.matchedPosts,
          duration_ms: diagnostic.durationMs,
          fallback_reason: diagnostic.fallbackReason,
        }),
        cache: 'no-store',
        keepalive: true,
      });
    } catch {
      // فشل التشخيص لا يمسّ تحميل المنشورات ولا الـfallback بأي شكل.
    }
  })();
}

/**
 * المسار الشخصي للرئيسية. يُعيد مصفوفة Post[] جاهزة بترتيب rank_position عند
 * النجاح، أو null عند أي فشل — بما فيه نتيجة فارغة أو فشل التجهيز — ليستخدم
 * المستدعي الجلب الزمني الحالي بدل إظهار صفحة فارغة أو رسالة خطأ.
 *
 * يمرّ كل شيء عبر الآليات القائمة: normalizePostRowsWithVisibility
 * (ومعها resolvePostMediaUrls)، normalizePostRow، جلب ملفات المؤلفين، ثم
 * hydratePostInteractions — فحقول الوسائط والصوت والروابط الموقعة تبقى كما
 * هي بلا إعادة بناء.
 *
 * التجهيز النهائي (hydratePostInteractions) يقع داخل هذا الـtry عن قصد:
 * فشله يجب أن يعود إلى المسار الزمني، لا أن يصل إلى catch المستدعي فيُفرغ
 * الصفحة ويعرض خطأً.
 *
 * التشخيص: كل خروج يُسجّل ملخصاً واحداً (نتيجة + أعداد + زمن + سبب الانتقال).
 * التسجيل غير حاجب ولا يغيّر أي قرار: نفس شروط النجاح والـfallback كما هي.
 */
async function fetchPersonalizedFeedPosts(currentUserId: string): Promise<Post[] | null> {
  const operationId = newDiagnosticOperationId();
  const startedAt = Date.now();
  let rpcRows = 0;
  let requestedPosts = 0;
  let matchedPosts = 0;
  /**
   * مرحلة التنفيذ الحالية: true فقط داخل استدعاء الـRPC. كل خطأ غير متوقع
   * بعد نجاح الـRPC (تطبيع، جلب منشورات، تجهيز) لا يُصنَّف rpc_error.
   */
  let rpcPhase = false;

  /**
   * يسجّل الخروج الحالي ثم يُعيد القيمة كما هي بلا تغيير.
   * `fallbackReason` منفصل عن `outcome`: الانتقال إلى الزمني فقط هو ما يُسجَّل
   * كـfallback، أما فشل التجهيز الذي لا يعود إلى الزمني فيُسجَّل بـnull.
   */
  const finish = <T>(
    posts: T,
    outcome: FeedRankingOutcome,
    fallbackReason: FeedRankingOutcome | null,
  ): T => {
    reportFeedDiagnostic({
      operationId,
      outcome,
      rpcRows,
      requestedPosts,
      matchedPosts,
      durationMs: Math.min(MAX_DIAGNOSTIC_DURATION_MS, Math.max(0, Date.now() - startedAt)),
      fallbackReason,
    });
    return posts;
  };

  /** خروج مع انتقال فعلي إلى الجلب الزمني: النتيجة نفسها هي سبب الانتقال. */
  const fallBack = (outcome: FeedRankingOutcome): null => finish(null, outcome, outcome);

  try {
    // المرحلة الأولى: استدعاء الـRPC فقط. أي خطأ هنا (أو مهلة) يُصنَّف rpc_*.
    rpcPhase = true;
    const rpcResult = await withTimeout(
      Promise.resolve(supabase.rpc('get_personalized_feed', {
        p_limit: PERSONALIZED_FEED_LIMIT,
        p_candidate_limit: PERSONALIZED_FEED_CANDIDATES,
      })),
      PERSONALIZED_FEED_TIMEOUT_MS,
    );
    rpcPhase = false;

    if (rpcResult.error) {
      console.warn('[feed] تعذر استدعاء get_personalized_feed — الانتقال إلى الترتيب الزمني', {
        code: rpcResult.error.code,
        message: rpcResult.error.message,
      });
      return fallBack('rpc_error');
    }

    // rpcRows = الصفوف الخام كما وصلت قبل التطبيع، لكشف ما أُسقط أو تكرّر.
    rpcRows = Array.isArray(rpcResult.data) ? rpcResult.data.length : 0;
    const ranked = normalizePersonalizedFeedRows(rpcResult.data);
    // نتيجة فارغة أو غير صالحة بالكامل: المسار الزمني هو الإجراء الاحتياطي.
    if (ranked.length === 0) {
      console.info('[feed] نتيجة الترتيب الشخصي فارغة — الانتقال إلى الترتيب الزمني');
      return fallBack('rpc_empty_or_invalid');
    }

    // requestedPosts = الصفوف الصالحة بعد التطبيع (ما طُلب تحميله فعلاً).
    const requestedIds = ranked.map(row => row.post_id);
    requestedPosts = requestedIds.length;
    const postData = await fetchPersonalizedPostRows(requestedIds);
    if (postData === null) {
      console.warn('[feed] تعذر جلب منشورات الترتيب الشخصي — الانتقال إلى الترتيب الزمني');
      return fallBack('posts_fetch_failed');
    }

    const rawPosts = (await normalizePostRowsWithVisibility(postData))
      .filter(post => post.destination === 'feed');
    const postsById = new Map(rawPosts.map(post => [post.id, post] as const));
    if (postsById.size === 0) {
      console.warn('[feed] لا صفوف منشورات قابلة للاستخدام في الترتيب الشخصي — الانتقال إلى الترتيب الزمني');
      return fallBack('no_usable_posts');
    }

    // إسناد إعادة النشر: reposter_id و reposted_at من نتيجة الـRPC نفسها،
    // بلا خلط مع ترتيب المنشورات العادية.
    const reposterIds = ranked
      .map(row => row.reposter_id)
      .filter((id): id is string => typeof id === 'string' && Boolean(id));

    const authorIds = [...new Set(rawPosts.map(post => post.user_id))];
    const profileIds = [...new Set([...authorIds, ...reposterIds])];
    const { data: profileData } = await supabase
      .from('profiles')
      .select('id, username, full_name, display_name, avatar_url, gender')
      .in('id', profileIds);
    const profMap = profileMap(profileData);

    // الترتيب من rank_position: نمرّ على الصفوف المرتّبة، ونأخذ كل منشور مرة
    // واحدة. لا نُضيف أي منشور خارج قائمة الـRPC.
    const ordered: Post[] = [];
    for (const row of ranked) {
      const post = postsById.get(row.post_id);
      if (!post) continue;
      ordered.push({
        ...post,
        author: profMap.get(post.user_id) || fallbackProfile(post.user_id, ''),
        reposter_id: row.reposter_id,
        reposted_at: row.reposted_at,
        repost_attribution: row.reposter_id
          ? (profMap.get(row.reposter_id) || fallbackProfile(row.reposter_id, ''))
          : null,
        likes: [],
        comments: [],
      });
    }
    matchedPosts = ordered.length;

    // المطابقة يجب أن تكون كاملة: عدد المنشورات المجهّزة = عدد صفوف ranked.
    // أي نقص (منشور محذوف، أو محجوب أو غير مقروء بسبب RLS، أو مستبعد لأن
    // وجهته ليست feed) يعني نتيجة شخصية جزئية، فلا تُعرض ولا تُدمج مع
    // المسار الزمني: نُعيد null ليعود usePosts إلى الجلب الزمني بالكامل.
    if (ordered.length !== ranked.length) {
      console.warn('[feed] الترتيب الشخصي غير مكتمل — الانتقال إلى الترتيب الزمني', {
        requested: ranked.length,
        matched: ordered.length,
      });
      return fallBack('incomplete_match');
    }
    if (ordered.length === 0) return fallBack('no_usable_posts');

    // تجهيز التفاعلات: hydratePostRows تلتقط أخطاءها داخلياً وتُعيد **نفس**
    // المصفوفة التي وصلتها (سطر 385 و400-403 في hydration.ts)، فلا يصل أي
    // استثناء إلى catch أدناه. لذلك نكشف النجاح بمقارنة المرجع: مصفوفة جديدة
    // = التجهيز تمّ فعلاً، ونفس المرجع = لم يُطبَّق شيء.
    //
    // لا تغيير في السلوك: نُعيد `hydrated` كما هو في الحالتين، فالمنشورات
    // تُعرض من المسار الشخصي حتى لو فشل التجهيز، ولا انتقال إلى الزمني هنا.
    const hydrationApplicable = supabaseConfigured && Boolean(currentUserId) && ordered.length > 0;
    try {
      const hydrated = await hydratePostInteractions(ordered, currentUserId);
      if (!hydrationApplicable) return finish(hydrated, 'hydration_skipped', null);
      if (hydrated === ordered) {
        console.warn('[feed] تجهيز التفاعلات لم يُطبَّق (فشل داخلي) — المنشورات تُعرض بلا تجهيز');
        return finish(hydrated, 'hydration_incomplete', null);
      }
      return finish(hydrated, 'personalized_success', null);
    } catch (hydrationError) {
      console.warn('[feed] فشل تجهيز الترتيب الشخصي — الانتقال إلى الترتيب الزمني', hydrationError);
      return fallBack('hydration_failed');
    }
  } catch (caughtError) {
    // انتهاء المهلة له حالة مستقلة، وخطأ أثناء الـRPC نفسِه يُصنَّف rpc_error.
    // أي خطأ بعد نجاح الـRPC (تطبيع، جلب منشورات، ملفات، تجهيز) ليس خطأ RPC،
    // ويُسجَّل feed_processing_failed. القرار نفسه في كل الحالات: fallback.
    const timedOut = caughtError instanceof Error && caughtError.message === 'personalized feed timeout';
    console.warn('[feed] فشل المسار الشخصي — الانتقال إلى الترتيب الزمني', caughtError);
    if (timedOut) return fallBack('rpc_timeout');
    return fallBack(rpcPhase ? 'rpc_error' : 'feed_processing_failed');
  }
}

// =====================================================================
// المرحلة 5-C: ربط محرك ترتيب الريلز المستقل
// =====================================================================
// get_personalized_reels على Supabase تُعيد ترتيباً فقط (post_id,
// reposter_id, reposted_at, rank_position) — نفس شكل مخرجات
// get_personalized_feed. صفوف المنشورات تبقى من جدول posts عبر الآليات
// الحالية نفسها، فلا شكل بيانات جديد ولا إعادة بناء يدوية تفقد حقول الوسائط
// أو الصوت أو روابط ImageKit.
//
// الدالة موجودة ومطبَّقة على قاعدة الإنتاج. المسار الزمني الاحتياطي يُستخدم
// فقط عند فشل الـRPC أو انتهاء مهلته أو وصول نتيجة لا تطابق العقد (يُعاد null)،
// بلا دمج أي نتيجة جزئية معه.
// =====================================================================

/** أقصى عدد ريلز يطلبه الـRPC، وأقصى مرشحين قبل الترتيب (حدود الدالة). */
const PERSONALIZED_REELS_LIMIT = 40;
const PERSONALIZED_REELS_CANDIDATES = 200;
/** مهلة قصوى لاستدعاء الـRPC قبل الانتقال إلى المسار الزمني (ms). */
const PERSONALIZED_REELS_TIMEOUT_MS = 6000;

/** صف واحد من نتيجة get_personalized_reels بعد التحقق. */
type PersonalizedReelRow = {
  post_id: string;
  reposter_id: string | null;
  reposted_at: string | null;
  rank_position: number;
};

/**
 * يتحقق من صفوف الـRPC وفق عقد الدالة: post_id نص غير فارغ، rank_position رقم
 * منتهٍ، reposter_id و reposted_at نص أو null حصراً.
 *
 * أي مخالفة — نتيجة ليست مصفوفة، أو صف واحد غير صالح — تُبطل النتيجة كاملة
 * وتُعيد null. لا يُسقَط صف ولا يُحوَّل نوع غير مقبول إلى null، لأن التسامح
 * هنا يجعل نتيجة RPC ناقصة تمرّ كأنها صحيحة. المستدعي يعيد null بدوره فيعمل
 * المسار الزمني الحالي بالكامل.
 */
function normalizePersonalizedReelRows(value: unknown): PersonalizedReelRow[] | null {
  if (!Array.isArray(value)) return null;

  const byPostId = new Map<string, PersonalizedReelRow>();
  for (const item of value as unknown[]) {
    if (!isRecord(item)) return null;
    const postId = item.post_id;
    const rank = item.rank_position;
    if (typeof postId !== 'string' || !postId) return null;
    if (typeof rank !== 'number' || !Number.isFinite(rank)) return null;
    const reposterId = item.reposter_id;
    const repostedAt = item.reposted_at;
    if (reposterId !== null && typeof reposterId !== 'string') return null;
    if (repostedAt !== null && typeof repostedAt !== 'string') return null;
    const row: PersonalizedReelRow = {
      post_id: postId,
      reposter_id: reposterId,
      reposted_at: repostedAt,
      rank_position: rank,
    };
    // عقد الدالة يضمن صفاً واحداً لكل post_id (تدمج المصادر الثلاثة ويُختار
    // صف واحد قبل الحصص والترتيب)، فهذا الاحتياط لا يغيّر نتيجة مطابقة للعقد.
    const existing = byPostId.get(postId);
    if (!existing || row.rank_position < existing.rank_position) byPostId.set(postId, row);
  }

  return [...byPostId.values()].sort((first, second) => first.rank_position - second.rank_position);
}

/**
 * المسار الشخصي للريلز. يُعيد Post[] جاهزة بترتيب rank_position عند النجاح،
 * أو null عند أي فشل — RPC أو مهلة أو نتيجة ليست مصفوفة أو صف واحد مخالف
 * للعقد أو نتيجة فارغة أو جلب منشورات فاشل أو مطابقة ناقصة أو فشل تجهيز —
 * ليستخدم المستدعي جلب الريلز الزمني الحالي بالكامل.
 *
 * كل تحديث يعيد المحاولة: لا يوجد تعطيل دائم للمحرك بعد فشل، والفشل يعني
 * الترتيب الزمني لهذا التحديث فقط.
 *
 * كل صف يمرّ عبر الآليات القائمة: normalizePostRowsWithVisibility (ومعها
 * resolvePostMediaUrls)، fetchPersonalizedPostRows، profileMap، ثم
 * hydratePostInteractions — فلا إعادة بناء يدوية لصفوف المنشورات.
 *
 * إعادات النشر: الـRPC يُعيد إعادات نشر المستخدم نفسه داخل ترتيبه، ثم تُضاف
 * إعادات نشر المستخدمين الآخرين من fetchGlobalReposts('reels') كما هي في
 * المسار الزمني — بلا إسقاط، وبلا تكرار، وبلا خلط لترتيب التوصيات.
 */
async function fetchPersonalizedReelPosts(currentUserId: string): Promise<Post[] | null> {
  if (!supabaseConfigured) return null;

  try {
    const rpcResult = await withTimeout(
      Promise.resolve(supabase.rpc('get_personalized_reels', {
        p_limit: PERSONALIZED_REELS_LIMIT,
        p_candidate_limit: PERSONALIZED_REELS_CANDIDATES,
      })),
      PERSONALIZED_REELS_TIMEOUT_MS,
      'personalized reels timeout',
    );

    if (rpcResult.error) {
      // لا تعطيل دائم للمحرك: كل تحديث يعيد المحاولة، وفشل واحد يعني
      // الترتيب الزمني لهذا التحديث فقط.
      console.warn('[reels] تعذر استدعاء get_personalized_reels — الانتقال إلى الترتيب الزمني', {
        code: rpcResult.error.code,
        message: rpcResult.error.message,
      });
      return null;
    }

    const ranked = normalizePersonalizedReelRows(rpcResult.data);
    // نتيجة ليست مصفوفة، أو تحتوي صفاً واحداً مخالفاً للعقد: تُرفض كاملة —
    // لا تُسقَط صفوف ولا تُعرض نتيجة شخصية جزئية.
    if (ranked === null) {
      console.warn('[reels] نتيجة RPC غير صالحة أو لا تطابق العقد — الانتقال إلى الترتيب الزمني');
      return null;
    }
    // مصفوفة بلا صفوف: فشل أيضاً، والمسار الزمني هو الإجراء الاحتياطي.
    if (ranked.length === 0) {
      console.info('[reels] نتيجة ترتيب الريلز فارغة — الانتقال إلى الترتيب الزمني');
      return null;
    }

    // نفس دالة جلب منشورات الرئيسية: أعمدة صريحة تُقلَّص عند عمود مفقود ثم
    // (*)، وسقفها 40 صفاً = سقف طلب الريلز هنا.
    const postData = await fetchPersonalizedPostRows(ranked.map(row => row.post_id));
    if (postData === null) {
      console.warn('[reels] تعذر جلب منشورات ترتيب الريلز — الانتقال إلى الترتيب الزمني');
      return null;
    }

    // نفس تعريف الريل في المسار الزمني: أي منشور وُجّه إلى الريلز أو أي فيديو
    // (type = 'reel')، فتبقى ريلز الصور (type = 'photo') مدعومة كما هي.
    const rawPosts = (await normalizePostRowsWithVisibility(postData))
      .filter(post => post.destination === 'reels' || post.type === 'reel');
    const postsById = new Map(rawPosts.map(post => [post.id, post] as const));
    if (postsById.size === 0) {
      console.warn('[reels] لا صفوف منشورات قابلة للاستخدام في ترتيب الريلز — الانتقال إلى الترتيب الزمني');
      return null;
    }

    // ملفات أصحاب المنشورات والمعيدين للنشر معاً، بنفس استعلام profiles.
    const reposterIds = ranked
      .map(row => row.reposter_id)
      .filter((id): id is string => typeof id === 'string' && Boolean(id));
    const authorIds = [...new Set(rawPosts.map(post => post.user_id))];
    const profileIds = [...new Set([...authorIds, ...reposterIds])];
    const { data: profileData } = await supabase
      .from('profiles')
      .select('id, username, full_name, display_name, avatar_url, gender')
      .in('id', profileIds);
    const profMap = profileMap(profileData);

    // الترتيب من rank_position وحده: نمرّ على الصفوف المرتّبة ونأخذ كل منشور
    // مرة واحدة، ولا نُضيف أي منشور خارج قائمة الـRPC.
    const ordered: Post[] = [];
    for (const row of ranked) {
      const post = postsById.get(row.post_id);
      if (!post) continue;
      ordered.push({
        ...post,
        author: profMap.get(post.user_id) || fallbackProfile(post.user_id, ''),
        reposter_id: row.reposter_id,
        reposted_at: row.reposted_at,
        repost_attribution: row.reposter_id
          ? (profMap.get(row.reposter_id) || fallbackProfile(row.reposter_id, ''))
          : null,
        likes: [],
        comments: [],
      });
    }

    // المطابقة يجب أن تكون كاملة: أي نقص (منشور محذوف أو محجوب أو غير مقروء
    // بسبب RLS، أو مستبعد لأن وجهته ليست الريلز) يعني نتيجة جزئية، فلا تُعرض
    // ولا تُدمج مع المسار الزمني: null يعيد usePosts إلى الجلب الزمني كاملاً.
    if (ordered.length !== ranked.length) {
      console.warn('[reels] ترتيب الريلز غير مكتمل — الانتقال إلى الترتيب الزمني', {
        requested: ranked.length,
        matched: ordered.length,
      });
      return null;
    }

    // إعادات النشر العامة: تُضاف بعد الترتيب الشخصي، فلا يُسقطها ولا يخلط
    // ترتيب التوصيات. الـRPC يُعيد إعادات نشر المستخدم نفسه فقط (قيد RLS على
    // reposts)، وهذا المصدر يُكمل ريلز أعاد نشرها مستخدمون آخرون كما هي في
    // المسار الزمني — بنفس الدالة ونفس شروط الظهور والصلاحيات.
    //
    // تُستخدم النسخة الصارمة هنا: null يعني فشلاً حقيقياً في الجلب، فلا تُعرض
    // قائمة شخصية ناقصة الإعادات — بل يعمل المسار الزمني بالكامل. أما []
    // فتعني نجاح الاستعلام مع عدم وجود إعادات نشر، وهي نتيجة صحيحة.
    const repostedPosts = await fetchGlobalRepostsStrict('reels');
    if (repostedPosts === null) {
      console.warn('[reels] تعذر جلب إعادات النشر العامة — الانتقال إلى الترتيب الزمني');
      return null;
    }
    // منع التكرار من أكثر من مصدر: منشور ظهر في الترتيب الشخصي أو أُضيف قبله
    // من إعادة نشر أخرى يبقى مرة واحدة فقط، بالتمثيل الذي وصل أولاً (الترتيب
    // الشخصي أولاً ثم إعادات النشر بترتيبها الزمني).
    const seenIds = new Set(ordered.map(post => post.id));
    const extraReposted: Post[] = [];
    for (const reposted of repostedPosts) {
      if (seenIds.has(reposted.id)) continue;
      seenIds.add(reposted.id);
      extraReposted.push(reposted);
    }

    return await hydratePostInteractions([...ordered, ...extraReposted], currentUserId);
  } catch (caughtError) {
    console.warn('[reels] فشل مسار ترتيب الريلز — الانتقال إلى الترتيب الزمني', caughtError);
    return null;
  }
}

export function usePosts(query: 'feed' | 'reel' | 'profile', targetUserId?: string, currentUserId = '') {
  // مفتاح الذاكرة يشمل المستخدم الحالي: لا تتشارك الحسابات ذاكرة الريلز أو
  // المنشورات، فلا يظهر محتوى حساب لحساب آخر عند تبديل الجلسة.
  const cacheKey = `${query}:${targetUserId || ''}:${currentUserId}`;
  // دفعة ريلز معلّقة من جلسة سابقة لنفس المفتاح: تُطبَّق عند بداية جلسة عرض
  // جديدة بدل استبدال ما يراه المستخدم في منتصف المشاهدة.
  const pendingReelsBatch = query === 'reel' ? getPendingReelsBatch(cacheKey) : undefined;
  const hadCachedPosts = postsCache.has(cacheKey) || pendingReelsBatch !== undefined;
  // القائمة محفوظة مع مفتاحها: لا يمكن عرض منشورات مفتاح سابق ولو لإطار واحد.
  const [postState, setPostState] = useState<{ key: string; posts: Post[] }>(() => ({
    key: cacheKey,
    posts: (getPendingReelsBatch(cacheKey) ?? postsCache.get(cacheKey)) || [],
  }));
  const [loadingState, setLoading] = useState(!hadCachedPosts);
  const [error, setError] = useState('');
  // خطأ قراءة سجلات إعادة النشر (RLS/جدول مفقود) — يُعرض في تبويب إعادة النشر
  // بدل إظهار تبويب فارغ يوحي بعدم وجود إعادة نشر.
  const [repostsError, setRepostsError] = useState('');
  // هل بدأت هذه الشاشة بدفعة ريلز معلّقة من الخادم؟ يُستخدم لإعادة التمرير إلى
  // أول ريل بدل استعادة موضع قديم لا يطابق ترتيبًا جديدًا.
  const [reelsBatchReplaced, setReelsBatchReplaced] = useState(false);
  // جيل الطلب: كل استدعاء جديد يُبطل صلاحية ما قبله للكتابة على حالة الشاشة.
  const requestIdRef = useRef(0);

  // المعروض مرتبط بالمفتاح الحالي: إن كان مفتاح الحالة لحساب أو استعلام سابق
  // نقرأ مفتاح اللحظة الحالية من الذاكرة (أو لا شيء)، فلا تتسرّب بيانات سابقة
  // إلى أي render قبل تنفيذ التأثير.
  const posts = postState.key === cacheKey ? postState.posts : (postsCache.get(cacheKey) || []);
  const loading = postState.key === cacheKey ? loadingState : !hadCachedPosts;
  // أحدث قائمة معروضة: تُقرأ داخل refresh لمعرفة هل هناك دفعة يشاهدها المستخدم
  // الآن. مرجع لا اعتمادية: إدخال postState في اعتماديات useCallback كان
  // سيُعيد إنشاء refresh مع كل تحديث ويدخل في حلقة تحديث بلا نهاية.
  const visiblePostsRef = useRef<Post[]>(posts);
  visiblePostsRef.current = posts;

  const refresh = useCallback(async (silent = false) => {
    // جيل هذا الطلب: أي طلب أحدث منه يُلغي صلاحيته للكتابة على حالة الشاشة.
    const requestId = ++requestIdRef.current;
    const isLatestRequest = () => requestId === requestIdRef.current;

    // كل تحديث لحالة الشاشة (القائمة، الخطأ، التحميل، خطأ إعادة النشر) يمرّ من
    // هنا، فلا يكتبه إلا أحدث طلب.
    const commitState = (apply: () => void) => {
      if (!isLatestRequest()) return;
      apply();
    };

    // جيل مستقل لهذا المفتاح: أحدث طلب لنفس المفتاح هو وحده من يكتب ذاكرته،
    // فطلب أقدم لا يستبدل نتيجة أحدث منه في postsCache.
    const generation = (postsCacheGeneration.get(cacheKey) ?? 0) + 1;
    postsCacheGeneration.set(cacheKey, generation);
    const isLatestForKey = () => (postsCacheGeneration.get(cacheKey) ?? 0) === generation;

    // الذاكرة تُكتب لمفتاح هذا الطلب، وبشرط أن يكون أحدث طلب لذلك المفتاح:
    // طلب حساب سابق يبقى قادراً على حفظ نتيجته في مفتاحه ما لم يبدأ طلب أحدث
    // لنفس المفتاح. أما حالة الشاشة فلا يمسّها إلا أحدث طلب عامّاً.
    const setPosts = (value: Post[]) => {
      if (isLatestForKey()) postsCache.set(cacheKey, value);
      commitState(() => setPostState({ key: cacheKey, posts: value }));
    };

    // هل توجد دفعة ريلز معروضة الآن؟ التبديل تحتها ممنوع: الترتيب الجديد
    // يُحفظ كدفعة معلّقة ويُطبَّق عند بداية جلسة عرض جديدة (تركيب الشاشة).
    const shouldDeferBatch = query === 'reel'
      && shouldDeferReelsBatch(visiblePostsRef.current.length > 0);

    /** كتابة نتيجة جلب الريلز: مباشرة إن لا دفعة ظاهرة، وإلا إلى الطابور المعلّق. */
    const applyReelsResult = (value: Post[]) => {
      postsCacheTimestamp.set(cacheKey, Date.now());
      if (shouldDeferBatch && value.length > 0) {
        setPendingReelsBatch(cacheKey, value);
        return;
      }
      setPosts(value);
    };

    if (!supabaseConfigured) {
      setPosts([]);
      commitState(() => {
        setError('تعذر الاتصال بقاعدة البيانات. تحقق من إعدادات Supabase.');
        setLoading(false);
      });
      return;
    }
    if (!silent) commitState(() => setLoading(true));
    commitState(() => setError(''));
    if (query === 'feed' && !silent) setPosts([]);
    try {
      const fetchPostRows = async (
        kind: 'feed' | 'reel' | 'profile',
        profileId?: string,
        postIds?: string[],
        includeProfileOrder = true,
      ) => {
        // قائمة أعمدة صريحة، تُقلَّص تلقائياً عند أول عمود غير موجود في المخطط
        // (خطأ 42703) بدل أن يفشل استعلام الريلز بالكامل بصمت. وإن فشل كل شيء
        // نجلب كل الأعمدة (*) التي تسمح بها الصلاحيات.
        let columns = [
          'id', 'user_id', 'content', 'post_metadata', 'media_url', 'media_urls',
          'media_asset_id', 'type', 'destination', 'visibility', 'created_at',
          ...(kind === 'profile' && includeProfileOrder ? ['display_order'] : []),
          'likes_count', 'comments_count', 'reposts_count', 'shares_count',
          'comments_disabled', 'audio_url', 'audio_title', 'sound_id',
          'sound_trim_start', 'sound_trim_end', 'trim_start', 'trim_end',
          'hide_likes', 'hide_comments', 'comment_privacy',
        ];
        const buildQuery = (selected: string) => {
          const request = supabase.from('posts').select(selected);
          // سقف جلب صارم (40 منشوراً) على كل مسارات هذا الجلب — يمنع سحب
          // مئات الصفوف دفعة واحدة واستنزاف باندويث قاعدة البيانات المجانية
          if (kind === 'profile' && postIds) {
            return request.in('id', postIds).order('created_at', { ascending: false }).limit(40);
          }
          if (kind === 'profile' && includeProfileOrder) {
            return request.eq('user_id', profileId || '')
              .order('display_order', { ascending: true })
              .order('created_at', { ascending: false })
              .limit(40);
          }
          if (kind === 'profile') {
            return request.eq('user_id', profileId || '').order('created_at', { ascending: false }).limit(40);
          }
          return request.order('created_at', { ascending: false }).limit(40);
        };
        let result = await buildQuery(columns.join(', '));
        for (let attempt = 0; attempt < 10 && result.error; attempt += 1) {
          const missingColumn = missingSelectColumn(result.error, columns);
          if (!missingColumn) break;
          console.warn('[posts] عمود مفقود في جدول posts — أُعيد الاستعلام بدونه', {
            query: kind,
            column: missingColumn,
          });
          columns = columns.filter(column => column !== missingColumn);
          result = await buildQuery(columns.join(', '));
        }
        if (result.error) {
          console.warn('[posts] فشل الاستعلام بالأعمدة الصريحة — إعادة المحاولة بكل الأعمدة (*)', {
            query: kind,
            code: result.error.code,
            message: result.error.message,
            details: result.error.details,
            hint: result.error.hint,
          });
          result = await buildQuery('*');
        }
        return result;
      };

      if (query === 'feed') {
        // 4-B: نحاول أولاً ترتيب get_personalized_feed. أي فشل أو نتيجة
        // فارغة — بما فيه فشل التجهيز — يُعيد null، فينفّذ المسار الزمني
        // الحالي كما هو تماماً بدل صفحة فارغة أو رسالة خطأ.
        const personalizedPosts = await fetchPersonalizedFeedPosts(currentUserId);
        if (personalizedPosts) {
          setPosts(personalizedPosts);
          return;
        }

        const { data: postData, error: postsErr } = await fetchPostRows('feed');

        if (postsErr) throw postsErr;

        const rawPosts = (await normalizePostRowsWithVisibility(postData))
          .filter(post => post.destination === 'feed');
        let formatted: Post[] = [];
        if (rawPosts.length > 0) {
          const uIds = [...new Set(rawPosts.map(post => post.user_id))];
          const { data: profileData } = await supabase.from('profiles').select('id, username, full_name, display_name, avatar_url, gender').in('id', uIds);
          const profMap = profileMap(profileData);

          formatted = rawPosts.map(post => ({
            ...post,
            author: profMap.get(post.user_id) || fallbackProfile(post.user_id, ''),
            likes: [],
            comments: [],
          }));
        }

        const repostedPosts = await fetchGlobalReposts('feed');
        const feedPosts = [...repostedPosts, ...formatted].sort((first, second) =>
          Date.parse(second.reposted_at || second.created_at) - Date.parse(first.reposted_at || first.created_at),
        );
        setPosts(await hydratePostInteractions(feedPosts, currentUserId));
      } else if (query === 'profile' && targetUserId) {
        let profileRowsResult = await fetchPostRows('profile', targetUserId);
        if (profileRowsResult.error && (/display_order/i.test(profileRowsResult.error.message) || isPostsPermissionError(profileRowsResult.error))) {
          profileRowsResult = await fetchPostRows('profile', targetUserId, undefined, false);
        }
        const { data: postData, error: postsErr } = profileRowsResult;

        if (postsErr) throw postsErr;

        const rawPosts = await normalizePostRowsWithVisibility(postData);

        // جلب المنشورات التي أعاد المستخدم نشرها لعرضها في ملفه الشخصي.
        // error يُفحص صراحةً: فشل RLS أو غياب الجدول لا يُعرض كقائمة فارغة صامتة.
        const { data: repostData, error: repostsError } = await supabase
          .from('reposts')
          .select('post_id, user_id, created_at')
          .eq('user_id', targetUserId)
          .order('created_at', { ascending: false })
          .limit(100);

        if (repostsError) {
          console.error('[reposts] تعذر جلب إعادات نشر الملف الشخصي', {
            code: repostsError.code,
            message: repostsError.message,
            details: repostsError.details,
            hint: repostsError.hint,
            targetUserId,
          });
          commitState(() => {
            setRepostsError(
              repostsError.code === '42501'
                ? 'تعذر تحميل إعادات النشر: صلاحيات القراءة (RLS) تمنع قراءة سجلات reposts لهذا الحساب.'
                : 'تعذر تحميل إعادات النشر من قاعدة البيانات. حاول التحديث، وإن استمر الخطأ راجع سجلات التشخيص.',
            );
          });
        } else {
          commitState(() => setRepostsError(''));
        }

        const repostRows = repostsError ? [] : normalizeRepostRows(repostData);
        const repostPostIds = repostRows
          .map(row => row.post_id)
          .filter(id => !rawPosts.some(post => post.id === id));

        let repostedRaw: Array<PostRow & { reposter_id: string }> = [];
        const repostedAtById = new Map<string, string>();
        repostRows.forEach(row => repostedAtById.set(row.post_id, row.created_at));

        if (repostPostIds.length > 0) {
          // fetchPostRows يحدّ كل طلب بـ40 صفاً (حد PostgREST) — نجلب دفعات ونضمّها
          // حتى لا تختفي إعادات نشر بعد المنشور الأربعين.
          const repostedRawCollected: Array<PostRow & { reposter_id: string }> = [];
          for (let start = 0; start < repostPostIds.length; start += 40) {
            const chunk = repostPostIds.slice(start, start + 40);
            let repostRowsResult = await fetchPostRows('profile', undefined, chunk);
            if (repostRowsResult.error && (/display_order/i.test(repostRowsResult.error.message) || isPostsPermissionError(repostRowsResult.error))) {
              repostRowsResult = await fetchPostRows('profile', undefined, chunk, false);
            }
            if (repostRowsResult.error) {
              console.error('[reposts] تعذر جلب المنشورات الأصلية لإعادات النشر', {
                code: repostRowsResult.error.code,
                message: repostRowsResult.error.message,
                chunkSize: chunk.length,
              });
              continue;
            }
            const normalized = await normalizePostRowsWithVisibility(repostRowsResult.data);
            repostedRawCollected.push(...normalized.map(post => ({ ...post, reposter_id: targetUserId })));
          }
          repostedRaw = repostedRawCollected;
        }

        const allRaw: PostRow[] = [...rawPosts, ...repostedRaw];

        if (allRaw.length > 0) {
          const authorIds = [...new Set(allRaw.map(post => post.user_id))];
          const { data: profileData } = await supabase
            .from('profiles')
            .select('id, username, full_name, display_name, avatar_url, gender')
            .in('id', authorIds);
          const { data: reposterProfileData } = await supabase
            .from('profiles')
            .select('id, username, full_name, display_name, avatar_url, gender')
            .eq('id', targetUserId)
            .maybeSingle();

          const profMap = profileMap(profileData);
          const reposterProfile = normalizePostProfile(reposterProfileData)
            || fallbackProfile(targetUserId, 'مستخدم');

          const formattedPosts: Post[] = allRaw
            .map((post): Post => ({
              ...post,
              author: profMap.get(post.user_id) || fallbackProfile(post.user_id, 'مستخدم'),
              repost_attribution: post.reposter_id ? reposterProfile : null,
              likes: [],
              comments: [],
            }))
            .sort((a, b) => {
              const aTime = repostedAtById.get(a.id) || a.created_at;
              const bTime = repostedAtById.get(b.id) || b.created_at;
              return new Date(bTime).getTime() - new Date(aTime).getTime();
            });

          const orderedOwnedPosts = formattedPosts
            .filter(post => post.user_id === targetUserId && !post.reposter_id)
            .sort((a, b) => (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER));
          let ownedPostIndex = 0;
          const postsWithProfileOrder = formattedPosts.map(post => (
            post.user_id === targetUserId && !post.reposter_id
              ? orderedOwnedPosts[ownedPostIndex++] || post
              : post
          ));

          setPosts(await hydratePostInteractions(postsWithProfileOrder, currentUserId));
        } else {
          setPosts([]);
        }
      } else if (query === 'reel') {
        // 5-C: نحاول أولاً ترتيب get_personalized_reels. أي فشل أو مهلة أو
        // نتيجة فارغة/غير صالحة أو مطابقة ناقصة يُعيد null، فينفّذ المسار
        // الزمني الحالي كما هو تماماً — بلا دمج أي نتيجة جزئية معه.
        const personalizedReels = await fetchPersonalizedReelPosts(currentUserId);
        if (personalizedReels) {
          applyReelsResult(personalizedReels);
          return;
        }

        const { data: postData, error: postsErr } = await fetchPostRows('reel');

        if (postsErr) {
          // اطبع الخطأ الحقيقي (عمود ناقص/صلاحيات/RLS) بدل رسالة عامة فقط
          console.error('[reels] فشل استعلام الريلز', {
            code: postsErr.code,
            message: postsErr.message,
            details: postsErr.details,
            hint: postsErr.hint,
          });
          throw postsErr;
        }

        const allRows = await normalizePostRowsWithVisibility(postData);
        // الريل هو أي منشور وُجّه إلى الريلز أو أي فيديو (type = 'reel')،
        // حتى لو حُفظت وجهته feed بسبب قاعدة بيانات ناقصة الترحيلات.
        const rawPosts = allRows.filter(post => post.destination === 'reels' || post.type === 'reel');
        if (allRows.length > 0 && rawPosts.length === 0) {
          console.warn('[reels] الاستعلام أعاد صفوفاً لكن لا أحدها ريل', allRows.slice(0, 5).map(post => ({
            id: post.id,
            type: post.type,
            destination: post.destination,
          })));
        }
        const reelsWithoutMedia = rawPosts.filter(post => !post.media_url && !post.media_urls?.length);
        if (reelsWithoutMedia.length > 0) {
          console.warn('[reels] ريلز بلا رابط وسائط (ستظهر شاشة سوداء)', reelsWithoutMedia.map(post => ({
            id: post.id,
            media_asset_id: post.media_asset_id ?? null,
          })));
        }
        let formatted: Post[] = [];
        if (rawPosts.length > 0) {
          const uIds = [...new Set(rawPosts.map(post => post.user_id))];
          const { data: profileData } = await supabase.from('profiles').select('id, username, full_name, display_name, avatar_url, gender').in('id', uIds);
          const profMap = profileMap(profileData);

          formatted = rawPosts.map(post => ({
            ...post,
            author: profMap.get(post.user_id) || fallbackProfile(post.user_id, ''),
            likes: [],
            comments: [],
          }));
        }

        const repostedPosts = await fetchGlobalReposts('reels');
        const reelPosts = [...repostedPosts, ...formatted].sort((first, second) =>
          Date.parse(second.reposted_at || second.created_at) - Date.parse(first.reposted_at || first.created_at),
        );
        applyReelsResult(await hydratePostInteractions(reelPosts, currentUserId));
      }
    } catch (caughtError) {
      // طلب قديم (مفتاح أو حساب سابق): لا يمسّ حالة الشاشة ولا رسائل الخطأ.
      if (!isLatestRequest()) return;
      console.error('[posts] فشل جلب المنشورات', { query, error: caughtError });
      if (!silent) {
        commitState(() => {
          // الريلز لا تُفرَّغ عند فشل تحديث: القائمة المعروضة تبقى كما هي بدل
          // شاشة فارغة أو إعادة بناء بترتيب لم يعد مطابقًا.
          if (query !== 'reel') setPostState({ key: cacheKey, posts: [] });
          const errorCode = isRecord(caughtError) && typeof caughtError.code === 'string' ? caughtError.code : '';
          const errorMessage = isRecord(caughtError) && typeof caughtError.message === 'string' ? caughtError.message : '';
          const errorDetail = errorCode || errorMessage
            ? ` (${[errorCode, errorMessage].filter(Boolean).join(': ')})`
            : '';
          setError(isPostsPermissionError(caughtError)
            ? 'تعذر قراءة المنشورات بسبب صلاحيات جدول posts. راجع GRANT وسياسات RLS في Supabase لدور authenticated.'
            : `تعذر تحميل ${query === 'reel' ? 'الريلز' : 'المنشورات'}. أعد المحاولة بعد لحظات.${errorDetail}`);
        });
      }
      handleAppError(
        'فشل تحميل المنشورات',
        caughtError,
        'تعذر تحميل المنشورات. راجع التفاصيل التشخيصية ثم أعد المحاولة.',
      );
    } finally {
      if (!silent && isLatestRequest()) setLoading(false);
    }
  }, [query, targetUserId, currentUserId, cacheKey]);

  useEffect(() => {
    // ذاكرة المفتاح الحالي تحدد البداية وقرار التحديث الصامت: عند تغيّر الحساب
    // يتغيّر المفتاح، فلا تُعرض قائمة الحساب السابق أثناء انتظار الجلب — تُعرض
    // ذاكرة الحساب الجديد إن وُجدت، وإلا حالة التحميل (Skeleton).
    const pendingBatch = query === 'reel' ? getPendingReelsBatch(cacheKey) : undefined;
    const cachedPosts = pendingBatch ?? postsCache.get(cacheKey);
    setPostState({ key: cacheKey, posts: cachedPosts ?? [] });
    setLoading(!cachedPosts);
    if (pendingBatch) {
      // جلسة عرض جديدة تبدأ بترتيب الخادم الأحدث: تُثبَّت الدفعة في الذاكرة
      // وتُزال من الطابور، وتُعلَّم الشاشة لتستأنف من أول ريل (لا موضع قديم
      // يشير إلى ترتيب مختلف).
      postsCache.set(cacheKey, pendingBatch);
      postsCacheTimestamp.set(cacheKey, Date.now());
      clearPendingReelsBatch(cacheKey);
      setReelsBatchReplaced(true);
    }
    // عند وجود محتوى محفوظ حديث: لا طلب جديد عند كل إعادة تركيب للشاشة؛
    // الجلب الصامت في الخلفية يبقى فقط بعد انتهاء صلاحية الذاكرة القصيرة.
    const cachedAt = postsCacheTimestamp.get(cacheKey) ?? 0;
    const cacheIsFresh = query === 'reel'
      && cachedPosts !== undefined
      && Date.now() - cachedAt < REELS_CACHE_TTL_MS;
    if (!cacheIsFresh) void refresh(cachedPosts !== undefined);
    let repostRefreshTimer: number | null = null;
    // تحديث فوري بعد نجاح النشر: جلب صامت يحدّث القائمة والذاكرة المؤقتة
    // دون وميض Skeleton، فيظهر الريل الجديد في تبويب الريلز مباشرة.
    const onPostCreated = () => void refresh(true);
    const onRepostChanged = () => {
      if (repostRefreshTimer !== null) window.clearTimeout(repostRefreshTimer);
      repostRefreshTimer = window.setTimeout(() => {
        repostRefreshTimer = null;
        void refresh(true);
      }, 80);
    };
    const onContentRefresh = (event: Event) => {
      if (query !== 'feed' && query !== 'reel') return;
      registerContentRefreshRequest(event, refresh(true));
    };
    window.addEventListener('aani:post-created', onPostCreated);
    window.addEventListener('aani:repost-changed', onRepostChanged);
    window.addEventListener('aani:content-refresh', onContentRefresh);
    return () => {
      // إبطال صلاحية أي طلب سابق عند تغيّر المفتاح أو مغادرة المكوّن: نتائجه
      // تبقى في ذاكرة مفتاحه، لكنها لا تكتب على حالة الشاشة.
      requestIdRef.current += 1;
      if (repostRefreshTimer !== null) window.clearTimeout(repostRefreshTimer);
      window.removeEventListener('aani:post-created', onPostCreated);
      window.removeEventListener('aani:repost-changed', onRepostChanged);
      window.removeEventListener('aani:content-refresh', onContentRefresh);
    };
  }, [refresh, cacheKey]);

  const interactionVersion = useInteractionsVersion();
  const currentPosts = useMemo(
    () => posts.map((post) => decoratePost(post, currentUserId)),
    [posts, currentUserId, interactionVersion],
  );

  return { posts: currentPosts, loading, error, repostsError, refresh, reelsBatchReplaced };
}
