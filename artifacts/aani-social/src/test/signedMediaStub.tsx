// Test-only stand-in for SignedMedia: renders the raw media URL as an image,
// without mediaAccess, storage signing or Supabase in the browser tests.
export function SignedImage({ src, alt = '', className, ...rest }: {
  src: string | null | undefined;
  alt?: string;
  className?: string;
} & Record<string, unknown>) {
  if (!src) return null;
  return <img src={src} alt={alt} className={className} {...rest} />;
}
