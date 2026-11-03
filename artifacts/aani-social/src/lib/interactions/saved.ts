import { useCallback, useEffect, useState } from "react";
import type { Post } from "../types";
import { supabase, supabaseConfigured } from "../supabase";
import { decoratePosts } from "./hydration";
import { useInteractionsVersion } from "./hooks";
import type { RawRow, SavedPostsState } from "./types";
import { readCache } from "./store";

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
