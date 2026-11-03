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
        className={`topbar fixed inset-x-0 top-0 z-40 grid grid-cols-3 items-center overflow-hidden border-b border-zinc-800 bg-zinc-900/95 backdrop-blur-md will-change-[transform,opacity] ${
          chromeHidden ? 'is-hidden' : ''
        }`}
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: '0.625rem',
          paddingLeft: '1rem',
          paddingRight: '1rem',
        }}
      >
        <div className="flex items-center justify-start">
          <button className="relative p-2 rounded-full hover:bg-zinc-800 text-zinc-300" onClick={onOpenNotifications}>
            <Bell size={20} />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 bg-pink-600 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                {unreadCount}
              </span>
            )}
          </button>
        </div>

        <div className="flex items-center justify-center">
          <Link href="/feed" className="brand font-bold text-lg text-white flex items-center gap-1">
            <span className="brand-mark bg-gradient-to-r from-pink-500 to-purple-600 text-white px-2 py-0.5 rounded-lg text-sm">آ</span>
            <span>آني <small className="text-[10px] text-zinc-400 font-normal">Aani</small></span>
          </Link>
        </div>

        <div className="flex items-center justify-end gap-2">
          {path.startsWith('/profile') && (
            <button className="icon-button text-zinc-300" onClick={onOpenSettings}>
              <Settings size={20} />
            </button>
          )}
          <button type="button" aria-label="إنشاء محتوى" className="icon-button bg-pink-600 text-white p-1.5 rounded-full shadow" onClick={onOpenCreatePost}>
            <Plus size={20} />
          </button>
        </div>
      </header>

      {/* مساحة تعويضية ثابتة للشريط العلوي (بصري فقط) */}
      <div aria-hidden="true" style={{ height: 'calc(2.9375rem + env(safe-area-inset-top))' }} />
    </>
  );
}
