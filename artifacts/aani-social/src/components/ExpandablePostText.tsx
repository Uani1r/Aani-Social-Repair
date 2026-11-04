import { useLayoutEffect, useRef, useState } from 'react';

type ExpandablePostTextProps = {
  text: string;
  className?: string;
};

const COLLAPSED_LINES = 6;

export default function ExpandablePostText({ text, className = '' }: ExpandablePostTextProps) {
  const measurementRef = useRef<HTMLParagraphElement>(null);
  const [canExpand, setCanExpand] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const measurement = measurementRef.current;
    if (!measurement) return;

    const updateOverflow = () => {
      const style = window.getComputedStyle(measurement);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const fontSize = Number.parseFloat(style.fontSize);
      const effectiveLineHeight = Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.5;
      const nextCanExpand = measurement.scrollHeight > effectiveLineHeight * COLLAPSED_LINES + 2;
      setCanExpand(current => current === nextCanExpand ? current : nextCanExpand);
    };

    updateOverflow();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateOverflow);
      return () => window.removeEventListener('resize', updateOverflow);
    }

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(measurement.parentElement || measurement);
    return () => observer.disconnect();
  }, [text, className]);

  return (
    <div className="relative min-w-0">
      <p className={`${className} whitespace-pre-line break-words ${expanded ? '' : 'line-clamp-6'}`}>
        {text}
      </p>
      <p
        ref={measurementRef}
        aria-hidden="true"
        className={`${className} pointer-events-none absolute inset-x-0 top-0 -z-10 w-full whitespace-pre-line break-words opacity-0`}
      >
        {text}
      </p>
      {canExpand && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(current => !current)}
          className="mt-1 text-xs font-semibold text-violet-300 transition hover:text-violet-200"
        >
          {expanded ? 'عرض أقل' : 'عرض المزيد'}
        </button>
      )}
    </div>
  );
}
