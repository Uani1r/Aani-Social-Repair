import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Bell, Plus, Settings } from 'lucide-react';

import Avatar from '@/components/Avatar';
import type { Profile } from '@/lib/types';

type UnifiedTopBarProps = {
  hidden: boolean;
  path: string;
  profile: Profile | null;
  unreadCount: number;
  stories?: ReactNode;
  onOpenNotifications: () => void;
  onOpenSettings: () => void;
  onOpenCreatePost: () => void;
};

export default function UnifiedTopBar({
  hidden,
  path,
  profile,
  unreadCount,
  stories,
  onOpenNotifications,
  onOpenSettings,
  onOpenCreatePost,
}: UnifiedTopBarProps) {
  return (
    <>
      <div className={`unified-top-bar${hidden ? ' is-hidden' : ''}`} dir="rtl">
        <header className="unified-top-header">
          <Link href="/feed" className="unified-profile-section" aria-label="آلي Aani">
            <span className="unified-profile-text">
              <span className="unified-name-ar">آلي</span>
              <span className="unified-name-en">Aani</span>
            </span>
            <span className="unified-avatar-container" aria-hidden="true">
              <span className="unified-avatar-letter">آ</span>
            </span>
          </Link>

          <div className="unified-actions-section">
            <Link href="/profile" className="unified-user-profile-link" aria-label="ملفي الشخصي">
              <Avatar profile={profile} />
            </Link>
            {path.startsWith('/profile') && (
              <button
                type="button"
                aria-label="الإعدادات"
                className="unified-icon-button"
                onClick={onOpenSettings}
              >
                <Settings size={20} />
              </button>
            )}
            <button
              type="button"
              aria-label="الإشعارات"
              aria-haspopup="dialog"
              className="unified-icon-button"
              onClick={onOpenNotifications}
            >
              <Bell size={24} strokeWidth={1.75} />
              {unreadCount > 0 && (
                <span className="unified-unread-count">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label="إضافة"
              className="unified-add-button"
              onClick={onOpenCreatePost}
            >
              <Plus size={22} strokeWidth={2.5} />
            </button>
          </div>
        </header>
        {stories}
      </div>
      <div className={`unified-top-bar-spacer${stories ? ' has-stories' : ''}`} aria-hidden="true" />
    </>
  );
}
