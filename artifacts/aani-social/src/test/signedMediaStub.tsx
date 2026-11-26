// Test-only stand-in for SignedMedia: renders the raw URL, without mediaAccess,
// storage signing or Supabase. Mirrors every export of the real module.
type SignedImageProps = {
  src: string | null | undefined;
  alt?: string;
  className?: string;
} & Record<string, unknown>;

type SignedVideoProps = {
  src: string | null | undefined;
  poster?: string | null;
} & Record<string, unknown>;

export function SignedImage({ src, alt = '', ...rest }: SignedImageProps) {
  if (!src) return null;
  return <img src={src} alt={alt} {...rest} />;
}

export function SignedVideo({ src, poster, ...rest }: SignedVideoProps) {
  if (!src) return null;
  return <video src={src} poster={poster ?? undefined} {...rest} />;
}
