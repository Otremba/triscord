// Procedural UI sound engine for Triscord.
// Uses Web Audio API oscillator synthesis with micro-second envelopes for zero-latency,
// click-free, and high-fidelity auditory feedback without asset fetching.

export type SoundCue =
  | 'join'
  | 'leave'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'click'
  | 'channelSwitch'
  | 'messageSent';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private enabled: boolean = true;
  private volume: number = 0.5; // 0.0 to 1.0

  constructor() {
    // AudioContext will be lazily initialized on first user interaction to comply with browser autoplay policies.
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

  public play(cue: SoundCue): void {
    if (!this.enabled || this.volume <= 0) return;
    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(this.volume * 0.25, now);
      masterGain.connect(ctx.destination);

      switch (cue) {
        case 'join':
          this.synthesizeChime(ctx, masterGain, now, [523.25, 783.99], 0.16);
          break;
        case 'leave':
          this.synthesizeChime(ctx, masterGain, now, [783.99, 440.0], 0.18);
          break;
        case 'mute':
          this.synthesizeChirp(ctx, masterGain, now, 620, 360, 0.08);
          break;
        case 'unmute':
          this.synthesizeChirp(ctx, masterGain, now, 380, 680, 0.08);
          break;
        case 'deafen':
          this.synthesizeClick(ctx, masterGain, now, 180, 0.06);
          break;
        case 'undeafen':
          this.synthesizeClick(ctx, masterGain, now, 440, 0.06);
          break;
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
      // Audio synthesis failures should never interrupt UI interaction.
    }
  }

  private synthesizeChime(ctx: AudioContext, dest: GainNode, now: number, notes: number[], durationPerNote: number): void {
    notes.forEach((freq, idx) => {
      const start = now + idx * (durationPerNote * 0.65);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.6, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + durationPerNote);

      osc.connect(gain);
      gain.connect(dest);

      osc.start(start);
      osc.stop(start + durationPerNote + 0.02);
    });
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

  private synthesizeClick(ctx: AudioContext, dest: GainNode, now: number, freq: number, duration: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.4, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(now);
    osc.stop(now + duration + 0.01);
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
