// Authentic Discord UI sound engine for Triscord.
// Uses official Discord audio assets decoded and cached in Web Audio API for zero-latency,
// click-free, and high-fidelity auditory feedback with user volume control.

import joinAudio from '../../assets/call-sounds/user_join.mp3';
import leaveAudio from '../../assets/call-sounds/disconnect.mp3';
import userJoinAudio from '../../assets/call-sounds/user_join.mp3';
import userLeaveAudio from '../../assets/call-sounds/user_leave.mp3';
import muteAudio from '../../assets/call-sounds/mute.mp3';
import unmuteAudio from '../../assets/call-sounds/unmute.mp3';
import deafenAudio from '../../assets/call-sounds/deafen.mp3';
import undeafenAudio from '../../assets/call-sounds/undeafen.mp3';
import cameraOnAudio from '../../assets/call-sounds/camera_on.mp3';
import cameraOffAudio from '../../assets/call-sounds/camera_off.mp3';
import streamStartAudio from '../../assets/call-sounds/stream_started.mp3';
import streamStopAudio from '../../assets/call-sounds/stream_ended.mp3';

export type SoundCue =
  | 'join'
  | 'leave'
  | 'userJoin'
  | 'userLeave'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'cameraOn'
  | 'cameraOff'
  | 'streamStart'
  | 'streamStop'
  | 'click'
  | 'channelSwitch'
  | 'messageSent';

const AUDIO_SOURCES: Partial<Record<SoundCue, string>> = {
  join: joinAudio,
  leave: leaveAudio,
  userJoin: userJoinAudio,
  userLeave: userLeaveAudio,
  mute: muteAudio,
  unmute: unmuteAudio,
  deafen: deafenAudio,
  undeafen: undeafenAudio,
  cameraOn: cameraOnAudio,
  cameraOff: cameraOffAudio,
  streamStart: streamStartAudio,
  streamStop: streamStopAudio,
};

class SoundEngine {
  private ctx: AudioContext | null = null;
  private enabled: boolean = true;
  private volume: number = 0.7; // 0.0 to 1.0
  private buffers: Partial<Record<SoundCue, AudioBuffer>> = {};
  private loading: Partial<Record<SoundCue, Promise<AudioBuffer | null>>> = {};

  constructor() {
    if (typeof window !== 'undefined') {
      const warm = () => {
        this.prewarm();
        window.removeEventListener('click', warm);
        window.removeEventListener('keydown', warm);
      };
      window.addEventListener('click', warm, { passive: true });
      window.addEventListener('keydown', warm, { passive: true });
    }
  }

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        try {
          this.ctx = new AudioCtx();
        } catch {
          this.ctx = null;
        }
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public setVolume(volume0to100: number): void {
    this.volume = Math.max(0, Math.min(100, volume0to100)) / 100;
  }

  public prewarm(): void {
    const ctx = this.getContext();
    if (!ctx) return;
    for (const [cue, url] of Object.entries(AUDIO_SOURCES)) {
      if (url) {
        this.loadBuffer(cue as SoundCue, url);
      }
    }
  }

  private async loadBuffer(cue: SoundCue, dataUrl: string): Promise<AudioBuffer | null> {
    if (this.buffers[cue]) return this.buffers[cue]!;
    if (this.loading[cue]) return this.loading[cue]!;
    const ctx = this.getContext();
    if (!ctx) return null;

    this.loading[cue] = (async () => {
      try {
        if ((import.meta as unknown as { env?: { MODE?: string } }).env?.MODE === 'test') {
          return null;
        }
        let arrayBuffer: ArrayBuffer;
        if (dataUrl.startsWith('data:')) {
          const parts = dataUrl.split(',');
          const base64 = parts[1] ?? parts[0];
          const binaryString = atob(base64);
          const len = binaryString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          arrayBuffer = bytes.buffer;
        } else if (typeof window !== 'undefined' && typeof fetch === 'function') {
          const res = await fetch(dataUrl).catch(() => null);
          if (!res || !res.ok) return null;
          arrayBuffer = await res.arrayBuffer();
        } else {
          return null;
        }
        const decoded = await ctx.decodeAudioData(arrayBuffer);
        this.buffers[cue] = decoded;
        return decoded;
      } catch {
        return null;
      }
    })();
    return this.loading[cue]!;
  }

  private playBuffer(ctx: AudioContext, buffer: AudioBuffer): void {
    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(this.volume, now);
    masterGain.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(masterGain);
    source.start(now);
  }

  public play(cue: SoundCue): void {
    if (!this.enabled || this.volume <= 0) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const dataUrl = AUDIO_SOURCES[cue];
    if (dataUrl) {
      const buffer = this.buffers[cue];
      if (buffer) {
        this.playBuffer(ctx, buffer);
        return;
      }
      this.loadBuffer(cue, dataUrl).then(buf => {
        if (buf && this.enabled && this.volume > 0) {
          const freshCtx = this.getContext();
          if (freshCtx) this.playBuffer(freshCtx, buf);
        }
      });
      return;
    }

    try {
      const now = ctx.currentTime;
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(this.volume * 0.25, now);
      masterGain.connect(ctx.destination);

      switch (cue) {
        case 'click':
          this.synthesizeHaptic(ctx, masterGain, now, 900, 0.015);
          break;
        case 'channelSwitch':
          this.synthesizeHaptic(ctx, masterGain, now, 520, 0.025);
          break;
        case 'messageSent':
          this.synthesizeChirp(ctx, masterGain, now, 720, 960, 0.04);
          break;
      }
    } catch {
      // Audio playback should never interrupt UI execution.
    }
  }

  private synthesizeChirp(ctx: AudioContext, dest: GainNode, now: number, startFreq: number, endFreq: number, duration: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.5, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  private synthesizeHaptic(ctx: AudioContext, dest: GainNode, now: number, freq: number, duration: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(now);
    osc.stop(now + duration + 0.01);
  }
}

export const soundEngine = new SoundEngine();
