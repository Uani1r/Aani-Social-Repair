import {
  Ghost,
  Instagram,
  Link2,
  Mail,
  MessageCircle,
  MessageSquare,
  Send,
  Share2,
} from 'lucide-react';

import RepostIcon from '../RepostIcon';
import ShareAction from './ShareAction';

const ShareMethodActions = ({
  reposted,
  repostBusy,
  onRepost,
  onWhatsApp,
  onInstagram,
  onCopyLink,
  onSnapchat,
  onTelegram,
  onSms,
  onEmail,
  onNativeShare,
}: {
  reposted: boolean;
  repostBusy: boolean;
  onRepost: () => void;
  onWhatsApp: () => void;
  onInstagram: () => void;
  onCopyLink: () => void;
  onSnapchat: () => void;
  onTelegram: () => void;
  onSms: () => void;
  onEmail: () => void;
  onNativeShare: () => void;
}) => (
  <div className="px-4 pt-2">
    <span className="text-[11px] font-bold text-zinc-400">مشاركة عبر</span>

    <div className="no-scrollbar mt-2 flex gap-2.5 overflow-x-auto pb-3">
      <ShareAction
        icon={<RepostIcon active={reposted} size={18} />}
        label={reposted ? 'إلغاء الإعادة' : 'إعادة النشر'}
        busy={repostBusy}
        onClick={onRepost}
      />
      <ShareAction icon={<MessageCircle size={18} />} label="واتساب" onClick={onWhatsApp} />
      <ShareAction icon={<Instagram size={18} />} label="إنستغرام" onClick={onInstagram} />
      <ShareAction icon={<Link2 size={18} />} label="نسخ الرابط" onClick={onCopyLink} />
      <ShareAction icon={<Ghost size={18} />} label="سناب شات" onClick={onSnapchat} />
      <ShareAction icon={<Send size={18} />} label="تيليجرام" onClick={onTelegram} />
      <ShareAction icon={<MessageSquare size={18} />} label="رسالة نصية" onClick={onSms} />
      <ShareAction icon={<Mail size={18} />} label="بريد" onClick={onEmail} />
      <ShareAction icon={<Share2 size={18} />} label="المزيد" onClick={onNativeShare} />
    </div>
  </div>
);

export default ShareMethodActions;
