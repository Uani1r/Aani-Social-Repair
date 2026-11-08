import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Mic, MicOff, Phone, PhoneOff, Video, VideoOff, Volume2, VolumeX, X } from 'lucide-react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { toast } from 'sonner';

import { supabase } from '@/lib/supabase';
import { displayName, type Profile } from '@/lib/types';

export const OPEN_CALL_PICKER_EVENT = 'aani:open-call-picker';

export function openCallPicker(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_CALL_PICKER_EVENT));
}

type CallMode = 'audio' | 'video';
type CallPhase = 'outgoing' | 'incoming' | 'active';
type CallTerminalStatus = 'declined' | 'no-answer' | 'busy';
type CallSignalType = 'offer' | 'answer' | 'ice-candidate' | 'hangup' | 'decline-call' | 'ringing-ack' | 'busy-call';

type CallPeer = {
  id: string;
  name: string;
  username: string;
  avatarUrl: string | null;
};

type CallUiState = {
  callId: string;
  phase: CallPhase;
  mode: CallMode;
  peer: CallPeer;
  offer: RTCSessionDescriptionInit | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  speakerOn: boolean;
  ringing: boolean;
  accepting: boolean;
  dismissing: boolean;
  terminalStatus: CallTerminalStatus | null;
  accepted: boolean;
  startedAt: number | null;
};

type CallSignal = {
  type: CallSignalType;
  callId: string;
  from: string;
  to: string;
  mode?: CallMode;
  name?: string;
  username?: string;
  avatarUrl?: string | null;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  reason?: string;
  renegotiate?: boolean;
};

type OutgoingCallSignal = Omit<CallSignal, 'from' | 'to'> & { to: string };

const CALL_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const CALL_STYLES = `
.aani-call-layer{position:fixed;inset:0;z-index:12000;color:#fff;font-family:inherit;direction:rtl}
.aani-call-backdrop{position:absolute;inset:0;background:rgba(4,7,12,.65);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);animation:aani-call-fade-in .18s ease both}
.aani-call-sheet-wrap{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;padding:12px 12px max(12px,env(safe-area-inset-bottom));}
.aani-call-sheet{position:relative;width:min(100%,440px);padding:12px 16px 18px;border:1px solid rgba(255,255,255,.14);border-radius:24px;background:rgba(28,32,39,.86);box-shadow:0 24px 80px rgba(0,0,0,.4);backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px);animation:aani-call-sheet-in .22s cubic-bezier(.2,.75,.25,1) both}
.aani-call-sheet-handle{width:38px;height:4px;margin:0 auto 13px;border-radius:99px;background:rgba(255,255,255,.36);touch-action:none}
.aani-call-sheet-title{margin:0 36px 12px 0;text-align:center;font-size:16px;font-weight:700;}
.aani-call-sheet-close{position:absolute;top:14px;right:14px;width:34px;height:34px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.1);border-radius:50%;background:rgba(255,255,255,.08);color:#fff}
.aani-call-options{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.aani-call-option{min-height:86px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border:1px solid rgba(255,255,255,.1);border-radius:18px;background:rgba(255,255,255,.055);color:#fff;font:inherit;font-size:14px;font-weight:600;transition:background .16s,border-color .16s,transform .16s}
.aani-call-option:active{transform:scale(.98);background:rgba(255,255,255,.11)}
.aani-call-option-icon{width:38px;height:38px;display:grid;place-items:center;border-radius:50%;background:rgba(255,255,255,.1)}
.aani-call-overlay{position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:calc(30px + env(safe-area-inset-top)) 22px calc(30px + env(safe-area-inset-bottom));background:rgba(7,10,16,.78);backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px);animation:aani-call-fade-in .2s ease both}
.aani-call-overlay-video{background:#080a0d}
.aani-call-layer-outgoing,.aani-call-layer-incoming{z-index:9999}
.aani-call-overlay-outgoing{justify-content:center;padding:0;background:rgba(5,5,8,.88);backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%)}
.aani-call-overlay-incoming{justify-content:center;padding:0;background:rgba(5,5,8,.85);backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%)}
.aani-call-overlay-dismissing{animation:aani-call-dismiss .25s ease forwards}
.aani-call-overlay-terminal-dismissing{animation:aani-call-terminal-dismiss .6s ease forwards}
.aani-call-outgoing-content,.aani-call-incoming-content{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;gap:25px;text-align:center}
.aani-call-outgoing-avatar-wrap{position:relative;z-index:1;width:110px;height:110px;display:grid;place-items:center;border-radius:50%;animation:aani-call-intense-glow 3s ease-in-out infinite}
.aani-call-outgoing-avatar-wrap.is-red-glow{animation:aani-call-red-glow 1.8s ease-in-out infinite}
.aani-call-outgoing-avatar-wrap.is-red-glow .aani-call-avatar-outgoing{border-color:rgba(255,59,48,.5);box-shadow:inset 0 0 20px rgba(255,59,48,.08),0 0 18px rgba(255,59,48,.2)}
.aani-call-avatar-outgoing{position:relative;width:110px;height:110px;border:2px solid rgba(255,255,255,.4);box-shadow:inset 0 0 20px rgba(255,255,255,.15),0 15px 35px rgba(0,0,0,.8),0 5px 15px rgba(0,0,0,.6),0 0 10px rgba(255,255,255,.2)}
.aani-call-avatar-outgoing::after{content:'';position:absolute;inset:0;border-radius:50%;background:linear-gradient(135deg,rgba(255,255,255,.4) 0%,rgba(255,255,255,0) 50%);pointer-events:none}
.aani-call-person{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;margin-top:-22px}
.aani-call-person-outgoing,.aani-call-person-incoming{gap:25px;margin:0}
.aani-call-avatar{width:132px;height:132px;display:grid;place-items:center;overflow:hidden;border:1px solid rgba(255,255,255,.22);border-radius:50%;background:linear-gradient(145deg,#394654,#171c24);box-shadow:0 12px 50px rgba(0,0,0,.3);font-size:44px;font-weight:700}
.aani-call-avatar-outgoing{width:110px;height:110px;border:2px solid rgba(255,255,255,.4);font-size:36px;box-shadow:inset 0 0 20px rgba(255,255,255,.15),0 15px 35px rgba(0,0,0,.8),0 5px 15px rgba(0,0,0,.6),0 0 10px rgba(255,255,255,.2)}
.aani-call-avatar-incoming{border:2px solid rgba(255,255,255,.5)}
.aani-call-avatar img{width:100%;height:100%;object-fit:cover}
.aani-call-avatar-outgoing img{filter:grayscale(1)}
.aani-call-name{margin:12px 0 0;font-size:25px;font-weight:700}
.aani-call-name-outgoing,.aani-call-name-incoming{margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-.3px;text-shadow:0 2px 10px rgba(0,0,0,.8)}
.aani-call-status{margin:0;color:rgba(255,255,255,.76);font-size:15px}
.aani-call-status-outgoing,.aani-call-status-incoming{display:flex;align-items:center;gap:2px;color:#bbb;font-size:16px;font-weight:400}
.aani-call-status-connecting{color:#fff}
.aani-call-status-terminal{font-weight:500}
.aani-call-status-terminal-declined{color:#ff3b30}
.aani-call-status-terminal-no-answer,.aani-call-status-terminal-busy{color:#bbb}
.aani-call-dots span{animation:aani-call-dot-blink 1.4s infinite both}
.aani-call-dots span:nth-child(2){animation-delay:.2s}
.aani-call-dots span:nth-child(3){animation-delay:.4s}
.aani-call-timer{margin-top:4px;font-variant-numeric:tabular-nums;font-size:15px;color:rgba(255,255,255,.84)}
.aani-call-close{position:absolute;top:calc(16px + env(safe-area-inset-top));right:18px;z-index:4;width:40px;height:40px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.14);border-radius:50%;background:rgba(255,255,255,.1);color:#fff}
.aani-call-remote-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#111}
.aani-call-video-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.38),transparent 28%,transparent 65%,rgba(0,0,0,.62));pointer-events:none}
.aani-call-local-video{position:absolute;z-index:3;top:calc(18px + env(safe-area-inset-top));left:18px;width:min(30vw,126px);aspect-ratio:3/4;object-fit:cover;border:1px solid rgba(255,255,255,.45);border-radius:18px;background:#20242a;box-shadow:0 8px 28px rgba(0,0,0,.35)}
.aani-call-controls{position:absolute;z-index:3;bottom:calc(34px + env(safe-area-inset-bottom));left:0;right:0;display:flex;align-items:center;justify-content:center;gap:18px}
.aani-call-controls.aani-call-controls-fading{opacity:0;transform:translate(-50%,20px);transition:opacity .35s ease,transform .35s ease;pointer-events:none}
.aani-call-controls-outgoing{left:50%;right:auto;bottom:40px;display:inline-flex;width:max-content;gap:20px;padding:10px 24px;transform:translateX(-50%);border:1px solid rgba(255,255,255,.12);border-radius:100px;background:rgba(255,255,255,.08);box-shadow:0 8px 32px rgba(0,0,0,.45);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%)}
.aani-call-controls-incoming{left:50%;right:auto;bottom:40px;display:inline-flex;width:max-content;gap:20px;padding:10px 24px;transform:translateX(-50%);direction:ltr;border:1px solid rgba(255,255,255,.12);border-radius:100px;background:rgba(255,255,255,.08);box-shadow:0 8px 32px rgba(0,0,0,.45);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%)}
.aani-call-controls-incoming.is-accepting,.aani-call-controls-incoming.is-dismissing{pointer-events:none;opacity:.6}
.aani-call-control{width:58px;height:58px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.16);border-radius:50%;background:rgba(255,255,255,.16);color:#fff;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);transition:transform .2s ease,background .2s ease,filter .2s ease}
.aani-call-control-label{position:absolute;top:64px;white-space:nowrap;font-size:12px;color:rgba(255,255,255,.82)}
.aani-call-control-wrap{position:relative;display:flex;justify-content:center}
.aani-call-control.is-active{background:rgba(255,255,255,.28)}
.aani-call-control.is-end{width:66px;height:66px;border:0;background:#e5484d;transform:rotate(135deg)}
.aani-call-control.is-accept{width:66px;height:66px;border:0;background:#24a86a;transform:rotate(0)}
.aani-call-control.is-reject{width:66px;height:66px;border:0;background:#e5484d;transform:rotate(135deg)}
.aani-call-control-incoming{width:56px;height:56px;min-width:56px;min-height:56px;border:0;backdrop-filter:none;-webkit-backdrop-filter:none}
.aani-call-control-incoming.is-reject{background:#ff3b30;box-shadow:0 4px 16px rgba(255,59,48,.4);transform:none}
.aani-call-control-incoming.is-reject svg{transform:rotate(135deg)}
.aani-call-control-incoming.is-accept{background:#34c759;box-shadow:0 4px 16px rgba(52,199,89,.4);transform:none}
.aani-call-control-incoming.is-accept svg{transform:rotate(0)}
.aani-call-control-incoming:active{transform:scale(.92)}
.aani-call-control-incoming.is-reject:active,.aani-call-control-incoming.is-accept:active{transform:scale(.92)}
.aani-call-control-outgoing{position:relative;width:56px;height:56px;min-width:56px;min-height:56px;border:0;background:rgba(255,255,255,.15);color:#fff;backdrop-filter:none;-webkit-backdrop-filter:none}
.aani-call-control-outgoing:active{transform:scale(.92)}
.aani-call-control-outgoing.is-muted{background:rgba(255,255,255,.25);color:#ff3b30}
.aani-call-control-outgoing.is-muted::after{content:'';position:absolute;width:30px;height:2.5px;border-radius:2px;background:#ff3b30;transform:rotate(-45deg);box-shadow:0 0 4px rgba(0,0,0,.5)}
.aani-call-control-outgoing.is-end{width:56px;height:56px;min-width:56px;min-height:56px;background:#ff3b30;color:#fff;box-shadow:0 4px 16px rgba(255,59,48,.4);transform:none}
.aani-call-control-outgoing.is-end:active{filter:brightness(.85);transform:scale(.92)}
.aani-call-control-outgoing.is-end svg{transform:rotate(135deg)}
.aani-call-actions-note{position:absolute;bottom:calc(116px + env(safe-area-inset-bottom));z-index:2;color:rgba(255,255,255,.76);font-size:14px;text-align:center}
@keyframes aani-call-fade-in{from{opacity:0}to{opacity:1}}
@keyframes aani-call-sheet-in{from{opacity:.7;transform:translateY(26px)}to{opacity:1;transform:translateY(0)}}
@keyframes aani-call-intense-glow{0%,100%{box-shadow:0 0 20px 2px rgba(255,255,255,.4),0 0 50px 10px rgba(255,255,255,.1);background:radial-gradient(circle,rgba(255,255,255,.08) 0%,rgba(255,255,255,0) 70%)}50%{box-shadow:0 0 30px 5px rgba(255,255,255,.8),0 0 80px 20px rgba(255,255,255,.4),0 0 150px 40px rgba(255,255,255,.15);background:radial-gradient(circle,rgba(255,255,255,.2) 0%,rgba(255,255,255,0) 70%)}}
@keyframes aani-call-dot-blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
@keyframes aani-call-dismiss{to{opacity:0;transform:scale(.96)}}
@keyframes aani-call-terminal-dismiss{to{opacity:0;transform:scale(.96)}}
@keyframes aani-call-red-glow{0%,100%{box-shadow:0 0 18px 3px rgba(255,59,48,.18),0 0 42px 8px rgba(255,59,48,.08)}50%{box-shadow:0 0 27px 5px rgba(255,59,48,.42),0 0 70px 16px rgba(255,59,48,.18)}}
@media(min-width:700px){.aani-call-sheet-wrap{align-items:center}.aani-call-overlay{padding-left:40px;padding-right:40px}.aani-call-controls{gap:24px}.aani-call-overlay-outgoing,.aani-call-overlay-incoming{padding:0}.aani-call-controls-outgoing,.aani-call-controls-incoming{gap:20px}}
.aani-call-overlay-active-audio{background:rgba(5,5,8,.90);backdrop-filter:blur(35px) saturate(150%);-webkit-backdrop-filter:blur(35px) saturate(150%)}
.aani-call-avatar-active{width:110px;height:110px;border:2px solid rgba(255,255,255,.4);font-size:36px;box-shadow:0 0 18px rgba(255,255,255,.14);animation:aani-call-calm-glow 4s ease-in-out infinite}
.aani-call-overlay-active-audio .aani-call-name{font-size:20px}
.aani-call-timer-active{color:#34c759;font-size:17px;font-weight:600;animation:aani-call-timer-pulse 1.8s ease-in-out infinite}
.aani-call-controls-active{left:50%;right:auto;bottom:calc(40px + env(safe-area-inset-bottom));display:inline-flex;width:max-content;max-width:calc(100% - 24px);gap:10px;padding:10px 14px;transform:translateX(-50%);border:1px solid rgba(255,255,255,.12);border-radius:100px;background:rgba(255,255,255,.08);box-shadow:0 8px 32px rgba(0,0,0,.35);backdrop-filter:blur(20px) saturate(150%);-webkit-backdrop-filter:blur(20px) saturate(150%)}
.aani-call-controls-active .aani-call-control{width:52px;height:52px;min-width:52px;min-height:52px}
.aani-call-controls-active .aani-call-control.is-end{background:#ff3b30;color:#fff;border:0;transform:none}
.aani-call-controls-active .aani-call-control.is-end svg{transform:none}
.aani-call-controls-active .aani-call-control.is-end:active{transform:scale(.92)}
.aani-call-controls-active .aani-call-control.is-muted{position:relative;color:#ff3b30}
.aani-call-controls-active .aani-call-control.is-muted::after{content:'';position:absolute;width:28px;height:2px;border-radius:2px;background:#ff3b30;transform:rotate(-45deg);box-shadow:0 0 4px rgba(0,0,0,.55)}
.aani-call-local-video-audio{top:auto;left:auto;right:18px;bottom:calc(112px + env(safe-area-inset-bottom));width:min(28vw,112px);aspect-ratio:3/4}
@keyframes aani-call-calm-glow{0%,100%{box-shadow:0 0 14px 2px rgba(255,255,255,.12),0 0 34px 5px rgba(255,255,255,.05)}50%{box-shadow:0 0 25px 4px rgba(255,255,255,.28),0 0 60px 12px rgba(255,255,255,.1)}}
@keyframes aani-call-timer-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.82;transform:scale(1.035)}}
@media(max-width:360px){.aani-call-controls-active{gap:6px;padding:9px 10px}.aani-call-controls-active .aani-call-control{width:48px;height:48px;min-width:48px;min-height:48px}}
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCallSignal(value: unknown): value is CallSignal {
  if (!isRecord(value)
    || typeof value.callId !== 'string'
    || value.callId.length > 160
    || typeof value.from !== 'string'
    || typeof value.to !== 'string') return false;
  if (value.type === 'offer' || value.type === 'answer') {
    return isRecord(value.description)
      && value.description.type === value.type
      && typeof value.description.sdp === 'string'
      && value.description.sdp.length <= 200_000
      && (value.type !== 'offer' || value.renegotiate === true || value.mode === 'audio' || value.mode === 'video')
      && (value.renegotiate === undefined || typeof value.renegotiate === 'boolean');
  }
  if (value.type === 'ice-candidate') {
    return isRecord(value.candidate)
      && typeof value.candidate.candidate === 'string'
      && (value.renegotiate === undefined || typeof value.renegotiate === 'boolean');
  }
  if (value.type === 'ringing-ack' || value.type === 'busy-call') return true;
  return (value.type === 'hangup' || value.type === 'decline-call')
    && (value.reason === undefined || typeof value.reason === 'string');
}

function safeAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function makePeerFromProfile(profile: Profile): CallPeer {
  return {
    id: profile.id,
    name: displayName(profile),
    username: profile.username || '',
    avatarUrl: safeAvatarUrl(profile.avatar_url),
  };
}

function makePeerFromSignal(signal: CallSignal): CallPeer {
  const username = typeof signal.username === 'string' ? signal.username.trim().slice(0, 40) : '';
  const name = typeof signal.name === 'string' ? signal.name.trim().slice(0, 80) : '';
  return {
    id: signal.from,
    name: name || username || 'مستخدم آني',
    username,
    avatarUrl: safeAvatarUrl(signal.avatarUrl),
  };
}

function formatCallDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function CallAvatar({ peer, className = '' }: { peer: CallPeer; className?: string }) {
  return (
    <div className={`aani-call-avatar ${className}`.trim()} aria-label={peer.name}>
      {peer.avatarUrl ? <img src={peer.avatarUrl} alt="" /> : <span>{peer.name.trim().charAt(0) || 'آ'}</span>}
    </div>
  );
}

export default function CallManager({
  currentUserId,
  currentProfile,
  contact,
}: {
  currentUserId: string;
  currentProfile: Profile | null;
  contact: Profile | null;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [callState, setCallState] = useState<CallUiState | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const callRef = useRef<CallUiState | null>(null);
  const contactRef = useRef<Profile | null>(contact);
  const currentProfileRef = useRef<Profile | null>(currentProfile);
  const inboxChannelRef = useRef<RealtimeChannel | null>(null);
  const inboxReadyRef = useRef(false);
  const outboundChannelsRef = useRef(new Map<string, Promise<RealtimeChannel>>());
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const earlyCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const renegotiatingCallRef = useRef<string | null>(null);
  const remoteRenegotiationReadyRef = useRef<string | null>(null);
  const ringtoneTimerRef = useRef<number | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const ringtoneContextRef = useRef<AudioContext | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const receiveSignalRef = useRef<(payload: unknown) => void>(() => undefined);

  contactRef.current = contact;
  currentProfileRef.current = currentProfile;

  const setActiveCall = useCallback((next: CallUiState | null) => {
    callRef.current = next;
    setCallState(next);
  }, []);

  const stopRingtone = useCallback(() => {
    if (ringtoneTimerRef.current !== null) window.clearInterval(ringtoneTimerRef.current);
    ringtoneTimerRef.current = null;
    const context = ringtoneContextRef.current;
    ringtoneContextRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }, []);

  const playSoftRingtone = useCallback(() => {
    try {
      const AudioContextConstructor = window.AudioContext;
      if (!AudioContextConstructor) return;
      let context = ringtoneContextRef.current;
      if (!context || context.state === 'closed') {
        context = new AudioContextConstructor();
        ringtoneContextRef.current = context;
      }
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
      const startAt = context.currentTime + 0.04;
      [0, 0.32].forEach((offset, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = index === 0 ? 520 : 660;
        gain.gain.setValueAtTime(0.0001, startAt + offset);
        gain.gain.exponentialRampToValueAtTime(0.045, startAt + offset + 0.035);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.28);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(startAt + offset);
        oscillator.stop(startAt + offset + 0.3);
      });
    } catch {
      /* قد يمنع المتصفح تشغيل الرنين قبل تفاعل المستخدم. */
    }
  }, []);

  const startRingtone = useCallback(() => {
    stopRingtone();
    playSoftRingtone();
    ringtoneTimerRef.current = window.setInterval(playSoftRingtone, 2400);
  }, [playSoftRingtone, stopRingtone]);

  const getOutboundChannel = useCallback((recipientId: string): Promise<RealtimeChannel> => {
    const cached = outboundChannelsRef.current.get(recipientId);
    if (cached) return cached;

    const channel = supabase.channel(`aani-call-user-${recipientId}`, { config: { broadcast: { self: false } } });
    const pending = new Promise<RealtimeChannel>((resolve, reject) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('انتهت مهلة الاتصال بخدمة المكالمات.'));
      }, 8000);
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED' && !settled) {
          settled = true;
          window.clearTimeout(timeoutId);
          resolve(channel);
        } else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') && !settled) {
          settled = true;
          window.clearTimeout(timeoutId);
          reject(new Error('تعذر الاتصال بقناة المكالمة.'));
        }
      });
    }).catch(error => {
      outboundChannelsRef.current.delete(recipientId);
      void supabase.removeChannel(channel);
      throw error;
    });
    outboundChannelsRef.current.set(recipientId, pending);
    return pending;
  }, []);

  const closeOutboundChannels = useCallback(() => {
    const channels = [...outboundChannelsRef.current.values()];
    outboundChannelsRef.current.clear();
    channels.forEach(channelPromise => {
      void channelPromise.then(channel => supabase.removeChannel(channel)).catch(() => undefined);
    });
  }, []);

  const sendSignal = useCallback(async (signal: OutgoingCallSignal) => {
    if (!signal.to || !signal.callId) throw new Error('بيانات المكالمة غير مكتملة.');
    const channel = await getOutboundChannel(signal.to);
    const result = await channel.send({
      type: 'broadcast',
      event: 'signal',
      payload: { ...signal, from: currentUserId },
    });
    if (result !== 'ok') throw new Error('تعذر إرسال إشارة المكالمة.');
  }, [currentUserId, getOutboundChannel]);

  const finishCall = useCallback((reason = 'ended', notifyPeer = true) => {
    const activeCall = callRef.current;
    if (!activeCall) return;
    stopRingtone();
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    setActiveCall(null);
    setElapsedSeconds(0);
    const connection = peerConnectionRef.current;
    peerConnectionRef.current = null;
    if (connection) {
      connection.ontrack = null;
      connection.onicecandidate = null;
      connection.onconnectionstatechange = null;
      connection.close();
    }
    const stream = localStreamRef.current;
    localStreamRef.current = null;
    stream?.getTracks().forEach(track => track.stop());
    earlyCandidatesRef.current.delete(activeCall.callId);
    if (renegotiatingCallRef.current === activeCall.callId) renegotiatingCallRef.current = null;
    if (remoteRenegotiationReadyRef.current === activeCall.callId) remoteRenegotiationReadyRef.current = null;
    if (notifyPeer) {
      void sendSignal({ type: 'hangup', callId: activeCall.callId, to: activeCall.peer.id, reason })
        .catch(error => console.warn('[calls] تعذر إرسال إنهاء المكالمة:', error))
        .finally(closeOutboundChannels);
    } else {
      closeOutboundChannels();
    }
  }, [closeOutboundChannels, sendSignal, setActiveCall, stopRingtone]);

  const showTerminalStatus = useCallback((callId: string, status: CallTerminalStatus) => {
    const activeCall = callRef.current;
    if (!activeCall || activeCall.callId !== callId || activeCall.terminalStatus || activeCall.dismissing) return;
    stopRingtone();
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    if (status === 'no-answer') {
      void sendSignal({ type: 'hangup', callId, to: activeCall.peer.id, reason: 'no-answer' })
        .catch(error => console.warn('[calls] تعذر إنهاء الرنين بعد انتهاء المهلة:', error));
    }
    setActiveCall({ ...activeCall, terminalStatus: status, ringing: false, accepting: false });
    dismissTimerRef.current = window.setTimeout(() => {
      const currentCall = callRef.current;
      if (currentCall?.callId !== callId || currentCall.dismissing) return;
      setActiveCall({ ...currentCall, dismissing: true });
      dismissTimerRef.current = window.setTimeout(() => {
        if (callRef.current?.callId === callId) finishCall(status, false);
      }, 600);
    }, 2000);
  }, [finishCall, sendSignal, setActiveCall, stopRingtone]);

  const flushEarlyCandidates = useCallback(async (callId: string, connection: RTCPeerConnection) => {
    const candidates = earlyCandidatesRef.current.get(callId) || [];
    earlyCandidatesRef.current.delete(callId);
    for (const candidate of candidates) {
      try {
        await connection.addIceCandidate(candidate);
      } catch (error) {
        console.warn('[calls] تعذر إضافة مرشح اتصال مبكر:', error);
      }
    }
  }, []);

  const createPeerConnection = useCallback((callId: string, peer: CallPeer): RTCPeerConnection => {
    peerConnectionRef.current?.close();
    const connection = new RTCPeerConnection({ iceServers: CALL_ICE_SERVERS });
    peerConnectionRef.current = connection;
    connection.onicecandidate = event => {
      if (!event.candidate) {
        if (renegotiatingCallRef.current === callId) renegotiatingCallRef.current = null;
        return;
      }
      if (callRef.current?.callId !== callId) return;
      void sendSignal({
        type: 'ice-candidate',
        callId,
        to: peer.id,
        candidate: event.candidate.toJSON(),
        renegotiate: renegotiatingCallRef.current === callId,
      }).catch(error => console.warn('[calls] تعذر إرسال مرشح اتصال:', error));
    };
    connection.ontrack = event => {
      if (callRef.current?.callId !== callId) return;
      let remoteStream = event.streams[0];
      if (!remoteStream) {
        remoteStream = new MediaStream();
        remoteStream.addTrack(event.track);
      }
      const activeCall = callRef.current;
      if (activeCall?.callId === callId) setActiveCall({ ...activeCall, remoteStream });
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') {
        const activeCall = callRef.current;
        if (activeCall?.callId === callId && !activeCall.dismissing && !activeCall.terminalStatus) {
          setActiveCall({ ...activeCall, phase: 'active', accepting: false, dismissing: false, startedAt: activeCall.startedAt || Date.now() });
        }
      } else if (connection.connectionState === 'failed') {
        toast.error('انقطع الاتصال. حاول إجراء المكالمة مرة أخرى.');
        finishCall('connection-failed');
      }
    };
    return connection;
  }, [finishCall, sendSignal, setActiveCall]);

  const receiveSignal = useCallback(async (payload: unknown) => {
    if (!isCallSignal(payload) || payload.to !== currentUserId || payload.from === currentUserId) return;
    const activeCall = callRef.current;

    if (payload.type === 'offer') {
      if (activeCall && activeCall.callId !== payload.callId) {
        void sendSignal({ type: 'busy-call', callId: payload.callId, to: payload.from })
          .catch(error => console.warn('[calls] تعذر إرسال إشارة انشغال المكالمة:', error));
        return;
      }
      if (!payload.description || payload.description.type !== 'offer') return;
      if (payload.renegotiate) {
        if (!activeCall || activeCall.phase !== 'active' || activeCall.peer.id !== payload.from) return;
        const connection = peerConnectionRef.current;
        if (!connection) return;
        remoteRenegotiationReadyRef.current = null;
        renegotiatingCallRef.current = payload.callId;
        try {
          await connection.setRemoteDescription(payload.description);
          remoteRenegotiationReadyRef.current = payload.callId;
          await flushEarlyCandidates(payload.callId, connection);
          const answer = await connection.createAnswer();
          await connection.setLocalDescription(answer);
          const localDescription = connection.localDescription;
          if (!localDescription) throw new Error('تعذر إنشاء إجابة تحديث الفيديو.');
          await sendSignal({
            type: 'answer',
            callId: payload.callId,
            to: payload.from,
            description: localDescription.toJSON(),
          });
        } catch (error) {
          console.warn('[calls] تعذر التفاوض على مسار الفيديو:', error);
          toast.error('تعذر تفعيل الفيديو لدى الطرف الآخر.');
        }
        return;
      }
      if (activeCall?.callId === payload.callId) {
        if (activeCall.phase === 'incoming') {
          void sendSignal({ type: 'ringing-ack', callId: payload.callId, to: payload.from })
            .catch(error => console.warn('[calls] تعذر تأكيد رنين المكالمة:', error));
        }
        return;
      }
      if (payload.mode !== 'audio' && payload.mode !== 'video') return;
      setPickerOpen(false);
      const incomingCall: CallUiState = {
        callId: payload.callId,
        phase: 'incoming',
        mode: payload.mode,
        peer: makePeerFromSignal(payload),
        offer: payload.description,
        localStream: null,
        remoteStream: null,
        muted: false,
        cameraOff: payload.mode === 'audio',
        speakerOn: true,
        ringing: false,
        accepting: false,
        dismissing: false,
        terminalStatus: null,
        accepted: false,
        startedAt: null,
      };
      setActiveCall(incomingCall);
      startRingtone();
      void sendSignal({ type: 'ringing-ack', callId: payload.callId, to: payload.from })
        .catch(error => console.warn('[calls] تعذر تأكيد رنين المكالمة:', error));
      return;
    }

    if (payload.type === 'ringing-ack') {
      if (activeCall?.callId === payload.callId && activeCall.peer.id === payload.from && activeCall.phase === 'outgoing') {
        setActiveCall({ ...activeCall, ringing: true });
      }
      return;
    }

    if (payload.type === 'ice-candidate') {
      if (!payload.candidate) return;
      if (activeCall && (activeCall.callId !== payload.callId || activeCall.peer.id !== payload.from)) return;
      const connection = activeCall?.callId === payload.callId ? peerConnectionRef.current : null;
      const waitingForRenegotiation = payload.renegotiate === true && remoteRenegotiationReadyRef.current !== payload.callId;
      if (connection?.remoteDescription && !waitingForRenegotiation) {
        try {
          await connection.addIceCandidate(payload.candidate);
        } catch (error) {
          console.warn('[calls] تعذر إضافة مرشح اتصال:', error);
        }
      } else {
        const pending = earlyCandidatesRef.current.get(payload.callId) || [];
        if (pending.length < 64) earlyCandidatesRef.current.set(payload.callId, [...pending, payload.candidate]);
      }
      return;
    }

    if (payload.type === 'hangup' || payload.type === 'decline-call' || payload.type === 'busy-call') {
      earlyCandidatesRef.current.delete(payload.callId);
      if (activeCall?.callId !== payload.callId || activeCall.peer.id !== payload.from) return;
      if (payload.type === 'decline-call' || payload.reason === 'declined') {
        if (activeCall.phase === 'outgoing') showTerminalStatus(payload.callId, 'declined');
        else {
          toast.info('لم يتم قبول المكالمة.');
          finishCall(payload.reason || 'declined', false);
        }
      } else if (payload.type === 'busy-call' || payload.reason === 'busy') {
        if (activeCall.phase === 'outgoing') showTerminalStatus(payload.callId, 'busy');
        else {
          toast.info('المستخدم مشغول بمكالمة أخرى.');
          finishCall('busy', false);
        }
      } else if (payload.reason === 'permission-denied') {
        toast.info('تعذر على الطرف الآخر السماح باستخدام الميكروفون أو الكاميرا.');
        finishCall(payload.reason, false);
      } else {
        finishCall(payload.reason || 'remote-ended', false);
      }
      return;
    }

    if (!activeCall || activeCall.callId !== payload.callId || activeCall.peer.id !== payload.from || activeCall.terminalStatus) return;

    if (payload.type === 'answer') {
      const connection = peerConnectionRef.current;
      if (!connection || !payload.description || payload.description.type !== 'answer') return;
      if (!activeCall.accepted) setActiveCall({ ...activeCall, accepted: true, ringing: false });
      const isRenegotiationAnswer = activeCall.phase === 'active' && connection.signalingState === 'have-local-offer';
      if (isRenegotiationAnswer) remoteRenegotiationReadyRef.current = null;
      try {
        await connection.setRemoteDescription(payload.description);
        if (isRenegotiationAnswer) remoteRenegotiationReadyRef.current = payload.callId;
        await flushEarlyCandidates(payload.callId, connection);
      } catch (error) {
        console.error('[calls] تعذر تطبيق إجابة المكالمة:', error);
        toast.error('تعذر إنشاء الاتصال. حاول مرة أخرى.');
        finishCall('connection-failed');
      }
      return;
    }

  }, [currentUserId, finishCall, flushEarlyCandidates, sendSignal, setActiveCall, showTerminalStatus, startRingtone]);

  receiveSignalRef.current = payload => { void receiveSignal(payload); };

  useEffect(() => {
    inboxReadyRef.current = false;
    const channel = supabase
      .channel(`aani-call-user-${currentUserId}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'signal' }, ({ payload }) => receiveSignalRef.current(payload))
      .subscribe(status => {
        if (status === 'SUBSCRIBED') inboxReadyRef.current = true;
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') inboxReadyRef.current = false;
      });
    inboxChannelRef.current = channel;
    return () => {
      inboxReadyRef.current = false;
      if (inboxChannelRef.current === channel) inboxChannelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [currentUserId]);

  const waitForInbox = useCallback(async () => {
    const deadline = Date.now() + 6000;
    while (!inboxReadyRef.current && Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 80));
    }
    if (!inboxReadyRef.current) throw new Error('تعذر الاتصال بخدمة المكالمات الفورية.');
  }, []);

  const requestLocalMedia = useCallback(async (mode: CallMode): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('MEDIA_ACCESS_UNAVAILABLE');
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mode === 'video' ? { facingMode: 'user' } : false,
    });
  }, []);

  const startCall = useCallback(async (mode: CallMode) => {
    const profile = contactRef.current;
    if (!profile) {
      toast.info('افتح محادثة مع الشخص الذي تريد الاتصال به أولاً.');
      return;
    }
    if (callRef.current) {
      toast.info('لديك مكالمة جارية بالفعل.');
      return;
    }

    const peer = makePeerFromProfile(profile);
    const callId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPickerOpen(false);
    setActiveCall({
      callId,
      phase: 'outgoing',
      mode,
      peer,
      offer: null,
      localStream: null,
      remoteStream: null,
      muted: false,
      cameraOff: mode === 'audio',
      speakerOn: true,
      ringing: false,
      accepting: false,
      dismissing: false,
      terminalStatus: null,
      accepted: false,
      startedAt: null,
    });

    let acquiredStream: MediaStream | null = null;
    try {
      acquiredStream = await requestLocalMedia(mode);
      if (callRef.current?.callId !== callId) {
        acquiredStream.getTracks().forEach(track => track.stop());
        return;
      }
      const callBeforeMediaReady = callRef.current;
      acquiredStream.getAudioTracks().forEach(track => {
        track.enabled = !(callBeforeMediaReady?.callId === callId && callBeforeMediaReady.muted);
      });
      localStreamRef.current = acquiredStream;
      await waitForInbox();
      if (callRef.current?.callId !== callId) {
        acquiredStream.getTracks().forEach(track => track.stop());
        if (localStreamRef.current === acquiredStream) localStreamRef.current = null;
        return;
      }
      const connection = createPeerConnection(callId, peer);
      acquiredStream.getTracks().forEach(track => connection.addTrack(track, acquiredStream as MediaStream));
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (callRef.current?.callId !== callId) {
        connection.close();
        acquiredStream.getTracks().forEach(track => track.stop());
        return;
      }
      const localDescription = connection.localDescription;
      if (!localDescription) throw new Error('تعذر إنشاء عرض المكالمة.');
      const activeCall = callRef.current;
      if (activeCall?.callId === callId) setActiveCall({ ...activeCall, localStream: acquiredStream, offer: localDescription.toJSON() });
      const callerProfile = currentProfileRef.current;
      await sendSignal({
        type: 'offer',
        callId,
        to: peer.id,
        mode,
        description: localDescription.toJSON(),
        name: callerProfile ? displayName(callerProfile) : 'مستخدم آني',
        username: callerProfile?.username || '',
        avatarUrl: callerProfile?.avatar_url || null,
      });
    } catch (error) {
      acquiredStream?.getTracks().forEach(track => track.stop());
      if (localStreamRef.current === acquiredStream) localStreamRef.current = null;
      const permissionError = error instanceof Error && /NotAllowedError|PermissionDeniedError|SecurityError|Permission denied|MEDIA_ACCESS_UNAVAILABLE/i.test(`${error.name} ${error.message}`);
      if (permissionError) {
        toast.error('يرجى السماح بالوصول إلى الميكروفون أو الكاميرا من إعدادات المتصفح لإجراء المكالمة.');
      } else {
        console.error('[calls] تعذر بدء المكالمة:', error);
        toast.error(error instanceof Error && error.message.includes('خدمة المكالمات')
          ? error.message
          : 'تعذر بدء المكالمة. تحقق من الأذونات واتصال الإنترنت ثم حاول مرة أخرى.');
      }
      if (callRef.current?.callId === callId) finishCall('setup-failed', false);
    }
  }, [createPeerConnection, finishCall, requestLocalMedia, sendSignal, setActiveCall, waitForInbox]);

  const acceptCall = useCallback(async () => {
    const incomingCall = callRef.current;
    if (!incomingCall || incomingCall.phase !== 'incoming' || !incomingCall.offer || incomingCall.accepting || incomingCall.dismissing) return;
    stopRingtone();
    setActiveCall({ ...incomingCall, accepting: true });
    let acquiredStream: MediaStream | null = null;
    try {
      acquiredStream = await requestLocalMedia(incomingCall.mode);
      if (callRef.current?.callId !== incomingCall.callId) {
        acquiredStream.getTracks().forEach(track => track.stop());
        return;
      }
      localStreamRef.current = acquiredStream;
      const connection = createPeerConnection(incomingCall.callId, incomingCall.peer);
      acquiredStream.getTracks().forEach(track => connection.addTrack(track, acquiredStream as MediaStream));
      await connection.setRemoteDescription(incomingCall.offer);
      await flushEarlyCandidates(incomingCall.callId, connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      if (callRef.current?.callId !== incomingCall.callId) {
        connection.close();
        acquiredStream.getTracks().forEach(track => track.stop());
        return;
      }
      const localDescription = connection.localDescription;
      if (!localDescription) throw new Error('تعذر إنشاء إجابة المكالمة.');
      const currentCall = callRef.current;
      if (currentCall?.callId === incomingCall.callId) {
        setActiveCall({ ...currentCall, phase: 'incoming', accepting: true, localStream: acquiredStream, offer: null });
      }
      await sendSignal({
        type: 'answer',
        callId: incomingCall.callId,
        to: incomingCall.peer.id,
        description: localDescription.toJSON(),
      });
    } catch (error) {
      acquiredStream?.getTracks().forEach(track => track.stop());
      if (localStreamRef.current === acquiredStream) localStreamRef.current = null;
      const permissionError = error instanceof Error && /NotAllowedError|PermissionDeniedError|SecurityError|Permission denied|MEDIA_ACCESS_UNAVAILABLE/i.test(`${error.name} ${error.message}`);
      if (permissionError) {
        toast.error('يرجى السماح بالوصول إلى الميكروفون أو الكاميرا من إعدادات المتصفح لقبول المكالمة.');
      } else {
        console.error('[calls] تعذر قبول المكالمة:', error);
        toast.error('تعذر قبول المكالمة. تحقق من الأذونات واتصال الإنترنت ثم حاول مرة أخرى.');
      }
      if (callRef.current?.callId === incomingCall.callId) finishCall('permission-denied');
    }
  }, [createPeerConnection, finishCall, flushEarlyCandidates, requestLocalMedia, sendSignal, setActiveCall, stopRingtone]);

  const rejectOrEndCall = useCallback((reason = 'declined') => {
    const activeCall = callRef.current;
    if (!activeCall || activeCall.dismissing) return;
    if (reason === 'declined' && activeCall.phase === 'incoming' && !activeCall.accepting) {
      stopRingtone();
      setActiveCall({ ...activeCall, dismissing: true });
      void sendSignal({ type: 'decline-call', callId: activeCall.callId, to: activeCall.peer.id, reason: 'declined' })
        .catch(error => console.warn('[calls] تعذر إرسال رفض المكالمة:', error));
      dismissTimerRef.current = window.setTimeout(() => {
        if (callRef.current?.callId === activeCall.callId) finishCall('declined', false);
      }, 250);
      return;
    }
    stopRingtone();
    setActiveCall({ ...activeCall, dismissing: true, startedAt: null });
    dismissTimerRef.current = window.setTimeout(() => {
      if (callRef.current?.callId === activeCall.callId) finishCall(reason);
    }, 250);
  }, [finishCall, sendSignal, setActiveCall, stopRingtone]);

  const toggleMute = useCallback(() => {
    const activeCall = callRef.current;
    const stream = localStreamRef.current;
    if (!activeCall || activeCall.dismissing) return;
    const nextMuted = !activeCall.muted;
    stream?.getAudioTracks().forEach(track => { track.enabled = !nextMuted; });
    setActiveCall({ ...activeCall, muted: nextMuted });
  }, [setActiveCall]);

  const toggleCamera = useCallback(async () => {
    const activeCall = callRef.current;
    const stream = localStreamRef.current;
    if (!activeCall || activeCall.phase !== 'active' || activeCall.dismissing || !stream) return;
    const liveVideoTrack = stream.getVideoTracks().find(track => track.readyState === 'live');
    if (!activeCall.cameraOff) {
      stream.getVideoTracks().forEach(track => { track.enabled = false; });
      setActiveCall({ ...activeCall, cameraOff: true });
      return;
    }
    if (liveVideoTrack) {
      liveVideoTrack.enabled = true;
      setActiveCall({ ...activeCall, cameraOff: false });
      return;
    }

    let cameraStream: MediaStream | null = null;
    let cameraTrack: MediaStreamTrack | null = null;
    let cameraSender: RTCRtpSender | null = null;
    const connection = peerConnectionRef.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !connection) throw new Error('MEDIA_ACCESS_UNAVAILABLE');
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      cameraTrack = cameraStream.getVideoTracks()[0] || null;
      const currentCall = callRef.current;
      const currentStream = localStreamRef.current;
      if (!cameraTrack || !currentCall || currentCall.callId !== activeCall.callId || !currentStream || peerConnectionRef.current !== connection) {
        cameraStream.getTracks().forEach(track => track.stop());
        return;
      }
      renegotiatingCallRef.current = activeCall.callId;
      currentStream.addTrack(cameraTrack);
      cameraSender = connection.addTrack(cameraTrack, currentStream);
      setActiveCall({ ...currentCall, cameraOff: false, localStream: currentStream });
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (callRef.current?.callId !== activeCall.callId || peerConnectionRef.current !== connection) return;
      const localDescription = connection.localDescription;
      if (!localDescription) throw new Error('تعذر إنشاء عرض الفيديو.');
      await sendSignal({
        type: 'offer',
        callId: activeCall.callId,
        to: activeCall.peer.id,
        renegotiate: true,
        description: localDescription.toJSON(),
      });
    } catch (error) {
      if (renegotiatingCallRef.current === activeCall.callId) renegotiatingCallRef.current = null;
      if (cameraSender && peerConnectionRef.current === connection) connection?.removeTrack(cameraSender);
      if (cameraTrack) {
        stream.removeTrack(cameraTrack);
        cameraTrack.stop();
      }
      const currentCall = callRef.current;
      if (currentCall?.callId === activeCall.callId) setActiveCall({ ...currentCall, cameraOff: true });
      console.warn('[calls] تعذر تشغيل كاميرا المكالمة:', error);
      toast.error(/NotAllowedError|PermissionDeniedError|SecurityError|Permission denied|MEDIA_ACCESS_UNAVAILABLE/i.test(error instanceof Error ? `${error.name} ${error.message}` : String(error))
        ? 'يرجى السماح بالوصول إلى الكاميرا من إعدادات المتصفح لتشغيل الفيديو.'
        : 'تعذر تشغيل الكاميرا. تحقق من الأذونات واتصال الإنترنت ثم حاول مرة أخرى.');
    }
  }, [sendSignal, setActiveCall]);

  const toggleSpeaker = useCallback(() => {
    const activeCall = callRef.current;
    if (!activeCall || activeCall.dismissing) return;
    setActiveCall({ ...activeCall, speakerOn: !activeCall.speakerOn });
  }, [setActiveCall]);

  useEffect(() => {
    if (!callState || callState.phase !== 'active' || !callState.startedAt) {
      setElapsedSeconds(0);
      return;
    }
    const updateDuration = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - (callRef.current?.startedAt || Date.now())) / 1000)));
    updateDuration();
    const timerId = window.setInterval(updateDuration, 1000);
    return () => window.clearInterval(timerId);
  }, [callState?.phase, callState?.startedAt, callState]);

  useEffect(() => {
    if (!callState || callState.phase !== 'outgoing' || !callState.offer || callState.startedAt || callState.accepted || callState.terminalStatus) return;
    const callId = callState.callId;
    const timerId = window.setTimeout(() => {
      const activeCall = callRef.current;
      if (activeCall?.callId !== callId || activeCall.phase !== 'outgoing' || activeCall.startedAt || activeCall.accepted || activeCall.terminalStatus) return;
      showTerminalStatus(callId, 'no-answer');
    }, 30_000);
    return () => window.clearTimeout(timerId);
  }, [callState?.callId, callState?.phase, callState?.offer, callState?.startedAt, callState?.accepted, callState?.terminalStatus, showTerminalStatus]);

  useEffect(() => {
    const stream = callState?.localStream || null;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
      if (stream) void localVideoRef.current.play().catch(() => undefined);
    }
  }, [callState?.localStream, callState?.remoteStream, callState?.phase, callState?.cameraOff]);

  useEffect(() => {
    const stream = callState?.remoteStream || null;
    const remoteElement = callState?.mode === 'video' || stream?.getVideoTracks().some(track => track.readyState === 'live')
      ? remoteVideoRef.current
      : remoteAudioRef.current;
    if (remoteElement) {
      remoteElement.srcObject = stream;
      if (stream) void remoteElement.play().catch(() => undefined);
    }
  }, [callState?.mode, callState?.phase, callState?.remoteStream]);

  useEffect(() => {
    const handleOpenPicker = () => {
      if (!contactRef.current) {
        toast.info('افتح محادثة مع الشخص الذي تريد الاتصال به أولاً.');
        return;
      }
      if (callRef.current) {
        toast.info('لديك مكالمة جارية بالفعل.');
        return;
      }
      setPickerOpen(true);
    };
    window.addEventListener(OPEN_CALL_PICKER_EVENT, handleOpenPicker);
    return () => window.removeEventListener(OPEN_CALL_PICKER_EVENT, handleOpenPicker);
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pickerOpen) setPickerOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [pickerOpen]);

  useEffect(() => () => {
    stopRingtone();
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    const activeCall = callRef.current;
    if (activeCall && !activeCall.dismissing && !activeCall.terminalStatus) {
      void sendSignal({ type: 'hangup', callId: activeCall.callId, to: activeCall.peer.id, reason: 'ended' })
        .catch(() => undefined)
        .finally(closeOutboundChannels);
    } else {
      closeOutboundChannels();
    }
    peerConnectionRef.current?.close();
    localStreamRef.current?.getTracks().forEach(track => track.stop());
  }, [closeOutboundChannels, sendSignal, stopRingtone]);

  const closePicker = () => setPickerOpen(false);
  const sheetDragStartYRef = useRef<number | null>(null);
  const activeDuration = formatCallDuration(elapsedSeconds);
  const showActiveVideo = Boolean(callState?.phase === 'active' && (
    callState.mode === 'video' || callState.remoteStream?.getVideoTracks().some(track => track.readyState === 'live')
  ));
  const showUi = pickerOpen || Boolean(callState);

  if (!showUi || typeof document === 'undefined') return null;

  return createPortal(
    <>
      <style>{CALL_STYLES}</style>
      {pickerOpen && !callState && (
        <div className="aani-call-layer" dir="rtl">
          <div className="aani-call-backdrop" role="presentation" onClick={closePicker} />
          <div className="aani-call-sheet-wrap">
            <section
              className="aani-call-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="aani-call-sheet-title"
              onClick={event => event.stopPropagation()}
            >
              <div
                className="aani-call-sheet-handle"
                role="presentation"
                onPointerDown={event => {
                  sheetDragStartYRef.current = event.clientY;
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerUp={event => {
                  const startY = sheetDragStartYRef.current;
                  sheetDragStartYRef.current = null;
                  if (startY !== null && event.clientY - startY > 55) closePicker();
                }}
                onPointerCancel={() => { sheetDragStartYRef.current = null; }}
              />
              <button type="button" className="aani-call-sheet-close" aria-label="إغلاق" onClick={closePicker}><X size={18} /></button>
              <h2 id="aani-call-sheet-title" className="aani-call-sheet-title">بدء مكالمة</h2>
              <div className="aani-call-options">
                <button type="button" className="aani-call-option" onClick={() => void startCall('audio')}>
                  <span className="aani-call-option-icon"><Phone size={21} /></span>
                  <span>اتصال صوتي</span>
                </button>
                <button type="button" className="aani-call-option" onClick={() => void startCall('video')}>
                  <span className="aani-call-option-icon"><Video size={21} /></span>
                  <span>اتصال فيديو</span>
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
      {callState && (
        <div className={`aani-call-layer${callState.phase === 'outgoing' ? ' aani-call-layer-outgoing' : ''}${callState.phase === 'incoming' ? ' aani-call-layer-incoming' : ''}${showActiveVideo ? ' aani-call-overlay-video' : ''}`} dir="rtl">
          <section className={`aani-call-overlay${callState.phase === 'outgoing' ? ' aani-call-overlay-outgoing' : ''}${callState.phase === 'incoming' ? ' aani-call-overlay-incoming' : ''}${callState.phase === 'active' && !showActiveVideo ? ' aani-call-overlay-active-audio' : ''}${callState.dismissing ? ' aani-call-overlay-dismissing' : ''}${callState.dismissing && callState.terminalStatus ? ' aani-call-overlay-terminal-dismissing' : ''}${showActiveVideo ? ' aani-call-overlay-video' : ''}`} role="dialog" aria-modal="true" aria-label={callState.mode === 'video' ? 'مكالمة فيديو' : 'مكالمة صوتية'}>
            {showActiveVideo && (
              <>
                <video ref={remoteVideoRef} className="aani-call-remote-video" muted={!callState.speakerOn} autoPlay playsInline aria-label="فيديو الطرف الآخر" />
                <div className="aani-call-video-shade" />
                {callState.localStream && !callState.cameraOff && <video ref={localVideoRef} className="aani-call-local-video" muted autoPlay playsInline aria-label="الفيديو المحلي" />}
                {callState.remoteStream?.getAudioTracks().length ? null : <audio ref={remoteAudioRef} muted={!callState.speakerOn} autoPlay playsInline />}
              </>
            )}
            {!(showActiveVideo) && (
              <>
                {callState.phase === 'outgoing' || callState.phase === 'incoming' ? (
                  <div className={callState.phase === 'outgoing' ? 'aani-call-outgoing-content' : 'aani-call-incoming-content'}>
                    <div className={`aani-call-outgoing-avatar-wrap${callState.terminalStatus === 'declined' ? ' is-red-glow' : ''}`}>
                      <CallAvatar peer={callState.peer} className={`aani-call-avatar-outgoing${callState.phase === 'incoming' ? ' aani-call-avatar-incoming' : ''}${callState.terminalStatus === 'declined' ? ' is-declined' : ''}`} />
                    </div>
                    <div className={`aani-call-person${callState.phase === 'outgoing' ? ' aani-call-person-outgoing' : ' aani-call-person-incoming'}`}>
                      <h2 className={`aani-call-name${callState.phase === 'outgoing' ? ' aani-call-name-outgoing' : ' aani-call-name-incoming'}`}>{callState.peer.name}</h2>
                      <p className={`aani-call-status ${callState.phase === 'outgoing' ? 'aani-call-status-outgoing' : 'aani-call-status-incoming'}${callState.terminalStatus ? ` aani-call-status-terminal aani-call-status-terminal-${callState.terminalStatus}` : ''}${!callState.terminalStatus && (callState.accepting || (callState.phase === 'outgoing' && !callState.ringing)) ? ' aani-call-status-connecting' : ''}`}>
                        {callState.terminalStatus === 'declined' ? 'تم رفض المكالمة'
                          : callState.terminalStatus === 'no-answer' ? 'لا يوجد رد...'
                            : callState.terminalStatus === 'busy' ? 'خط مشغول...'
                              : callState.phase === 'outgoing'
                                ? callState.ringing ? 'يرن...' : 'جاري الاتصال...'
                                : callState.accepting
                                  ? 'جاري التوصيل'
                                  : `مكالمة ${callState.mode === 'video' ? 'فيديو' : 'صوتية'} واردة`}
                        {!callState.terminalStatus && callState.phase === 'incoming' && <span className="aani-call-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>}
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    <CallAvatar peer={callState.peer} className="aani-call-avatar-active" />
                    <div className="aani-call-person">
                      <h2 className="aani-call-name">{callState.peer.name}</h2>
                      <p className="aani-call-status">المكالمة متصلة</p>
                      <span className="aani-call-timer aani-call-timer-active" aria-label={`مدة المكالمة ${activeDuration}`}>{activeDuration}</span>
                    </div>
                    {callState.mode === 'audio' && callState.localStream && !callState.cameraOff && (
                      <video ref={localVideoRef} className="aani-call-local-video aani-call-local-video-audio" muted autoPlay playsInline aria-label="الفيديو المحلي" />
                    )}
                  </>
                )}
                {callState.mode === 'audio' && <audio ref={remoteAudioRef} muted={!callState.speakerOn} autoPlay playsInline />}
              </>
            )}
            {showActiveVideo && (
              <div className="aani-call-person" style={{ position: 'absolute', top: 'calc(18px + env(safe-area-inset-top))', right: 20, alignItems: 'flex-start', gap: 5 }}>
                <h2 className="aani-call-name" style={{ margin: 0, fontSize: 18, textShadow: '0 1px 8px #000' }}>{callState.peer.name}</h2>
                <span className="aani-call-timer aani-call-timer-active" style={{ margin: 0, textShadow: '0 1px 8px #000' }}>{activeDuration}</span>
              </div>
            )}
            {callState.phase !== 'incoming' && callState.mode === 'video' && callState.phase !== 'active' && callState.localStream && (
              <video ref={localVideoRef} className="aani-call-local-video" muted autoPlay playsInline aria-label="الفيديو المحلي" />
            )}
            <div className={`aani-call-controls${callState.phase === 'outgoing' ? ' aani-call-controls-outgoing' : ''}${callState.phase === 'active' ? ' aani-call-controls-active' : ''}${callState.phase === 'incoming' ? ` aani-call-controls-incoming${callState.accepting ? ' is-accepting' : ''}${callState.dismissing ? ' is-dismissing' : ''}` : ''}${callState.terminalStatus ? ' aani-call-controls-fading' : ''}`}>
              {callState.phase === 'incoming' ? (
                <>
                  <button type="button" className="aani-call-control aani-call-control-incoming is-reject" aria-label="رفض المكالمة" disabled={callState.accepting || callState.dismissing} onClick={() => rejectOrEndCall('declined')}><Phone size={28} /></button>
                  <button type="button" className="aani-call-control aani-call-control-incoming is-accept" aria-label="قبول المكالمة" aria-busy={callState.accepting} disabled={callState.accepting || callState.dismissing} onClick={() => void acceptCall()}><Phone size={28} /></button>
                </>
              ) : callState.phase === 'outgoing' ? (
                <>
                  <button type="button" className={`aani-call-control aani-call-control-outgoing${callState.muted ? ' is-muted' : ''}`} aria-label={callState.muted ? 'إلغاء كتم الصوت' : 'كتم الصوت'} aria-pressed={callState.muted} onClick={toggleMute}><Mic size={25} /></button>
                  <button type="button" className="aani-call-control aani-call-control-outgoing is-end" aria-label="إلغاء الاتصال" onClick={() => rejectOrEndCall('ended')}><Phone size={28} /></button>
                </>
              ) : (
                <>
                  <button type="button" className={`aani-call-control${callState.muted ? ' is-active is-muted' : ''}`} aria-label={callState.muted ? 'إلغاء كتم الصوت' : 'كتم الصوت'} aria-pressed={callState.muted} onClick={toggleMute} disabled={!callState.localStream || callState.dismissing}>{callState.muted ? <MicOff size={22} /> : <Mic size={22} />}</button>
                  <button type="button" className={`aani-call-control${callState.cameraOff ? ' is-active' : ''}`} aria-label={callState.cameraOff ? 'تشغيل الكاميرا' : 'إيقاف الكاميرا'} aria-pressed={!callState.cameraOff} onClick={() => void toggleCamera()} disabled={!callState.localStream || callState.dismissing}>{callState.cameraOff ? <VideoOff size={22} /> : <Camera size={22} />}</button>
                  <button type="button" className={`aani-call-control${!callState.speakerOn ? ' is-active' : ''}`} aria-label={callState.speakerOn ? 'إيقاف مكبر الصوت' : 'تشغيل مكبر الصوت'} aria-pressed={callState.speakerOn} onClick={toggleSpeaker} disabled={callState.dismissing}>{callState.speakerOn ? <Volume2 size={22} /> : <VolumeX size={22} />}</button>
                  <button type="button" className="aani-call-control is-end" aria-label="إنهاء المكالمة" disabled={callState.dismissing} onClick={() => rejectOrEndCall('ended')}><PhoneOff size={24} /></button>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </>,
    document.body,
  );
}
