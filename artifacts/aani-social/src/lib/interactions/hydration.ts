import { supabase, supabaseConfigured } from "../supabase";
import { displayName, type Post, type Profile } from "../types";
import type {
  CommentAuthor,
  PostCommentRow,
  RawRow,
} from "./types";
import {
  isDirectHydrationStale,
  isPending,
  markDirectHydration,
  patchCache,
  readCache,
  readLocalFlags,
  snapshotFromPost,
  stateOf,
} from "./store";

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
  feedback?: Post["feedback_by_me"];
};

export function normalizeComment(row: RawRow): PostCommentRow {
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

export async function fetchCommentProfiles(
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

export async function attachCommentAuthors(
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

function mapSummaryRow(row: RawRow): Summary {
  const feedback = Object.prototype.hasOwnProperty.call(row, "feedback_by_me")
    ? row.feedback_by_me
    : row.feedback;

  return {
    postId: String(row.post_id ?? row.postId ?? ""),
    likes: optionalNumber(row.likes_count ?? row.like_count ?? row.likes),
    comments: optionalNumber(
      row.comments_count ?? row.comment_count ?? row.comments,
    ),
    reposts: optionalNumber(
      row.reposts_count ?? row.repost_count ?? row.reposts,
    ),
    shares: optionalNumber(row.shares_count ?? row.share_count ?? row.shares),
    liked: optionalBool(row.liked_by_me ?? row.liked),
    bookmarked: optionalBool(row.saved_by_me ?? row.bookmarked),
    reposted: optionalBool(row.reposted_by_me ?? row.reposted),
    shared: optionalBool(row.shared_by_me ?? row.shared),
    feedback:
      feedback === null
        ? null
        : typeof feedback === "string"
          ? (feedback as Post["feedback_by_me"])
          : undefined,
  };
}

export function optionalNumber(value: unknown): number | undefined {
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

  const map = new Map<string, Summary>();

  try {
    const { data, error } = await supabase.rpc("post_interaction_summaries", {
      post_ids: postIds,
    });

    if (!error && Array.isArray(data)) {
      (data as RawRow[]).forEach((row) => {
        const summary = mapSummaryRow(row);
        if (summary.postId) map.set(summary.postId, summary);
      });
    }
  } catch {
    // Use the same direct-query fallback for RPC errors and thrown requests.
  }

  const fallbackIds = postIds.filter((postId) => {
    const summary = map.get(postId);
    return (
      !summary ||
      summary.likes === undefined ||
      summary.comments === undefined ||
      summary.reposts === undefined ||
      summary.shares === undefined ||
      summary.feedback === undefined
    );
  });

  if (fallbackIds.length > 0) {
    try {
      const fallback = await fetchFallbackSummaries(fallbackIds, userId);
      fallback.forEach((value, key) => {
        const current = map.get(key);
        map.set(key, {
          postId: key,
          likes: current?.likes ?? value.likes,
          comments: current?.comments ?? value.comments,
          reposts: current?.reposts ?? value.reposts,
          shares: current?.shares ?? value.shares,
          saves: current?.saves ?? value.saves,
          liked: current?.liked ?? value.liked,
          bookmarked: current?.bookmarked ?? value.bookmarked,
          reposted: current?.reposted ?? value.reposted,
          shared: current?.shared ?? value.shared,
          feedback:
            current?.feedback !== undefined ? current.feedback : value.feedback,
        });
      });
    } catch {
      // Keep any RPC data already received; callers preserve cached values.
    }
  }

  return map;
}

// Keep each query independent so an unavailable table does not hide other fields.
export const soft = (
  request: PromiseLike<{ data: unknown; error: unknown }>,
): Promise<{ data: unknown; error: unknown }> =>
  Promise.resolve(request).catch((error: unknown) => ({ data: null, error }));

function querySucceeded(result: { data: unknown; error: unknown }): boolean {
  return result.error == null && Array.isArray(result.data);
}

async function fetchFallbackSummaries(
  postIds: string[],
  userId: string,
): Promise<Map<string, Summary>> {
  const summaries = new Map<string, Summary>();
  postIds.forEach((id) => summaries.set(id, { postId: id }));

  if (!supabaseConfigured || postIds.length === 0) return summaries;

  const [likes, comments, reposts, savedPosts, bookmarks, shares, rows, feedback] =
    await Promise.all([
      soft(supabase.from("likes").select("post_id,user_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("comments").select("post_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("reposts").select("post_id,user_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("saved_posts").select("post_id,user_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("bookmarks").select("post_id,user_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("post_shares").select("post_id,user_id").in("post_id", postIds).limit(20000)),
      soft(supabase.from("posts").select("id,likes_count,comments_count,reposts_count,shares_count").in("id", postIds)),
      soft(supabase.from("post_feedback").select("post_id,feedback").eq("user_id", userId).in("post_id", postIds)),
    ]);

  const likeCounts = countByPost(likes.data);
  const commentCounts = countByPost(comments.data);
  const repostCounts = countByPost(reposts.data);
  const shareCounts = countByPost(shares.data);

  const counters = new Map<string, RawRow>();
  if (querySucceeded(rows)) {
    (rows.data as RawRow[]).forEach((row) => {
      counters.set(String(row.id), row);
    });
  }

  const likeRows = querySucceeded(likes) ? (likes.data as RawRow[]) : [];
  const savedRows = [
    ...(querySucceeded(savedPosts) ? (savedPosts.data as RawRow[]) : []),
    ...(querySucceeded(bookmarks) ? (bookmarks.data as RawRow[]) : []),
  ];
  const repostRows = querySucceeded(reposts) ? (reposts.data as RawRow[]) : [];
  const shareRows = querySucceeded(shares) ? (shares.data as RawRow[]) : [];
  const feedbackByPost = new Map<string, string>();
  if (querySucceeded(feedback)) {
    (feedback.data as RawRow[]).forEach((row) => {
      feedbackByPost.set(String(row.post_id), String(row.feedback));
    });
  }

  // Count each user's save once if rows exist in both compatibility tables.
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

    summary.likes = optionalNumber(row?.likes_count) ??
      (querySucceeded(likes) ? likeCounts.get(postId) ?? 0 : undefined);
    summary.comments = optionalNumber(row?.comments_count) ??
      (querySucceeded(comments) ? commentCounts.get(postId) ?? 0 : undefined);
    summary.reposts = optionalNumber(row?.reposts_count) ??
      (querySucceeded(reposts) ? repostCounts.get(postId) ?? 0 : undefined);
    summary.shares = optionalNumber(row?.shares_count) ??
      (querySucceeded(shares) ? shareCounts.get(postId) ?? 0 : undefined);

    if (querySucceeded(savedPosts) || querySucceeded(bookmarks)) {
      summary.saves = savesCounts.get(postId) ?? 0;
      summary.bookmarked = savedRows.some(
        (saved) => saved.post_id === postId && saved.user_id === userId,
      );
    }
    if (querySucceeded(likes)) {
      summary.liked = likeRows.some(
        (like) => like.post_id === postId && like.user_id === userId,
      );
    }
    if (querySucceeded(reposts)) {
      summary.reposted = repostRows.some(
        (repost) => repost.post_id === postId && repost.user_id === userId,
      );
    }
    if (querySucceeded(shares)) {
      summary.shared = shareRows.some(
        (share) => share.post_id === postId && share.user_id === userId,
      );
    }
    if (querySucceeded(feedback)) {
      summary.feedback = (feedbackByPost.get(postId) ?? null) as Post["feedback_by_me"];
    }

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
  const hasFreshData =
    summary.likes !== undefined ||
    summary.comments !== undefined ||
    summary.reposts !== undefined ||
    summary.shares !== undefined ||
    summary.saves !== undefined ||
    summary.liked !== undefined ||
    summary.bookmarked !== undefined ||
    summary.reposted !== undefined ||
    summary.shared !== undefined ||
    summary.feedback !== undefined;

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
    feedback:
      summary.feedback !== undefined ? summary.feedback : current.feedback,
    hydrated: current.hydrated || hasFreshData,
  });
}

export async function hydratePostRows(
  posts: Post[],
  userId: string,
): Promise<Post[]> {
  if (!supabaseConfigured || !userId || posts.length === 0) return posts;

  const ids = Array.from(new Set(posts.map((post) => post.id).filter(Boolean)));
  ids.forEach((id) => markDirectHydration(id, userId));

  try {
    const summaries = await fetchSummaries(ids, userId);
    if (!summaries) return posts;

    summaries.forEach((summary) => applySummary(summary, userId));

    return posts.map((post) => {
      const summary = summaries.get(post.id);
      const decorated = decoratePost(post, userId);
      return {
        ...decorated,
        feedback_by_me:
          summary?.feedback !== undefined
            ? summary.feedback
            : decorated.feedback_by_me ?? null,
      };
    });
  } catch (error) {
    console.warn("[interactions] post hydration failed:", error);
    return posts;
  }
}

export async function hydratePosts(
  posts: Post[],
  userId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!supabaseConfigured || !userId || posts.length === 0) return;

  const ids = posts
    .map((post) => post.id)
    .filter((id) => options.force || isDirectHydrationStale(id, userId));

  if (ids.length === 0) return;

  ids.forEach((id) => markDirectHydration(id, userId));

  try {
    const summaries = await fetchSummaries(ids, userId);
    summaries?.forEach((summary) => applySummary(summary, userId));
  } catch (error) {
    console.warn("[interactions] post hydration failed:", error);
  }
}

export async function hydratePostIds(
  postIds: string[],
  userId: string,
  _options: { force?: boolean } = {},
): Promise<void> {
  if (!supabaseConfigured || !userId || postIds.length === 0) return;

  const ids = Array.from(new Set(postIds)).filter(Boolean);
  if (ids.length === 0) return;

  try {
    const summaries = await fetchSummaries(ids, userId);
    summaries?.forEach((summary) => applySummary(summary, userId));
  } catch (error) {
    console.warn("[interactions] post hydration failed:", error);
  }
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
    feedback_by_me:
      state.feedback !== undefined ? state.feedback : post.feedback_by_me,
  };
}

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

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("aani:comment-count", { detail: { postId, count: normalized } }),
    );
  }
}

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

    if (savedResult.error && bookmarkResult.error) return;

    const savedRows = [
      ...(querySucceeded(savedResult) ? (savedResult.data as RawRow[]) : []),
      ...(querySucceeded(bookmarkResult) ? (bookmarkResult.data as RawRow[]) : []),
    ];
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
