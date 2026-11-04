import { Link } from 'wouter';
import { Bell, Plus, Settings } from 'lucide-react';

type ShellTopBarProps = {
  path: string;
  chromeHidden: boolean;
  unreadCount: number;
  onOpenNotifications: () => void;
  onOpenSettings: () => void;
  onOpenCreatePost: () => void;
};

export default function ShellTopBar({
  path,
  chromeHidden,
  unreadCount,
  onOpenNotifications,
  onOpenSettings,
  onOpenCreatePost,
}: ShellTopBarProps) {
  return (
    <>
      <header
        className={`topbar fixed top-0 z-50 flex w-full flex-nowrap items-center justify-between overflow-hidden border-b border-zinc-800 bg-zinc-900/95 backdrop-blur-md will-change-[transform,opacity] ${
          chromeHidden ? 'is-hidden' : ''
        }`}
        dir="rtl"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: '0.625rem',
          paddingLeft: '1rem',
          paddingRight: '1rem',
        }}
      >
        <Link href="/feed" className="brand flex shrink-0 items-center gap-1 whitespace-nowrap text-lg font-bold text-white">
          <span className="brand-mark shrink-0 rounded-lg bg-gradient-to-r from-pink-500 to-purple-600 px-2 py-0.5 text-sm text-white">آ</span>
          <span>آني <small className="text-[10px] font-normal text-zinc-400">Aani</small></span>
        </Link>

        <div className="flex shrink-0 items-center justify-end gap-2" dir="ltr">
          <button type="button" aria-label="فتح خيارات النشر" className="icon-button shrink-0 rounded-full bg-pink-600 p-1.5 text-white shadow" onClick={onOpenCreatePost}>
            <Plus size={20} className="shrink-0" />
          </button>
          {path.startsWith('/profile') && (
            <button type="button" aria-label="الإعدادات" className="icon-button shrink-0 text-zinc-300" onClick={onOpenSettings}>
              <Settings size={20} className="shrink-0" />
            </button>
          )}
          <button type="button" aria-label="الإشعارات" aria-haspopup="dialog" className="relative shrink-0 rounded-full p-2 text-[#e6a17b] transition hover:bg-[#e6a17b]/10" onClick={onOpenNotifications}>
            <Bell size={20} className="shrink-0" />
            {unreadCount > 0 && (
              <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#e6a17b] px-1 text-[9px] font-bold text-[#09090b]">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* مساحة تعويضية ثابتة للشريط العلوي (بصري فقط) */}
      <div aria-hidden="true" style={{ height: 'calc(2.9375rem + env(safe-area-inset-top))' }} />
    </>
  );
}
