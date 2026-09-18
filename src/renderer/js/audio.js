/**
 * Audio System: Sound FX Synthesizer + Real-time Speaking Voice Activity Detector (VAD)
 */

class SoundEffects {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  getAudioContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  playJoin() {
    if (!this.enabled) return;
    const ctx = this.getAudioContext();
    const now = ctx.currentTime;
    
    // Smooth dual chime (Discord-style join)
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';

    osc1.frequency.setValueAtTime(440, now); // A4
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5
    osc2.frequency.setValueAtTime(554.37, now); // C#5
    osc2.frequency.exponentialRampToValueAtTime(1108.73, now + 0.18);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.35);
    osc2.stop(now + 0.35);
  }

  playLeave() {
    if (!this.enabled) return;
    const ctx = this.getAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(659.25, now); // E5
    osc.frequency.exponentialRampToValueAtTime(329.63, now + 0.2); // E4

    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.25);
  }

  playMute(isMuted) {
    if (!this.enabled) return;
    const ctx = this.getAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    if (isMuted) {
      // Descending tone
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(300, now + 0.12);
    } else {
      // Ascending tone
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.12);
    }

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.15);
  }

  playMessage() {
    if (!this.enabled) return;
    const ctx = this.getAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.08);

    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.12);
  }
}

class SpeakingDetector {
  constructor(stream, onSpeakingChange, options = {}) {
    this.stream = stream;
    this.onSpeakingChange = onSpeakingChange;
    this.threshold = options.threshold || 15; // 0-100 threshold
    this.smoothing = options.smoothing || 0.8;
    this.isSpeaking = false;
    this.audioContext = null;
    this.analyser = null;
    this.microphone = null;
    this.javascriptNode = null;
    this.active = false;
    this.silenceTimeout = null;

    this.init();
  }

  init() {
    try {
      const audioTracks = this.stream.getAudioTracks();
      if (audioTracks.length === 0) return;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = this.smoothing;

      this.microphone = this.audioContext.createMediaStreamSource(this.stream);
      this.microphone.connect(this.analyser);

      this.active = true;
      this.bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(this.bufferLength);

      this.checkAudioLevel();
    } catch (e) {
      console.warn('SpeakingDetector initialization error:', e);
    }
  }

  setThreshold(val) {
    this.threshold = val;
  }

  checkAudioLevel = () => {
    if (!this.active || !this.analyser) return;

    this.analyser.getByteFrequencyData(this.dataArray);
    let sum = 0;
    for (let i = 0; i < this.bufferLength; i++) {
      sum += this.dataArray[i];
    }
    const average = sum / this.bufferLength;

    const speakingNow = average > this.threshold;

    if (speakingNow) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.onSpeakingChange(true, average);
      }
      if (this.silenceTimeout) {
        clearTimeout(this.silenceTimeout);
        this.silenceTimeout = null;
      }
    } else {
      if (this.isSpeaking && !this.silenceTimeout) {
        this.silenceTimeout = setTimeout(() => {
          this.isSpeaking = false;
          this.onSpeakingChange(false, 0);
          this.silenceTimeout = null;
        }, 400); // 400ms buffer to prevent rapid flickering
      }
    }

    requestAnimationFrame(this.checkAudioLevel);
  };

  destroy() {
    this.active = false;
    if (this.silenceTimeout) clearTimeout(this.silenceTimeout);
    if (this.microphone) {
      try { this.microphone.disconnect(); } catch (e) {}
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { this.audioContext.close(); } catch (e) {}
    }
  }
}

window.SoundEffects = new SoundEffects();
window.SpeakingDetector = SpeakingDetector;
