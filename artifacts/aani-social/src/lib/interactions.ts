/**
 * Persistent interactions layer (likes, comments, reposts, shares, bookmarks, threaded comments).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";

import { storageBucket, supabase, supabaseConfigured } from "./supabase";
import { displayName, type Post, type Profile } from "./types";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type InteractionSnapshot = {
  likes: number;
  comments: number;
  reposts: number;
  shares: number;
  saves: number;
  liked: boolean;
  bookmarked: boolean;
  reposted: boolean;
  shared: boolean;
  hydrated: boolean;
};

export type CommentAuthor = Partial<Profile> | null;

export type PostCommentRow = {
  id: string;
  post_id: string;
  user_id: string;
  content: string;
  created_at: string;
  author: CommentAuthor;
};

export interface CommentWithDetails {
  id: string;
  post_id: string;
  user_id: string;
  parent_id: string | null;
  content: string;
  image_url: string | null;
  created_at: string;
  profiles: {
    full_name: string;
    username: string;
    avatar_url: string | null;
  } | null;
  likes_count?: number;
  dislikes_count?: number;
  is_liked?: boolean;
  is_disliked?: boolean;
  replies?: CommentWithDetails[];
}

type RawRow = Record<string, any>;

type LocalPostState = {
  liked?: boolean;
  bookmarked?: boolean;
  reposted?: boolean;
  shared?: boolean;
  likes?: number;
  reposts?: number;
  shares?: number;
  comments?: number;
};

type LocalFlags = Record<string, LocalPostState>;

const EMPTY_SNAPSHOT: InteractionSnapshot = {
  likes: 0,
  comments: 0,
  reposts: 0,
  shares: 0,
  saves: 0,
  liked: false,
  bookmarked: false,
  reposted: false,
  shared: false,
  hydrated: false,
};

/* ------------------------------------------------------------------ */
/* Shared store                                                        */
/* ------------------------------------------------------------------ */

const cache = new Map<string, InteractionSnapshot>();
const listeners = new Set<() => void>();
const pendingWrites = new Map<string, number>();
const directHydration = new Map<string, number>();
const HYDRATION_TTL_MS = 20_000;
let version = 0;

function keyOf(postId: string, userId: string): string {
  return `${userId}:${postId}`;
}

function emit(): void {
  version += 1;
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error("interaction listener failed", error);
    }
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isPending(postId: string, userId: string): boolean {
  return (pendingWrites.get(keyOf(postId, userId)) ?? 0) > 0;
}

function markPending(postId: string, userId: string, delta: number): void {
  const key = keyOf(postId, userId);
  const next = (pendingWrites.get(key) ?? 0) + delta;
  if (next <= 0) pendingWrites.delete(key);
  else pendingWrites.set(key, next);
}

function readCache(
  postId: string,
  userId: string,
): InteractionSnapshot | undefined {
  return cache.get(keyOf(postId, userId));
}

function patchCache(
  postId: string,
  userId: string,
  patch: Partial<InteractionSnapshot>,
): void {
  const key = keyOf(postId, userId);
  const current = cache.get(key) ?? { ...EMPTY_SNAPSHOT };
  const next: InteractionSnapshot = { ...current, ...patch };

  if (
    next.likes === current.likes &&
    next.comments === current.comments &&
    next.reposts === current.reposts &&
    next.shares === current.shares &&
    next.saves === current.saves &&
    next.liked === current.liked &&
    next.bookmarked === current.bookmarked &&
    next.reposted === current.reposted &&
    next.shared === current.shared &&
    next.hydrated === current.hydrated
  ) {
    return;
  }

  cache.set(key, next);
  emit();
}

export function snapshotFromPost(
  post: Post,
  userId: string,
): InteractionSnapshot {
  const existing = readCache(post.id, userId);
  const local = readLocalFlags(userId)[post.id] ?? {};

  return {
    likes: localNumber(local.likes, post.likes_count, existing?.likes ?? 0),
    comments: localNumber(
      local.comments,
      post.comments_count,
      existing?.comments ?? 0,
    ),
    reposts: localNumber(
      local.reposts,
      post.reposts_count,
      existing?.reposts ?? 0,
    ),
    shares: localNumber(local.shares, post.shares_count, existing?.shares ?? 0),
    saves: existing?.saves ?? 0,
    liked: local.liked ?? post.liked_by_me ?? existing?.liked ?? false,
    bookmarked:
      local.bookmarked ?? post.saved_by_me ?? existing?.bookmarked ?? false,
    reposted:
      local.reposted ?? post.reposted_by_me ?? existing?.reposted ?? false,
    shared: local.shared ?? existing?.shared ?? false,
    hydrated: existing?.hydrated ?? false,
  };
}

function localNumber(
  local: number | undefined,
  server: number | undefined,
  fallback: number,
): number {
  if (typeof server === "number" && Number.isFinite(server)) return server;
  if (typeof local === "number" && Number.isFinite(local)) return local;
  return fallback;
}

export function readInteractionState(
  post: Post,
  userId: string,
): InteractionSnapshot {
  return readCache(post.id, userId) ?? snapshotFromPost(post, userId);
}

function stateOf(
  postId: string,
  userId: string,
  fallback: Partial<InteractionSnapshot> = {},
): InteractionSnapshot {
  return (
    readCache(postId, userId) ?? {
      ...EMPTY_SNAPSHOT,
      ...fallback,
    }
  );
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

/* ------------------------------------------------------------------ */
/* Local fallback                                                      */
/* ------------------------------------------------------------------ */

const localFlagCache = new Map<string, LocalFlags>();

function localKey(userId: string): string {
  return `aani:interactions:${userId}`;
}

export function readLocalFlags(userId: string): LocalFlags {
  if (!userId) return {};

  const cached = localFlagCache.get(userId);
  if (cached) return cached;

  let parsed: LocalFlags = {};

  try {
    const raw = window.localStorage.getItem(localKey(userId));
    if (raw) {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === "object") parsed = value as LocalFlags;
    }
  } catch {
    parsed = {};
  }

  localFlagCache.set(userId, parsed);
  return parsed;
}

function writeLocalFlag(
  userId: string,
  postId: string,
  patch: LocalPostState,
): void {
  const all = { ...readLocalFlags(userId) };
  all[postId] = { ...(all[postId] ?? {}), ...patch };
  localFlagCache.set(userId, all);

  try {
    window.localStorage.setItem(localKey(userId), JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

function isMissingRelation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    code?: string;
    message?: string;
    details?: string;
  };

  const code = candidate.code ?? "";
  const message = `${candidate.message ?? ""} ${candidate.details ?? ""}`;

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    code === "PGRST204" ||
    code === "42501" ||
    /does not exist|schema cache|could not find the table|permission denied/i.test(
      message,
    )
  );
}

/* ------------------------------------------------------------------ */
/* Comment data helpers                                                */
/* ------------------------------------------------------------------ */

async function fetchCommentProfiles(
  userIds: string[],
): Promise<Map<string, Profile>> {
  const profilesById = new Map<string, Profile>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));

  if (!supabaseConfigured || ids.length === 0) return profilesById;

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id,username,full_name,display_name,avatar_url,bio")
      .in("id", ids);

    if (error) {
      console.warn("[comments] تعذر جلب الملفات الشخصية:", error.message);
      return profilesById;
    }

    ((data ?? []) as Profile[]).forEach((profile) => {
      if (profile.id) profilesById.set(String(profile.id), profile);
    });
  } catch (error) {
    console.warn("[comments] فشل طلب الملفات الشخصية:", error);
  }

  return profilesById;
}

async function attachCommentAuthors(
  rows: RawRow[],
): Promise<PostCommentRow[]> {
  if (rows.length === 0) return [];

  const userIds = rows.map((row) => String(row.user_id ?? "")).filter(Boolean);
  const profilesById = await fetchCommentProfiles(userIds);

  return rows.map((row) => {
    const normalized = normalizeComment(row);
    const author = profilesById.get(normalized.user_id) ?? null;

    return {
      ...normalized,
      author,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Hydration & Decorate                                                */
/* ------------------------------------------------------------------ */

type Summary = {
  postId: string;
  likes?: number;
  comments?: number;
  reposts?: number;
  shares?: number;
  saves?: number;
  liked?: boolean;
  bookmarked?: boolean;
  reposted?: boolean;
  shared?: boolean;
};

function mapSummaryRow(row: RawRow): Summary {
  return {
    postId: String(row.post_id ?? row.postId ?? ""),
    likes: optionalNumber(row.like_count ?? row.likes_count ?? row.likes),
    comments: optionalNumber(
      row.comment_count ?? row.comments_count ?? row.comments,
    ),
    reposts: optionalNumber(
      row.repost_count ?? row.reposts_count ?? row.reposts,
    ),
    shares: optionalNumber(row.share_count ?? row.shares_count ?? row.shares),
    liked: optionalBool(row.liked ?? row.liked_by_me),
    bookmarked: optionalBool(row.bookmarked ?? row.saved_by_me),
    reposted: optionalBool(row.reposted ?? row.reposted_by_me),
    shared: optionalBool(row.shared ?? row.shared_by_me),
  };
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

function optionalBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

async function fetchSummaries(
  postIds: string[],
  userId: string,
): Promise<Map<string, Summary> | null> {
  if (!supabaseConfigured || postIds.length === 0) return null;

  try {
    const { data, error } = await supabase.rpc("post_interaction_summaries", {
      post_ids: postIds,
    });

    if (error || !Array.isArray(data)) return null;

    const map = new Map<string, Summary>();

    (data as RawRow[]).forEach((row) => {
      const summary = mapSummaryRow(row);
      if (summary.postId) map.set(summary.postId, summary);
    });

    if (map.size < postIds.length) {
      const fallback = await fetchFallbackSummaries(postIds, userId);
      fallback.forEach((value, key) => {
        if (!map.has(key)) map.set(key, value);
      });
    }

    return map;
  } catch {
    return null;
  }
}

// كل استعلام يُنفَّذ بشكل مستقل؛ فشل جدول واحد (غير موجود مثلًا)
// لا يُسقط بقية العدّادات، فبقي العدّاد صفرًا على الرغم من وجود بيانات.
const soft = (
  request: PromiseLike<{
    data: unknown;
    error: unknown;
  }>,
): Promise<{
  data: unknown;
  error: unknown;
}> => Promise.resolve(request).catch(() => ({ data: null, error: null }));

async function fetchFallbackSummaries(
  postIds: string[],
  userId: string,
): Promise<Map<string, Summary>> {
  const summaries = new Map<string, Summary>();
  postIds.forEach((id) => summaries.set(id, { postId: id }));

  if (!supabaseConfigured || postIds.length === 0) return summaries;

  const [likes, comments, reposts, savedPosts, bookmarks, shares, rows] =
    await Promise.all([
      soft(supabase.from("likes").select("post_id,user_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("comments").select("post_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("reposts").select("post_id,user_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("saved_posts").select("post_id,user_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("bookmarks").select("post_id,user_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("post_shares").select("post_id,user_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("posts").select("*").in("id", postIds)),
    ]);

  const likeCounts = countByPost(likes.data);
  const commentCounts = countByPost(comments.data);
  const repostCounts = countByPost(reposts.data);

  const counters = new Map<string, RawRow>();
  ((rows.data ?? []) as RawRow[]).forEach((row) => {
    counters.set(String(row.id), row);
  });

  const likeRows = (likes.data ?? []) as RawRow[];
  const savedRows = [...((savedPosts.data ?? []) as RawRow[]), ...((bookmarks.data ?? []) as RawRow[])];
  const repostRows = (reposts.data ?? []) as RawRow[];
  const shareRows = (shares.data ?? []) as RawRow[];

  // عدد عمليات الحفظ: كل مستخدم يُحسب مرة واحدة حتى لو وُجد صفه في الجدولين
  const savesCounts = new Map<string, number>();
  const seenSaves = new Set<string>();
  savedRows.forEach((row) => {
    const id = String(row.post_id ?? "");
    const key = `${id}:${row.user_id ?? ""}`;
    if (!id || seenSaves.has(key)) return;
    seenSaves.add(key);
    savesCounts.set(id, (savesCounts.get(id) ?? 0) + 1);
  });

  postIds.forEach((postId) => {
    const summary = summaries.get(postId) ?? { postId };
    const row = counters.get(postId);

    summary.likes = toNumber(row?.likes_count, likeCounts.get(postId) ?? 0);
    summary.comments = toNumber(
      row?.comments_count,
      commentCounts.get(postId) ?? 0,
    );
    summary.reposts = toNumber(row?.reposts_count, repostCounts.get(postId) ?? 0);
    summary.shares = toNumber(row?.shares_count, 0);
    summary.saves = savesCounts.get(postId) ?? 0;
    summary.liked = likeRows.some(
      (like) => like.post_id === postId && like.user_id === userId,
    );
    summary.bookmarked = savedRows.some(
      (saved) => saved.post_id === postId && saved.user_id === userId,
    );
    summary.reposted = repostRows.some(
      (repost) => repost.post_id === postId && repost.user_id === userId,
    );
    summary.shared = shareRows.some(
      (share) => share.post_id === postId && share.user_id === userId,
    );

    summaries.set(postId, summary);
  });

  return summaries;
}

function countByPost(rows: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  if (!Array.isArray(rows)) return counts;

  (rows as RawRow[]).forEach((row) => {
    const id = String(row.post_id ?? "");
    if (!id) return;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  });

  return counts;
}

function applySummary(summary: Summary, userId: string): void {
  if (!summary.postId) return;
  if (isPending(summary.postId, userId)) return;

  const local = readLocalFlags(userId)[summary.postId] ?? {};
  const current = stateOf(summary.postId, userId);

  patchCache(summary.postId, userId, {
    likes: summary.likes ?? current.likes,
    comments: summary.comments ?? current.comments,
    reposts: summary.reposts ?? current.reposts,
    shares: summary.shares ?? current.shares,
    saves: summary.saves ?? current.saves,
    liked: summary.liked ?? current.liked,
    bookmarked: summary.bookmarked ?? local.bookmarked ?? current.bookmarked,
    reposted: summary.reposted ?? local.reposted ?? current.reposted,
    shared: summary.shared ?? local.shared ?? current.shared,
    hydrated: true,
  });
}

export async function hydratePosts(
  posts: Post[],
  userId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!userId || posts.length === 0) return;

  const ids = posts
    .map((post) => post.id)
    .filter((id) => {
      if (options.force) return true;
      const hydratedAt = directHydration.get(keyOf(id, userId));
      return !hydratedAt || Date.now() - hydratedAt > HYDRATION_TTL_MS;
    });

  ids.forEach((id) => directHydration.set(keyOf(id, userId), Date.now()));
  const targets = ids.length > 0 ? ids : posts.map((post) => post.id);

  const summaries = await fetchSummaries(targets, userId);

  if (summaries) {
    summaries.forEach((summary) => applySummary(summary, userId));
    return;
  }

  try {
    const fallback = await fetchFallbackSummaries(targets, userId);
    fallback.forEach((summary) => applySummary(summary, userId));
  } catch (error) {
    console.warn("[interactions] fallback hydration failed:", error);
  }
}

export async function hydratePostIds(
  postIds: string[],
  userId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!userId || postIds.length === 0) return;

  const ids = Array.from(new Set(postIds)).filter(Boolean);
  const summaries = await fetchSummaries(ids, userId);

  if (summaries) {
    summaries.forEach((summary) => applySummary(summary, userId));
    return;
  }

  const { data } = await supabase.from("posts").select("*").in("id", ids);
  const rows = (data ?? []) as RawRow[];

  const posts = rows.map((row) => ({
    id: String(row.id),
    user_id: String(row.user_id ?? ""),
    content: String(row.content ?? ""),
    media_url: (row.media_url as string | null) ?? null,
    type: (row.type as Post["type"]) ?? "text",
    created_at: String(row.created_at ?? new Date().toISOString()),
    author: null,
    likes_count: optionalNumber(row.likes_count),
    comments_count: optionalNumber(row.comments_count),
    reposts_count: optionalNumber(row.reposts_count),
    shares_count: optionalNumber(row.shares_count),
  })) as Post[];

  if (posts.length > 0) await hydratePosts(posts, userId, options);
}

export async function decoratePosts(
  rows: RawRow[],
  userId: string,
): Promise<Post[]> {
  if (!rows || rows.length === 0) return [];

  const authorIds = Array.from(
    new Set(rows.map((row) => String(row.user_id ?? "")).filter(Boolean)),
  );

  const reposterIds = Array.from(
    new Set(rows.map((row) => String(row.reposter_id ?? "")).filter(Boolean)),
  );

  const profileIds = Array.from(new Set([...authorIds, ...reposterIds]));

  let profiles: Profile[] = [];

  if (supabaseConfigured && profileIds.length > 0) {
    const { data } = await supabase
      .from("profiles")
      .select("id,username,full_name,display_name,avatar_url,bio")
      .in("id", profileIds);

    profiles = (data ?? []) as Profile[];
  }

  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  const posts: Post[] = rows.map((row) => ({
    id: String(row.id),
    user_id: String(row.user_id ?? ""),
    content: String(row.content ?? ""),
    media_url: (row.media_url as string | null) ?? null,
    media_urls: (row.media_urls as string[] | null) ?? null,
    type: (row.type as Post["type"]) ?? "text",
    created_at: String(row.created_at ?? new Date().toISOString()),
    author: byId.get(String(row.user_id ?? "")) ?? null,
    likes_count: optionalNumber(row.likes_count),
    comments_count: optionalNumber(row.comments_count),
    reposts_count: optionalNumber(row.reposts_count),
    shares_count: optionalNumber(row.shares_count),
    reposted_at: (row.reposted_at as string | null) ?? null,
    repost_attribution: row.reposter_id
      ? (byId.get(String(row.reposter_id)) ?? null)
      : null,
    comments_disabled: row.comments_disabled === true,
    audio_url: (row.audio_url as string | null) ?? null,
    audio_title: (row.audio_title as string | null) ?? null,
  }));

  await hydratePosts(posts, userId);
  return posts.map((post) => decoratePost(post, userId));
}

export function decoratePost(post: Post, userId: string): Post {
  const state = readCache(post.id, userId) ?? snapshotFromPost(post, userId);

  return {
    ...post,
    likes_count: state.likes,
    comments_count: state.comments,
    reposts_count: state.reposts,
    shares_count: state.shares,
    saves_count: state.saves,
    liked_by_me: state.liked,
    saved_by_me: state.bookmarked,
    reposted_by_me: state.reposted,
  };
}

/**
 * يحدّث عدّاد التعليقات المرتبط بالمنشور في ذاكرة التفاعل المحلية،
 * ليظهر العدد الحقيقي في بطاقة المنشور فورًا دون انتظار إعادة الجلب.
 */
export function syncCommentCount(
  postId: string,
  userId: string,
  count: number,
): void {
  if (!postId) return;

  const normalized = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;

  if (userId && !isPending(postId, userId)) {
    patchCache(postId, userId, {
      comments: normalized,
      hydrated: true,
    });
  }

  // إبلاغ بطاقات المنشورات بالعدد الجديد فورًا (Optimistic UI) وبدون إعادة تحميل
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("aani:comment-count", { detail: { postId, count: normalized } }),
    );
  }
}

/**
 * يجلب عدد عمليات الحفظ الحقيقي من قاعدة البيانات ويحدّث عدّاد المنشور.
 * يُستدعى عند تهيئة المنشور وعند وصول تحديث فوري لحفظ/إزالة حفظ.
 */
export async function hydrateSavesCount(
  postIds: string[],
  userId: string,
): Promise<void> {
  if (!supabaseConfigured || postIds.length === 0) return;

  const ids = Array.from(new Set(postIds)).filter(Boolean);
  if (ids.length === 0) return;

  try {
    const [savedResult, bookmarkResult] = await Promise.all([
      soft(supabase.from("saved_posts").select("post_id,user_id").in("post_id", ids).limit(20000)),
      soft(supabase.from("bookmarks").select("post_id,user_id").in("post_id", ids).limit(20000)),
    ]);

    const savedRows = [...((savedResult.data ?? []) as RawRow[]), ...((bookmarkResult.data ?? []) as RawRow[])];

    const savesCounts = new Map<string, number>();
    const seen = new Set<string>();
    savedRows.forEach((row) => {
      const id = String(row.post_id ?? "");
      const key = `${id}:${row.user_id ?? ""}`;
      if (!id || seen.has(key)) return;
      seen.add(key);
      savesCounts.set(id, (savesCounts.get(id) ?? 0) + 1);
    });

    ids.forEach((id) => {
      if (isPending(id, userId)) return;
      patchCache(id, userId, { saves: savesCounts.get(id) ?? 0, hydrated: true });
    });
  } catch (error) {
    console.warn("[interactions] saves hydration failed:", error);
  }
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export async function toggleLike(post: Post, userId: string): Promise<void> {
  if (isPending(post.id, userId)) return;

  const before = readInteractionState(post, userId);
  const liked = !before.liked;
  const likes = Math.max(0, before.likes + (liked ? 1 : -1));

  markPending(post.id, userId, 1);
  patchCache(post.id, userId, { liked, likes });

  if (!supabaseConfigured) {
    writeLocalFlag(userId, post.id, { liked, likes });
    markPending(post.id, userId, -1);
    return;
  }

  try {
    const { error } = liked
      ? await supabase.from("likes").insert({ post_id: post.id, user_id: userId })
      : await supabase.from("likes").delete().eq("post_id", post.id).eq("user_id", userId);

    if (error && error.code !== "23505") {
      patchCache(post.id, userId, { liked: before.liked, likes: before.likes });
      writeLocalFlag(userId, post.id, { liked: before.liked, likes: before.likes });
      toast.error("تعذر حفظ الإعجاب، تحقق من الاتصال وحاول مجدداً");
      return;
    }

    writeLocalFlag(userId, post.id, { liked, likes });
  } catch {
    patchCache(post.id, userId, { liked: before.liked, likes: before.likes });
    toast.error("تعذر حفظ الإعجاب، تحقق من الاتصال وحاول مجدداً");
    return;
  } finally {
    markPending(post.id, userId, -1);
  }

  await hydratePostIds([post.id], userId, { force: true });
}

export async function toggleBookmark(
  postOrId: Post | string,
  userId: string,
  overrideState?: boolean
): Promise<void> {
  const post: Post = typeof postOrId === "string"
    ? ({ id: postOrId } as Post)
    : postOrId;

  const before = readInteractionState(post, userId);
  const bookmarked = overrideState !== undefined ? !overrideState : !before.bookmarked;
  const saves = Math.max(0, before.saves + (bookmarked ? 1 : -1));

  markPending(post.id, userId, 1);
  patchCache(post.id, userId, { bookmarked, saves });

  try {
    if (!supabaseConfigured) {
      writeLocalFlag(userId, post.id, { bookmarked });
      toast.warning("تم الحفظ على هذا الجهاز فقط (قاعدة البيانات غير مهيأة)");
      return;
    }

    let errorToReport: any = null;

    if (bookmarked) {
      const { error: savedError } = await supabase.from("saved_posts").insert({ post_id: post.id, user_id: userId });
      if (savedError && isMissingRelation(savedError)) {
        const { error: bookmarkError } = await supabase.from("bookmarks").insert({ post_id: post.id, user_id: userId });
        errorToReport = bookmarkError;
      } else {
        errorToReport = savedError;
      }
    } else {
      const { error: savedError } = await supabase.from("saved_posts").delete().eq("post_id", post.id).eq("user_id", userId);
      const { error: bookmarkError } = await supabase.from("bookmarks").delete().eq("post_id", post.id).eq("user_id", userId);
      errorToReport = savedError && bookmarkError ? savedError : null;
    }

    if (errorToReport && errorToReport.code !== "23505") {
      if (isMissingRelation(errorToReport)) {
        writeLocalFlag(userId, post.id, { bookmarked });
        toast.warning("تم حفظ المنشور على هذا الجهاز.");
        return;
      }

      patchCache(post.id, userId, { bookmarked: before.bookmarked, saves: before.saves });
      toast.error("تعذر حفظ المنشور، حاول مرة أخرى");
      return;
    }

    writeLocalFlag(userId, post.id, { bookmarked });
    toast.success(bookmarked ? "تم حفظ المنشور في المحفوظات" : "تمت إزالة المنشور من المحفوظات");
  } finally {
    markPending(post.id, userId, -1);
  }

  await hydratePostIds([post.id], userId, { force: true });
}

export const toggleSavePost = toggleBookmark;

export async function toggleRepost(
  postOrId: Post | string,
  userId: string,
  overrideState?: boolean
): Promise<void> {
  const post: Post = typeof postOrId === "string"
    ? ({ id: postOrId } as Post)
    : postOrId;

  const before = readInteractionState(post, userId);
  const reposted = overrideState !== undefined ? !overrideState : !before.reposted;

  markPending(post.id, userId, 1);
  patchCache(post.id, userId, {
    reposted,
    reposts: Math.max(0, before.reposts + (reposted ? 1 : -1)),
  });

  let stored = false;

  try {
    if (!supabaseConfigured) {
      writeLocalFlag(userId, post.id, { reposted });
      toast.warning("تم تسجيل إعادة النشر على هذا الجهاز فقط");
      return;
    }

    const { error } = reposted
      ? await supabase.from("reposts").insert({ post_id: post.id, user_id: userId })
      : await supabase.from("reposts").delete().eq("post_id", post.id).eq("user_id", userId);

    if (error && error.code !== "23505") {
      if (isMissingRelation(error)) {
        writeLocalFlag(userId, post.id, { reposted });
        toast.warning("تم تسجيل إعادة النشر على هذا الجهاز.");
        return;
      }

      patchCache(post.id, userId, {
        reposted: before.reposted,
        reposts: before.reposts,
      });
      toast.error("تعذر إعادة النشر، حاول مرة أخرى");
      return;
    }

    stored = true;
    writeLocalFlag(userId, post.id, { reposted });
    toast.success(reposted ? "تمت إعادة نشر المنشور" : "تمت إزالة إعادة النشر");
  } finally {
    markPending(post.id, userId, -1);
  }

  if (stored) await hydratePostIds([post.id], userId, { force: true });
}

export function buildPostUrl(postId: string): string {
  if (typeof window === "undefined") return `/post/${postId}`;

  const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
  return `${window.location.origin}${base}/post/${postId}`;
}

export function postShareUrl(postId: string): string {
  return buildPostUrl(postId);
}

export function postShareText(post: Post): string {
  const excerpt = (post.content ?? "").trim().replace(/\s+/g, " ");
  if (!excerpt) return `منشور ${displayName(post.author)} على آني`;
  return excerpt.length > 140 ? `${excerpt.slice(0, 139)}…` : excerpt;
}

export async function recordShare(post: Post, userId: string): Promise<boolean> {
  const before = readInteractionState(post, userId);

  if (before.shared) {
    patchCache(post.id, userId, { shared: true });
    return true;
  }

  const shares = before.shares + 1;
  patchCache(post.id, userId, { shared: true, shares });
  writeLocalFlag(userId, post.id, { shared: true, shares });

  if (!supabaseConfigured || !userId) return false;

  try {
    const { error } = await supabase
      .from("post_shares")
      .insert({ post_id: post.id, user_id: userId });

    const persisted = !error || error.code === "23505" || isMissingRelation(error);

    if (persisted) {
      void hydratePostIds([post.id], userId, { force: true });
    } else {
      patchCache(post.id, userId, { shares: before.shares });
    }

    return persisted;
  } catch {
    patchCache(post.id, userId, { shares: before.shares });
    return false;
  }
}

export async function createComment(
  post: Post,
  userId: string,
  content: string,
): Promise<PostCommentRow | null> {
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (!supabaseConfigured || !userId) {
    toast.error("لا يمكن نشر التعليق دون الاتصال بقاعدة البيانات");
    return null;
  }

  markPending(post.id, userId, 1);

  try {
    const { data, error } = await supabase
      .from("comments")
      .insert({ post_id: post.id, user_id: userId, content: trimmed })
      .select("id, post_id, user_id, content, created_at")
      .single();

    if (error || !data) {
      console.error("[comments] تعذر حفظ التعليق:", error);
      toast.error("تعذر نشر التعليق، حاول مرة أخرى");
      return null;
    }

    toast.success("تم نشر التعليق");
    return normalizeComment(data as RawRow);
  } catch (error) {
    console.error("[comments] خطأ أثناء نشر التعليق:", error);
    toast.error("تعذر نشر التعليق، حاول مرة أخرى");
    return null;
  } finally {
    markPending(post.id, userId, -1);
    void hydratePostIds([post.id], userId, { force: true });
  }
}

export async function deleteComment(
  post: Post,
  userId: string,
  commentId: string,
): Promise<boolean> {
  if (!supabaseConfigured || !userId) {
    toast.error("لا يمكن حذف التعليق دون الاتصال بقاعدة البيانات");
    return false;
  }

  markPending(post.id, userId, 1);

  try {
    const { data, error } = await supabase
      .from("comments")
      .delete()
      .eq("id", commentId)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();

    if (error || !data) {
      toast.error("تعذر حذف التعليق");
      return false;
    }

    toast.success("تم حذف التعليق");
    return true;
  } catch {
    toast.error("تعذر حذف التعليق");
    return false;
  } finally {
    markPending(post.id, userId, -1);
  }
}

/* ------------------------------------------------------------------ */
/* Threaded Comments & Interactions                                   */
/* ------------------------------------------------------------------ */

export async function fetchCommentsWithReplies(
  postId: string,
  currentUserId?: string,
): Promise<CommentWithDetails[]> {
  if (!postId) return [];

  if (!supabaseConfigured) {
    throw new Error("الاتصال بقاعدة البيانات غير متاح");
  }

  const { data: comments, error } = await supabase
    .from("comments")
    .select("*")
    .eq("post_id", postId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[comments] فشل جلب التعليقات:", error);
    throw error;
  }

  if (!comments) {
    throw new Error("تعذر قراءة التعليقات");
  }

  const rawComments = comments as RawRow[];
  if (rawComments.length === 0) return [];

  const userIds = rawComments
    .map((comment) => String(comment.user_id ?? ""))
    .filter(Boolean);

  const profilesById = await fetchCommentProfiles(userIds);

  const commentIds = rawComments
    .map((comment) => String(comment.id ?? ""))
    .filter(Boolean);

  let likes: { comment_id: string; user_id: string }[] = [];
  let dislikes: { comment_id: string; user_id: string }[] = [];

  if (commentIds.length > 0) {
    const [likesResult, dislikesResult] = await Promise.allSettled([
      supabase
        .from("comment_likes")
        .select("comment_id, user_id")
        .in("comment_id", commentIds),
      supabase
        .from("comment_dislikes")
        .select("comment_id, user_id")
        .in("comment_id", commentIds),
    ]);

    if (likesResult.status === "fulfilled" && !likesResult.value.error) {
      likes = (likesResult.value.data ?? []) as typeof likes;
    }

    if (
      dislikesResult.status === "fulfilled" &&
      !dislikesResult.value.error
    ) {
      dislikes = (dislikesResult.value.data ?? []) as typeof dislikes;
    }
  }

  const likesMap = new Map<string, { count: number; isLiked: boolean }>();

  likes.forEach((like) => {
    const current = likesMap.get(like.comment_id) ?? {
      count: 0,
      isLiked: false,
    };

    likesMap.set(like.comment_id, {
      count: current.count + 1,
      isLiked:
        current.isLiked ||
        (!!currentUserId && like.user_id === currentUserId),
    });
  });

  const dislikesMap = new Map<
    string,
    { count: number; isDisliked: boolean }
  >();

  dislikes.forEach((dislike) => {
    const current = dislikesMap.get(dislike.comment_id) ?? {
      count: 0,
      isDisliked: false,
    };

    dislikesMap.set(dislike.comment_id, {
      count: current.count + 1,
      isDisliked:
        current.isDisliked ||
        (!!currentUserId && dislike.user_id === currentUserId),
    });
  });

  const formatted: CommentWithDetails[] = rawComments.map((comment) => {
    const commentId = String(comment.id);
    const author = profilesById.get(String(comment.user_id ?? ""));

    return {
      id: commentId,
      post_id: String(comment.post_id ?? ""),
      user_id: String(comment.user_id ?? ""),
      parent_id: comment.parent_id ? String(comment.parent_id) : null,
      content: String(comment.content ?? ""),
      image_url: comment.image_url ? String(comment.image_url) : null,
      created_at: String(
        comment.created_at ?? new Date().toISOString(),
      ),
      profiles: author
        ? {
            full_name: String(author.full_name ?? author.display_name ?? ""),
            username: String(author.username ?? ""),
            avatar_url: author.avatar_url
              ? String(author.avatar_url)
              : null,
          }
        : null,
      likes_count: likesMap.get(commentId)?.count ?? 0,
      is_liked: likesMap.get(commentId)?.isLiked ?? false,
      dislikes_count: dislikesMap.get(commentId)?.count ?? 0,
      is_disliked: dislikesMap.get(commentId)?.isDisliked ?? false,
      replies: [],
    };
  });

  const commentMap = new Map<string, CommentWithDetails>();

  formatted.forEach((comment) => {
    commentMap.set(comment.id, comment);
  });

  const rootComments: CommentWithDetails[] = [];

  formatted.forEach((comment) => {
    if (comment.parent_id) {
      const parent = commentMap.get(comment.parent_id);

      if (parent) {
        parent.replies!.push(comment);
        return;
      }
    }

    rootComments.push(comment);
  });

  return rootComments;
}

export async function toggleCommentLike(
  commentId: string,
  userId: string,
  isLiked: boolean,
): Promise<void> {
  if (!supabaseConfigured || !userId) {
    throw new Error("الاتصال بقاعدة البيانات غير متاح");
  }

  if (isLiked) {
    const { error } = await supabase
      .from("comment_likes")
      .delete()
      .eq("comment_id", commentId)
      .eq("user_id", userId);

    if (error) throw error;
  } else {
    const { error: oppositeError } = await supabase
      .from("comment_dislikes")
      .delete()
      .eq("comment_id", commentId)
      .eq("user_id", userId);

    if (oppositeError) throw oppositeError;

    const { error } = await supabase
      .from("comment_likes")
      .upsert(
        { comment_id: commentId, user_id: userId },
        {
          onConflict: "comment_id,user_id",
          ignoreDuplicates: true,
        },
      );

    if (error) throw error;
  }
}

export async function toggleCommentDislike(
  commentId: string,
  userId: string,
  isDisliked: boolean,
): Promise<void> {
  if (!supabaseConfigured || !userId) {
    throw new Error("الاتصال بقاعدة البيانات غير متاح");
  }

  if (isDisliked) {
    const { error } = await supabase
      .from("comment_dislikes")
      .delete()
      .eq("comment_id", commentId)
      .eq("user_id", userId);

    if (error) throw error;
  } else {
    const { error: oppositeError } = await supabase
      .from("comment_likes")
      .delete()
      .eq("comment_id", commentId)
      .eq("user_id", userId);

    if (oppositeError) throw oppositeError;

    const { error } = await supabase
      .from("comment_dislikes")
      .upsert(
        { comment_id: commentId, user_id: userId },
        { onConflict: "comment_id,user_id", ignoreDuplicates: true },
      );

    if (error) throw error;
  }
}

export type UploadedCommentImage = {
  publicUrl: string;
  path: string;
};

export async function uploadCommentImage(
  file: File,
  userId: string,
): Promise<UploadedCommentImage> {
  if (!supabaseConfigured || !userId) {
    throw new Error("الاتصال بقاعدة البيانات غير متاح");
  }

  if (!file.type.startsWith("image/")) {
    throw new Error("اختر ملف صورة صالحًا");
  }

  if (file.size > 10 * 1024 * 1024) {
    throw new Error("حجم الصورة يجب ألا يتجاوز 10 ميغابايت");
  }

  const extension = file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? "jpg";
  const path = `${userId}/comments/${crypto.randomUUID()}.${extension.toLowerCase()}`;

  const { error } = await supabase.storage
    .from(storageBucket)
    .upload(path, file, { contentType: file.type, upsert: false });

  if (error) throw error;

  const { data } = supabase.storage.from(storageBucket).getPublicUrl(path);
  return { publicUrl: data.publicUrl, path };
}

export async function translateText(
  text: string,
  targetLang = "ar",
): Promise<string> {
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=Autodetect|${targetLang}`,
    );

    const data = await res.json();
    return data.responseData?.translatedText || text;
  } catch {
    return text;
  }
}

export const fetchSavedPosts = async (userId: string): Promise<Post[]> => {
  if (!userId || !supabaseConfigured) return [];

  try {
    let ids: string[] = [];

    const { data: savedData, error: savedError } = await supabase
      .from("saved_posts")
      .select("post_id, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (!savedError && savedData && savedData.length > 0) {
      ids = (savedData as RawRow[]).map((row) => String(row.post_id));
    } else {
      const { data: bookmarkData } = await supabase
        .from("bookmarks")
        .select("post_id, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (bookmarkData) {
        ids = (bookmarkData as RawRow[]).map((row) => String(row.post_id));
      }
    }

    if (ids.length === 0) return [];

    const { data: rows, error: postsError } = await supabase
      .from("posts")
      .select("*")
      .in("id", ids);

    if (postsError || !rows) return [];

    const decorated = await decoratePosts(rows as RawRow[], userId);
    const order = new Map(ids.map((id, index) => [id, index]));

    decorated.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return decorated;
  } catch {
    return [];
  }
};

/* ------------------------------------------------------------------ */
/* Realtime Subscription & Hooks                                       */
/* ------------------------------------------------------------------ */

const dirtyPosts = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleHydration(userId: string): void {
  if (flushTimer) return;

  flushTimer = setTimeout(() => {
    flushTimer = null;
    const ids = Array.from(dirtyPosts);
    dirtyPosts.clear();

    if (ids.length > 0) {
      void hydratePostIds(ids, userId, { force: true });
    }
  }, 450);
}

function handleChange(
  payload: RealtimePostgresChangesPayload<RawRow>,
  userId: string,
  table?: string,
): void {
  const record = (payload.new ?? payload.old ?? {}) as RawRow;
  const postId = record.post_id ? String(record.post_id) : "";

  if (!postId) return;

  dirtyPosts.add(postId);
  scheduleHydration(userId);

  // تحديث عدّاد الحفظ فورًا عند وصول تحديث فوري من قاعدة البيانات
  if (table === "saved_posts" || table === "bookmarks") {
    void hydrateSavesCount([postId], userId);
  }
}

function handlePostUpdate(
  payload: RealtimePostgresChangesPayload<RawRow>,
  userId: string,
): void {
  const row = (payload.new ?? {}) as RawRow;
  const postId = row.id ? String(row.id) : "";

  if (!postId || isPending(postId, userId)) return;

  const likes = optionalNumber(row.likes_count);
  const comments = optionalNumber(row.comments_count);
  const reposts = optionalNumber(row.reposts_count);
  const shares = optionalNumber(row.shares_count);

  if (
    likes === undefined &&
    comments === undefined &&
    reposts === undefined &&
    shares === undefined
  ) {
    return;
  }

  patchCache(postId, userId, {
    likes: likes ?? stateOf(postId, userId).likes,
    comments: comments ?? stateOf(postId, userId).comments,
    reposts: reposts ?? stateOf(postId, userId).reposts,
    shares: shares ?? stateOf(postId, userId).shares,
  });
}

let realtimeChannel: RealtimeChannel | null = null;
let realtimeRefs = 0;
let realtimeUserId: string | null = null;

function buildChannel(userId: string): RealtimeChannel {
  let channel = supabase.channel(`aani-interactions-${userId}`);

  (
    [
      "likes",
      "comments",
      "reposts",
      "saved_posts",
      "bookmarks",
      "post_shares",
      "comment_likes",
    ] as const
  ).forEach((table) => {
    channel = channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table },
      (payload) =>
        handleChange(
          payload as RealtimePostgresChangesPayload<RawRow>,
          userId,
          table,
        ),
    );
  });

  channel = channel.on(
    "postgres_changes",
    { event: "UPDATE", schema: "public", table: "posts" },
    (payload) =>
      handlePostUpdate(
        payload as RealtimePostgresChangesPayload<RawRow>,
        userId,
      ),
  );

  channel.subscribe((status) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.warn(`[interactions] realtime channel ${status}`);
    }
  });

  return channel;
}

export function useInteractionRealtime(
  userId: string | null | undefined,
): void {
  useEffect(() => {
    if (!supabaseConfigured || !userId) return;

    if (realtimeChannel && realtimeUserId !== userId) {
      void supabase.removeChannel(realtimeChannel);
      realtimeChannel = null;
      realtimeRefs = 0;
    }

    realtimeRefs += 1;

    if (!realtimeChannel) {
      realtimeUserId = userId;
      realtimeChannel = buildChannel(userId);
    }

    return () => {
      realtimeRefs -= 1;

      if (realtimeRefs <= 0) {
        if (realtimeChannel) void supabase.removeChannel(realtimeChannel);

        realtimeChannel = null;
        realtimeUserId = null;

        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }

        dirtyPosts.clear();
      }
    };
  }, [userId]);
}

export function useInteractionsVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

export type PostInteractions = InteractionSnapshot & {
  pending: boolean;
  toggleLike: () => Promise<void>;
  toggleBookmark: () => Promise<void>;
  toggleRepost: () => Promise<void>;
  share: () => Promise<void>;
};

export function usePostInteractions(
  post: Post,
  userId: string,
): PostInteractions {
  const key = keyOf(post.id, userId);

  const snapshot = useSyncExternalStore(
    subscribe,
    () => cache.get(key) ?? null,
    () => null,
  );

  const seeded = useRef<string>("");

  useEffect(() => {
    if (seeded.current === key) return;

    seeded.current = key;

    if (!cache.has(key)) {
      patchCache(post.id, userId, snapshotFromPost(post, userId));
    }

    void hydratePosts([post], userId);
    void hydrateSavesCount([post.id], userId);
  }, [key, post, userId]);

  const state = snapshot ?? snapshotFromPost(post, userId);

  const onLike = useCallback(() => toggleLike(post, userId), [post, userId]);

  const onBookmark = useCallback(
    () => toggleBookmark(post, userId),
    [post, userId],
  );

  const onRepost = useCallback(async () => {
    await toggleRepost(post, userId);

    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("aani:repost-changed"));
    }
  }, [post, userId]);

  const onShare = useCallback(
    () => recordShare(post, userId).then(() => {}),
    [post, userId],
  );

  return {
    ...state,
    pending: isPending(post.id, userId),
    toggleLike: onLike,
    toggleBookmark: onBookmark,
    toggleRepost: onRepost,
    share: onShare,
  };
}

function normalizeComment(row: RawRow): PostCommentRow {
  return {
    id: String(row.id),
    post_id: String(row.post_id ?? ""),
    user_id: String(row.user_id ?? ""),
    content: String(row.content ?? ""),
    created_at: String(row.created_at ?? new Date().toISOString()),
    author:
      (row.author as CommentAuthor) ??
      (row.profiles as CommentAuthor) ??
      null,
  };
}

const COMMENT_SELECT =
  "id, post_id, user_id, parent_id, content, image_url, created_at";

export type PostComments = {
  comments: PostCommentRow[] | null;
  loading: boolean;
  sending: boolean;
  error: string | null;
  load: () => Promise<void>;
  add: (content: string) => Promise<boolean>;
  remove: (commentId: string) => Promise<void>;
};

export function usePostComments(
  post: Post,
  userId: string,
  profile: Profile | null,
  enabled: boolean,
): PostComments {
  const [comments, setComments] = useState<PostCommentRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    if (!supabaseConfigured) {
      setComments(null);
      setError("الاتصال بقاعدة البيانات غير متاح");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data, error: loadError } = await supabase
        .from("comments")
        .select(COMMENT_SELECT)
        .eq("post_id", post.id)
        .order("created_at", { ascending: true });

      if (loadError) {
        console.error("[comments] فشل تحميل التعليقات:", loadError);
        setError("تعذر تحميل التعليقات");
        return;
      }

      const rows = await attachCommentAuthors((data ?? []) as RawRow[]);
      setComments(rows);

      if (!isPending(post.id, userId)) {
        patchCache(post.id, userId, {
          comments: rows.length,
          hydrated: true,
        });
      }
    } catch (loadError) {
      console.error("[comments] خطأ أثناء تحميل التعليقات:", loadError);
      setError("تعذر تحميل التعليقات");
    } finally {
      setLoading(false);
    }
  }, [post.id, userId, profile]);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;

    loadedRef.current = true;
    void load();
  }, [enabled, load]);

  useEffect(() => {
    loadedRef.current = false;
    setComments(null);
    setError(null);
  }, [post.id]);

  useEffect(() => {
    if (!enabled || !supabaseConfigured) return;

    const channel = supabase
      .channel(`aani-comments-${post.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "comments",
          filter: `post_id=eq.${post.id}`,
        },
        (payload) => {
          const record = (payload.new ?? payload.old ?? {}) as RawRow;
          const id = record.id ? String(record.id) : "";

          if (!id) return;

          if (payload.eventType === "DELETE") {
            setComments((previous) =>
              previous
                ? previous.filter((item) => item.id !== id)
                : previous,
            );
            return;
          }

          if (payload.eventType === "INSERT") {
            setComments((previous) => {
              if (!previous || previous.some((item) => item.id === id)) {
                return previous;
              }

              return [
                ...previous,
                { ...normalizeComment(record), author: null },
              ];
            });

            void supabase
              .from("comments")
              .select(COMMENT_SELECT)
              .eq("id", id)
              .maybeSingle()
              .then(async ({ data, error: fetchError }) => {
                if (fetchError) {
                  console.warn(
                    "[comments] تعذر تحديث بيانات التعليق الجديد:",
                    fetchError,
                  );
                  return;
                }

                if (!data) return;

                const [withAuthor] = await attachCommentAuthors([
                  data as RawRow,
                ]);

                if (!withAuthor) return;

                setComments((previous) =>
                  previous
                    ? previous.map((item) =>
                        item.id === id ? withAuthor : item,
                      )
                    : previous,
                );
              });
          }
        },
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn(`[comments] realtime channel ${status}`);
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled, post.id]);

  const add = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return false;

      setSending(true);

      try {
        const row = await createComment(post, userId, trimmed);
        if (!row) return false;

        setComments((previous) => {
          const list = previous ?? [];

          return list.some((item) => item.id === row.id)
            ? list
            : [...list, { ...row, author: profile }];
        });

        return true;
      } finally {
        setSending(false);
      }
    },
    [post, profile, userId],
  );

  const remove = useCallback(
    async (commentId: string) => {
      const ok = await deleteComment(post, userId, commentId);
      if (ok) await load();
    },
    [load, post, userId],
  );

  return { comments, loading, sending, error, load, add, remove };
}

/* ------------------------------------------------------------------ */
/* Saved (bookmarks)                                                   */
/* ------------------------------------------------------------------ */

export type SavedPostsState = {
  posts: Post[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export function useSavedPosts(userId: string): SavedPostsState {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      setPosts([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const savedList = await fetchSavedPosts(userId);
      setPosts(savedList);
    } catch {
      setError("تعذر تحميل المحفوظات");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useInteractionsVersion();

  const visible = posts.filter(
    (post) => readCache(post.id, userId)?.bookmarked !== false,
  );

  return { posts: visible, loading, error, refresh };
}
