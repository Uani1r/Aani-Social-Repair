import type { Profile } from '@/lib/types';
import DefaultAvatar from '@/components/DefaultAvatar';
import { useMediaUrl } from '@/lib/mediaAccess';

export default function Avatar({ profile, large = false, small = false, storyBorder = false, isCloseFriends = false, extraLarge = false }: { profile?: Partial<Profile> | null; large?: boolean; small?: boolean; storyBorder?: boolean; isCloseFriends?: boolean; extraLarge?: boolean }) {
  const sizeClass = extraLarge ? 'w-16 h-16 text-lg' : large ? 'w-12 h-12 text-base' : small ? 'w-5 h-5 text-[8px]' : 'w-8 h-8 text-xs';
  const borderClass = isCloseFriends || storyBorder
    ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-900'
    : '';
  const baseClass = `rounded-full object-cover flex items-center justify-center shrink-0 ${sizeClass} ${borderClass}`;
  // صورة الملف قد تكون في bucket خاص: تُحوَّل إلى رابط موقّع، ويبقى الرابط
  // الأصلي معروضاً حتى يصل الموقّع (أو إن كان خارجياً بلا تغيير).
  const avatarUrl = useMediaUrl(profile?.avatar_url);
  if (avatarUrl) {
    return <img className={baseClass} src={avatarUrl} alt="" />;
  }
  // معيار الأيقونة الافتراضية: دائرة بيضاء وشخصية سوداء هندسية
  // تحدد صورتها من جنس الملف (ذكر افتراضياً عند غياب الجنس)
  return (
    <span
      className={`${baseClass} overflow-hidden bg-white`}
      aria-hidden="true"
    >
      <DefaultAvatar gender={profile?.gender} className="h-full w-full" />
    </span>
  );
}
