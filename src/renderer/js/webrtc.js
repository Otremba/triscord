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
 *
 * Every RTCPeerConnection also gets a random session id that travels with all
 * of its signalling (session = the sender's, targetSession = the receiver's as
 * far as the sender knows). Without it an offer from a brand-new connection
 * (the peer rejoined, or rebuilt a connection that would not heal) looked like
 * a renegotiation of the old one: it was applied to a peer connection with the
 * wrong DTLS/ICE state, which can leave one pair of a call with audio flowing
 * in one direction only, or in none. Messages for a connection that no longer
 * exists are dropped. Peers or servers that do not send session ids fall back
 * to the plain perfect-negotiation behaviour.
 */

const CHANNEL_ORDER = ['mic', 'cam', 'screen', 'screenAudio'];

// A connection that never reaches 'connected', or falls out of it, is retried
// with a backoff instead of being torn down: 'disconnected' is often transient.
// Recovery is driven by the impolite side (the one that opened the connection);
// the polite side waits POLITE_BACKOFF_FACTOR times longer before stepping in,
// so the two rarely restart at the same moment.
const CONNECT_TIMEOUT_MS = 10000;
// An answer normally arrives well within a second; one that has not after this
// long was lost, and waiting for the full connect timeout only prolongs silence
const ANSWER_TIMEOUT_MS = 5000;
const DISCONNECT_GRACE_MS = 5000;
const MAX_RESTART_ATTEMPTS = 12;
const POLITE_BACKOFF_FACTOR = 3;
// Every third attempt throws the peer connection away and opens a new one
// instead of restarting ICE on it: some broken states (a half-applied offer, a
// DTLS mismatch) are not something an ICE restart can get out of.
const ICE_RESTARTS_BEFORE_REBUILD = 2;
const MAX_PENDING_CANDIDATES = 200;

// More STUN servers only yield duplicate server-reflexive candidates and slow
// gathering down; two are plenty.
const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

const DEFAULT_TURN_SERVERS = [
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

// How often to sample getStats() for the on-tile connection quality indicator
const QUALITY_POLL_MS = 3000;

// Screen share encoding. Measured in the Electron app with game-like motion
// at 1080p, the old setup (contentHint 'detail' and WebRTC's default 2.5 Mbps
// cap above 960x540) kept the resolution and dropped the frame rate to 6-18
// fps. 'motion' keeps the frame rate and lets the resolution adapt to the
// bandwidth instead. Caps are per viewer: in a mesh every viewer is a
// separate encode and upload, and bandwidth estimation still keeps each one
// within what the connection can carry.
const SCREEN_BITRATE_BPS = {
  720: { 30: 2500000, 60: 4000000 },
  1080: { 30: 4500000, 60: 8000000 }
};
// A little extra buffering on the receiving side of a screen share absorbs
// network jitter, which shows up as stutter; voice is left untouched
const SCREEN_JITTER_BUFFER_MS = 100;

function screenEncodingFor({ height = 1080, frameRate = 30, mode = 'motion' } = {}) {
  const byFps = SCREEN_BITRATE_BPS[height >= 1080 ? 1080 : 720];
  const fps = frameRate >= 60 ? 60 : 30;
  const sharp = mode === 'detail';
  return {
    contentHint: sharp ? 'detail' : 'motion',
    degradationPreference: sharp ? 'maintain-resolution' : 'maintain-framerate',
    maxBitrate: byFps[fps],
    maxFramerate: fps
  };
}

function newSessionId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

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
    // Whether the server relays session ids and peers send them (see signal())
    this.sessionsSeen = false;
    // Map: socketId -> remote MediaStream (mic + camera)
    this.remoteStreams = new Map();
    // Map: socketId -> remote MediaStream (screen video + screen audio)
    this.remoteScreenStreams = new Map();

    // Local streams
    this.localMicStream = null;
    this.localCamStream = null;
    this.localScreenStream = null;
    this.screenEncoding = null; // see screenEncodingFor()

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

    this.userCustomIceServers = Array.isArray(options.iceServers) ? options.iceServers : [];
    this.iceTransportPolicy = options.iceTransportPolicy === 'relay' ? 'relay' : 'all';
    this.iceServers = [
      ...this.userCustomIceServers,
      ...DEFAULT_STUN_SERVERS,
      ...DEFAULT_TURN_SERVERS
    ];

    this.setupSocketListeners();
  }

  updateIceServers(servers, iceTransportPolicy = this.iceTransportPolicy) {
    if (Array.isArray(servers) && servers.length > 0) {
      const combined = [
        ...this.userCustomIceServers,
        ...servers,
        ...DEFAULT_STUN_SERVERS,
        ...DEFAULT_TURN_SERVERS
      ];
      const seen = new Set();
      const iceServers = combined.filter(s => {
        const key = JSON.stringify(s);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const transportPolicy = iceTransportPolicy === 'relay' ? 'relay' : 'all';
      const serversChanged = JSON.stringify(iceServers) !== JSON.stringify(this.iceServers);
      const policyChanged = transportPolicy !== this.iceTransportPolicy;
      if (!serversChanged && !policyChanged) return;

      this.iceServers = iceServers;
      this.iceTransportPolicy = transportPolicy;
      console.log(`[WebRTC] Updated ICE servers (${this.iceServers.length}), transport policy: ${transportPolicy}`);

      this.peers.forEach((pc, socketId) => {
        try {
          pc.setConfiguration({
            ...pc.getConfiguration(),
            iceServers: this.iceServers,
            iceTransportPolicy: this.iceTransportPolicy
          });
          // A working connection keeps its path; only one still trying to
          // connect restarts ICE to gather candidates from the new servers
          const negotiation = this.peerState.get(socketId);
          if (!negotiation || negotiation.polite || pc.connectionState === 'connected') return;

          negotiation.iceRestartPending = true;
          if (pc.signalingState === 'stable') this.flushIceRestart(socketId);
        } catch (err) {
          console.error(`[WebRTC] Failed to update ICE configuration for ${socketId}:`, err);
        }
      });
    }
  }

  flushIceRestart(socketId) {
    const pc = this.peers.get(socketId);
    const negotiation = this.peerState.get(socketId);
    if (!pc || !negotiation || !negotiation.iceRestartPending || pc.signalingState !== 'stable') return;

    negotiation.iceRestartPending = false;
    console.log(`[WebRTC] Restarting ICE with ${socketId} after ICE server update`);
    this.sendOffer(socketId, { iceRestart: true });
  }

  /**
   * Emit a signalling message for one peer, tagged with both session ids.
   * Nothing is sent while the socket is down: socket.io would buffer it and
   * deliver it after reconnecting under a new socket id, for a peer connection
   * that the rejoin has already replaced.
   */
  signal(event, socketId, payload) {
    if (!this.socket.connected) return;
    const negotiation = this.peerState.get(socketId);
    this.socket.emit(event, {
      targetSocketId: socketId,
      type: 'mesh',
      ...payload,
      session: negotiation ? negotiation.localSession : undefined,
      targetSession: (negotiation && negotiation.remoteSession) || undefined
    });
  }

  setupSocketListeners() {
    // Handle incoming WebRTC Offer
    this.socket.on('webrtc-offer', async ({ senderSocketId, offer, session, targetSession }) => {
      console.log(`[WebRTC] Received offer from ${senderSocketId}`);
      let pc = this.peers.get(senderSocketId);
      let negotiation = this.peerState.get(senderSocketId);

      if (pc && session) {
        // Meant for a connection of ours that has since been replaced
        if (targetSession && targetSession !== negotiation.localSession) {
          console.warn(`[WebRTC] Dropping stale offer from ${senderSocketId}`);
          return;
        }

        // The peer opened a brand-new connection: ours belongs to one that no
        // longer exists on their side, and renegotiating it would half-work
        if (!targetSession && session !== negotiation.remoteSession) {
          const bothJustOpened = !negotiation.polite && !negotiation.remoteSession;
          if (bothJustOpened && this.socket.id < senderSocketId) {
            // Both sides opened a connection at once: the lower socket id keeps
            // its own, the other side yields and answers it
            console.warn(`[WebRTC] Both sides opened a connection with ${senderSocketId}, keeping ours`);
            return;
          }
          console.warn(`[WebRTC] ${senderSocketId} opened a new connection, replacing ours`);
          const early = this.pendingCandidates.get(senderSocketId);
          this.removePeer(senderSocketId);
          if (early) this.pendingCandidates.set(senderSocketId, early);
          pc = null;
        }
      }

      // Whoever receives the first offer is the polite side of this pair
      if (!pc) {
        pc = this.createPeerConnection(senderSocketId, { polite: true });
        negotiation = this.peerState.get(senderSocketId);
      }
      if (session) {
        negotiation.remoteSession = session;
        negotiation.peerUsesSessions = true;
        this.sessionsSeen = true;
      }

      // Perfect negotiation: on a collision only the polite side gives way
      const collision = negotiation.makingOffer || pc.signalingState !== 'stable';
      negotiation.ignoreOffer = collision && !negotiation.polite;
      if (negotiation.ignoreOffer) {
        console.warn(`[WebRTC] Ignoring colliding offer from ${senderSocketId}`);
        return;
      }

      try {
        // Implicit rollback when we had an offer of our own in flight
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        if (this.peers.get(senderSocketId) !== pc) return;
        this.adoptChannels(senderSocketId, pc);
        await this.flushPendingCandidates(senderSocketId);

        const answer = await pc.createAnswer();
        if (this.peers.get(senderSocketId) !== pc) return;
        await pc.setLocalDescription(answer);

        this.signal('webrtc-answer', senderSocketId, { answer: pc.localDescription });
        this.armConnectTimeout(senderSocketId);
      } catch (err) {
        if (this.peers.get(senderSocketId) !== pc) return;
        console.error('[WebRTC] Error handling offer:', err);
        this.scheduleRestart(senderSocketId);
      }
    });

    // Handle incoming WebRTC Answer
    this.socket.on('webrtc-answer', async ({ senderSocketId, answer, session, targetSession }) => {
      console.log(`[WebRTC] Received answer from ${senderSocketId}`);
      const pc = this.peers.get(senderSocketId);
      const negotiation = this.peerState.get(senderSocketId);
      if (!pc || !negotiation) return;

      // An answer to an offer made by a peer connection we have since replaced
      if (session && targetSession && targetSession !== negotiation.localSession) {
        console.warn(`[WebRTC] Dropping stale answer from ${senderSocketId}`);
        return;
      }

      // A late answer to an offer we already rolled back would throw
      if (pc.signalingState !== 'have-local-offer') {
        console.warn(`[WebRTC] Dropping answer from ${senderSocketId} in state ${pc.signalingState}`);
        return;
      }

      if (session) {
        negotiation.remoteSession = session;
        negotiation.peerUsesSessions = true;
        this.sessionsSeen = true;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await this.flushPendingCandidates(senderSocketId);
      } catch (err) {
        if (this.peers.get(senderSocketId) !== pc) return;
        console.error('[WebRTC] Error setting remote description for answer:', err);
        this.scheduleRestart(senderSocketId);
      }
    });

    // Handle incoming ICE candidate. Candidates routinely arrive before the
    // description they belong to; queue those instead of dropping them.
    this.socket.on('webrtc-ice-candidate', async ({ senderSocketId, candidate, session, targetSession }) => {
      if (!candidate) return;

      const pc = this.peers.get(senderSocketId);
      const negotiation = this.peerState.get(senderSocketId);

      let belongsToOtherSession = false;
      if (negotiation && session) {
        // Gathered for a connection of ours that was replaced
        if (targetSession && targetSession !== negotiation.localSession) return;
        if (negotiation.remoteSession && session !== negotiation.remoteSession) {
          // Gathered by an old connection of theirs — or by a new one whose
          // offer has not arrived yet: the queue keeps it until we know which
          if (targetSession) return;
          belongsToOtherSession = true;
        }
      }

      if (!pc || !pc.remoteDescription || belongsToOtherSession) {
        const queue = this.pendingCandidates.get(senderSocketId) || [];
        if (queue.length < MAX_PENDING_CANDIDATES) queue.push({ candidate, session });
        this.pendingCandidates.set(senderSocketId, queue);
        return;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        // Candidates of an offer we deliberately ignored are expected to fail
        if (!negotiation || !negotiation.ignoreOffer) {
          console.warn('[WebRTC] Error adding ICE candidate:', err);
        }
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
    const negotiation = this.peerState.get(socketId);
    this.pendingCandidates.delete(socketId);
    if (!pc) return;

    // Candidates of another remote session stay queued: they belong either to
    // a connection the peer replaced, or to one whose offer is still on its way
    const remoteSession = negotiation && negotiation.remoteSession;
    const later = [];
    for (const entry of queue) {
      const { candidate, session } = entry;
      if (remoteSession && session && session !== remoteSession) {
        later.push(entry);
        continue;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('[WebRTC] Error adding queued ICE candidate:', err);
      }
    }

    if (later.length && this.peers.get(socketId) === pc) {
      const arrivedMeanwhile = this.pendingCandidates.get(socketId) || [];
      this.pendingCandidates.set(socketId, later.concat(arrivedMeanwhile).slice(-MAX_PENDING_CANDIDATES));
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
      const constraints = {
        echoCancellation: true,
        autoGainControl: true
      };
      if (audioDeviceId && audioDeviceId !== 'default' && audioDeviceId !== 'communications') {
        constraints.deviceId = { exact: audioDeviceId };
      }

      const mic = await window.captureMicrophone(constraints, noiseSuppression);

      this.stopMicrophone();
      this.micCapture = mic;
      this.localMicStream = mic.stream;
      this.noiseSuppressionMode = mic.mode;
      console.info(`[WebRTC] Microphone started, noise suppression: ${mic.mode}`);

      this.applyTrackToPeers('mic', this.localMicStream.getAudioTracks()[0] || null);
      return this.localMicStream;
    } catch (err) {
      console.error('[WebRTC] Error accessing microphone:', err);
      // Final mobile fallback: pure audio
      try {
        console.warn('[WebRTC] Retrying microphone with pure audio: true');
        const fallbackStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this.stopMicrophone();
        this.localMicStream = fallbackStream;
        this.noiseSuppressionMode = 'off';
        this.applyTrackToPeers('mic', this.localMicStream.getAudioTracks()[0] || null);
        return this.localMicStream;
      } catch (fallbackErr) {
        console.error('[WebRTC] Ultimate microphone fallback failed:', fallbackErr);
        throw err;
      }
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
      const videoConstraints = {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 30 }
      };

      if (videoDeviceId && videoDeviceId !== 'default') {
        videoConstraints.deviceId = { exact: videoDeviceId };
      } else {
        videoConstraints.facingMode = 'user';
      }

      const constraints = {
        audio: false,
        video: videoConstraints
      };

      try {
        this.rawCamStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (camErr) {
        console.warn('[WebRTC] Constrained camera failed, falling back to basic video:', camErr);
        this.rawCamStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      }

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
  /**
   * @param profile { height, frameRate, mode } as picked in the share dialog;
   *   mode 'motion' (games, video) or 'detail' (text, code)
   */
  setScreenStream(screenStream, profile = {}) {
    this.localScreenStream = screenStream;
    if (!screenStream) {
      this.applyTrackToPeers('screen', null);
      this.applyTrackToPeers('screenAudio', null);
      return;
    }

    this.screenEncoding = screenEncodingFor(profile);
    const screenTrack = screenStream.getVideoTracks()[0];
    if (screenTrack) screenTrack.contentHint = this.screenEncoding.contentHint;

    this.applyTrackToPeers('screen', screenTrack || null);
    this.applyTrackToPeers('screenAudio', screenStream.getAudioTracks()[0] || null);
    this.peerChannels.forEach((_, socketId) => this.applyScreenEncoding(socketId));
  }

  /**
   * Put the screen share's bitrate cap, frame rate and degradation preference
   * on one peer's screen sender. Each viewer has its own encoder in a mesh,
   * so this runs per peer — again once a peer finishes connecting, because a
   * sender has no encodings to configure before its first negotiation.
   */
  async applyScreenEncoding(socketId) {
    const channels = this.peerChannels.get(socketId);
    const sender = channels && channels.screen && channels.screen.sender;
    if (!sender || !this.localScreenStream || !this.screenEncoding) return;

    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) return;

    const { maxBitrate, maxFramerate, degradationPreference } = this.screenEncoding;
    const encoding = params.encodings[0];
    if (encoding.maxBitrate === maxBitrate && encoding.maxFramerate === maxFramerate &&
        params.degradationPreference === degradationPreference) return;

    encoding.maxBitrate = maxBitrate;
    encoding.maxFramerate = maxFramerate;
    params.degradationPreference = degradationPreference;
    try {
      await sender.setParameters(params);
    } catch (err) {
      console.warn(`[WebRTC] Could not configure screen encoding for ${socketId}:`, err);
    }
  }

  stopScreenShare() {
    this.applyTrackToPeers('screen', null);
    this.applyTrackToPeers('screenAudio', null);

    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(t => t.stop());
      this.localScreenStream = null;
    }
  }

  createPeerConnection(socketId, { polite = false, restartAttempts = 0 } = {}) {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: this.iceTransportPolicy,
      // Gather for one transport only: without it every m-line gathers (and
      // allocates TURN relays) on its own until the answer arrives, which makes
      // the first connection noticeably slower
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    this.peerState.set(socketId, {
      polite,
      localSession: newSessionId(),
      remoteSession: null,
      peerUsesSessions: false,
      makingOffer: false,
      ignoreOffer: false,
      iceRestartPending: false,
      restartAttempts,
      restartTimer: null,
      graceTimer: null,
      answerTimer: null,
      offersSent: 0
    });

    // Send ICE candidates to target peer
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signal('webrtc-ice-candidate', socketId, { candidate: event.candidate });
      }
    };

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') {
        setTimeout(() => this.flushIceRestart(socketId), 0);
      }
    };

    // Receive remote tracks, routed by the m-line they arrived on. The index
    // into getTransceivers() matches CHANNEL_ORDER on both sides, and is
    // available even before the answering side has adopted its channels.
    pc.ontrack = (event) => {
      const channel = CHANNEL_ORDER[pc.getTransceivers().indexOf(event.transceiver)];
      const isScreen = channel === 'screen' || channel === 'screenAudio';
      console.log(`[WebRTC] Remote ${event.track.kind} track from ${socketId} (${channel || 'unknown'})`);

      // Same target on screen video and screen audio keeps the two in sync
      if (isScreen && 'jitterBufferTarget' in event.receiver) {
        event.receiver.jitterBufferTarget = SCREEN_JITTER_BUFFER_MS;
      }

      const streamMap = isScreen ? this.remoteScreenStreams : this.remoteStreams;
      let remoteStream = streamMap.get(socketId);
      if (!remoteStream) {
        remoteStream = new MediaStream();
        streamMap.set(socketId, remoteStream);
      }

      if (!remoteStream.getTracks().includes(event.track)) {
        remoteStream.addTrack(event.track);
      }

      event.track.onunmute = () => {
        console.log(`[WebRTC] Remote track unmuted: ${event.track.kind} from ${socketId}`);
        if (this.onRemoteStreamAdded) {
          this.onRemoteStreamAdded(socketId, remoteStream, isScreen);
        }
      };

      if (this.onRemoteStreamAdded) {
        this.onRemoteStreamAdded(socketId, remoteStream, isScreen);
      }
    };

    // A peer is only dropped when it actually leaves the room; a connection
    // that breaks is retried, because nothing else would ever bring it back.
    pc.onconnectionstatechange = () => {
      const negotiation = this.peerState.get(socketId);
      console.log(`[WebRTC] Connection state with ${socketId}: ${pc.connectionState}`);
      if (!negotiation || this.peers.get(socketId) !== pc) return;

      if (pc.connectionState === 'connected') {
        this.clearRecoveryTimers(socketId);
        negotiation.restartAttempts = 0;
        // Someone who joins mid-share gets the screen settings once negotiated
        this.applyScreenEncoding(socketId);
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
          if (current === pc && current.connectionState !== 'connected') {
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
      if (pc.signalingState !== 'stable' || this.peers.get(socketId) !== pc) {
        // An incoming offer won the race; that handshake takes over from here
        this.armConnectTimeout(socketId);
        return;
      }
      await pc.setLocalDescription(offer);

      this.signal('webrtc-offer', socketId, { offer: pc.localDescription });
      this.armConnectTimeout(socketId);
      this.armAnswerTimeout(socketId, pc, ++negotiation.offersSent);
    } catch (err) {
      if (this.peers.get(socketId) !== pc) return;
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

    const timeout = CONNECT_TIMEOUT_MS * (negotiation.polite ? POLITE_BACKOFF_FACTOR : 1);
    negotiation.restartTimer = setTimeout(() => {
      negotiation.restartTimer = null;
      const pc = this.peers.get(socketId);
      if (pc && pc.connectionState !== 'connected') {
        console.warn(`[WebRTC] ${socketId} still ${pc.connectionState} after handshake, restarting`);
        this.restartConnection(socketId);
      }
    }, timeout);
  }

  armAnswerTimeout(socketId, pc, offerNumber) {
    const negotiation = this.peerState.get(socketId);
    if (!negotiation) return;

    clearTimeout(negotiation.answerTimer);
    negotiation.answerTimer = setTimeout(() => {
      negotiation.answerTimer = null;
      const stillWaiting = this.peers.get(socketId) === pc &&
        pc.signalingState === 'have-local-offer' && negotiation.offersSent === offerNumber;
      if (!stillWaiting) return;

      console.warn(`[WebRTC] No answer from ${socketId}, retrying`);
      clearTimeout(negotiation.restartTimer);
      negotiation.restartTimer = null;
      this.restartConnection(socketId);
    }, ANSWER_TIMEOUT_MS);
  }

  scheduleRestart(socketId) {
    const negotiation = this.peerState.get(socketId);
    if (!negotiation || negotiation.restartTimer) return;

    if (negotiation.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      console.error(`[WebRTC] Giving up on ${socketId} after ${negotiation.restartAttempts} attempts`);
      return;
    }

    const base = Math.min(1000 * Math.pow(2, negotiation.restartAttempts), 15000);
    const delay = base * (negotiation.polite ? POLITE_BACKOFF_FACTOR : 1);
    negotiation.restartTimer = setTimeout(() => {
      negotiation.restartTimer = null;
      this.restartConnection(socketId);
    }, delay);
  }

  async restartConnection(socketId) {
    const pc = this.peers.get(socketId);
    const negotiation = this.peerState.get(socketId);
    if (!pc || !negotiation) return;
    if (pc.connectionState === 'connected') return;

    negotiation.restartAttempts++;

    // Our very first offer was never answered. Rolling it back would reset the
    // m-lines' mids, and a peer that did apply it would reject the next offer
    // for not matching; only a fresh connection gets out of that.
    const initialOfferUnanswered = pc.signalingState === 'have-local-offer' && !pc.currentRemoteDescription;
    // Some broken states are not something an ICE restart can fix either, so
    // every few attempts start over. The peer has to understand session ids to
    // recognise the new connection for what it is.
    const periodicRebuild = (negotiation.peerUsesSessions || this.sessionsSeen) &&
      negotiation.restartAttempts % (ICE_RESTARTS_BEFORE_REBUILD + 1) === 0;

    // Only the side that opened the connection rebuilds it, so the two sides
    // never both replace theirs at once
    if (!negotiation.polite && (initialOfferUnanswered || periodicRebuild)) {
      console.warn(`[WebRTC] Rebuilding connection with ${socketId} (attempt ${negotiation.restartAttempts})`);
      const attempts = negotiation.restartAttempts;
      this.removePeer(socketId);
      this.connectToPeer(socketId, { restartAttempts: attempts });
      return;
    }

    // A re-offer that was never answered (lost, or ignored in a collision) would
    // otherwise block every later offer forever. Its m-lines were negotiated
    // before, so rolling it back keeps them intact.
    if (pc.signalingState === 'have-local-offer') {
      try {
        await pc.setLocalDescription({ type: 'rollback' });
      } catch (err) {
        console.warn(`[WebRTC] Rollback with ${socketId} failed:`, err);
      }
      if (this.peers.get(socketId) !== pc) return;
    }

    console.warn(`[WebRTC] Restarting ICE with ${socketId} (attempt ${negotiation.restartAttempts})`);
    this.sendOffer(socketId, { iceRestart: true });
  }

  clearRecoveryTimers(socketId) {
    const negotiation = this.peerState.get(socketId);
    if (!negotiation) return;

    clearTimeout(negotiation.restartTimer);
    clearTimeout(negotiation.graceTimer);
    clearTimeout(negotiation.answerTimer);
    negotiation.restartTimer = null;
    negotiation.graceTimer = null;
    negotiation.answerTimer = null;
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
    if (!pc || pc.connectionState !== 'connected') return;

    this.ensureSending(socketId);
    if (!this.onConnectionQualityChanged) return;

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
   * Self-heal the "they can hear me but I can't hear them" case on a connected
   * peer: the mic sender must carry the current mic track and the m-line must
   * have been negotiated as sending.
   */
  ensureSending(socketId) {
    const pc = this.peers.get(socketId);
    const channels = this.peerChannels.get(socketId);
    const mic = channels && channels.mic;
    if (!pc || !mic || !mic.sender || mic.stopped) return;

    const micTrack = this.localMicStream ? this.localMicStream.getAudioTracks()[0] || null : null;
    if (micTrack && mic.sender.track !== micTrack) {
      console.warn(`[WebRTC] Mic was not attached for ${socketId}, re-attaching`);
      mic.sender.replaceTrack(micTrack).catch(err => {
        console.error(`[WebRTC] Re-attaching mic for ${socketId} failed:`, err);
      });
    }

    const notSending = mic.currentDirection === 'recvonly' || mic.currentDirection === 'inactive';
    if (notSending && pc.signalingState === 'stable') {
      console.warn(`[WebRTC] Mic m-line with ${socketId} negotiated as ${mic.currentDirection}, renegotiating`);
      mic.direction = 'sendrecv';
      this.sendOffer(socketId);
    }
  }

  /**
   * Snapshot of every peer connection, for debugging a call from the console.
   */
  async getDiagnostics() {
    const rows = [];
    for (const [socketId, pc] of this.peers) {
      const negotiation = this.peerState.get(socketId) || {};
      const channels = this.peerChannels.get(socketId) || {};
      const row = {
        socketId,
        role: negotiation.polite ? 'polite' : 'impolite',
        signaling: pc.signalingState,
        ice: pc.iceConnectionState,
        connection: pc.connectionState,
        restarts: negotiation.restartAttempts,
        micSending: !!(channels.mic && channels.mic.sender && channels.mic.sender.track),
        micDirection: channels.mic ? channels.mic.currentDirection : null,
        path: null,
        audioSent: 0,
        audioReceived: 0,
        // Screen share: what we send to this peer / what we get from them.
        // limitedBy 'cpu' means our PC cannot encode fast enough; 'bandwidth'
        // means the upload (ours) or the connection cannot carry more
        screenOut: null,
        screenIn: null
      };

      try {
        const stats = await pc.getStats();
        const byId = new Map();
        const screenMid = channels.screen ? channels.screen.mid : null;
        stats.forEach(r => byId.set(r.id, r));
        stats.forEach(r => {
          if (r.type === 'transport' && r.selectedCandidatePairId) {
            const pair = byId.get(r.selectedCandidatePairId);
            const local = pair && byId.get(pair.localCandidateId);
            const remote = pair && byId.get(pair.remoteCandidateId);
            if (local && remote) row.path = `${local.candidateType} -> ${remote.candidateType}`;
          }
          if (r.type === 'outbound-rtp' && r.kind === 'audio') row.audioSent += r.packetsSent || 0;
          if (r.type === 'inbound-rtp' && r.kind === 'audio') row.audioReceived += r.packetsReceived || 0;

          const isScreen = r.kind === 'video' && screenMid !== null && r.mid === screenMid;
          if (isScreen && r.type === 'outbound-rtp' && r.framesEncoded) {
            row.screenOut = `${r.framesPerSecond || 0} fps ${r.frameWidth}x${r.frameHeight} ` +
              `${r.encoderImplementation || ''} limitedBy=${r.qualityLimitationReason}`;
          }
          if (isScreen && r.type === 'inbound-rtp' && r.framesDecoded) {
            row.screenIn = `${r.framesPerSecond || 0} fps ${r.frameWidth}x${r.frameHeight} ` +
              `dropped=${r.framesDropped || 0} freezes=${r.freezeCount || 0}`;
          }
        });
      } catch (err) {}

      rows.push(row);
    }
    return rows;
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
        transceiver.sender.replaceTrack(track).catch(err => {
          console.error(`[WebRTC] Attaching ${name} for ${socketId} failed:`, err);
        });
      }
    };

    if (this.localMicStream) assign('mic', this.localMicStream.getAudioTracks()[0] || null);
    if (this.localCamStream) assign('cam', this.localCamStream.getVideoTracks()[0] || null);
    if (this.localScreenStream) {
      assign('screen', this.localScreenStream.getVideoTracks()[0] || null);
      assign('screenAudio', this.localScreenStream.getAudioTracks()[0] || null);
      this.applyScreenEncoding(socketId);
    }
  }

  async connectToPeer(socketId, { restartAttempts = 0 } = {}) {
    if (this.peers.has(socketId)) return;

    console.log(`[WebRTC] Initiating connection to peer ${socketId}`);
    // We opened this connection, so we are the impolite side of the pair
    const pc = this.createPeerConnection(socketId, { polite: false, restartAttempts });

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
      pc.onsignalingstatechange = null;
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
