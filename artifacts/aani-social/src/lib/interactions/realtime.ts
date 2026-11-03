import { useEffect } from "react";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "../supabase";
import { hydratePostIds, hydrateSavesCount } from "./hydration";
import {
  isPending,
  patchCache,
  stateOf,
} from "./store";
import type { RawRow } from "./types";

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

  if (table === "saved_posts" || table === "bookmarks") {
    void hydrateSavesCount([postId], userId);
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
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
