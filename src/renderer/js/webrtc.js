/**
 * WebRTC Multi-Peer Mesh Manager
 *
 * Every peer connection carries four m-lines in a fixed order — mic, camera,
 * screen, screen audio — so camera and screen share travel on separate tracks
 * and can be active at the same time. Toggling a device is a replaceTrack() on
 * the matching sender, which needs no renegotiation and therefore never
 * disturbs the voice channel.
 *
 * Only the offering side calls addTransceiver: per spec, setRemoteDescription
 * associates m-lines with transceivers created by addTrack, never with ones
 * created by addTransceiver, so pre-creating them on the answering side just
 * leaves orphans and the answer ends up recvonly. The answering side therefore
 * adopts the transceivers that setRemoteDescription creates for it.
 *
 * Signalling follows the "perfect negotiation" pattern: the side that opens the
 * connection is impolite, the side that receives the first offer is polite, so
 * either one can re-offer to restart ICE without the two colliding. ICE
 * candidates that arrive before the matching description is set are queued
 * instead of thrown away — dropping them is what used to leave one pair of a
 * three-way call silently half-connected.
 */

const CHANNEL_ORDER = ['mic', 'cam', 'screen', 'screenAudio'];

// A connection that never reaches 'connected', or falls out of it, is retried
// with a backoff instead of being torn down: 'disconnected' is often transient.
const CONNECT_TIMEOUT_MS = 12000;
const DISCONNECT_GRACE_MS = 6000;
const MAX_RESTART_ATTEMPTS = 10;

// Public, rate-limited TURN relay (Open Relay Project) used as a fallback so
// calls still connect behind strict NATs/symmetric firewalls where STUN alone
// fails. It's a shared testing service, not meant for heavy daily use — add
// your own TURN server (coturn, or a paid provider) in Configurações >
// Servidor for reliable long-term use; anything entered there is prepended
// ahead of this fallback.
const DEFAULT_TURN_SERVERS = [
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

// How often to sample getStats() for the on-tile connection quality indicator
const QUALITY_POLL_MS = 3000;

class WebRTCManager {
  constructor(socket, currentUserId, options = {}) {
    this.socket = socket;
    this.currentUserId = currentUserId;

    // Map: socketId -> RTCPeerConnection
    this.peers = new Map();
    // Map: socketId -> { mic, cam, screen, screenAudio } RTCRtpTransceivers
    this.peerChannels = new Map();
    // Map: socketId -> negotiation bookkeeping (see createPeerConnection)
    this.peerState = new Map();
    // Map: socketId -> ICE candidates that arrived before the remote description
    this.pendingCandidates = new Map();
    // Map: socketId -> remote MediaStream (mic + camera)
    this.remoteStreams = new Map();
    // Map: socketId -> remote MediaStream (screen video + screen audio)
    this.remoteScreenStreams = new Map();

    // Local streams
    this.localMicStream = null;
    this.localCamStream = null;
    this.localScreenStream = null;

    // Camera background effects (see startCamera / setCameraEffect)
    this.rawCamStream = null;
    this.cameraEffects = null;
    this.cameraEffect = { type: 'none' };
    this.cameraEffectVersion = 0;
    this.onLocalCameraChanged = null; // (stream)

    // Owns the raw capture + RNNoise pipeline behind localMicStream
    this.micCapture = null;
    this.noiseSuppressionMode = null; // 'rnnoise' | 'native' | 'off'

    // Callbacks
    this.onRemoteStreamAdded = null; // (socketId, stream, isScreen)
    this.onRemoteStreamRemoved = null; // (socketId, isScreen)
    this.onConnectionQualityChanged = null; // (socketId, { level: 'good'|'ok'|'bad', rttMs, lossPct })

    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      // A user-supplied TURN server (Configurações > Servidor) goes first so it
      // wins over the shared fallback below when both are reachable
      ...(Array.isArray(options.iceServers) ? options.iceServers : []),
      ...DEFAULT_TURN_SERVERS
    ];

    this.setupSocketListeners();
  }

  setupSocketListeners() {
    // Handle incoming WebRTC Offer
    this.socket.on('webrtc-offer', async ({ senderSocketId, offer, type }) => {
      console.log(`[WebRTC] Received offer from ${senderSocketId} (${type})`);
      // Whoever receives the first offer is the polite side of this pair
      const pc = this.peers.get(senderSocketId) ||
        this.createPeerConnection(senderSocketId, { polite: true });
      const negotiation = this.peerState.get(senderSocketId);
      if (!negotiation) return;

      // Perfect negotiation: on a collision only the polite side gives way
      const collision = negotiation.makingOffer || pc.signalingState !== 'stable';
      if (collision && !negotiation.polite) {
        console.warn(`[WebRTC] Ignoring colliding offer from ${senderSocketId}`);
        return;
      }

      try {
        // Implicit rollback when we had an offer of our own in flight
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        this.adoptChannels(senderSocketId, pc);
        await this.flushPendingCandidates(senderSocketId);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.socket.emit('webrtc-answer', {
          targetSocketId: senderSocketId,
          answer: pc.localDescription,
          type: type || 'mesh'
        });

        this.armConnectTimeout(senderSocketId);
      } catch (err) {
        console.error('[WebRTC] Error handling offer:', err);
        this.scheduleRestart(senderSocketId);
      }
    });

    // Handle incoming WebRTC Answer
    this.socket.on('webrtc-answer', async ({ senderSocketId, answer }) => {
      console.log(`[WebRTC] Received answer from ${senderSocketId}`);
      const pc = this.peers.get(senderSocketId);
      if (!pc) return;

      // A late answer to an offer we already rolled back would throw
      if (pc.signalingState !== 'have-local-offer') {
        console.warn(`[WebRTC] Dropping answer from ${senderSocketId} in state ${pc.signalingState}`);
        return;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await this.flushPendingCandidates(senderSocketId);
      } catch (err) {
        console.error('[WebRTC] Error setting remote description for answer:', err);
        this.scheduleRestart(senderSocketId);
      }
    });

    // Handle incoming ICE candidate. Candidates routinely arrive before the
    // description they belong to; queue those instead of dropping them.
    this.socket.on('webrtc-ice-candidate', async ({ senderSocketId, candidate }) => {
      if (!candidate) return;

      const pc = this.peers.get(senderSocketId);
      if (!pc || !pc.remoteDescription) {
        const queue = this.pendingCandidates.get(senderSocketId) || [];
        queue.push(candidate);
        this.pendingCandidates.set(senderSocketId, queue);
        return;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('[WebRTC] Error adding ICE candidate:', err);
      }
    });
  }

  /**
   * Adopt the transceivers setRemoteDescription created for us, in m-line
   * order. Only needed once per peer: later offers reuse the same m-lines.
   */
  adoptChannels(socketId, pc) {
    if (this.peerChannels.has(socketId)) return;

    const transceivers = pc.getTransceivers();
    const channels = {};
    CHANNEL_ORDER.forEach((name, index) => {
      const transceiver = transceivers[index];
      if (!transceiver) return;
      // They arrive recvonly; we have to answer sendrecv to be able to send
      transceiver.direction = 'sendrecv';
      channels[name] = transceiver;
    });

    this.peerChannels.set(socketId, channels);
    this.attachLocalTracks(socketId);
  }

  /**
   * Drain the candidates that arrived before the remote description was set.
   */
  async flushPendingCandidates(socketId) {
    const queue = this.pendingCandidates.get(socketId);
    if (!queue || !queue.length) return;

    const pc = this.peers.get(socketId);
    this.pendingCandidates.delete(socketId);
    if (!pc) return;

    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('[WebRTC] Error adding queued ICE candidate:', err);
      }
    }
  }

  /**
   * Push a track (or null to stop sending) onto the matching sender of every peer.
   */
  applyTrackToPeers(channel, track) {
    this.peerChannels.forEach((channels, socketId) => {
      const transceiver = channels[channel];
      if (!transceiver || !transceiver.sender) return;

      transceiver.sender.replaceTrack(track).catch(err => {
        console.error(`[WebRTC] replaceTrack(${channel}) failed for ${socketId}:`, err);
      });
    });
  }

  /**
   * Acquire the microphone with echo cancellation and noise suppression
   * (RNNoise when available, the browser's built-in suppressor otherwise).
   */
  async startMicrophone(audioDeviceId = null, noiseSuppression = true) {
    try {
      const mic = await window.captureMicrophone({
        echoCancellation: true,
        autoGainControl: true,
        ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {})
      }, noiseSuppression);

      this.stopMicrophone();
      this.micCapture = mic;
      this.localMicStream = mic.stream;
      this.noiseSuppressionMode = mic.mode;
      console.info(`[WebRTC] Microphone started, noise suppression: ${mic.mode}`);

      this.applyTrackToPeers('mic', this.localMicStream.getAudioTracks()[0] || null);
      return this.localMicStream;
    } catch (err) {
      console.error('[WebRTC] Error accessing microphone:', err);
      throw err;
    }
  }

  stopMicrophone() {
    if (this.micCapture) {
      this.micCapture.release();
      this.micCapture = null;
    }
    if (this.localMicStream) {
      this.localMicStream.getTracks().forEach(t => t.stop());
      this.localMicStream = null;
    }
    this.noiseSuppressionMode = null;
  }

  /**
   * Acquire the webcam. rawCamStream is the device capture; localCamStream is
   * what peers and the local preview see: the raw stream, or the background
   * effects output once it is ready.
   */
  async startCamera(videoDeviceId = null) {
    try {
      const constraints = {
        audio: false,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {})
        }
      };

      this.rawCamStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.useCameraStream(this.rawCamStream);

      // The camera shows up immediately; the effect takes over when the model has loaded
      if (this.cameraEffect.type !== 'none') {
        this.setCameraEffect(this.cameraEffect).catch(err => {
          console.warn('[WebRTC] Camera effect unavailable:', err);
        });
      }

      return this.localCamStream;
    } catch (err) {
      console.error('[WebRTC] Error accessing camera:', err);
      throw err;
    }
  }

  /**
   * Switch the background effect, live if the camera is on. Swapping between
   * raw and processed video is a replaceTrack, so no renegotiation happens.
   */
  async setCameraEffect(effect) {
    this.cameraEffect = effect;
    const version = ++this.cameraEffectVersion;
    if (!this.rawCamStream) return;

    if (effect.type === 'none') {
      this.useCameraStream(this.rawCamStream);
      this.stopCameraEffects();
      return;
    }

    if (this.cameraEffects) {
      await this.cameraEffects.setEffect(effect);
      return;
    }

    const rawTrack = this.rawCamStream.getVideoTracks()[0];
    const processor = await window.CameraEffectsProcessor.create(rawTrack, effect);

    // The camera was turned off or another effect was picked while loading
    const stale = version !== this.cameraEffectVersion ||
      !this.rawCamStream || this.rawCamStream.getVideoTracks()[0] !== rawTrack;
    if (stale) {
      processor.stop();
      return;
    }

    this.cameraEffects = processor;
    this.useCameraStream(processor.stream);
  }

  useCameraStream(stream) {
    if (this.localCamStream === stream) return;
    this.localCamStream = stream;

    const track = stream.getVideoTracks()[0] || null;
    if (track) track.contentHint = 'motion';
    this.applyTrackToPeers('cam', track);

    if (this.onLocalCameraChanged) this.onLocalCameraChanged(stream);
  }

  stopCameraEffects() {
    if (this.cameraEffects) {
      this.cameraEffects.stop();
      this.cameraEffects = null;
    }
  }

  stopCamera() {
    this.applyTrackToPeers('cam', null);
    this.cameraEffectVersion++;
    this.stopCameraEffects();

    if (this.rawCamStream) {
      this.rawCamStream.getTracks().forEach(t => t.stop());
      this.rawCamStream = null;
    }
    this.localCamStream = null;
  }

  /**
   * Set local screen share stream
   */
  setScreenStream(screenStream) {
    this.localScreenStream = screenStream;
    if (!screenStream) {
      this.applyTrackToPeers('screen', null);
      this.applyTrackToPeers('screenAudio', null);
      return;
    }

    const screenTrack = screenStream.getVideoTracks()[0];
    if (screenTrack) screenTrack.contentHint = 'detail';

    this.applyTrackToPeers('screen', screenTrack || null);
    this.applyTrackToPeers('screenAudio', screenStream.getAudioTracks()[0] || null);
  }

  stopScreenShare() {
    this.applyTrackToPeers('screen', null);
    this.applyTrackToPeers('screenAudio', null);

    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(t => t.stop());
      this.localScreenStream = null;
    }
  }

  createPeerConnection(socketId, { polite = false } = {}) {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers
    });

    this.peerState.set(socketId, {
      polite,
      makingOffer: false,
      restartAttempts: 0,
      restartTimer: null,
      graceTimer: null
    });

    // Send ICE candidates to target peer
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-ice-candidate', {
          targetSocketId: socketId,
          candidate: event.candidate,
          type: 'mesh'
        });
      }
    };

    // Receive remote tracks, routed by the m-line they arrived on. The index
    // into getTransceivers() matches CHANNEL_ORDER on both sides, and is
    // available even before the answering side has adopted its channels.
    pc.ontrack = (event) => {
      const channel = CHANNEL_ORDER[pc.getTransceivers().indexOf(event.transceiver)];
      const isScreen = channel === 'screen' || channel === 'screenAudio';
      console.log(`[WebRTC] Remote ${event.track.kind} track from ${socketId} (${channel || 'unknown'})`);

      const streamMap = isScreen ? this.remoteScreenStreams : this.remoteStreams;
      let remoteStream = streamMap.get(socketId);
      if (!remoteStream) {
        remoteStream = new MediaStream();
        streamMap.set(socketId, remoteStream);
      }

      if (!remoteStream.getTracks().includes(event.track)) {
        remoteStream.addTrack(event.track);
      }

      if (this.onRemoteStreamAdded) {
        this.onRemoteStreamAdded(socketId, remoteStream, isScreen);
      }
    };

    // A peer is only dropped when it actually leaves the room; a connection
    // that breaks is retried, because nothing else would ever bring it back.
    pc.onconnectionstatechange = () => {
      const negotiation = this.peerState.get(socketId);
      console.log(`[WebRTC] Connection state with ${socketId}: ${pc.connectionState}`);
      if (!negotiation) return;

      if (pc.connectionState === 'connected') {
        this.clearRecoveryTimers(socketId);
        negotiation.restartAttempts = 0;
        if (!negotiation.statsInterval) {
          negotiation.statsInterval = setInterval(() => this.pollConnectionQuality(socketId), QUALITY_POLL_MS);
          this.pollConnectionQuality(socketId);
        }
        return;
      }

      this.stopQualityPolling(socketId);

      if (pc.connectionState === 'failed') {
        this.scheduleRestart(socketId);
        return;
      }

      // 'disconnected' usually heals by itself within a few seconds
      if (pc.connectionState === 'disconnected' && !negotiation.graceTimer) {
        negotiation.graceTimer = setTimeout(() => {
          negotiation.graceTimer = null;
          const current = this.peers.get(socketId);
          if (current && current.connectionState !== 'connected') {
            this.scheduleRestart(socketId);
          }
        }, DISCONNECT_GRACE_MS);
      }
    };

    this.peers.set(socketId, pc);
    return pc;
  }

  /**
   * Send an offer to a peer, optionally restarting ICE. Safe to call from
   * either side: a collision is resolved by the perfect-negotiation rules.
   */
  async sendOffer(socketId, { iceRestart = false } = {}) {
    const pc = this.peers.get(socketId);
    const negotiation = this.peerState.get(socketId);
    if (!pc || !negotiation) return;

    // A negotiation is already in flight; come back to it if it does not settle
    if (pc.signalingState !== 'stable') {
      console.warn(`[WebRTC] Skipping offer to ${socketId}, state ${pc.signalingState}`);
      this.scheduleRestart(socketId);
      return;
    }

    try {
      negotiation.makingOffer = true;
      if (iceRestart) pc.restartIce();

      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') {
        // An incoming offer won the race; that handshake takes over from here
        this.armConnectTimeout(socketId);
        return;
      }
      await pc.setLocalDescription(offer);

      this.socket.emit('webrtc-offer', {
        targetSocketId: socketId,
        offer: pc.localDescription,
        type: 'mesh'
      });

      this.armConnectTimeout(socketId);
    } catch (err) {
      console.error(`[WebRTC] Error offering to peer ${socketId}:`, err);
      this.scheduleRestart(socketId);
    } finally {
      negotiation.makingOffer = false;
    }
  }

  /**
   * If the handshake never produces a connected peer — a lost candidate, an
   * answer that never came — retry rather than sit there mute.
   */
  armConnectTimeout(socketId) {
    const negotiation = this.peerState.get(socketId);
    if (!negotiation || negotiation.restartTimer) return;

    negotiation.restartTimer = setTimeout(() => {
      negotiation.restartTimer = null;
      const pc = this.peers.get(socketId);
      if (pc && pc.connectionState !== 'connected') {
        console.warn(`[WebRTC] ${socketId} still ${pc.connectionState} after handshake, restarting`);
        this.restartConnection(socketId);
      }
    }, CONNECT_TIMEOUT_MS);
  }

  scheduleRestart(socketId) {
    const negotiation = this.peerState.get(socketId);
    if (!negotiation || negotiation.restartTimer) return;

    if (negotiation.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      console.error(`[WebRTC] Giving up on ${socketId} after ${negotiation.restartAttempts} attempts`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, negotiation.restartAttempts), 15000);
    negotiation.restartTimer = setTimeout(() => {
      negotiation.restartTimer = null;
      this.restartConnection(socketId);
    }, delay);
  }

  restartConnection(socketId) {
    const pc = this.peers.get(socketId);
    const negotiation = this.peerState.get(socketId);
    if (!pc || !negotiation) return;
    if (pc.connectionState === 'connected') return;

    negotiation.restartAttempts++;
    console.warn(`[WebRTC] Restarting ICE with ${socketId} (attempt ${negotiation.restartAttempts})`);
    this.sendOffer(socketId, { iceRestart: true });
  }

  clearRecoveryTimers(socketId) {
    const negotiation = this.peerState.get(socketId);
    if (!negotiation) return;

    clearTimeout(negotiation.restartTimer);
    clearTimeout(negotiation.graceTimer);
    negotiation.restartTimer = null;
    negotiation.graceTimer = null;
  }

  stopQualityPolling(socketId) {
    const negotiation = this.peerState.get(socketId);
    if (!negotiation || !negotiation.statsInterval) return;
    clearInterval(negotiation.statsInterval);
    negotiation.statsInterval = null;
  }

  /**
   * Sample getStats() for a rough, cheap-to-compute signal: round-trip time on
   * the active candidate pair plus inbound packet loss, bucketed into
   * good/ok/bad for the little indicator on each tile.
   */
  async pollConnectionQuality(socketId) {
    const pc = this.peers.get(socketId);
    if (!pc || pc.connectionState !== 'connected' || !this.onConnectionQualityChanged) return;

    try {
      const stats = await pc.getStats();
      let rttMs = null;
      let packetsLost = 0;
      let packetsTotal = 0;

      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' &&
            (report.nominated || report.selected) && typeof report.currentRoundTripTime === 'number') {
          rttMs = report.currentRoundTripTime * 1000;
        }
        if (report.type === 'inbound-rtp' && !report.isRemote) {
          const lost = report.packetsLost || 0;
          packetsLost += lost;
          packetsTotal += lost + (report.packetsReceived || 0);
        }
      });

      const lossPct = packetsTotal > 0 ? (packetsLost / packetsTotal) * 100 : 0;
      let level = 'good';
      if ((rttMs !== null && rttMs > 300) || lossPct > 8) level = 'bad';
      else if ((rttMs !== null && rttMs > 150) || lossPct > 3) level = 'ok';

      this.onConnectionQualityChanged(socketId, { level, rttMs, lossPct });
    } catch (err) {
      // getStats() rejecting mid-teardown isn't worth logging
    }
  }

  /**
   * Push whatever is currently live locally onto one peer's senders.
   */
  attachLocalTracks(socketId) {
    const channels = this.peerChannels.get(socketId);
    if (!channels) return;

    const assign = (name, track) => {
      const transceiver = channels[name];
      if (transceiver && transceiver.sender) {
        transceiver.sender.replaceTrack(track).catch(() => {});
      }
    };

    if (this.localMicStream) assign('mic', this.localMicStream.getAudioTracks()[0] || null);
    if (this.localCamStream) assign('cam', this.localCamStream.getVideoTracks()[0] || null);
    if (this.localScreenStream) {
      assign('screen', this.localScreenStream.getVideoTracks()[0] || null);
      assign('screenAudio', this.localScreenStream.getAudioTracks()[0] || null);
    }
  }

  async connectToPeer(socketId) {
    if (this.peers.has(socketId)) return;

    console.log(`[WebRTC] Initiating connection to peer ${socketId}`);
    // We opened this connection, so we are the impolite side of the pair
    const pc = this.createPeerConnection(socketId, { polite: false });

    // Fixed m-line layout. Only the offering side declares it; the answering
    // side adopts the same order from the offer.
    this.peerChannels.set(socketId, {
      mic: pc.addTransceiver('audio', { direction: 'sendrecv' }),
      cam: pc.addTransceiver('video', { direction: 'sendrecv' }),
      screen: pc.addTransceiver('video', { direction: 'sendrecv' }),
      screenAudio: pc.addTransceiver('audio', { direction: 'sendrecv' })
    });
    this.attachLocalTracks(socketId);

    await this.sendOffer(socketId);
  }

  removePeer(socketId) {
    this.clearRecoveryTimers(socketId);
    this.stopQualityPolling(socketId);

    if (this.peers.has(socketId)) {
      const pc = this.peers.get(socketId);
      pc.onconnectionstatechange = null;
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.close();
      this.peers.delete(socketId);
    }

    this.peerChannels.delete(socketId);
    this.peerState.delete(socketId);
    this.pendingCandidates.delete(socketId);

    [this.remoteStreams, this.remoteScreenStreams].forEach(streamMap => {
      const stream = streamMap.get(socketId);
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        streamMap.delete(socketId);
      }
    });

    if (this.onRemoteStreamRemoved) {
      this.onRemoteStreamRemoved(socketId);
    }
  }

  /**
   * Tear down every peer connection but keep the local mic/camera/screen
   * running — what switching channels needs. Leaving stale connections behind
   * makes connectToPeer() skip a peer we meet again in the next channel.
   */
  resetPeers() {
    Array.from(this.peers.keys()).forEach(socketId => this.removePeer(socketId));
    this.peers.clear();
    this.peerChannels.clear();
    this.peerState.clear();
    this.pendingCandidates.clear();
    this.remoteStreams.clear();
    this.remoteScreenStreams.clear();
  }

  cleanupAll() {
    this.resetPeers();

    this.stopMicrophone();
    this.stopCamera();
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(t => t.stop());
      this.localScreenStream = null;
    }
  }
}

window.WebRTCManager = WebRTCManager;
