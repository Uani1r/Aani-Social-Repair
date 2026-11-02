import { displayName, type Profile } from '@/lib/types';

export default function Avatar({ profile, large = false, storyBorder = false, isCloseFriends = false, extraLarge = false }: { profile?: Partial<Profile> | null; large?: boolean; storyBorder?: boolean; isCloseFriends?: boolean; extraLarge?: boolean }) {
  const initials = (displayName(profile).replace('@', '').trim().slice(0, 2) || 'آ').toUpperCase();
  const sizeClass = extraLarge ? 'w-16 h-16 text-lg' : large ? 'w-12 h-12 text-base' : 'w-8 h-8 text-xs';
  const borderClass = isCloseFriends
    ? 'ring-2 ring-emerald-500 ring-offset-2 ring-offset-zinc-900'
    : storyBorder
      ? 'ring-2 ring-pink-500 ring-offset-2 ring-offset-zinc-900'
      : '';
  const baseClass = `rounded-full object-cover flex items-center justify-center font-bold bg-zinc-800 text-white shrink-0 ${sizeClass} ${borderClass}`;
  return profile?.avatar_url
    ? <img className={baseClass} src={profile.avatar_url} alt="" />
    : <span className={baseClass}>{initials}</span>;
}
