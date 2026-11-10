import { AtSign, Link2, MapPin, X } from 'lucide-react';
import { Link } from 'wouter';

import type { PostMetadataTag } from '@/lib/types';

type PostMetadataChipsProps = {
  tags: PostMetadataTag[];
  className?: string;
  onRemove?: (index: number) => void;
  onMentionClick?: () => void;
  /** إخفاء شرائح الإشارة (تُعرض في رأس المنشور بدلاً منها للمنشورات غير النصية) */
  hideMentions?: boolean;
};

export default function PostMetadataChips({
  tags,
  className = '',
  onRemove,
  onMentionClick,
  hideMentions = false,
}: PostMetadataChipsProps) {
  // وسام الغلاف ووسام tagged_users وسيلة تخزين وليست شرائح معروضة،
  // وشرائح الإشارة تُخفى للمنشورات غير النصية (الإشارة تظهر في الرأس)
  const visibleTags = tags.filter(tag =>
    tag.kind !== 'cover'
    && tag.kind !== 'tagged_users'
    && !(hideMentions && tag.kind === 'mention'),
  );
  if (visibleTags.length === 0) return null;

  return (
    <div
      className={`flex flex-wrap items-center gap-2 ${className}`}
      dir="rtl"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      {visibleTags.map((tag, index) => {
        const TagIcon = tag.kind === 'location' ? MapPin : tag.kind === 'link' ? Link2 : AtSign;
        const label = tag.kind === 'mention' ? tag.label.replace(/^@+/, '') : tag.label;
        const linkClass = 'flex min-w-0 max-w-[220px] items-center gap-2 truncate px-3 py-2 text-xs text-violet-200';
        const chipKey = `${tag.kind}:${tag.profileId || tag.href}:${index}`;

        return (
          <div
            key={chipKey}
            className="flex min-w-0 items-center rounded-full border border-violet-400/20 bg-violet-500/15 shadow-sm backdrop-blur-md"
          >
            {tag.kind === 'mention' && tag.profileId ? (
              <Link href={`/profile/${encodeURIComponent(tag.profileId)}`} onClick={onMentionClick} className={linkClass}>
                <TagIcon size={14} className="shrink-0" />
                <span className="truncate">{label}</span>
              </Link>
            ) : (
              <a href={tag.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
                <TagIcon size={14} className="shrink-0" />
                <span className="truncate">{label}</span>
              </a>
            )}
            {onRemove && (
              <button
                type="button"
                aria-label={`إزالة ${tag.kind === 'location' ? 'الموقع' : tag.kind === 'link' ? 'الرابط' : 'الإشارة'}`}
                onClick={() => onRemove(index)}
                className="ml-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-violet-200/70 transition hover:bg-white/10 hover:text-white"
              >
                <X size={13} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
