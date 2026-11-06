import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Bell, Plus } from 'lucide-react';

type UnifiedTopBarProps = {
  hidden: boolean;
  unreadCount: number;
  stories?: ReactNode;
  onOpenNotifications: () => void;
  onOpenCreatePost: () => void;
};

export default function UnifiedTopBar({
  hidden,
  unreadCount,
  stories,
  onOpenNotifications,
  onOpenCreatePost,
}: UnifiedTopBarProps) {
  return (
    <>
      <div className={`unified-top-bar${hidden ? ' is-hidden' : ''}`} dir="rtl">
        <header className="unified-top-header">
          <Link href="/feed" className="unified-profile-section" aria-label="Ani آني">
            <svg
              className="unified-brand-logo"
              xmlns="http://www.w3.org/2000/svg"
              width="108"
              height="40"
              viewBox="0 0 430 160"
              aria-hidden="true"
            >
              <rect width="100%" height="100%" fill="transparent" />
              <g fill="#251B14" stroke="#C89B53" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" fillRule="evenodd">
                <path d="M 159 23 L 156 21 L 147 21 L 136 25 L 125 31 L 108 42 L 97 50 L 79 65 L 70 74 L 65 75 L 55 75 L 43 77 L 35 79 L 25 83 L 23 85 L 24 90 L 29 89 L 32 87 L 45 84 L 58 82 L 59 84 L 29 116 L 26 120 L 24 124 L 25 126 L 29 127 L 34 122 L 41 113 L 50 103 L 71 82 L 99 82 L 106 83 L 116 86 L 119 86 L 122 83 L 121 79 L 119 78 L 106 75 L 81 73 L 97 59 L 109 50 L 124 40 L 141 31 L 148 29 L 152 30 L 152 35 L 149 43 L 144 53 L 129 78 L 116 97 L 106 110 L 104 114 L 105 116 L 109 117 L 116 109 L 132 86 L 146 64 L 156 45 L 160 34 L 160 25 Z" />
                <path d="M 158 115 L 159 118 L 161 119 L 164 119 L 170 116 L 178 108 L 185 99 L 190 91 L 197 84 L 198 87 L 192 100 L 190 106 L 190 115 L 192 117 L 194 118 L 203 118 L 222 109 L 247 95 L 246 110 L 248 114 L 252 118 L 257 120 L 264 120 L 273 117 L 283 112 L 298 102 L 313 90 L 316 86 L 316 84 L 314 82 L 311 82 L 308 84 L 298 93 L 282 104 L 267 111 L 259 111 L 255 107 L 254 105 L 254 99 L 261 78 L 259 76 L 256 76 L 251 82 L 250 82 L 247 85 L 233 94 L 210 107 L 205 109 L 200 110 L 198 108 L 198 106 L 200 100 L 204 92 L 207 83 L 207 77 L 204 74 L 199 74 L 195 76 L 190 80 L 173 103 L 167 109 L 166 106 L 167 105 L 170 90 L 174 79 L 174 76 L 172 74 L 170 74 L 167 76 L 165 80 L 158 107 Z" />
                <path d="M 259 53 L 256 57 L 256 60 L 257 62 L 259 64 L 264 64 L 266 63 L 268 60 L 268 57 L 267 55 L 264 53 Z" />
                <path d="M 382 95 L 380 92 L 375 90 L 373 83 L 373 77 L 371 72 L 366 73 L 364 77 L 364 81 L 365 82 L 364 88 L 361 88 L 359 89 L 357 92 L 357 94 L 359 96 L 363 97 L 368 97 L 371 98 L 373 100 L 371 102 L 364 105 L 348 109 L 332 110 L 320 107 L 318 106 L 316 103 L 320 99 L 326 96 L 335 94 L 338 92 L 339 90 L 338 86 L 323 89 L 316 93 L 309 100 L 308 102 L 308 109 L 310 112 L 317 116 L 324 118 L 344 118 L 350 117 L 367 112 L 375 108 L 381 102 L 382 100 Z" />
                <path d="M 393 68 L 391 69 L 389 72 L 389 82 L 391 107 L 393 109 L 395 109 L 398 107 L 399 105 L 399 91 L 398 76 L 396 68 Z" />
                <path d="M 359 131 L 356 128 L 353 127 L 348 127 L 340 129 L 336 131 L 334 134 L 337 138 L 339 139 L 342 139 L 345 138 L 348 136 L 353 136 L 354 135 L 358 135 L 359 133 Z" />
                <path d="M 380 59 L 382 61 L 384 61 L 387 58 L 390 58 L 394 60 L 399 60 L 405 58 L 409 53 L 408 51 L 404 51 L 400 53 L 396 53 L 392 51 L 387 51 L 385 52 L 380 57 Z" />
                <path d="M 362 50 L 360 53 L 360 56 L 363 59 L 366 60 L 370 60 L 373 57 L 373 53 L 371 51 L 367 49 L 364 49 Z" />
              </g>
            </svg>
          </Link>

          <div className="unified-actions-section">
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
