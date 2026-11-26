// Test-only stand-in for the media preloader: it never loads, signs or preloads
// anything and never reaches Supabase or the network. Mirrors every export of the
// real mediaPreload module so the harness can import it safely.
export function thumbnailUrl(url: string | null | undefined): string | null {
  return url ?? null;
}

export function preloadImage(_url: string | null | undefined): void {}

export function setVideoPreloadCandidate(
  _id: string,
  _url: string | null | undefined,
  _priority?: number,
  _index?: number,
): void {}

export function releaseVideoPreloadCandidate(_id: string): void {}

export function prebufferVideo(_url: string | null | undefined, _id?: string): void {}

export function preloadMediaList(_urls: Array<string | null | undefined>, _limit?: number): void {}

export function preloadMedia(_url: string | null | undefined): void {}

export function firstMediaUrlOfPost(
  post: { media_url?: string | null; media_urls?: string[] | null } | null | undefined,
): string | null {
  if (!post) return null;
  const list = Array.isArray(post.media_urls) ? post.media_urls : [];
  return list[0] ?? post.media_url ?? null;
}
