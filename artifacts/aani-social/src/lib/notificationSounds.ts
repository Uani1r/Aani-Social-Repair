let notificationAudioContext: AudioContext | null = null;

function getNotificationAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextConstructor = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  if (!notificationAudioContext || notificationAudioContext.state === 'closed') {
    notificationAudioContext = new AudioContextConstructor();
  }
  return notificationAudioContext;
}

export async function unlockNotificationAudio(): Promise<void> {
  const context = getNotificationAudioContext();
  if (context?.state === 'suspended') {
    try {
      await context.resume();
    } catch {
      // Audio playback may remain unavailable until the browser permits it.
    }
  }
}

export function playMessageChime(): void {
  const context = getNotificationAudioContext();
  if (!context) return;

  const play = () => {
    const startAt = context.currentTime + 0.025;
    [0, 0.16].forEach((offset, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = index === 0 ? 880 : 1174;
      gain.gain.setValueAtTime(0.0001, startAt + offset);
      gain.gain.exponentialRampToValueAtTime(0.055, startAt + offset + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.19);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(startAt + offset);
      oscillator.stop(startAt + offset + 0.2);
    });
  };

  if (context.state === 'suspended') {
    void context.resume().then(play).catch(() => undefined);
  } else if (context.state === 'running') {
    play();
  }
}
