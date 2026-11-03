type StoryAlignmentGuidesProps = {
  vertical: boolean;
  horizontal: boolean;
  insideEditor?: boolean;
};

export default function StoryAlignmentGuides({ vertical, horizontal, insideEditor = false }: StoryAlignmentGuidesProps) {
  if (!vertical && !horizontal) return null;

  return (
    <div className={`pointer-events-none fixed inset-0 ${insideEditor ? 'z-[50]' : 'z-[90]'}`} aria-hidden="true">
      {vertical && (
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#42e8f4] shadow-[0_0_8px_rgba(66,232,244,0.9)]" />
      )}
      {horizontal && (
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[#42e8f4] shadow-[0_0_8px_rgba(66,232,244,0.9)]" />
      )}
    </div>
  );
}
