import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { MoreHorizontal, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, getPostMentions, taggedMentionDisplayName, type Post, type PostMetadataTag, type Profile } from '@/lib/types';

type PostHeaderIdentityProps = {
  post: Post;
  className?: string;
  nameClassName?: string;
  usernameClassName?: string;
  nameLinkClass?: string;
  taggedNameLinkClass?: string;
  moreTriggerClass?: string;
};

/**
 * رأس المنشور مع دعم الإشارات:
 * - شخص واحد: [الناشر] و [المشار إليه]
 * - أكثر من شخص: [الناشر] و [الأول] ... مع زر الثلاث نقاط يفتح لوحة بكل المشار إليهم
 * - المنشورات النصية تبقى باسم الناشر فقط.
 */
export default function PostHeaderIdentity({
  post,
  className,
  nameClassName,
  usernameClassName,
  nameLinkClass = 'hover:underline',
  taggedNameLinkClass = 'hover:underline',
  moreTriggerClass = 'mx-0.5 inline-flex shrink-0 items-center rounded-full px-0.5 align-middle text-current opacity-70 transition hover:opacity-100',
}: PostHeaderIdentityProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const mentions = post.type !== 'text' ? getPostMentions(post) : [];
  const primary = mentions[0] || null;
  const hasMore = mentions.length > 1;
  const publisherHref = `/profile/${post.user_id}`;

  const moreButton = (size: number) => (
    <button
      type="button"
      aria-label="عرض جميع الأشخاص المشار إليهم"
      onClick={() => setSheetOpen(true)}
      className={moreTriggerClass}
    >
      <MoreHorizontal size={size} />
    </button>
  );

  const nameNode = (
    <>
      <Link href={publisherHref} className={nameLinkClass}>
        {displayName(post.author)}
      </Link>
      {primary?.profileId && (
        <>
          <span className="mx-1 font-normal">و</span>
          <Link href={`/profile/${encodeURIComponent(primary.profileId)}`} className={taggedNameLinkClass}>
            {taggedMentionDisplayName(primary)}
          </Link>
        </>
      )}
      {hasMore && moreButton(15)}
    </>
  );

  // منشورات الإشارة: يظهر الاسم فقط (اسم الناشر و اسم المشار إليه) دون سطر اليوزرات
  const usernameNode = primary?.profileId ? undefined : (post.author?.username || 'user');

  return (
    <>
      <UserIdentity
        name={nameNode}
        username={usernameNode}
        className={className}
        nameClassName={nameClassName}
        usernameClassName={usernameClassName}
      />
      {sheetOpen && (
        <TaggedUsersSheet mentions={mentions} onClose={() => setSheetOpen(false)} />
      )}
    </>
  );
}

type TaggedUsersSheetProps = {
  mentions: PostMetadataTag[];
  onClose: () => void;
};

function TaggedUsersSheet({ mentions, onClose }: TaggedUsersSheetProps) {
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());

  // اجلب بيانات الملفات الحقيقية (الصورة والاسم الكامل) للمشار إليهم
  useEffect(() => {
    let active = true;
    const ids = mentions.map(mention => mention.profileId).filter((id): id is string => Boolean(id));
    if (ids.length === 0 || !supabaseConfigured) return undefined;

    void supabase
      .from('profiles')
      .select('id, username, full_name, display_name, avatar_url')
      .in('id', ids)
      .then(({ data }) => {
        if (!active) return;
        const map = new Map<string, Profile>();
        (data || []).forEach(row => {
          if (typeof row.id === 'string') map.set(row.id, row as unknown as Profile);
        });
        setProfiles(map);
      });
    return () => {
      active = false;
    };
  }, [mentions]);

  return (
    <div className="fixed inset-0 z-[95] bg-black/65 backdrop-blur-[2px]" dir="rtl" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="الأشخاص المشار إليهم في المنشور"
        dir="rtl"
        onClick={event => event.stopPropagation()}
        className="fixed inset-x-0 bottom-0 z-[96] max-h-[70dvh] overflow-y-auto rounded-t-[24px] border border-white/10 bg-[#18181b] px-5 pt-3 text-white shadow-[0_-12px_50px_rgba(0,0,0,0.45)]"
        style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-bold">الأشخاص المشار إليهم</span>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={onClose}
            className="rounded-full p-1 text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>
        {mentions.map(mention => {
          const profileId = mention.profileId || '';
          const profile = profiles.get(profileId) || {
            id: profileId,
            username: mention.label,
            full_name: mention.displayName || '',
            display_name: mention.displayName || null,
            avatar_url: null,
            bio: '',
          };
          return (
            <Link
              key={mention.profileId || mention.label}
              href={`/profile/${encodeURIComponent(profileId)}`}
              onClick={onClose}
              className="flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-right transition hover:bg-white/10"
            >
              <Avatar profile={profile} large />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-white">
                  {taggedMentionDisplayName(mention)}
                </p>
                <p className="truncate text-[11px] text-white/50" dir="ltr">
                  @{mention.label}
                </p>
              </div>
            </Link>
          );
        })}
      </section>
    </div>
  );
}
