import type { Post } from "../types";
import type {
  InteractionSnapshot,
  LocalFlags,
  LocalPostState,
} from "./types";

export const EMPTY_SNAPSHOT: InteractionSnapshot = {
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

const cache = new Map<string, InteractionSnapshot>();
const listeners = new Set<() => void>();
const pendingWrites = new Map<string, number>();
const directHydration = new Map<string, number>();
export const HYDRATION_TTL_MS = 20_000;
let version = 0;

export function keyOf(postId: string, userId: string): string {
  return `${userId}:${postId}`;
}

export function emit(): void {
  version += 1;
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error("interaction listener failed", error);
    }
  });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getVersion(): number {
  return version;
}

export function isPending(postId: string, userId: string): boolean {
  return (pendingWrites.get(keyOf(postId, userId)) ?? 0) > 0;
}

export function markPending(postId: string, userId: string, delta: number): void {
  const key = keyOf(postId, userId);
  const next = (pendingWrites.get(key) ?? 0) + delta;
  if (next <= 0) pendingWrites.delete(key);
  else pendingWrites.set(key, next);
}

export function readCache(
  postId: string,
  userId: string,
): InteractionSnapshot | undefined {
  return cache.get(keyOf(postId, userId));
}

export function readCacheByKey(
  key: string,
): InteractionSnapshot | undefined {
  return cache.get(key);
}

export function hasCacheKey(key: string): boolean {
  return cache.has(key);
}

export function patchCache(
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

export function markDirectHydration(postId: string, userId: string): void {
  directHydration.set(keyOf(postId, userId), Date.now());
}

export function isDirectHydrationStale(postId: string, userId: string): boolean {
  const hydratedAt = directHydration.get(keyOf(postId, userId));
  return !hydratedAt || Date.now() - hydratedAt > HYDRATION_TTL_MS;
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

const localFlagCache = new Map<string, LocalFlags>();

function localKey(userId: string): string {
  return `aani:interactions:${userId}`;
}

export function writeLocalFlag(
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

export function isMissingRelation(error: unknown): boolean {
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

function localNumber(
  local: number | undefined,
  server: number | undefined,
  fallback: number,
): number {
  if (typeof server === "number" && Number.isFinite(server)) return server;
  if (typeof local === "number" && Number.isFinite(local)) return local;
  return fallback;
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

export function readInteractionState(
  post: Post,
  userId: string,
): InteractionSnapshot {
  return readCache(post.id, userId) ?? snapshotFromPost(post, userId);
}

export function stateOf(
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
