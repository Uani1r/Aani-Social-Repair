import { useCallback, useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { Route, Router as WouterRouter, Switch } from 'wouter';

import GlobalErrorToast from '@/components/GlobalErrorToast';
import { TooltipProvider } from '@/components/ui/tooltip';
import CommentsDrawer from '@/components/CommentsDrawer';
import NotificationsModal from '@/components/NotificationsModal';
import Shell from '@/components/Shell';
import StoriesBar from '@/components/StoriesBar';
import { AuthPage } from '@/pages/AuthPage';
import FeedPage from '@/pages/FeedPage';
import MessagesPage from '@/pages/MessagesPage';
import NotFound from '@/pages/not-found';
import PostDetailPage from '@/pages/PostDetailPage';
import ProfilePage from '@/pages/ProfilePage';
import ReelsPage from '@/pages/ReelsPage';
import SearchPage from '@/pages/SearchPage';
import useAppSession from '@/hooks/useAppSession';
import { handleAppError, installSupabaseErrorInterceptor } from '@/lib/appErrors';
import { supabase } from '@/lib/supabase';
import { useInteractionRealtime } from '@/lib/interactions';
import type { StoryRow as StoryDmCardStory } from '@/components/StoryDmCard';
import '@/index.css';

installSupabaseErrorInterceptor(supabase);

function App() {
  const { authLoading, user, profile, setProfile, signOut } = useAppSession();
  useInteractionRealtime(user?.id);
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

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      if (event.error) {
        handleAppError('خطأ غير معالج في التطبيق', event.error, 'حدث خطأ غير متوقع. أعد المحاولة.');
      }
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      handleAppError('فشل إجراء غير مكتمل', event.reason, 'تعذر إتمام العملية. راجع التفاصيل التشخيصية.');
    };

    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  if (authLoading) {
    return (
      <>
        <div className="loading-screen"><div className="loading-brand">آني Aani</div></div>
        <GlobalErrorToast />
        <Toaster position="top-center" duration={10000} theme="dark" />
      </>
    );
  }

  return (
    <TooltipProvider>
      <WouterRouter base={import.meta.env.BASE_URL ? import.meta.env.BASE_URL.replace(/\/$/, '') : ''}>
        {user ? (
          <Shell
            userId={user.id}
            profile={profile}
            onSignOut={() => void signOut()}
            onOpenComments={openComments}
            onOpenStory={openNotificationStory}
            NotificationsModalComponent={NotificationsModal}
          >
            <Switch>
              <Route path="/feed">
                <FeedPage
                  userId={user.id}
                  profile={profile}
                  onOpenComments={openComments}
                  pendingStoryReshare={pendingStoryReshare}
                  onStoryReshareHandled={clearPendingStoryReshare}
                  pendingProfileStoryOwnerId={pendingProfileStoryOwnerId}
                  pendingStoryId={pendingStoryId}
                  onProfileStoryHandled={clearPendingProfileStory}
                  StoriesBarComponent={StoriesBar}
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
                  profile={profile}
                  onOpenComments={openComments}
                  pendingStoryReshare={pendingStoryReshare}
                  onStoryReshareHandled={clearPendingStoryReshare}
                  pendingProfileStoryOwnerId={pendingProfileStoryOwnerId}
                  pendingStoryId={pendingStoryId}
                  onProfileStoryHandled={clearPendingProfileStory}
                  StoriesBarComponent={StoriesBar}
                />
              </Route>
              <Route path="/reels"><ReelsPage userId={user.id} onOpenComments={openComments} /></Route>
              <Route path="/search"><SearchPage userId={user.id} /></Route>
              <Route path="/messages">
                <MessagesPage currentUserId={user.id} onReshareStory={setPendingStoryReshare} />
              </Route>
              <Route path="/messages/:userId">
                {params => (
                  <MessagesPage
                    currentUserId={user.id}
                    selectedId={params.userId}
                    onReshareStory={setPendingStoryReshare}
                  />
                )}
              </Route>
              <Route path="/profile">
                {() => (
                  <ProfilePage
                    targetUserId={user.id}
                    currentUserId={user.id}
                    profile={profile}
                    onProfileUpdate={setProfile}
                    onOpenComments={openComments}
                    onOpenStories={openProfileStories}
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
                    onOpenStories={openProfileStories}
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
          </Shell>
        ) : (
          <Switch>
            <Route path="/signup"><AuthPage mode="signup" afterAuth={() => undefined} /></Route>
            <Route path="/login"><AuthPage mode="login" afterAuth={() => undefined} /></Route>
            <Route path="/"><AuthPage mode="login" afterAuth={() => undefined} /></Route>
            <Route component={NotFound} />
          </Switch>
        )}
      </WouterRouter>
      <GlobalErrorToast />
      <Toaster position="top-center" duration={10000} theme="dark" />
    </TooltipProvider>
  );
}

export default App;
