import type { Post } from '@/lib/types';

export type PendingPostStage = 'uploading' | 'publishing' | 'success' | 'failed';

export type PendingPost = {
  id: string;
  post: Post;
  progress: number;
  stage: PendingPostStage;
  error: string | null;
  objectUrls: string[];
  retry: (() => void) | null;
};

let pendingPosts: PendingPost[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach(listener => listener());
}

export function getPendingPosts(): PendingPost[] {
  return pendingPosts;
}

export function subscribePendingPosts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function addPendingPost(post: PendingPost): void {
  pendingPosts = [post, ...pendingPosts.filter(item => item.id !== post.id)];
  notify();
}

export function updatePendingPost(id: string, changes: Partial<Omit<PendingPost, 'id'>>): void {
  let didChange = false;
  pendingPosts = pendingPosts.map(item => {
    if (item.id !== id) return item;
    didChange = true;
    return { ...item, ...changes };
  });
  if (didChange) notify();
}

export function retryPendingPost(id: string): void {
  pendingPosts.find(post => post.id === id)?.retry?.();
}

export function removePendingPost(id: string): void {
  const item = pendingPosts.find(post => post.id === id);
  if (!item) return;
  pendingPosts = pendingPosts.filter(post => post.id !== id);
  if (typeof URL !== 'undefined') item.objectUrls.forEach(url => URL.revokeObjectURL(url));
  notify();
}
