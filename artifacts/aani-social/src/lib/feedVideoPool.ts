type FeedVideoPriority = 0 | 1;

type FeedVideoCandidate = {
  priority: FeedVideoPriority;
  distance: number;
};

type Listener = () => void;

const MAX_FEED_VIDEO_PLAYERS = 3;
const candidates = new Map<string, FeedVideoCandidate>();
const listeners = new Set<Listener>();
let selected = new Set<string>();

function recalculateSelection(): void {
  const next = new Set(Array.from(candidates.entries())
    .sort((first, second) => first[1].priority - second[1].priority || first[1].distance - second[1].distance)
    .slice(0, MAX_FEED_VIDEO_PLAYERS)
    .map(([id]) => id));
  if (next.size === selected.size && Array.from(next).every(id => selected.has(id))) return;
  selected = next;
  listeners.forEach(listener => listener());
}

/** Reserve at most three feed video decoders, favoring visible and nearby items. */
export function updateFeedVideoCandidate(id: string, candidate: FeedVideoCandidate | null): void {
  if (!id) return;
  if (candidate) candidates.set(id, candidate);
  else candidates.delete(id);
  recalculateSelection();
}

export function isFeedVideoSelected(id: string): boolean {
  return selected.has(id);
}

export function subscribeFeedVideoPool(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
