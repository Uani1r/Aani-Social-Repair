// Test-only stand-in for the media preloader: the browser tests show the raw
// thumbnail URL and never load, sign or preload media through Supabase.
export function thumbnailUrl(url: string | null | undefined): string | null {
  return url ?? null;
}
