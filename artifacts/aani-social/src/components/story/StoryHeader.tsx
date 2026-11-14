import { Link } from 'wouter';
import { MoreVertical, Trash2, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import RepostIcon from '@/components/RepostIcon';
import UserIdentity from '@/components/UserIdentity';
import { cleanUsername, displayName, formatDate } from '@/lib/types';

import type { StoryViewerProps } from './types';

type StoryHeaderProps = Pick<
  StoryViewerProps,
  | 'currentStory'
  | 'originalStoryAuthor'
  | 'userId'
  | 'showUI'
  | 'showMenu'
  | 'onMenuChange'
  | 'onReportStory'
  | 'onDeleteStory'
  | 'onCloseViewer'
>;

export default function StoryHeader({
  currentStory,
  originalStoryAuthor,
  userId,
  showUI,
  showMenu,
  onMenuChange,
  onReportStory,
  onDeleteStory,
  onCloseViewer,
}: StoryHeaderProps) {
  // قصة معاد نشرها: تُعرض أيقونة إعادة النشر متداخلة مع أسفل صورة صاحب القصة
  // الحالية، وبجانبها @username صاحب القصة الأصلية فقط (بلا الاسم الكامل).
  const isReshare = Boolean(currentStory.original_story_id);
  const originalUsername = cleanUsername(originalStoryAuthor?.username);

  return (
    <>
      {showUI && (
        <div className="absolute inset-x-0 z-30 flex items-center justify-between px-3 pt-2 text-white bg-gradient-to-b from-black/80 via-black/40 to-transparent" style={{ top: 'calc(1.5rem + env(safe-area-inset-top))' }}>
          <div className="flex min-w-0 flex-col items-start gap-1">
            <Link href={`/profile/${currentStory.user_id}`} className="flex min-w-0 items-center gap-4">
              <span className="relative inline-flex shrink-0">
                <Avatar profile={currentStory.author} storyBorder={false} />
                {isReshare && (
                  <span
                    className="absolute -bottom-1 -left-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/85 text-white ring-1 ring-white/45"
                    title="إعادة نشر"
                  >
                    <RepostIcon active={false} size={10} strokeWidth={2.6} />
                  </span>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <UserIdentity
                  name={(
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate">{displayName(currentStory.author)}</span>
                      {currentStory.is_close_friends && (
                        <span className="shrink-0 rounded-md bg-emerald-500 px-1.5 py-0.5 text-[9px] font-semibold">أصدقاء مقربون</span>
                      )}
                    </span>
                  )}
                  username={currentStory.author?.username}
                  nameClassName="text-xs font-bold text-white"
                  usernameClassName="text-[10px] text-zinc-300"
                />
                <span className="mt-1 block whitespace-nowrap text-[10px] text-zinc-300">{formatDate(currentStory.created_at)}</span>
              </div>
            </Link>
            {isReshare && (
              <div className="flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-white/85 backdrop-blur-sm">
                <RepostIcon active={false} size={11} strokeWidth={2.4} />
                {originalUsername && (
                  <span dir="ltr" className="max-w-[42vw] truncate text-[9px]">@{originalUsername}</span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-story-viewer-menu-toggle="true"
              aria-label="خيارات الستوري"
              onClick={() => onMenuChange(!showMenu)}
              className="p-1 hover:bg-white/20 rounded-full"
            >
              <MoreVertical size={18} />
            </button>
            <button onClick={onCloseViewer} className="p-1 hover:bg-white/20 rounded-full">
              <X size={20} />
            </button>
          </div>
        </div>
      )}

      {showMenu && (
        <div data-story-viewer-menu="true" className="absolute top-14 left-3 z-40 bg-zinc-900 border border-zinc-800 rounded-xl p-2 shadow-xl text-xs space-y-1">
          {currentStory.user_id === userId ? (
            <button onClick={onDeleteStory} className="flex items-center gap-2 text-red-400 p-2 w-full hover:bg-zinc-800 rounded-lg">
              <Trash2 size={14} /> حذف الستوري
            </button>
          ) : (
            <button onClick={onReportStory} className="p-2 w-full text-zinc-300 hover:bg-zinc-800 rounded-lg">
              إبلاغ عن الستوري
            </button>
          )}
        </div>
      )}
    </>
  );
}
