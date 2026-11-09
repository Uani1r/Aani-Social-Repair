import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Bell,
  Bot,
  Check,
  ChevronLeft,
  LogOut,
  Palette,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import Avatar from '@/components/Avatar';
import UserIdentity from '@/components/UserIdentity';
import type { SettingsModalProps } from '@/lib/appShared';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { cleanUsername, displayName, type Profile } from '@/lib/types';

type SettingsView = 'home' | 'edit' | 'privacy' | 'appearance' | 'mulhim';

const viewTitles: Record<SettingsView, string> = {
  home: 'الإعدادات',
  edit: 'تعديل الملف الشخصي',
  privacy: 'الخصوصية والأمان',
  appearance: 'المظهر',
  mulhim: 'مُلهِم آني',
};

export default function SettingsModal({
  isOpen,
  onClose,
  currentProfile,
  onProfileUpdate,
  onOpenNotifications,
  onSignOut,
}: SettingsModalProps) {
  const [view, setView] = useState<SettingsView>('home');
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [city, setCity] = useState('');
  const [job, setJob] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [showCity, setShowCity] = useState(true);
  const [showJob, setShowJob] = useState(false);
  const [showBirthDate, setShowBirthDate] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [privacySaving, setPrivacySaving] = useState(false);
  const [mode, setMode] = useState<'gemini' | 'chatgpt' | 'coanalysis'>('coanalysis');
  const [messages, setMessages] = useState<Array<{ id: string; sender: 'user' | 'mulhim'; text: string }>>([
    { id: 'init', sender: 'mulhim', text: 'أهلاً بك في مركز "مُلهِم آني"! أنا جاهز لتلقي أوامرك وتعديل كود المشروع المباشر فوراً.' },
  ]);
  const [inputMsg, setInputMsg] = useState('');
  const [aiThinking, setAiThinking] = useState(false);
  const profileName = currentProfile?.full_name || currentProfile?.display_name || '';
  const profileUsername = currentProfile?.username || '';
  const profileBio = currentProfile?.bio || '';
  const profileCity = currentProfile?.city || currentProfile?.location || '';

  useEffect(() => {
    if (isOpen) setView('home');
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setFullName(profileName);
    setUsername(profileUsername);
    setBio(profileBio);
    setCity(profileCity);
    setJob(currentProfile?.job || '');
    setBirthDate(currentProfile?.birth_date || '');
    setShowCity(currentProfile?.show_city ?? Boolean(profileCity));
    setShowJob(Boolean(currentProfile?.show_job));
    setShowBirthDate(Boolean(currentProfile?.show_birth_date));
  }, [isOpen, profileName, profileUsername, profileBio, profileCity, currentProfile?.job, currentProfile?.birth_date, currentProfile?.show_city, currentProfile?.show_job, currentProfile?.show_birth_date]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSaveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!currentProfile || profileSaving) return;

    const name = fullName.trim();
    const normalizedUsername = cleanUsername(username).toLowerCase();
    const normalizedBio = bio.trim();
    const normalizedCity = city.trim();
    const normalizedJob = job.trim();
    if (!name || name.length > 120) {
      toast.error('أدخل اسماً لا يتجاوز 120 حرفاً.');
      return;
    }
    if (!/^[a-z0-9_.]{3,32}$/.test(normalizedUsername)) {
      toast.error('اسم المستخدم يجب أن يتكون من 3 إلى 32 حرفاً إنجليزياً أو رقماً أو نقطة أو شرطة سفلية.');
      return;
    }
    if (!supabaseConfigured) {
      toast.error('إعدادات الاتصال بقاعدة البيانات غير مكتملة.');
      return;
    }

    const profilePatch: Partial<Profile> = {
      full_name: name,
      display_name: name,
      username: normalizedUsername,
      bio: normalizedBio,
      city: normalizedCity || null,
      location: normalizedCity || null,
      job: normalizedJob || null,
      birth_date: birthDate || null,
      show_city: showCity,
      show_job: showJob,
      show_birth_date: showBirthDate,
    };
    setProfileSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update(profilePatch)
      .eq('id', currentProfile.id);
    if (error) {
      const missingMetadataColumn = (error.code === 'PGRST204' || error.code === '42703') && /city|job|birth_date|show_city|show_job|show_birth_date/i.test(error.message);
      toast.error(error.code === '23505'
        ? 'اسم المستخدم مستخدم بالفعل.'
        : missingMetadataColumn
          ? 'تعذر حفظ البيانات الجديدة. طبّق ترحيل بيانات الملف الشخصي في Supabase.'
          : 'تعذر حفظ تعديلات الملف الشخصي.');
      setProfileSaving(false);
      return;
    }

    onProfileUpdate({ ...currentProfile, ...profilePatch });
    setProfileSaving(false);
    setView('home');
    toast.success('تم تحديث الملف الشخصي.');
  };

  const toggleAccountPrivacy = async () => {
    if (!currentProfile || privacySaving || !supabaseConfigured) return;
    const isPrivate = !Boolean(currentProfile.is_private);
    setPrivacySaving(true);
    const { error } = await supabase.from('profiles').update({ is_private: isPrivate }).eq('id', currentProfile.id);
    if (error) {
      toast.error('تعذر تحديث خصوصية الحساب.');
      setPrivacySaving(false);
      return;
    }
    onProfileUpdate({ ...currentProfile, is_private: isPrivate });
    setPrivacySaving(false);
    toast.success(isPrivate ? 'أصبح الحساب خاصاً.' : 'أصبح الحساب عاماً.');
  };

  const handleSendAi = (event: FormEvent) => {
    event.preventDefault();
    if (!inputMsg.trim() || aiThinking) return;

    const userText = inputMsg.trim();
    setMessages(previous => [...previous, { id: Math.random().toString(), sender: 'user', text: userText }]);
    setInputMsg('');
    setAiThinking(true);

    window.setTimeout(() => {
      const replyText = `[وضع ${mode.toUpperCase()}]: أهلاً بك! إجابة سريعة على "${userText}": التطبيق جاهز ومربوط مع خادم التعديل المباشر.`;
      setMessages(previous => [...previous, { id: Math.random().toString(), sender: 'mulhim', text: replyText }]);
      setAiThinking(false);
    }, 800);
  };

  const openNotifications = () => {
    onClose();
    onOpenNotifications();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onClick={onClose}>
      <section
        className="flex h-[min(84dvh,680px)] w-full max-w-md flex-col overflow-hidden rounded-[28px] border border-border bg-card text-card-foreground shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        dir={currentProfile?.language_preference === 'en' ? 'ltr' : 'rtl'}
        onClick={event => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            {view !== 'home' && (
              <button
                type="button"
                aria-label="العودة إلى الإعدادات"
                onClick={() => setView('home')}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/80 transition hover:bg-foreground/10 hover:text-foreground"
              >
                <ArrowRight size={18} />
              </button>
            )}
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
              {view === 'edit' ? <UserRound size={18} /> : view === 'privacy' ? <ShieldCheck size={18} /> : view === 'appearance' ? <Palette size={18} /> : view === 'mulhim' ? <Sparkles size={18} /> : <Settings size={18} />}
            </span>
            <h2 id="settings-modal-title" className="truncate text-base font-bold">{viewTitles[view]}</h2>
          </div>
          <button
            type="button"
            aria-label="إغلاق الإعدادات"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-foreground/[0.07] hover:text-foreground"
          >
            <X size={19} />
          </button>
        </div>

        {view === 'home' && (
          <>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5">
              <div className="flex items-center gap-3 rounded-2xl border border-border bg-muted/40 p-3.5">
                <Avatar profile={currentProfile} large />
                <UserIdentity
                  name={displayName(currentProfile)}
                  username={currentProfile?.username}
                  className="min-w-0 flex-1"
                  nameClassName="text-sm font-semibold text-foreground"
                  usernameClassName="text-xs text-muted-foreground"
                />
              </div>

              <div className="overflow-hidden rounded-2xl border border-border bg-muted/30">
                <button type="button" onClick={() => setView('edit')} className="flex w-full items-center gap-3 border-b border-border px-4 py-3.5 text-right transition hover:bg-muted/60">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-400/10 text-sky-300"><UserRound size={18} /></span>
                  <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">تعديل الملف الشخصي</span><span className="mt-0.5 block text-[11px] text-muted-foreground">الاسم واسم المستخدم والنبذة</span></span>
                  <ChevronLeft size={17} className="shrink-0 text-muted-foreground/70" />
                </button>
                <button type="button" onClick={() => setView('privacy')} className="flex w-full items-center gap-3 border-b border-border px-4 py-3.5 text-right transition hover:bg-muted/60">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-300"><ShieldCheck size={18} /></span>
                  <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">الخصوصية والأمان</span><span className="mt-0.5 block text-[11px] text-muted-foreground">إدارة خصوصية حسابك</span></span>
                  <ChevronLeft size={17} className="shrink-0 text-muted-foreground/70" />
                </button>
                <button type="button" onClick={openNotifications} className="flex w-full items-center gap-3 border-b border-border px-4 py-3.5 text-right transition hover:bg-muted/60">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-400/10 text-amber-300"><Bell size={18} /></span>
                  <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">الإشعارات</span><span className="mt-0.5 block text-[11px] text-muted-foreground">عرض التنبيهات والنشاط</span></span>
                  <ChevronLeft size={17} className="shrink-0 text-muted-foreground/70" />
                </button>
                <button type="button" onClick={() => setView('appearance')} className="flex w-full items-center gap-3 px-4 py-3.5 text-right transition hover:bg-white/[0.045]">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-400/10 text-violet-300"><Palette size={18} /></span>
                  <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">المظهر</span><span className="mt-0.5 block text-[11px] text-muted-foreground">المظهر الداكن</span></span>
                  <ChevronLeft size={17} className="shrink-0 text-muted-foreground/70" />
                </button>
              </div>

              <button type="button" onClick={() => setView('mulhim')} className="flex w-full items-center gap-3 rounded-2xl border border-pink-400/10 bg-gradient-to-l from-purple-500/[0.09] to-pink-500/[0.08] px-4 py-3 text-right transition hover:border-pink-400/20">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-pink-400/10 text-pink-300"><Bot size={18} /></span>
                <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">مُلهِم آني</span><span className="mt-0.5 block text-[11px] text-muted-foreground">المساعد الذكي</span></span>
                <ChevronLeft size={17} className="shrink-0 text-muted-foreground/70" />
              </button>
            </div>
            <div className="shrink-0 border-t border-border bg-card p-4">
              <button type="button" onClick={onSignOut} className="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-red-400/15 bg-red-500/[0.12] px-4 py-3.5 text-sm font-bold text-red-600 transition hover:border-red-400/30 hover:bg-red-500/10 dark:text-red-300">
                <LogOut size={18} />
                تسجيل الخروج
              </button>
            </div>
          </>
        )}

        {view === 'edit' && (
          <form onSubmit={event => void handleSaveProfile(event)} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
              <label className="block space-y-2 text-xs font-semibold text-foreground/80">
                الاسم الظاهر
                <input value={fullName} onChange={event => setFullName(event.target.value)} maxLength={120} required className="w-full rounded-xl border border-input bg-muted/40 px-3.5 py-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/50" />
              </label>
              <label className="block space-y-2 text-xs font-semibold text-foreground/80">
                اسم المستخدم
                <div className="flex items-center rounded-xl border border-input bg-muted/40 px-3.5 focus-within:border-primary/50">
                  <span className="text-sm text-muted-foreground">@</span>
                  <input value={username} onChange={event => setUsername(event.target.value)} maxLength={32} autoCapitalize="none" autoCorrect="off" required className="w-full bg-transparent px-2 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground" />
                </div>
              </label>
              <label className="block space-y-2 text-xs font-semibold text-foreground/80">
                السيرة الذاتية
                <textarea value={bio} onChange={event => setBio(event.target.value)} rows={6} className="w-full resize-y rounded-xl border border-input bg-muted/40 px-3.5 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/50" />
              </label>
              <div className="space-y-2">
                <label htmlFor="settings-profile-job" className="block text-xs font-semibold text-foreground/80">الوظيفة</label>
                <div className="flex items-center gap-3">
                  <input id="settings-profile-job" value={job} onChange={event => setJob(event.target.value)} maxLength={120} className="min-w-0 flex-1 rounded-xl border border-input bg-muted/40 px-3.5 py-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/50" />
                  <button type="button" role="switch" aria-checked={showJob} aria-label="إظهار الوظيفة في الملف الشخصي العام" onClick={() => setShowJob(value => !value)} className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${showJob ? 'border-sky-500 bg-sky-500 text-white' : 'border-muted-foreground/50 bg-transparent text-transparent hover:border-sky-400'}`}>
                    {showJob && <Check size={14} strokeWidth={3} aria-hidden="true" />}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="settings-profile-city" className="block text-xs font-semibold text-foreground/80">المدينة</label>
                <div className="flex items-center gap-3">
                  <input id="settings-profile-city" value={city} onChange={event => setCity(event.target.value)} maxLength={100} className="min-w-0 flex-1 rounded-xl border border-input bg-muted/40 px-3.5 py-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary/50" />
                  <button type="button" role="switch" aria-checked={showCity} aria-label="إظهار المدينة في الملف الشخصي العام" onClick={() => setShowCity(value => !value)} className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${showCity ? 'border-sky-500 bg-sky-500 text-white' : 'border-muted-foreground/50 bg-transparent text-transparent hover:border-sky-400'}`}>
                    {showCity && <Check size={14} strokeWidth={3} aria-hidden="true" />}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="settings-profile-birth-date" className="block text-xs font-semibold text-foreground/80">تاريخ الميلاد</label>
                <div className="flex items-center gap-3">
                  <input id="settings-profile-birth-date" type="date" value={birthDate} onChange={event => setBirthDate(event.target.value)} max={new Date().toISOString().slice(0, 10)} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-muted/40 px-3.5 py-3 text-sm text-foreground outline-none transition focus:border-primary/50" />
                  <button type="button" role="switch" aria-checked={showBirthDate} aria-label="إظهار تاريخ الميلاد في الملف الشخصي العام" onClick={() => setShowBirthDate(value => !value)} className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${showBirthDate ? 'border-sky-500 bg-sky-500 text-white' : 'border-muted-foreground/50 bg-transparent text-transparent hover:border-sky-400'}`}>
                    {showBirthDate && <Check size={14} strokeWidth={3} aria-hidden="true" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="shrink-0 border-t border-border p-4">
              <button type="submit" disabled={profileSaving} className="w-full rounded-2xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-wait disabled:opacity-60">
                {profileSaving ? 'جارٍ الحفظ…' : 'حفظ التغييرات'}
              </button>
            </div>
          </form>
        )}

        {view === 'privacy' && (
          <div className="flex min-h-0 flex-1 flex-col px-5 py-5">
            <p className="mb-5 text-sm leading-6 text-muted-foreground">تحكم بمن يمكنه متابعة حسابك ورؤية محتواك. عند جعل الحساب خاصاً، تحتاج طلبات المتابعة إلى موافقتك.</p>
            <div className="flex items-center gap-4 rounded-2xl border border-border bg-muted/40 p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-600 dark:text-emerald-300"><ShieldCheck size={19} /></span>
              <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">حساب خاص</span><span className="mt-1 block text-xs text-muted-foreground">{currentProfile?.is_private ? 'الحساب خاص حالياً' : 'الحساب عام حالياً'}</span></span>
              <button type="button" role="switch" aria-label="حساب خاص" aria-checked={Boolean(currentProfile?.is_private)} onClick={() => void toggleAccountPrivacy()} disabled={privacySaving || !currentProfile} className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-50 ${currentProfile?.is_private ? 'bg-pink-500' : 'bg-muted-foreground/40'}`}>
                <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${currentProfile?.is_private ? 'right-1' : 'right-6'}`} />
              </button>
            </div>
            <p className="mt-4 text-[11px] leading-5 text-muted-foreground/70">يمكنك تغيير خصوصية الحساب في أي وقت. يظل محتوى الحساب العام متاحاً للجميع.</p>
          </div>
        )}

        {view === 'appearance' && (
          <div className="flex min-h-0 flex-1 flex-col px-5 py-5">
            <p className="mb-5 text-sm leading-6 text-muted-foreground">اختر شكل التطبيق المفضل لديك.</p>
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-muted/60 p-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-400/10 text-violet-600 dark:text-violet-300"><Palette size={19} /></span>
              <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">داكن</span><span className="mt-1 block text-xs text-muted-foreground">المظهر الحالي للتطبيق</span></span>
              <Check size={18} className="text-emerald-300" />
            </div>
            <p className="mt-4 text-[11px] leading-5 text-muted-foreground/70">المظهر الداكن هو المظهر المتاح حالياً.</p>
          </div>
        )}

        {view === 'mulhim' && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3">
            <div className="mb-3 flex items-center justify-between rounded-xl border border-border bg-muted/30 p-2 text-[10px]">
              <span className="px-1 font-semibold text-muted-foreground">الوضع:</span>
              <div className="flex gap-1">
                <button type="button" onClick={() => setMode('gemini')} className={`rounded-md px-2 py-1 ${mode === 'gemini' ? 'bg-purple-600 text-white font-bold' : 'text-muted-foreground'}`}>Gemini</button>
                <button type="button" onClick={() => setMode('chatgpt')} className={`rounded-md px-2 py-1 ${mode === 'chatgpt' ? 'bg-emerald-600 text-white font-bold' : 'text-muted-foreground'}`}>ChatGPT</button>
                <button type="button" onClick={() => setMode('coanalysis')} className={`rounded-md px-2 py-1 ${mode === 'coanalysis' ? 'bg-pink-600 text-white font-bold' : 'text-muted-foreground'}`}>مشترك</button>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-1 text-xs">
              {messages.map(message => (
                <div key={message.id} className={`max-w-[85%] whitespace-pre-wrap rounded-2xl p-3 leading-relaxed ${message.sender === 'user' ? 'mr-auto rounded-bl-none bg-pink-600 text-white' : 'ml-auto rounded-br-none border border-border bg-muted text-foreground'}`}>
                  {message.sender === 'mulhim' && <span className="mb-1 block text-[10px] font-bold text-pink-600 dark:text-pink-400">مُلهِم آني</span>}
                  {message.text}
                </div>
              ))}
              {aiThinking && <p className="animate-pulse px-2 text-[10px] text-muted-foreground">مُلهِم يكتب الآن...</p>}
            </div>
            <form onSubmit={handleSendAi} className="mt-2 flex gap-2 border-t border-border pt-3">
              <input value={inputMsg} onChange={event => setInputMsg(event.target.value)} placeholder="اسأل مُلهِم شيئاً..." className="min-w-0 flex-1 rounded-xl border border-input bg-muted/50 px-3 py-2.5 text-xs text-foreground outline-none focus:border-primary/50" />
              <button type="submit" disabled={aiThinking || !inputMsg.trim()} aria-label="إرسال" className="rounded-xl bg-pink-600 p-2.5 text-white transition hover:bg-pink-700 disabled:opacity-50"><SendHorizontal size={16} /></button>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
