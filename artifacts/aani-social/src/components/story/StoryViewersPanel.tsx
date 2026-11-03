import type { FormEvent } from 'react';
import { Ban, Eye, EyeOff, Flag, Heart, Loader2, MoreVertical, UserRound, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { storyViewerDisplayName, type StoryViewerEntry } from '@/lib/appShared';
import { formatDate } from '@/lib/types';

import type { StoryViewerProps } from './types';

type StoryViewersPanelProps = Pick<
  StoryViewerProps,
  | 'currentStory'
  | 'storyViewsOpen'
  | 'isStoryOwner'
  | 'storyViewsLoading'
  | 'storyViewsError'
  | 'storyViewsCount'
  | 'storyViewers'
  | 'storyViewerPreview'
  | 'viewerActionBusyId'
  | 'viewerReportTarget'
  | 'viewerReportCategory'
  | 'viewerReportDetails'
  | 'viewerReportBusy'
  | 'onCloseStoryViews'
  | 'onViewerRowMenuOpenChange'
  | 'onOpenViewerReport'
  | 'onBlockStoryViewer'
  | 'onHideStoryFromViewer'
  | 'onToggleStoryViewerFollow'
  | 'onViewerReportSubmit'
  | 'onViewerReportCancel'
  | 'onViewerReportCategoryChange'
  | 'onViewerReportDetailsChange'
>;

export default function StoryViewersPanel({
  currentStory,
  storyViewsOpen,
  isStoryOwner,
  storyViewsLoading,
  storyViewsError,
  storyViewsCount,
  storyViewers,
  storyViewerPreview,
  viewerActionBusyId,
  viewerReportTarget,
  viewerReportCategory,
  viewerReportDetails,
  viewerReportBusy,
  onCloseStoryViews,
  onViewerRowMenuOpenChange,
  onOpenViewerReport,
  onBlockStoryViewer,
  onHideStoryFromViewer,
  onToggleStoryViewerFollow,
  onViewerReportSubmit,
  onViewerReportCancel,
  onViewerReportCategoryChange,
  onViewerReportDetailsChange,
}: StoryViewersPanelProps) {
  if (!storyViewsOpen || !isStoryOwner) return null;

  return (
    <>
      <button
        type="button"
        aria-label="إغلاق قائمة المشاهدات"
        className="absolute inset-0 z-[60] bg-black/45"
        onClick={event => {
          event.stopPropagation();
          onCloseStoryViews();
        }}
      />
      <section
        data-story-viewers-panel="true"
        className="absolute inset-x-0 bottom-0 z-[70] flex h-[88dvh] max-h-[90dvh] flex-col overflow-hidden rounded-t-3xl border-t border-white/10 bg-zinc-950/95 px-4 pt-2 shadow-2xl backdrop-blur-xl"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
        role="dialog"
        aria-modal="true"
        aria-label="مشاهدات الستوري"
        onClick={event => event.stopPropagation()}
      >
        <div data-story-viewers-panel-header="true" className="mx-auto mb-3 mt-1 h-1 w-10 rounded-full bg-white/30" />
        <div data-story-viewers-panel-header="true" className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">المشاهدات والإعجابات</h2>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 text-xs text-zinc-400" aria-label={`${storyViewsCount} مشاهدة`}>
              <Eye size={13} /> {storyViewsCount}
            </span>
            <span className="flex items-center gap-1 text-xs text-pink-400" aria-label={`${storyViewers.filter(item => item.is_liked).length} إعجاب`}>
              <Heart size={13} fill="currentColor" /> {storyViewers.filter(item => item.is_liked).length}
            </span>
            <button
              type="button"
              onClick={onCloseStoryViews}
              aria-label="إغلاق"
              className="rounded-full p-1 text-zinc-300 transition hover:bg-white/10"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {storyViewsLoading && (
            <div className="flex items-center justify-center py-5 text-zinc-400" role="status" aria-label="جارٍ تحميل المشاهدات">
              <Loader2 size={20} className="animate-spin" />
            </div>
          )}
          {storyViewsError && (
            <p className="py-5 text-center text-xs text-red-300">تعذر تحميل بيانات المشاهدين أو الإعجابات الفعلية. تحقق من قاعدة البيانات والاتصال.</p>
          )}
          {!storyViewsLoading && !storyViewsError && storyViewers.length > 0 && (
            <ul className="space-y-2">
              {storyViewers.map((item: StoryViewerEntry) => (
                <li key={`${currentStory.id}:${item.user_id}`} className="flex items-center gap-4 rounded-xl px-2 py-2 hover:bg-white/[0.03]">
                  <Avatar profile={item.viewer} />
                  <div className="min-w-0 flex-1">
                    <UserIdentity
                      name={storyViewerDisplayName(item.viewer)}
                      username={item.viewer?.username || 'اسم المستخدم غير متاح'}
                      nameClassName="text-xs font-semibold text-white"
                      usernameClassName="text-[10px] text-zinc-400"
                    />
                    <time className="mt-1 block text-[10px] text-zinc-500">
                      {item.is_viewer === false
                        ? `أعجب بالقصة ${formatDate(item.liked_at || item.viewed_at)}`
                        : formatDate(item.viewed_at)}
                    </time>
                  </div>
                  {item.is_liked && (
                    <Heart size={16} fill="currentColor" className="shrink-0 text-pink-500" aria-label="أعجب بالستوري" />
                  )}
                  <DropdownMenu onOpenChange={onViewerRowMenuOpenChange}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`خيارات ${item.viewer?.username || 'المشاهد'}`}
                        disabled={Boolean(viewerActionBusyId)}
                        className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
                      >
                        <MoreVertical size={18} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="z-[150] min-w-48 border-zinc-800 bg-zinc-900 text-white">
                      <DropdownMenuItem onSelect={() => onOpenViewerReport(item)}>
                        <Flag size={15} /> الإبلاغ عن الحساب
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-amber-300 focus:text-amber-200" onSelect={() => onBlockStoryViewer(item)}>
                        <Ban size={15} /> حظر الحساب
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onHideStoryFromViewer(item)}>
                        <EyeOff size={15} /> إخفاء الستوري عنه
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onToggleStoryViewerFollow(item)}>
                        <UserRound size={15} />
                        {item.is_following
                          ? 'إلغاء المتابعة'
                          : item.follow_request_pending
                            ? 'إلغاء طلب المتابعة'
                            : item.viewer?.is_private
                              ? 'طلب متابعة'
                              : 'متابعة'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          )}

          {storyViewerPreview?.storyId === currentStory.id && storyViewerPreview.expiresAt > Date.now() && storyViewerPreview.rows.length > 0 && (
            <div className="mt-1">
              <ul className="space-y-2">
                {storyViewerPreview.rows.map(item => (
                  <li key={`preview:${currentStory.id}:${item.user_id}`} className="flex items-center gap-4 py-2">
                    <Avatar profile={item.viewer} />
                    <div className="min-w-0 flex-1">
                      <UserIdentity
                        name={storyViewerDisplayName(item.viewer)}
                        username={item.viewer?.username || 'اسم المستخدم غير متاح'}
                        nameClassName="text-xs font-semibold text-white"
                        usernameClassName="text-[10px] text-zinc-400"
                      />
                      <time className="mt-1 block text-[10px] text-zinc-500">{formatDate(item.viewed_at)} · معاينة</time>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      {viewerReportTarget && (
        <div
          className="absolute inset-0 z-[90] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={() => {
            if (!viewerReportBusy) onViewerReportCancel();
          }}
        >
          <form
            dir="rtl"
            onSubmit={(event: FormEvent<HTMLFormElement>) => onViewerReportSubmit(event)}
            onClick={event => event.stopPropagation()}
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-4 text-white shadow-2xl"
          >
            <h3 className="text-sm font-bold">الإبلاغ عن الحساب</h3>
            <p className="mt-1 text-[11px] text-zinc-400">{storyViewerDisplayName(viewerReportTarget.viewer)}</p>
            <label className="mt-4 block text-[11px] text-zinc-300">
              سبب الإبلاغ
              <select
                required
                value={viewerReportCategory}
                onChange={event => onViewerReportCategoryChange(event.target.value as typeof viewerReportCategory)}
                className="mt-1.5 h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-xs text-white outline-none focus:border-sky-400"
              >
                <option value="spam">رسائل أو محتوى مزعج</option>
                <option value="harassment">مضايقة أو تنمّر</option>
                <option value="hate">خطاب كراهية</option>
                <option value="fake_account">حساب منتحل أو مزيف</option>
                <option value="other">سبب آخر</option>
              </select>
            </label>
            <label className="mt-3 block text-[11px] text-zinc-300">
              تفاصيل إضافية (اختياري)
              <textarea
                value={viewerReportDetails}
                onChange={event => onViewerReportDetailsChange(event.target.value)}
                maxLength={1000}
                rows={3}
                className="mt-1.5 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-xs text-white outline-none focus:border-sky-400"
              />
            </label>
            <div className="mt-4 flex gap-2">
              <button type="button" disabled={viewerReportBusy} onClick={onViewerReportCancel} className="h-10 flex-1 rounded-lg border border-zinc-700 text-xs text-zinc-300 disabled:opacity-50">
                إلغاء
              </button>
              <button type="submit" disabled={viewerReportBusy} className="h-10 flex-1 rounded-lg bg-sky-500 text-xs font-bold text-zinc-950 disabled:opacity-50">
                {viewerReportBusy ? <Loader2 size={15} className="mx-auto animate-spin" /> : 'إرسال البلاغ'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
