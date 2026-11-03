import { useCallback, useState } from 'react';
import { Route, Router as WouterRouter, Switch } from 'wouter';

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
import type { StoryRow as StoryDmCardStory } from '@/components/StoryDmCard';
import '@/index.css';

function App() {
  const { authLoading, user, profile, setProfile, signOut } = useAppSession();
  const [selectedPostForComments, setSelectedPostForComments] = useState<string | null>(null);
  const [pendingStoryReshare, setPendingStoryReshare] = useState<StoryDmCardStory | null>(null);
  const clearPendingStoryReshare = useCallback(() => setPendingStoryReshare(null), []);
  const [pendingProfileStoryOwnerId, setPendingProfileStoryOwnerId] = useState<string | null>(null);
  const clearPendingProfileStory = useCallback(() => setPendingProfileStoryOwnerId(null), []);

  if (authLoading) return <div className="loading-screen"><div className="loading-brand">آني Aani</div></div>;

  return (
    <TooltipProvider>
      <WouterRouter base={import.meta.env.BASE_URL ? import.meta.env.BASE_URL.replace(/\/$/, '') : ''}>
        {user ? (
          <Shell
            userId={user.id}
            profile={profile}
            onSignOut={() => void signOut()}
            onOpenComments={id => setSelectedPostForComments(id)}
            NotificationsModalComponent={NotificationsModal}
          >
            <Switch>
              <Route path="/feed">
                <FeedPage
                  userId={user.id}
                  profile={profile}
                  onOpenComments={id => setSelectedPostForComments(id)}
                  pendingStoryReshare={pendingStoryReshare}
                  onStoryReshareHandled={clearPendingStoryReshare}
                  pendingProfileStoryOwnerId={pendingProfileStoryOwnerId}
                  onProfileStoryHandled={clearPendingProfileStory}
                  StoriesBarComponent={StoriesBar}
                />
              </Route>
              <Route path="/post/:postId">
                {params => (
                  <PostDetailPage
                    postId={params.postId}
                    currentUserId={user.id}
                    onOpenComments={id => setSelectedPostForComments(id)}
                  />
                )}
              </Route>
              <Route path="/">
                <FeedPage
                  userId={user.id}
                  profile={profile}
                  onOpenComments={id => setSelectedPostForComments(id)}
                  pendingStoryReshare={pendingStoryReshare}
                  onStoryReshareHandled={clearPendingStoryReshare}
                  pendingProfileStoryOwnerId={pendingProfileStoryOwnerId}
                  onProfileStoryHandled={clearPendingProfileStory}
                  StoriesBarComponent={StoriesBar}
                />
              </Route>
              <Route path="/reels"><ReelsPage userId={user.id} /></Route>
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
                    onOpenComments={id => setSelectedPostForComments(id)}
                    onOpenStories={setPendingProfileStoryOwnerId}
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
                    onOpenComments={id => setSelectedPostForComments(id)}
                    onOpenStories={setPendingProfileStoryOwnerId}
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
                onClose={() => setSelectedPostForComments(null)}
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
    </TooltipProvider>
  );
}

export default App;
