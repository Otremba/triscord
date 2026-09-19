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
 */

const CHANNEL_ORDER = ['mic', 'cam', 'screen', 'screenAudio'];

class WebRTCManager {
  constructor(socket, currentUserId) {
    this.socket = socket;
    this.currentUserId = currentUserId;

    // Map: socketId -> RTCPeerConnection
    this.peers = new Map();
    // Map: socketId -> { mic, cam, screen, screenAudio } RTCRtpTransceivers
    this.peerChannels = new Map();
    // Map: socketId -> remote MediaStream (mic + camera)
    this.remoteStreams = new Map();
    // Map: socketId -> remote MediaStream (screen video + screen audio)
    this.remoteScreenStreams = new Map();

    // Local streams
    this.localMicStream = null;
    this.localCamStream = null;
    this.localScreenStream = null;

    // Owns the raw capture + RNNoise pipeline behind localMicStream
    this.micCapture = null;
    this.noiseSuppressionMode = null; // 'rnnoise' | 'native' | 'off'

    // Callbacks
    this.onRemoteStreamAdded = null; // (socketId, stream, isScreen)
    this.onRemoteStreamRemoved = null; // (socketId, isScreen)

    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ];

    this.setupSocketListeners();
  }

  setupSocketListeners() {
    // Handle incoming WebRTC Offer
    this.socket.on('webrtc-offer', async ({ senderSocketId, offer, type }) => {
      console.log(`[WebRTC] Received offer from ${senderSocketId} (${type})`);
      const pc = this.peers.get(senderSocketId) || this.createPeerConnection(senderSocketId);

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        // Adopt the transceivers setRemoteDescription just created, in m-line order
        if (!this.peerChannels.has(senderSocketId)) {
          const transceivers = pc.getTransceivers();
          const channels = {};
          CHANNEL_ORDER.forEach((name, index) => {
            const transceiver = transceivers[index];
            if (!transceiver) return;
            // They arrive recvonly; we have to answer sendrecv to be able to send
            transceiver.direction = 'sendrecv';
            channels[name] = transceiver;
          });
          this.peerChannels.set(senderSocketId, channels);
          this.attachLocalTracks(senderSocketId);
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.socket.emit('webrtc-answer', {
          targetSocketId: senderSocketId,
          answer: pc.localDescription,
          type: type || 'mesh'
        });
      } catch (err) {
        console.error('[WebRTC] Error handling offer:', err);
      }
    });

    // Handle incoming WebRTC Answer
    this.socket.on('webrtc-answer', async ({ senderSocketId, answer }) => {
      console.log(`[WebRTC] Received answer from ${senderSocketId}`);
      const pc = this.peers.get(senderSocketId);
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
          console.error('[WebRTC] Error setting remote description for answer:', err);
        }
      }
    });

    // Handle incoming ICE candidate
    this.socket.on('webrtc-ice-candidate', async ({ senderSocketId, candidate }) => {
      const pc = this.peers.get(senderSocketId);
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('[WebRTC] Error adding ICE candidate:', err);
        }
      }
    });
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
   * Acquire local webcam video stream
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

      this.localCamStream = await navigator.mediaDevices.getUserMedia(constraints);

      const camTrack = this.localCamStream.getVideoTracks()[0];
      if (camTrack) camTrack.contentHint = 'motion';
      this.applyTrackToPeers('cam', camTrack || null);

      return this.localCamStream;
    } catch (err) {
      console.error('[WebRTC] Error accessing camera:', err);
      throw err;
    }
  }

  stopCamera() {
    this.applyTrackToPeers('cam', null);

    if (this.localCamStream) {
      this.localCamStream.getTracks().forEach(t => t.stop());
      this.localCamStream = null;
    }
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

  createPeerConnection(socketId) {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers
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

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state with ${socketId}: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removePeer(socketId);
      }
    };

    this.peers.set(socketId, pc);
    return pc;
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
    const pc = this.createPeerConnection(socketId);

    // Fixed m-line layout. Only the offering side declares it; the answering
    // side adopts the same order from the offer.
    this.peerChannels.set(socketId, {
      mic: pc.addTransceiver('audio', { direction: 'sendrecv' }),
      cam: pc.addTransceiver('video', { direction: 'sendrecv' }),
      screen: pc.addTransceiver('video', { direction: 'sendrecv' }),
      screenAudio: pc.addTransceiver('audio', { direction: 'sendrecv' })
    });
    this.attachLocalTracks(socketId);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.socket.emit('webrtc-offer', {
        targetSocketId: socketId,
        offer: pc.localDescription,
        type: 'mesh'
      });
    } catch (err) {
      console.error(`[WebRTC] Error connecting to peer ${socketId}:`, err);
    }
  }

  removePeer(socketId) {
    if (this.peers.has(socketId)) {
      const pc = this.peers.get(socketId);
      pc.close();
      this.peers.delete(socketId);
    }

    this.peerChannels.delete(socketId);

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

  cleanupAll() {
    this.peers.forEach((pc) => pc.close());
    this.peers.clear();
    this.peerChannels.clear();

    [this.remoteStreams, this.remoteScreenStreams].forEach(streamMap => {
      streamMap.forEach(stream => {
        stream.getTracks().forEach(t => t.stop());
      });
      streamMap.clear();
    });

    this.stopMicrophone();
    if (this.localCamStream) {
      this.localCamStream.getTracks().forEach(t => t.stop());
      this.localCamStream = null;
    }
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(t => t.stop());
      this.localScreenStream = null;
    }
  }
}

window.WebRTCManager = WebRTCManager;
