import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Post } from "../types";
import { hydratePosts, hydrateSavesCount } from "./hydration";
import { toggleBookmark, toggleLike, toggleRepost, recordShare } from "./mutations";
import {
  getVersion,
  isPending,
  keyOf,
  patchCache,
  readCacheByKey,
  hasCacheKey,
  snapshotFromPost,
  subscribe,
} from "./store";
import type { PostInteractions } from "./types";

export function useInteractionsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, () => 0);
}

export function usePostInteractions(
  post: Post,
  userId: string,
): PostInteractions {
  const key = keyOf(post.id, userId);

  const snapshot = useSyncExternalStore(
    subscribe,
    () => readCacheByKey(key) ?? null,
    () => null,
  );

  const seeded = useRef<string>("");

  useEffect(() => {
    if (seeded.current === key) return;

    seeded.current = key;

    if (!hasCacheKey(key)) {
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
  const onRepost = useCallback(
    () => toggleRepost(post, userId),
    [post, userId],
  );
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
