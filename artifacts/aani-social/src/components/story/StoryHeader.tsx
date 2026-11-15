import { Link } from 'wouter';
import { MoreVertical, Trash2, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
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
  // قصة معاد نشرها: تظهر صورة صاحب القصة الأصلية مصغّرة ومتداخلة أسفل صورة
  // الناشر وتفتح ملفه الشخصي — بلا شريط ريبوست سفلي وبلا أيقونة ثانية.
  const isReshare = Boolean(currentStory.original_story_id);
  const originalAuthorId = originalStoryAuthor?.id ?? null;
  const originalAuthorName = displayName(originalStoryAuthor) || 'صاحب القصة الأصلية';
  const originalUsername = cleanUsername(originalStoryAuthor?.username);

  return (
    <>
      {showUI && (
        <div className="absolute inset-x-0 z-30 flex items-center justify-between px-3 pt-2 text-white bg-gradient-to-b from-black/80 via-black/40 to-transparent" style={{ top: 'calc(1.5rem + env(safe-area-inset-top))' }}>
          <div className="flex min-w-0 flex-col items-start gap-1">
            <div className="flex min-w-0 items-center gap-4">
              {/* صورة الناشر: رابط مستقل لملفه الشخصي */}
              <span className="relative inline-flex shrink-0">
                <Link
                  href={`/profile/${currentStory.user_id}`}
                  aria-label={`ملف ${displayName(currentStory.author) || 'ناشر القصة'}`}
                  className="shrink-0"
                >
                  <Avatar profile={currentStory.author} storyBorder={false} />
                </Link>
                {isReshare && originalAuthorId && (
                  // صورة صاحب القصة الأصلية: دائرية صغيرة بإطار أبيض، متداخلة أسفل
                  // صورة الناشر، وتفتح ملفه الشخصي (رابط مستقل بلا تداخل HTML).
                  <Link
                    href={`/profile/${originalAuthorId}`}
                    aria-label={`ملف ${originalAuthorName}`}
                    title={originalAuthorName}
                    className="absolute -bottom-1 -left-1 z-10 inline-flex overflow-hidden rounded-full bg-white ring-2 ring-white shadow-md"
                  >
                    <Avatar profile={originalStoryAuthor} storyBorder={false} small />
                  </Link>
                )}
              </span>
              {/* اسم الناشر واسم المستخدم والتاريخ: رابط مستقل لملف الناشر */}
              <Link href={`/profile/${currentStory.user_id}`} className="min-w-0 flex-1">
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
            </div>
            {/* @username صاحب القصة الأصلية — نص صغير واضح أسفل معلومات الناشر،
                بلا أيقونة ريبوست وبلا رابط (الصورة المصغّرة وحدها تفتح ملفه). */}
            {isReshare && originalUsername && (
              <span
                dir="ltr"
                className="max-w-[52vw] truncate rounded-full bg-black/45 px-2 py-0.5 text-[9px] font-medium text-white/80 backdrop-blur-sm"
              >
                @{originalUsername}
              </span>
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
