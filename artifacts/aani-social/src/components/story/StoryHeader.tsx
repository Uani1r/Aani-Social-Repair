import { useState } from 'react';
import { Link } from 'wouter';
import { MoreVertical, Trash2, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import DefaultAvatar from '@/components/DefaultAvatar';
import UserIdentity from '@/components/UserIdentity';
import { useMediaUrl } from '@/lib/mediaAccess';
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

/** قطر صورة الناشر في وضع إعادة المشاركة (بكسل). */
const MAIN_AVATAR_SIZE = 44;
/** حجم الصورة المتداخلة كنسبة من الصورة الرئيسية. */
const MINI_AVATAR_RATIO = 0.42;

/**
 * صورة داخل دائرة: تعرض الصورة إن وُجدت، وإلا — أو عند فشل تحميلها —
 * تعرض الأيقونة الرمادية الافتراضية. لا تبقى الدائرة فارغة أبداً.
 */
function AvatarFill({ src, alt = '' }: { src: string | null; alt?: string }) {
  const [failed, setFailed] = useState(false);
  // قد تكون صورة ImageKit محمية: تُوقَّع أولاً، ولا يُطلب الرابط العام أبداً.
  const resolved = useMediaUrl(src);

  if (!resolved || failed) {
    return <DefaultAvatar className="h-full w-full" />;
  }

  return (
    <img
      src={resolved}
      alt={alt}
      onError={() => setFailed(true)}
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
    />
  );
}

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
  // قصة معاد نشرها: صورة صاحب القصة الأصلية متداخلة أسفل صورة الناشر.
  // الدائرة الصغيرة تظهر دائماً في وضع إعادة المشاركة، حتى لو غاب avatar_url
  // أو تعذّر جلب صاحب القصة الأصلية (تُعرض أيقونة رمادية افتراضية).
  const isReshare = Boolean(currentStory.original_story_id);
  const originalAuthorId = originalStoryAuthor?.id ?? null;
  const originalAuthorName = displayName(originalStoryAuthor) || 'صاحب القصة الأصلية';
  const originalUsername = cleanUsername(originalStoryAuthor?.username);

  return (
    <>
      {showUI && (
        <div
          className="absolute inset-x-0 z-30 flex items-center justify-between px-3 pt-2 text-white bg-gradient-to-b from-black/80 via-black/40 to-transparent"
          style={{ top: 'calc(1.5rem + env(safe-area-inset-top))', overflow: 'visible' }}
        >
          <div className="flex min-w-0 flex-col items-start gap-1" style={{ overflow: 'visible' }}>
            <div className="flex min-w-0 items-center gap-4" style={{ overflow: 'visible' }}>
              {isReshare ? (
                // حاوية مستقلة: صورة الناشر + صورة صاحب القصة الأصلية المتداخلة.
                <div
                  style={{
                    position: 'relative',
                    width: MAIN_AVATAR_SIZE,
                    height: MAIN_AVATAR_SIZE,
                    flexShrink: 0,
                    overflow: 'visible',
                  }}
                >
                  <Link
                    href={`/profile/${currentStory.user_id}`}
                    aria-label={`ملف ${displayName(currentStory.author) || 'ناشر القصة'}`}
                    style={{ display: 'block', width: '100%', height: '100%' }}
                  >
                    <span
                      style={{
                        display: 'block',
                        width: '100%',
                        height: '100%',
                        borderRadius: '50%',
                        overflow: 'hidden',
                        border: '2px solid #333',
                        backgroundColor: '#0f0f13',
                        boxSizing: 'border-box',
                      }}
                    >
                      <AvatarFill
                        key={currentStory.author?.avatar_url ?? 'no-avatar'}
                        src={currentStory.author?.avatar_url ?? null}
                      />
                    </span>
                  </Link>

                  {/* الصورة المصغّرة: 42% من الرئيسية، أسفل-يسار، بإطار وخلفية داكنة */}
                  <span
                    style={{
                      position: 'absolute',
                      bottom: -2,
                      left: -2,
                      width: `${MINI_AVATAR_RATIO * 100}%`,
                      height: `${MINI_AVATAR_RATIO * 100}%`,
                      borderRadius: '50%',
                      overflow: 'hidden',
                      backgroundColor: '#0f0f13',
                      border: '2px solid #0f0f13',
                      boxSizing: 'border-box',
                      zIndex: 2,
                      display: 'block',
                    }}
                  >
                    {originalAuthorId ? (
                      <Link
                        href={`/profile/${originalAuthorId}`}
                        aria-label={`ملف ${originalAuthorName}`}
                        title={originalAuthorName}
                        style={{ display: 'block', width: '100%', height: '100%' }}
                      >
                        <AvatarFill
                          key={originalStoryAuthor?.avatar_url ?? 'no-avatar'}
                          src={originalStoryAuthor?.avatar_url ?? null}
                          alt={originalAuthorName}
                        />
                      </Link>
                    ) : (
                      <AvatarFill src={null} />
                    )}
                  </span>
                </div>
              ) : (
                // القصص العادية: صورة الناشر كما هي بلا أي تغيير.
                <Link
                  href={`/profile/${currentStory.user_id}`}
                  aria-label={`ملف ${displayName(currentStory.author) || 'ناشر القصة'}`}
                  className="shrink-0"
                >
                  <Avatar profile={currentStory.author} storyBorder={false} />
                </Link>
              )}
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
