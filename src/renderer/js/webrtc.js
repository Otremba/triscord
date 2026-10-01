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

// Screen share encoding: one setting for games and text alike, chosen from
// measurements in the app with game-like motion at 1080p60:
// - contentHint 'detail' with WebRTC's default 2.5 Mbps cap kept 1080p but
//   fell to 6-25 fps;
// - 'maintain-framerate' kept 60 fps but dropped straight to 480x270 whenever
//   a viewer's bandwidth was tight;
// - 'balanced' gave up frame rate to stay sharp;
// - 8 Mbps was not enough for heavy motion at 1080p60 (held at 720p); 15 Mbps
//   was.
// WebRTC's own resolution choice is not used at all: even with a floor
// reacting within seconds, 'maintain-framerate' spent ~13% of a test share
// below 720p, and nobody should ever watch 540p. The encoder is told to keep
// the resolution it is given ('maintain-resolution'), and this app picks it:
// full resolution while it holds ~60 fps, 720p (SCREEN_MIN_HEIGHT) when the
// frame rate starts to give way (see nextScreenAdapt). Only at 720p does the
// frame rate drop further.
// The cap is per viewer: in a mesh every viewer is a separate encode and
// upload, and bandwidth estimation still keeps each one within what its
// connection can carry.
const SCREEN_ENCODING = {
  contentHint: 'motion',
  degradationPreference: 'maintain-resolution',
  maxBitrate: 15000000,
  maxFramerate: 60
};
// A little extra buffering on the receiving side of a screen share absorbs
// network jitter, which shows up as stutter; voice is left untouched
const SCREEN_JITTER_BUFFER_MS = 100;
// WebRTC starts every connection's bandwidth estimate at 300 kbps and climbs
// slowly, so a share used to open at 480x270 and take ~25 s to sharpen.
// Starting the estimate here opened it at 720p-1080p in the same test. A link
// that cannot carry it backs off within a second or two.
const VIDEO_START_BITRATE_KBPS = 2500;

// The screen share never goes below this height for any viewer: below it
// text and detail stop being readable. A viewer whose encode at full
// resolution loses frame rate to their bandwidth or our CPU is moved to this
// height, where 60 fps costs less than half as much, and from time to time
// tried at full resolution again.
const SCREEN_MIN_HEIGHT = 720;
const SCREEN_ADAPT = {
  // Frame rate under which full resolution counts as struggling (when the
  // encoder says something limits it; a still screen also sends few frames)
  minFullFps: 50,
  // Struggling polls before moving to the floor (~3 s)
  lowSamples: 1,
  // When to try full resolution again; doubled after each attempt that
  // drops right back, up to the max
  retryMs: 20000,
  maxRetryMs: 5 * 60000,
  // An attempt that drops below the floor within this long has failed
  trialMs: 30000,
  // Bandwidth estimate needed to attempt full resolution
  upgradeMinKbps: 5000
};

/**
 * One step of the screen share resolution choice for one viewer: full
 * resolution ('auto') or the 720p floor. Pure, so it can be reasoned about
 * (and tested) without a connection.
 * @param adapt { mode: 'auto'|'floor', low, retryAt, retryMs, trialUntil }
 * @param sample { height, fps, sourceHeight, limitedBy, availableKbps } from getStats()
 * @returns the new adapt state (a copy) and whether the mode changed
 */
function nextScreenAdapt(adapt, sample, now) {
  const next = { ...adapt };
  const floor = Math.min(SCREEN_MIN_HEIGHT, sample.sourceHeight || SCREEN_MIN_HEIGHT);

  if (next.mode === 'auto') {
    // Full resolution struggles when something limits the encoder and it
    // pays with frame rate (or, before 1.1.7's fixed resolution, with height).
    // A capture already at or under the floor has nowhere to go.
    const limited = !!sample.limitedBy && sample.limitedBy !== 'none';
    const roomToDrop = !(sample.sourceHeight > 0 && sample.sourceHeight <= SCREEN_MIN_HEIGHT);
    const losingFps = Number.isFinite(sample.fps) && sample.fps < SCREEN_ADAPT.minFullFps;
    const losingHeight = sample.height > 0 && sample.height < floor;
    const struggling = limited && roomToDrop && (losingFps || losingHeight);
    next.low = struggling ? next.low + 1 : 0;
    if (next.low < SCREEN_ADAPT.lowSamples) return { adapt: next, changed: false };

    // A full-resolution attempt that failed quickly waits longer next time
    next.retryMs = now < next.trialUntil
      ? Math.min(next.retryMs * 2, SCREEN_ADAPT.maxRetryMs)
      : SCREEN_ADAPT.retryMs;
    next.mode = 'floor';
    next.low = 0;
    next.retryAt = now + next.retryMs;
    return { adapt: next, changed: true };
  }

  // Holding the floor: try full resolution once nothing limits the encode
  // and the link looks able to carry more
  const headroom = sample.limitedBy === 'none' &&
    (sample.availableKbps == null || sample.availableKbps >= SCREEN_ADAPT.upgradeMinKbps);
  if (now >= next.retryAt && headroom) {
    next.mode = 'auto';
    next.trialUntil = now + SCREEN_ADAPT.trialMs;
    return { adapt: next, changed: true };
  }
  return { adapt: next, changed: false };
}

// A shared window delivering fewer frames than this, with nothing limiting the
// encoder, for this long: the capture itself is stalling. Seen with a game's
// window on a laptop with two GPUs (1-2 fps, where the whole screen ran at 58)
const SLOW_CAPTURE_FPS = 5;
const SLOW_CAPTURE_MS = 15000;

/**
 * Why our screen share reaches one viewer the way it does, from what the
 * encoder reports for every viewer. A limit on one viewer only is that
 * viewer's connection; a limit on every viewer is our own upload; with a
 * single viewer the two cannot be told apart.
 * @param me { limitedBy, floor } for this viewer
 * @param all the same for every viewer currently receiving the share
 * @returns 'ok' | 'sender-cpu' | 'sender-upload' | 'viewer-network' | 'network'
 */
function screenSendCause(me, all) {
  if (me.limitedBy === 'cpu') return 'sender-cpu';
  const constrained = s => s.limitedBy === 'bandwidth' || s.floor;
  if (!constrained(me)) return 'ok';
  if (all.length < 2) return 'network';
  return all.every(constrained) ? 'sender-upload' : 'viewer-network';
}
const SCREEN_SEND_CAUSES = ['ok', 'sender-cpu', 'sender-upload', 'viewer-network', 'network'];
// How long a viewer trusts the sharer's last report (sent every quality poll)
const SCREEN_SEND_STATS_TTL_MS = 10000;

function initialScreenAdapt() {
  return { mode: 'auto', low: 0, retryAt: 0, retryMs: SCREEN_ADAPT.retryMs, trialUntil: 0 };
}

/**
 * Put H.264 first on the screen share's m-line: it is the codec GPUs encode
 * (see gpu-relay.js). Both ends call this: each side sends with the first
 * codec of the other side's description. A peer on an older version keeps
 * VP8 first and simply gets VP8, as before.
 */
function preferH264(transceiver) {
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function' ||
      typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return;
  const codecs = RTCRtpReceiver.getCapabilities('video').codecs;
  const h264 = codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
  if (!h264.length) return;
  try {
    transceiver.setCodecPreferences([...h264, ...codecs.filter(c => !h264.includes(c))]);
  } catch (err) {
    console.warn('[WebRTC] Could not prefer H.264 for the screen share:', err);
  }
}

/**
 * Add x-google-start-bitrate to every video codec of a description we are
 * about to apply. The sending side reads it from the remote description, so
 * each app applies it to what it receives. VP8 has no fmtp line by default,
 * so one is added for it.
 */
function withVideoStartBitrate(description) {
  if (!description || !description.sdp) return description;
  const lines = description.sdp.split('\r\n');
  const withFmtp = new Set();
  lines.forEach((line) => {
    const match = line.match(/^a=fmtp:(\d+) /);
    if (match) withFmtp.add(match[1]);
  });

  const out = [];
  lines.forEach((line) => {
    const fmtp = line.match(/^a=fmtp:(\d+) /);
    const rtpmap = line.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\/90000$/);
    if (fmtp && !line.includes('x-google-start-bitrate') && isVideoCodecLine(lines, fmtp[1])) {
      out.push(`${line};x-google-start-bitrate=${VIDEO_START_BITRATE_KBPS}`);
      return;
    }
    out.push(line);
    if (rtpmap && !withFmtp.has(rtpmap[1])) {
      out.push(`a=fmtp:${rtpmap[1]} x-google-start-bitrate=${VIDEO_START_BITRATE_KBPS}`);
    }
  });
  return { type: description.type, sdp: out.join('\r\n') };
}

// Whether a payload type is one of the video codecs (not rtx/red/ulpfec)
function isVideoCodecLine(lines, payloadType) {
  return lines.some(line => new RegExp(`^a=rtpmap:${payloadType} (VP8|VP9|H264|AV1)/90000$`).test(line));
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
    // Map: socketId -> resolution floor state of our screen share to that peer (see nextScreenAdapt)
    this.screenAdapt = new Map();
    // Peers that clicked "Parar de assistir" on our screen share: nothing is
    // encoded or uploaded for them until they watch again
    this.screenPausedBy = new Set();
    // What the peers receive of our screen share: the GPU relay's track, or
    // the capture itself (see gpu-relay.js)
    this.screenRelay = null;
    this.screenSendTrack = null;
    // Map: socketId -> what our screen share reaches that viewer at, and why
    // (see reportScreenSend); and what each sharer told us about theirs
    this.screenSendStats = new Map();
    this.remoteScreenSendStats = new Map();

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
    this.onScreenCaptureSlow = null; // () — the shared window delivers almost no frames (see checkCaptureRate)
    this.onScreenSendReport = null; // ([{ socketId, height, fps, cause, paused }]) — how our share reaches each viewer

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
    // A viewer of our screen share stopped (or resumed) watching it
    this.socket.on('screen-watch', ({ senderSocketId, watching } = {}) => {
      if (typeof senderSocketId === 'string') this.setPeerWatchingScreen(senderSocketId, watching !== false);
    });

    // A sharer telling us what it sends us and why (see reportScreenSend)
    this.socket.on('screen-stats', ({ senderSocketId, height, fps, cause } = {}) => {
      if (typeof senderSocketId !== 'string' || !SCREEN_SEND_CAUSES.includes(cause)) return;
      this.remoteScreenSendStats.set(senderSocketId, { height, fps, cause, at: Date.now() });
    });

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
        await pc.setRemoteDescription(new RTCSessionDescription(withVideoStartBitrate(offer)));
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
        await pc.setRemoteDescription(new RTCSessionDescription(withVideoStartBitrate(answer)));
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
    preferH264(channels.screen);

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
   * Set local screen share stream (encoded with SCREEN_ENCODING)
   */
  setScreenStream(screenStream) {
    this.localScreenStream = screenStream;
    if (!screenStream) {
      this.applyTrackToPeers('screen', null);
      this.applyTrackToPeers('screenAudio', null);
      return;
    }

    const screenTrack = screenStream.getVideoTracks()[0];
    if (screenTrack) screenTrack.contentHint = SCREEN_ENCODING.contentHint;

    // Send it through the GPU relay where the browser supports one
    this.stopScreenRelay();
    this.screenSendTrack = screenTrack || null;
    if (screenTrack && window.GpuScreenRelay && window.GpuScreenRelay.isSupported()) {
      try {
        this.screenRelay = new window.GpuScreenRelay(screenTrack);
        this.screenRelay.track.contentHint = SCREEN_ENCODING.contentHint;
        this.screenSendTrack = this.screenRelay.track;
      } catch (err) {
        console.warn('[WebRTC] GPU relay unavailable, sending the capture directly:', err);
        this.screenRelay = null;
      }
    }

    // A new share starts at full resolution for everyone
    this.screenAdapt.clear();
    this.screenSendStats.clear();
    this.slowCaptureSince = null;
    this.slowCaptureReported = false;
    this.applyTrackToPeers('screen', this.screenSendTrack);
    this.applyTrackToPeers('screenAudio', screenStream.getAudioTracks()[0] || null);
    this.peerChannels.forEach((_, socketId) => this.applyScreenEncoding(socketId));
  }

  stopScreenRelay() {
    if (!this.screenRelay) return;
    this.screenRelay.stop();
    this.screenRelay = null;
  }

  /**
   * The GPU is not encoding our share (no hardware encoder, or a peer that
   * cannot take H.264): the relay would only add work, so the peers get the
   * capture directly. Swapping the track needs no renegotiation.
   */
  useDirectScreenTrack(reason) {
    if (!this.screenRelay || !this.localScreenStream) return;
    console.warn(`[WebRTC] Screen share not encoded on the GPU (${reason}); sending the capture directly`);
    this.screenSendTrack = this.localScreenStream.getVideoTracks()[0] || null;
    this.applyTrackToPeers('screen', this.screenSendTrack);
    this.stopScreenRelay();
  }

  /**
   * A peer told us (through the server) whether it is watching our screen
   * share. Not watching turns that peer's screen encodings off, so nothing is
   * encoded or uploaded for it; the other viewers are unaffected.
   */
  setPeerWatchingScreen(socketId, watching) {
    const wasPaused = this.screenPausedBy.has(socketId);
    if (watching) this.screenPausedBy.delete(socketId);
    else this.screenPausedBy.add(socketId);
    if (wasPaused === !watching) return;
    console.log(`[WebRTC] ${socketId} ${watching ? 'is watching our screen again' : 'stopped watching our screen'}`);
    // The encode restarts from a low bandwidth estimate after a pause: that
    // ramp is not a struggling link, so the resolution floor starts over
    this.screenAdapt.delete(socketId);
    this.applyScreenEncoding(socketId);
  }

  /** Tell a screen sharer whether we are watching their share. */
  sendScreenWatch(targetSocketId, watching) {
    if (!this.socket || !this.socket.connected) return;
    this.socket.emit('screen-watch', { targetSocketId, watching });
  }

  /**
   * Put the screen share's bitrate cap, frame rate and degradation preference
   * on one peer's screen sender. Each viewer has its own encoder in a mesh,
   * so this runs per peer — again once a peer finishes connecting, because a
   * sender has no encodings to configure before its first negotiation.
   * A viewer held at the resolution floor gets a fixed downscale to it, and
   * one who stopped watching gets nothing at all.
   */
  async applyScreenEncoding(socketId) {
    const channels = this.peerChannels.get(socketId);
    const sender = channels && channels.screen && channels.screen.sender;
    if (!sender || !this.localScreenStream) return;

    const active = !this.screenPausedBy.has(socketId);
    this.setScreenAudioActive(channels, active, socketId);

    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) return;

    const { maxBitrate, maxFramerate } = SCREEN_ENCODING;
    // Always the resolution we choose (see SCREEN_ENCODING): full, or the floor
    const { degradationPreference } = SCREEN_ENCODING;
    let scaleResolutionDownBy = 1;
    const adapt = this.screenAdapt.get(socketId);
    const track = this.localScreenStream.getVideoTracks()[0];
    const sourceHeight = track ? track.getSettings().height : 0;
    if (adapt && adapt.mode === 'floor') {
      // A capture already at or under the floor (a small window) is kept as is
      scaleResolutionDownBy = Math.max(1, sourceHeight / SCREEN_MIN_HEIGHT);
    }

    const encoding = params.encodings[0];
    if (encoding.maxBitrate === maxBitrate && encoding.maxFramerate === maxFramerate &&
        (encoding.scaleResolutionDownBy || 1) === scaleResolutionDownBy &&
        encoding.active === active &&
        params.degradationPreference === degradationPreference) return;

    encoding.maxBitrate = maxBitrate;
    encoding.maxFramerate = maxFramerate;
    encoding.scaleResolutionDownBy = scaleResolutionDownBy;
    encoding.active = active;
    params.degradationPreference = degradationPreference;
    try {
      await sender.setParameters(params);
    } catch (err) {
      console.warn(`[WebRTC] Could not configure screen encoding for ${socketId}:`, err);
    }
  }

  // The share's sound follows its picture: off for a peer who is not watching
  async setScreenAudioActive(channels, active, socketId) {
    const sender = channels.screenAudio && channels.screenAudio.sender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length || params.encodings[0].active === active) return;
    params.encodings[0].active = active;
    try {
      await sender.setParameters(params);
    } catch (err) {
      console.warn(`[WebRTC] Could not ${active ? 'resume' : 'pause'} screen audio for ${socketId}:`, err);
    }
  }

  stopScreenShare() {
    this.applyTrackToPeers('screen', null);
    this.applyTrackToPeers('screenAudio', null);
    this.stopScreenRelay();
    this.screenSendTrack = null;
    this.screenSendStats.clear();

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
   * Tell one viewer what our screen share reaches them at and why (see
   * screenSendCause), and give the app the picture for every viewer, so both
   * sides can see whose connection is holding the share back.
   */
  reportScreenSend(socketId) {
    if (!this.localScreenStream) return;
    const now = Date.now();
    const fresh = s => s && now - s.at < SCREEN_SEND_STATS_TTL_MS;
    const receiving = Array.from(this.screenSendStats.entries())
      .filter(([id, s]) => this.peers.has(id) && !this.screenPausedBy.has(id) && fresh(s))
      .map(([, s]) => s);

    const mine = this.screenSendStats.get(socketId);
    if (fresh(mine) && !this.screenPausedBy.has(socketId)) {
      mine.cause = screenSendCause(mine, receiving);
      if (this.socket && this.socket.connected) {
        this.socket.emit('screen-stats', { targetSocketId: socketId, height: mine.height, fps: mine.fps, cause: mine.cause });
      }
    }

    if (this.onScreenSendReport) this.onScreenSendReport(this.screenSendReport());
  }

  /** How our screen share reaches each connected viewer right now. */
  screenSendReport() {
    const now = Date.now();
    return Array.from(this.peers.keys()).map((socketId) => {
      if (this.screenPausedBy.has(socketId)) return { socketId, paused: true };
      const s = this.screenSendStats.get(socketId);
      if (!s || !s.cause || now - s.at >= SCREEN_SEND_STATS_TTL_MS) return { socketId, pending: true };
      return { socketId, height: s.height, fps: s.fps, cause: s.cause };
    });
  }

  /** What a sharer last told us about the share it sends us, if recent. */
  remoteScreenSendInfo(socketId) {
    const s = this.remoteScreenSendStats.get(socketId);
    return s && Date.now() - s.at < SCREEN_SEND_STATS_TTL_MS ? s : null;
  }

  /**
   * Warn once per share when a shared window delivers almost no frames while
   * nothing limits the encoder (see SLOW_CAPTURE_FPS). Whole screens are left
   * alone, and a still window can trip it too, so the advice is phrased for
   * games. Any peer's encode reflects the capture rate, so all polls count.
   */
  checkCaptureRate(track, outbound) {
    if (this.slowCaptureReported) return;
    const isWindow = String(track.getSettings().deviceId || '').startsWith('window:');
    const slow = isWindow && outbound.qualityLimitationReason === 'none' &&
      (outbound.framesPerSecond || 0) < SLOW_CAPTURE_FPS;
    if (!slow) {
      this.slowCaptureSince = null;
      return;
    }
    const now = Date.now();
    if (!this.slowCaptureSince) this.slowCaptureSince = now;
    if (now - this.slowCaptureSince < SLOW_CAPTURE_MS) return;

    this.slowCaptureReported = true;
    console.warn(`[WebRTC] Shared window delivers ${outbound.framesPerSecond || 0} fps with nothing limiting the encoder`);
    if (this.onScreenCaptureSlow) this.onScreenCaptureSlow();
  }

  /**
   * Keep our screen share to this peer at or above SCREEN_MIN_HEIGHT (see
   * nextScreenAdapt), from the stats the quality poll already took.
   */
  adaptScreenResolution(socketId, stats) {
    const track = this.localScreenStream && this.localScreenStream.getVideoTracks()[0];
    const channels = this.peerChannels.get(socketId);
    const screenMid = channels && channels.screen ? channels.screen.mid : null;
    // Nothing is encoded for a peer who is not watching
    if (!track || screenMid === null || this.screenPausedBy.has(socketId)) return;

    let outbound = null;
    let availableKbps = null;
    stats.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video' && r.mid === screenMid && r.framesEncoded) outbound = r;
      if (r.type === 'transport' && r.selectedCandidatePairId) {
        const pair = stats.get(r.selectedCandidatePairId);
        if (pair && pair.availableOutgoingBitrate) availableKbps = Math.round(pair.availableOutgoingBitrate / 1000);
      }
    });
    if (!outbound) return;
    this.checkCaptureRate(track, outbound);

    // Is the GPU encoding the share? Judged on H.264 only, the codec the
    // relay is for: a peer on an older version negotiates VP8, which says
    // nothing about the GPU. Two samples in a row, so a transient doesn't count.
    if (this.screenRelay) {
      const codec = outbound.codecId ? stats.get(outbound.codecId) : null;
      if (codec && /h264/i.test(codec.mimeType) && outbound.powerEfficientEncoder === false) {
        this.screenRelay.softwareSamples = (this.screenRelay.softwareSamples || 0) + 1;
        if (this.screenRelay.softwareSamples >= 2) this.useDirectScreenTrack(outbound.encoderImplementation || 'software');
      } else if (codec && /h264/i.test(codec.mimeType)) {
        this.screenRelay.softwareSamples = 0;
      }
    }

    const sample = {
      height: outbound.frameHeight || 0,
      fps: outbound.framesPerSecond || 0,
      sourceHeight: track.getSettings().height || 0,
      limitedBy: outbound.qualityLimitationReason,
      availableKbps
    };
    const { adapt, changed } = nextScreenAdapt(this.screenAdapt.get(socketId) || initialScreenAdapt(), sample, Date.now());
    this.screenAdapt.set(socketId, adapt);
    this.screenSendStats.set(socketId, {
      height: sample.height,
      fps: Math.round(outbound.framesPerSecond || 0),
      limitedBy: sample.limitedBy,
      floor: adapt.mode === 'floor',
      at: Date.now()
    });
    if (!changed) return;

    if (adapt.mode === 'floor') {
      console.log(`[WebRTC] Screen to ${socketId}: holding ${SCREEN_MIN_HEIGHT}p (was ${outbound.frameWidth}x${sample.height}, ` +
        `limitedBy=${sample.limitedBy}, upload estimate ${availableKbps} kbps); full resolution again in ${Math.round(adapt.retryMs / 1000)} s`);
    } else {
      console.log(`[WebRTC] Screen to ${socketId}: trying full resolution again (upload estimate ${availableKbps} kbps)`);
    }
    this.applyScreenEncoding(socketId);
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

    try {
      const stats = await pc.getStats();
      this.adaptScreenResolution(socketId, stats);
      this.reportScreenSend(socketId);
      if (!this.onConnectionQualityChanged) return;

      let rttMs = null;
      let packetsLost = 0;
      let packetsTotal = 0;
      let screen = null;
      const channels = this.peerChannels.get(socketId);
      const screenMid = channels && channels.screen ? channels.screen.mid : null;

      stats.forEach((report) => {
        // What this peer's screen share looks like here
        if (report.type === 'inbound-rtp' && report.kind === 'video' && screenMid !== null &&
            report.mid === screenMid && report.framesDecoded) {
          screen = {
            width: report.frameWidth,
            height: report.frameHeight,
            fps: Math.round(report.framesPerSecond || 0),
            freezes: report.freezeCount || 0,
            // What the sharer says it sends us and why, when it is on 1.1.6+
            sender: this.remoteScreenSendInfo(socketId)
          };
        }
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

      this.onConnectionQualityChanged(socketId, { level, rttMs, lossPct, screen });
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
        rttMs: null,
        // Share of everything received from this peer that never arrived
        lossPct: null,
        // What WebRTC estimates it can send to this peer right now
        uploadEstimateKbps: null,
        audioSent: 0,
        audioReceived: 0,
        // Screen share: what we send to this peer / what we get from them.
        // limitedBy 'cpu' means our PC cannot encode fast enough; 'bandwidth'
        // means the upload (ours) or the connection cannot carry more
        screenOut: null,
        screenIn: null
      };

      // Raw numbers for the diagnostics report (see diagnostics.js): cumulative
      // counters it compares between samples, and the current values
      const metrics = { screenOut: null, screenIn: null, voiceIn: null };
      row.metrics = metrics;

      try {
        const stats = await pc.getStats();
        const byId = new Map();
        const screenMid = channels.screen ? channels.screen.mid : null;
        const micMid = channels.mic ? channels.mic.mid : null;
        let received = 0;
        let lost = 0;
        stats.forEach(r => byId.set(r.id, r));
        stats.forEach(r => {
          if (r.type === 'transport' && r.selectedCandidatePairId) {
            const pair = byId.get(r.selectedCandidatePairId);
            const local = pair && byId.get(pair.localCandidateId);
            const remote = pair && byId.get(pair.remoteCandidateId);
            if (local && remote) row.path = `${local.candidateType} -> ${remote.candidateType}`;
            if (pair && typeof pair.currentRoundTripTime === 'number') row.rttMs = Math.round(pair.currentRoundTripTime * 1000);
            if (pair && pair.availableOutgoingBitrate) row.uploadEstimateKbps = Math.round(pair.availableOutgoingBitrate / 1000);
            metrics.rttMs = row.rttMs;
            metrics.uploadKbps = row.uploadEstimateKbps;
            metrics.path = local && remote ? {
              local: local.candidateType,
              remote: remote.candidateType,
              protocol: local.protocol,
              relayProtocol: local.relayProtocol || null
            } : null;
          }
          if (r.type === 'inbound-rtp' && r.kind === 'audio' && micMid !== null && r.mid === micMid) {
            metrics.voiceIn = {
              packetsReceived: r.packetsReceived || 0,
              packetsLost: Math.max(0, r.packetsLost || 0),
              jitterMs: Math.round((r.jitter || 0) * 1000),
              // Samples the decoder had to invent to cover missing audio: the
              // share of these is how often a voice breaks up
              concealedSamples: r.concealedSamples || 0,
              totalSamplesReceived: r.totalSamplesReceived || 0,
              concealmentEvents: r.concealmentEvents || 0
            };
          }
          if (r.type === 'inbound-rtp') {
            received += r.packetsReceived || 0;
            lost += Math.max(0, r.packetsLost || 0);
          }
          if (r.type === 'outbound-rtp' && r.kind === 'audio') row.audioSent += r.packetsSent || 0;
          if (r.type === 'inbound-rtp' && r.kind === 'audio') row.audioReceived += r.packetsReceived || 0;

          const isScreen = r.kind === 'video' && screenMid !== null && r.mid === screenMid;
          // Only while sharing: a finished share leaves stale counters behind
          if (isScreen && r.type === 'outbound-rtp' && r.framesEncoded && this.localScreenStream) {
            const adapt = this.screenAdapt.get(socketId);
            const codec = r.codecId ? byId.get(r.codecId) : null;
            const sender = channels.screen && channels.screen.sender;
            const preference = sender ? sender.getParameters().degradationPreference : null;
            row.screenOut = this.screenPausedBy.has(socketId)
              ? 'pausada (parou de assistir)'
              : `${r.framesPerSecond || 0} fps ${r.frameWidth ? `${r.frameWidth}x${r.frameHeight}` : '(sem quadros agora)'} ` +
                `${codec ? codec.mimeType.replace('video/', '') : ''} ${r.encoderImplementation || ''}` +
                `${r.powerEfficientEncoder ? ' (placa de vídeo)' : ''} limitedBy=${r.qualityLimitationReason}` +
                `${preference ? ` prioridade=${preference}` : ''}` +
                `${adapt && adapt.mode === 'floor' ? ` (segurando ${SCREEN_MIN_HEIGHT}p)` : ''}`;
            metrics.screenOut = {
              paused: this.screenPausedBy.has(socketId),
              fps: r.framesPerSecond || 0,
              height: r.frameHeight || 0,
              codec: codec ? codec.mimeType.replace('video/', '') : null,
              encoder: r.encoderImplementation || null,
              gpu: !!r.powerEfficientEncoder,
              gpuRelay: !!this.screenRelay,
              limitedBy: r.qualityLimitationReason || null,
              // Seconds spent limited by each reason since the encode started
              limitDurations: r.qualityLimitationDurations || null,
              floor: !!(adapt && adapt.mode === 'floor'),
              preference,
              framesEncoded: r.framesEncoded || 0,
              keyFramesEncoded: r.keyFramesEncoded || 0,
              totalEncodeTime: r.totalEncodeTime || 0,
              bytesSent: r.bytesSent || 0,
              retransmittedBytesSent: r.retransmittedBytesSent || 0,
              nackCount: r.nackCount || 0,
              pliCount: r.pliCount || 0
            };
          }
          if (isScreen && r.type === 'inbound-rtp' && r.framesDecoded) {
            row.screenIn = `${r.framesPerSecond || 0} fps ${r.frameWidth}x${r.frameHeight} ` +
              `dropped=${r.framesDropped || 0} freezes=${r.freezeCount || 0}`;
            metrics.screenIn = {
              fps: r.framesPerSecond || 0,
              height: r.frameHeight || 0,
              decoder: r.decoderImplementation || null,
              framesDecoded: r.framesDecoded || 0,
              framesDropped: r.framesDropped || 0,
              freezeCount: r.freezeCount || 0,
              totalFreezesDuration: r.totalFreezesDuration || 0,
              packetsReceived: r.packetsReceived || 0,
              packetsLost: Math.max(0, r.packetsLost || 0),
              bytesReceived: r.bytesReceived || 0,
              jitterMs: Math.round((r.jitter || 0) * 1000),
              pliCount: r.pliCount || 0,
              jitterBufferDelay: r.jitterBufferDelay || 0,
              jitterBufferEmittedCount: r.jitterBufferEmittedCount || 0,
              // What the sharer says it sends us and why (1.1.6+)
              sender: this.remoteScreenSendInfo(socketId)
            };
          }
        });
        if (received + lost > 0) row.lossPct = Math.round((lost / (received + lost)) * 1000) / 10;
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
      assign('screen', this.screenSendTrack);
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
    preferH264(this.peerChannels.get(socketId).screen);
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
    this.screenAdapt.delete(socketId);
    this.screenPausedBy.delete(socketId);
    this.screenSendStats.delete(socketId);
    this.remoteScreenSendStats.delete(socketId);

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
