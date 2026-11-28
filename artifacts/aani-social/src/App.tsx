import { useCallback, useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Toaster, toast } from 'sonner';
import { Route, Router as WouterRouter, Switch } from 'wouter';

import GlobalErrorToast from '@/components/GlobalErrorToast';
import PublishErrorPanel, { PublishErrorBadge } from '@/components/PublishErrorPanel';
import { TooltipProvider } from '@/components/ui/tooltip';
import CommentsDrawer from '@/components/CommentsDrawer';
import PasswordRecoverySheet from '@/components/PasswordRecoverySheet';
import NotificationsModal from '@/components/NotificationsModal';
import Shell from '@/components/Shell';
import StoriesBar from '@/components/StoriesBar';
import { AuthPage } from '@/pages/AuthPage';
import FeedPage from '@/pages/FeedPage';
import MessagesPage from '@/pages/MessagesPage';
import NotFound from '@/pages/not-found';
import OnboardingPage from '@/pages/OnboardingPage';
import LegalPage, { readLegalDocumentFromPath } from '@/pages/legal';
import PostDetailPage from '@/pages/PostDetailPage';
import ProfilePage from '@/pages/ProfilePage';
import AccountSettingsPage from '@/pages/AccountSettingsPage';
import ReelsPage from '@/pages/ReelsPage';
import SearchPage from '@/pages/SearchPage';
import AdminSandbox from '@/pages/AdminSandbox';
import FounderPanel from '@/features/core-accounts/components/FounderPanel';
import AdminDashboard from '@/features/core-accounts/components/AdminDashboard';
import OfficialComposer from '@/features/core-accounts/components/OfficialComposer';
import useAppSession from '@/hooks/useAppSession';
import useMfaGate from '@/hooks/useMfaGate';
import MfaChallengePage from '@/pages/MfaChallengePage';
import { useModalBodyScrollLock } from '@/hooks/useModalBodyScrollLock';
import { useInteractionRealtime } from '@/lib/interactions';
import type { StoryRow as StoryDmCardStory } from '@/components/StoryDmCard';
import { readLocalUserPreferences, saveLocalUserPreferences, userPreferencesFromProfile } from '@/lib/userPreferences';
import { applyFontPreference, readLocalFontPreference, resolveFontPreference } from '@/lib/fontPreferences';
import { AUTH_GATE_MESSAGES, resolveAuthGate } from '@/lib/authGate';
import { fullNameFromProvider, onboardingIsComplete, suggestedUsernameFromProvider } from '@/lib/onboarding';
import { PROFILE_COMPLETION_MESSAGES } from '@/lib/profileCompletion';
import '@/index.css';

/**
 * شاشة فشل تحميل الملف الشخصي: لا يُفتح التطبيق ولا يُعدّ الغياب اكتمالاً.
 * إعادة المحاولة تعيد الجلب من قاعدة البيانات، وتسجيل الخروج يخرج من الحساب.
 */
function ProfileLoadErrorScreen({ message, onRetry, onSignOut }: { message: string; onRetry: () => void; onSignOut: () => void }) {
  return (
    <div dir="rtl" className="loading-screen" role="alert" style={{ padding: '24px', textAlign: 'center', lineHeight: 1.9 }}>
      <div className="loading-brand">آني Aani</div>
      <p style={{ marginTop: '16px' }}>{message}</p>
      <button type="button" style={{ marginTop: '12px', padding: '12px 20px' }} onClick={onRetry}>
        {AUTH_GATE_MESSAGES.retry}
      </button>
      <button type="button" style={{ marginTop: '10px', padding: '12px 20px' }} onClick={onSignOut}>
        {AUTH_GATE_MESSAGES.signOut}
      </button>
    </div>
  );
}

function App() {
  useModalBodyScrollLock();
  const {
    authLoading,
    authResolved,
    user,
    profile,
    setProfile,
    signOut,
    passwordRecovery,
    clearPasswordRecovery,
    profileState,
    onboarding,
    reloadProfile,
  } = useAppSession();

  // تسجيل الخروج يُلغي رمز هذا الجهاز أولاً ثم ينهي الجلسة. فشل الإلغاء لا
  // يُعرض كنجاح: تُبقى الجلسة قائمة وتظهر رسالة الفشل كي يُعاد المحاولة.
  const handleSignOut = useCallback(async () => {
    const outcome = await signOut();
    if (!outcome.ok) toast.error(outcome.message);
  }, [signOut]);
  const { setTheme, resolvedTheme } = useTheme();
  useInteractionRealtime(user?.id);
  // فرض التحقق بخطوتين: لا يُعرض التطبيق ولا محتواه قبل aal2 لمن فعّلها،
  // أياً كانت طريقة الدخول (بريد، اسم مستخدم، هاتف، Google أو Apple).
  const mfaGate = useMfaGate(user?.id);
  const mfaFactorId = mfaGate.state.factors
    .find(factor => factor.factorType === 'totp' && factor.status === 'verified')?.id ?? '';

  useEffect(() => {
    const root = document.documentElement;
    if (!user?.id) {
      applyFontPreference(readLocalFontPreference());
      setTheme('dark');
      root.lang = 'ar';
      root.dir = 'rtl';
      return;
    }
    const preferences = userPreferencesFromProfile(profile, readLocalUserPreferences(user.id));
    saveLocalUserPreferences(user.id, preferences);
    applyFontPreference(resolveFontPreference(profile?.font_preference, readLocalFontPreference()));
    setTheme(preferences.appearance);
    root.lang = preferences.language;
    root.dir = preferences.language === 'ar' ? 'rtl' : 'ltr';
  }, [user?.id, profile?.notification_settings, profile?.appearance_preference, profile?.language_preference, profile?.hd_uploads, profile?.data_saver, profile?.font_preference, setTheme]);
  const [selectedPostForComments, setSelectedPostForComments] = useState<string | null>(null);
  const [selectedCommentIdForComments, setSelectedCommentIdForComments] = useState<string | null>(null);
  const openComments = useCallback((postId: string, commentId?: string) => {
    setSelectedPostForComments(postId);
    setSelectedCommentIdForComments(commentId || null);
  }, []);
  const [pendingStoryReshare, setPendingStoryReshare] = useState<StoryDmCardStory | null>(null);
  const clearPendingStoryReshare = useCallback(() => setPendingStoryReshare(null), []);
  const [pendingProfileStoryOwnerId, setPendingProfileStoryOwnerId] = useState<string | null>(null);
  const [pendingStoryId, setPendingStoryId] = useState<string | null>(null);
  const clearPendingProfileStory = useCallback(() => {
    setPendingProfileStoryOwnerId(null);
    setPendingStoryId(null);
  }, []);
  const openNotificationStory = useCallback((storyId: string, ownerId: string) => {
    setPendingStoryId(storyId);
    setPendingProfileStoryOwnerId(ownerId);
  }, []);
  const openProfileStories = useCallback((ownerId: string) => {
    setPendingStoryId(null);
    setPendingProfileStoryOwnerId(ownerId);
  }, []);

  // فتح قصص الملف الشخصي من حلقته داخل ProfilePage عبر نفس مسار pending
  // الذي يستخدمه شريط القصص — لا حالة عارض مستقلة.
  useEffect(() => {
    const handleOpenProfileStories = (event: Event) => {
      const ownerId = (event as CustomEvent<{ ownerId?: unknown }>).detail?.ownerId;
      if (typeof ownerId === 'string' && ownerId) openProfileStories(ownerId);
    };
    window.addEventListener('aani:open-profile-stories', handleOpenProfileStories);
    return () => window.removeEventListener('aani:open-profile-stories', handleOpenProfileStories);
  }, [openProfileStories]);

  useEffect(() => {
    const preventNativeTextSelection = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
      event.preventDefault();
    };
    document.addEventListener('selectstart', preventNativeTextSelection, true);
    return () => document.removeEventListener('selectstart', preventNativeTextSelection, true);
  }, []);

  /**
   * بعد حفظ إكمال التسجيل: يُعاد تحميل الملف من Supabase، ولا يُنقل المستخدم
   * إلى /feed إلا بعد نجاح التحقق (ملف محمّل وحالة إكمال مؤكدة).
   */
  const handleOnboardingCompleted = useCallback(async () => {
    const outcome = await reloadProfile();
    if (outcome.profileState === 'ready' && outcome.onboardingComplete) return { ok: true };
    return {
      ok: false,
      message: outcome.profileState === 'failed'
        ? AUTH_GATE_MESSAGES.profileLoadFailed
        : PROFILE_COMPLETION_MESSAGES.verifyFailed,
    };
  }, [reloadProfile]);

  // إكمال التسجيل يُقاس من قاعدة البيانات وحدها.
  const onboardingComplete = onboardingIsComplete(onboarding);

  // شاشات الشروط والخصوصية عامة: تُخدم قبل بوابة الجلسة وقبل الإكمال،
  // والرابط في نموذج الموافقة يفتح صفحة موجودة فعلاً.
  const legalDocument = readLegalDocumentFromPath(typeof window === 'undefined' ? '' : window.location.pathname);

  // شاشة الانتظار تُعرض حتى تُحسم حالة الجلسة فعلياً — مهلة 2500ms تحرر
  // حالة التحميل فقط، ولا تُحوّل الحالة غير المحسومة إلى "غير مسجل" ولا
  // تعرض تسجيل الدخول قبل تأكيد غياب الجلسة (الجلسة المتأخرة تُطبَّق فور
  // وصولها والواجهة تنتقل إليها مباشرة).
  if (authLoading || !authResolved || (user && mfaGate.state.status === 'resolving')) {
    return (
      <>
        <div className="loading-screen"><div className="loading-brand">آني Aani</div></div>
        <GlobalErrorToast />
        <Toaster position="top-center" duration={10000} theme={resolvedTheme === 'light' ? 'light' : 'dark'} />
      </>
    );
  }

  if (legalDocument) {
    return (
      <>
        <LegalPage kind={legalDocument} onBack={() => window.location.assign('/')} />
        <Toaster position="top-center" duration={10000} theme={resolvedTheme === 'light' ? 'light' : 'dark'} />
      </>
    );
  }

  // بوابة واحدة: انتظار، تسجيل دخول، فشل ملف، إكمال تسجيل، ثم التطبيق.
  const gate = resolveAuthGate({
    authLoading,
    authResolved,
    hasUser: Boolean(user),
    profileState,
    onboardingComplete,
  });

  return (
    <TooltipProvider>
      <WouterRouter base={import.meta.env.BASE_URL ? import.meta.env.BASE_URL.replace(/\/$/, '') : ''}>
        {gate === 'loading' ? (
          <div className="loading-screen"><div className="loading-brand">آني Aani</div></div>
        ) : gate === 'signin' ? (
          <Switch>
            <Route path="/signup"><AuthPage mode="signup" afterAuth={() => undefined} /></Route>
            <Route path="/login"><AuthPage mode="login" afterAuth={() => undefined} /></Route>
            <Route path="/"><AuthPage mode="login" afterAuth={() => undefined} /></Route>
            <Route component={NotFound} />
          </Switch>
        ) : gate === 'profile_error' ? (
          <ProfileLoadErrorScreen
            message={AUTH_GATE_MESSAGES.profileLoadFailed}
            onRetry={() => void reloadProfile()}
            onSignOut={() => void handleSignOut()}
          />
        ) : !user ? (
          <div className="loading-screen"><div className="loading-brand">آني Aani</div></div>
        ) : mfaGate.state.status === 'blocked' && mfaFactorId ? (
          <MfaChallengePage
            factorId={mfaFactorId}
            onVerified={() => void mfaGate.refresh()}
            onSignOut={() => void handleSignOut()}
          />
        ) : mfaGate.state.status === 'blocked' || mfaGate.state.status === 'unavailable' ? (
          <div className="loading-screen" role="alert" style={{ direction: 'rtl', padding: '24px', textAlign: 'center' }}>
            <div className="loading-brand">آني Aani</div>
            <p style={{ marginTop: '16px', lineHeight: 1.8 }}>{mfaGate.state.message}</p>
            <button type="button" style={{ marginTop: '12px', padding: '12px 20px' }} onClick={() => void handleSignOut()}>
              تسجيل الخروج
            </button>
          </div>
        ) : gate === 'onboarding' ? (
          // مستخدم غير مكتمل (Google جديد أو ملف غائب): واجهة الإكمال وحدها،
          // بلا Shell وبلا أي صفحة داخلية، ولو كان العنوان /feed.
          <OnboardingPage
            profile={profile}
            userId={user.id}
            providerFullName={fullNameFromProvider(user)}
            suggestedUsername={suggestedUsernameFromProvider(user)}
            onCompleted={handleOnboardingCompleted}
            onSignOut={() => void handleSignOut()}
          />
        ) : (
          <Shell
            userId={user.id}
            profile={profile}
            onProfileUpdate={setProfile}
            onSignOut={() => void handleSignOut()}
            onOpenComments={openComments}
            onOpenStory={openNotificationStory}
            NotificationsModalComponent={NotificationsModal}
            headerStories={
              <StoriesBar
                key={user.id}
                userId={user.id}
                currentProfile={profile}
                pendingReshare={pendingStoryReshare}
                onReshareHandled={clearPendingStoryReshare}
                pendingProfileStoryOwnerId={pendingProfileStoryOwnerId}
                pendingStoryId={pendingStoryId}
                onProfileStoryHandled={clearPendingProfileStory}
              />
            }
          >
            <Switch>
              <Route path="/feed">
                <FeedPage
                  userId={user.id}
                  onOpenComments={openComments}
                />
              </Route>
              <Route path="/post/:postId">
                {params => (
                  <PostDetailPage
                    postId={params.postId}
                    currentUserId={user.id}
                    onOpenComments={openComments}
                  />
                )}
              </Route>
              <Route path="/">
                <FeedPage
                  userId={user.id}
                  onOpenComments={openComments}
                />
              </Route>
              <Route path="/reels"><ReelsPage userId={user.id} onOpenComments={openComments} /></Route>
              <Route path="/search"><SearchPage userId={user.id} /></Route>
              <Route path="/messages">
                <MessagesPage currentUserId={user.id} onReshareStory={setPendingStoryReshare} onOpenStories={openProfileStories} onOpenStory={openNotificationStory} />
              </Route>
              <Route path="/messages/:userId">
                {params => (
                  <MessagesPage
                    currentUserId={user.id}
                    selectedId={params.userId}
                    onReshareStory={setPendingStoryReshare}
                    onOpenStories={openProfileStories}
                    onOpenStory={openNotificationStory}
                  />
                )}
              </Route>
              <Route path="/admin/sandbox"><AdminSandbox key={user.id} /></Route>
              <Route path="/core/founder"><FounderPanel key={user.id} /></Route>
              <Route path="/core/admin"><AdminDashboard key={user.id} /></Route>
              <Route path="/core/official"><OfficialComposer key={user.id} /></Route>
              <Route path="/settings/account"><AccountSettingsPage /></Route>
              <Route path="/profile">
                {() => (
                  <ProfilePage
                    targetUserId={user.id}
                    currentUserId={user.id}
                    profile={profile}
                    onProfileUpdate={setProfile}
                    onOpenComments={openComments}
                  />
                )}
              </Route>
              <Route path="/profile/:userId">
                {params => (
                  <ProfilePage
                    key={params.userId}
                    targetUserId={params.userId}
                    currentUserId={user.id}
                    profile={profile}
                    onProfileUpdate={setProfile}
                    onOpenComments={openComments}
                  />
                )}
              </Route>
              <Route component={NotFound} />
            </Switch>

            {selectedPostForComments && (
              <CommentsDrawer
                postId={selectedPostForComments}
                currentUserId={user.id}
                isOpen={Boolean(selectedPostForComments)}
                initialCommentId={selectedCommentIdForComments}
                onClose={() => {
                  setSelectedPostForComments(null);
                  setSelectedCommentIdForComments(null);
                }}
              />
            )}

            {/* رابط استعادة كلمة المرور من البريد: تعيين الكلمة بلا تسجيل خروج. */}
            {passwordRecovery && (
              <PasswordRecoverySheet
                open
                onClose={clearPasswordRecovery}
                onSaved={clearPasswordRecovery}
              />
            )}
          </Shell>
        )}
      </WouterRouter>
      <GlobalErrorToast />
      {/* تشخيص فشل النشر في الإنتاج: زر يظهر بعد أول فشل، ولوحة تفاصيل مع نسخ. */}
      <PublishErrorBadge />
      <PublishErrorPanel />
      <Toaster position="top-center" duration={10000} theme={resolvedTheme === 'light' ? 'light' : 'dark'} />
    </TooltipProvider>
  );
}

export default App;
