import { toast } from "sonner";
import { supabase, supabaseConfigured } from "../supabase";
import { displayName, type Post } from "../types";
import { hydratePostIds } from "./hydration";
import {
  isMissingRelation,
  isPending,
  markPending,
  patchCache,
  readInteractionState,
  writeLocalFlag,
} from "./store";

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
  overrideState?: boolean,
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
  overrideState?: boolean,
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
