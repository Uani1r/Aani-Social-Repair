import type { MouseEvent } from 'react';
import { Link } from 'wouter';
import { Film, Home, MessageCircle, Search, UserRound } from 'lucide-react';

type ShellBottomNavProps = {
  path: string;
  chromeHidden: boolean;
  onNavigationTap: (event: MouseEvent<HTMLAnchorElement>, navId: string) => void;
};

export default function ShellBottomNav({ path, chromeHidden, onNavigationTap }: ShellBottomNavProps) {
  const nav = [
    ['/feed', Home, 'الرئيسية', 'feed'],
    ['/reels', Film, 'ريلز', 'reels'],
    ['/search', Search, 'البحث', 'search'],
    ['/messages', MessageCircle, 'الرسائل', 'messages'],
    ['/profile', UserRound, 'ملفي', 'profile'],
  ] as const;

  return (
    <nav
      className={`mobile-nav fixed inset-x-0 bottom-0 z-40 mx-auto flex items-center justify-around gap-1 rounded-full border border-white/10 bg-zinc-900/95 px-3 pt-2 shadow-2xl backdrop-blur-md will-change-[transform,opacity] ${
        chromeHidden ? 'is-hidden' : ''
      }`}
      style={{
        width: 'min(92vw, 26rem)',
        paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))',
      }}
    >
      {nav.map(([href, Icon, label, id]) => {
        const active = path === href || (id === 'feed' && path === '/') || (id === 'profile' && path.startsWith('/profile'));

        return (
          <Link
            key={id}
            href={href}
            onClick={event => onNavigationTap(event, id)}
            className={`flex flex-col items-center gap-1 text-[10px] transition ${active ? 'text-pink-500 font-bold' : 'text-zinc-400'}`}
          >
            <span
              className={`flex h-8 w-8 items-center justify-center rounded-full transition-all duration-300 ${
                active ? 'bg-zinc-200 text-zinc-900' : 'bg-transparent'
              }`}
            >
              <Icon size={19} />
            </span>
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
