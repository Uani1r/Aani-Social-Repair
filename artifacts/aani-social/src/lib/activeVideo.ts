/**
 * Global feed/reel playback coordinator.
 *
 * Only one feed video may play at a time. Studio, native media pickers and
 * the sound library can suspend all background media; source attributes are
 * removed by the subscribed React render so pending network/decode work stops.
 */

type ActiveVideoEntry = { id: string; element: HTMLVideoElement };

type SuspensionListener = () => void;

let active: ActiveVideoEntry | null = null;
let resumeAfterVisible = false;
let bound = false;
let playbackGeneration = 0;
let activeVideoGeneration = 0;
const suspensionReasons = new Set<string>();
const suspensionListeners = new Set<SuspensionListener>();

export function isBackgroundMediaSuspended(): boolean {
  return suspensionReasons.size > 0;
}

export function getBackgroundMediaGeneration(): number {
  return playbackGeneration;
}

export function subscribeBackgroundMediaSuspension(listener: SuspensionListener): () => void {
  suspensionListeners.add(listener);
  return () => suspensionListeners.delete(listener);
}

function notifySuspensionListeners(): void {
  suspensionListeners.forEach(listener => listener());
}

function pauseRegisteredBackgroundMedia(): void {
  if (typeof document === 'undefined') return;
  document.querySelectorAll<HTMLMediaElement>('[data-aani-background-media]').forEach(media => {
    try { media.pause(); } catch { /* detached media can reject */ }
  });
}

function hasBlockingDialog(): boolean {
  if (typeof document === 'undefined') return false;
  return Array.from(document.querySelectorAll(
    '[role="dialog"]:not([aria-hidden="true"]):not([aria-modal="false"]):not([data-state="closed"])',
  )).some(dialog => !dialog.closest('.feed-reel-viewer'));
}

/** Suspend feed/reel media synchronously before opening studio, a picker or the sound library. */
export function suspendBackgroundMedia(reason: string): void {
  if (!reason || suspensionReasons.has(reason)) return;
  const wasSuspended = isBackgroundMediaSuspended();
  suspensionReasons.add(reason);
  playbackGeneration += 1;
  if (wasSuspended) return;

  if (typeof window !== 'undefined') window.dispatchEvent(new Event('aani:pause-feed-videos'));
  pauseRegisteredBackgroundMedia();
  notifySuspensionListeners();
}

/** Release a suspension reason; media resumes only after every overlay/picker is gone. */
export function resumeBackgroundMedia(reason: string): void {
  if (!suspensionReasons.delete(reason)) return;
  playbackGeneration += 1;
  if (isBackgroundMediaSuspended()) return;

  notifySuspensionListeners();
  if (typeof window === 'undefined') return;
  window.requestAnimationFrame(() => {
    if (!isBackgroundMediaSuspended() && !hasBlockingDialog()) {
      window.dispatchEvent(new Event('aani:resume-feed-videos'));
    }
  });
}

/** Play an HTML media element only while background media is permitted. */
export function playBackgroundMedia(media: HTMLMediaElement): Promise<boolean> {
  if (isBackgroundMediaSuspended() || !media.isConnected) {
    media.pause();
    return Promise.resolve(false);
  }
  const generation = playbackGeneration;
  try {
    return media.play().then(() => {
      if (generation !== playbackGeneration || isBackgroundMediaSuspended() || !media.isConnected || media.paused) {
        media.pause();
        return false;
      }
      return true;
    }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function bindGlobalHandlers(): void {
  if (bound || typeof document === 'undefined') return;
  bound = true;
  if (typeof window !== 'undefined') {
    window.addEventListener('aani:pause-feed-videos', () => {
      activeVideoGeneration += 1;
      resumeAfterVisible = false;
      const video = active?.element;
      active = null;
      if (video) {
        try { video.pause(); } catch { /* ignore */ }
      }
    });
  }
  document.addEventListener('visibilitychange', () => {
    const video = active?.element;
    const id = active?.id;
    if (!video || !id) return;
    if (document.visibilityState === 'hidden') {
      resumeAfterVisible = !video.paused;
      try { video.pause(); } catch { /* ignore */ }
    } else if (resumeAfterVisible && video.isConnected && !isBackgroundMediaSuspended()) {
      resumeAfterVisible = false;
      playExclusive(id, video);
    } else {
      resumeAfterVisible = false;
    }
  });
}

/** Claim exclusive playback; ignored while studio/media isolation is active. */
export function claimActiveVideo(id: string, element: HTMLVideoElement): void {
  if (isBackgroundMediaSuspended()) return;
  bindGlobalHandlers();
  if (!active || active.element !== element || active.id !== id) {
    activeVideoGeneration += 1;
    if (active && active.element !== element) {
      try { active.element.pause(); } catch { /* ignore */ }
    }
  }
  active = { id, element };
}

/** Release the registration when this video leaves view or is removed. */
export function releaseActiveVideo(id: string): void {
  if (active?.id === id) {
    active = null;
    activeVideoGeneration += 1;
  }
}

/** Start exclusive playback and cancel any late play resolution after suspension or replacement. */
export function playExclusive(id: string | undefined, element: HTMLVideoElement): void {
  if (isBackgroundMediaSuspended()) {
    element.pause();
    return;
  }
  if (id) claimActiveVideo(id, element);
  const generation = playbackGeneration;
  const activeGeneration = activeVideoGeneration;
  void playBackgroundMedia(element).then(played => {
    const wasReplaced = Boolean(id)
      && (activeGeneration !== activeVideoGeneration || !active || active.id !== id || active.element !== element);
    if (wasReplaced || (!played && generation !== playbackGeneration)) {
      element.pause();
      if (id && active?.id === id && active.element === element) releaseActiveVideo(id);
    }
  });
}
