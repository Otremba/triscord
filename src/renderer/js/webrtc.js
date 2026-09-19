/**
 * WebRTC Multi-Peer Mesh Manager
 * Manages RTCPeerConnections for all peers in the voice/video room.
 * Handles robust track replacement, screen sharing lifecycle, and clean track teardown.
 */

class WebRTCManager {
  constructor(socket, currentUserId) {
    this.socket = socket;
    this.currentUserId = currentUserId;

    // Map: socketId -> RTCPeerConnection
    this.peers = new Map();
    // Map: socketId -> { micT, camT, screenVideoT, screenAudioT } RTCRtpTransceivers
    this.peerMeta = new Map();
    // Map: socketId -> remote MediaStream (camera video + mic audio)
    this.remoteCamStreams = new Map();
    // Map: socketId -> remote MediaStream (screen video + screen audio)
    this.remoteScreenStreams = new Map();
    // Map: socketId -> Array<RTCIceCandidate> (queued candidates before remote description)
    this.iceCandidateQueues = new Map();

    // Local streams
    this.localMicStream = null;
    this.localCamStream = null;
    this.localScreenStream = null;

    // Combined local stream
    this.localCombinedStream = new MediaStream();

    // Callbacks
    this.onRemoteStreamAdded = null; // (socketId, kind: 'cam'|'screen', stream)
    this.onRemoteStreamRemoved = null; // (socketId, kind: 'cam'|'screen')

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
      const pc = this.getOrCreatePeer(senderSocketId);

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        // Process any queued ICE candidates
        const queue = this.iceCandidateQueues.get(senderSocketId) || [];
        while (queue.length > 0) {
          const candidate = queue.shift();
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.warn('[WebRTC] Error adding queued ICE candidate:', e);
          }
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

          // Process queued ICE candidates if any
          const queue = this.iceCandidateQueues.get(senderSocketId) || [];
          while (queue.length > 0) {
            const candidate = queue.shift();
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
              console.warn('[WebRTC] Error adding queued ICE candidate:', e);
            }
          }
        } catch (err) {
          console.error('[WebRTC] Error setting remote description for answer:', err);
        }
      }
    });

    // Handle incoming ICE candidate
    this.socket.on('webrtc-ice-candidate', async ({ senderSocketId, candidate }) => {
      const pc = this.peers.get(senderSocketId);
      if (pc && candidate) {
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          // Queue candidate until remote description is set
          let queue = this.iceCandidateQueues.get(senderSocketId);
          if (!queue) {
            queue = [];
            this.iceCandidateQueues.set(senderSocketId, queue);
          }
          queue.push(candidate);
        } else {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (err) {
            console.error('[WebRTC] Error adding ICE candidate:', err);
          }
        }
      }
    });
  }

  /**
   * Acquire local microphone audio stream with noise suppression & echo cancellation
   */
  async startMicrophone(audioDeviceId = null, noiseSuppression = true) {
    try {
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: noiseSuppression,
          autoGainControl: true,
          ...(audioDeviceId && audioDeviceId !== 'default' ? { deviceId: { exact: audioDeviceId } } : {})
        },
        video: false
      };

      this.localMicStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.updateLocalCombinedTracks();
      return this.localMicStream;
    } catch (err) {
      console.error('[WebRTC] Error accessing microphone:', err);
      throw err;
    }
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
          ...(videoDeviceId && videoDeviceId !== 'default' ? { deviceId: { exact: videoDeviceId } } : {})
        }
      };

      this.localCamStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.updateLocalCombinedTracks();
      return this.localCamStream;
    } catch (err) {
      console.error('[WebRTC] Error accessing camera:', err);
      throw err;
    }
  }

  stopCamera() {
    if (this.localCamStream) {
      this.localCamStream.getTracks().forEach(t => t.stop());
      this.localCamStream = null;
      this.updateLocalCombinedTracks();
    }
  }

  /**
   * Set local screen share stream
   */
  setScreenStream(screenStream) {
    this.localScreenStream = screenStream;
    this.updateLocalCombinedTracks();
  }

  stopScreenShare() {
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(t => t.stop());
      this.localScreenStream = null;
      this.updateLocalCombinedTracks();
    }
  }

  /**
   * Push the current local tracks (mic / camera / screen video / screen audio) onto every
   * peer connection's dedicated transceiver slots. Each slot is pre-created once per peer
   * (see getOrCreatePeer) and never renegotiated again - toggling a source on/off is just a
   * replaceTrack, which is what lets camera and screen share run at the same time.
   */
  updateLocalCombinedTracks() {
    const micTrack = (this.localMicStream && this.localMicStream.getAudioTracks()[0]) || null;
    const camTrack = (this.localCamStream && this.localCamStream.getVideoTracks()[0]) || null;
    const screenVideoTrack = (this.localScreenStream && this.localScreenStream.getVideoTracks()[0]) || null;
    const screenAudioTrack = (this.localScreenStream && this.localScreenStream.getAudioTracks()[0]) || null;

    if (camTrack) camTrack.contentHint = 'motion';
    if (screenVideoTrack) screenVideoTrack.contentHint = 'detail';

    this.peers.forEach((pc, socketId) => {
      const meta = this.peerMeta.get(socketId);
      if (!meta) return;

      this._replaceTrack(meta.micT, micTrack);
      this._replaceTrack(meta.camT, camTrack);
      this._replaceTrack(meta.screenVideoT, screenVideoTrack);
      this._replaceTrack(meta.screenAudioT, screenAudioTrack);
    });
  }

  _replaceTrack(transceiver, track) {
    if (!transceiver || transceiver.sender.track === track) return;
    transceiver.sender.replaceTrack(track).catch(err => {
      console.warn('[WebRTC] Error replacing track:', err);
    });
  }

  getOrCreatePeer(socketId) {
    if (this.peers.has(socketId)) {
      return this.peers.get(socketId);
    }

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

    // Pre-create 4 fixed transceivers up-front, in a stable order: mic audio, camera video,
    // screen video, screen audio. Both peers always create them in this same order, so WebRTC's
    // standard "match unassociated transceivers by kind and order" negotiation binds each side's
    // slots to the same semantic slot on the other side - no extra signaling needed to tell the
    // camera and screen-share video tracks apart, and no renegotiation is needed later since the
    // m-lines never change shape again (toggling a source is just a replaceTrack).
    const micT = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const camT = pc.addTransceiver('video', { direction: 'sendrecv' });
    const screenVideoT = pc.addTransceiver('video', { direction: 'sendrecv' });
    const screenAudioT = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const meta = { micT, camT, screenVideoT, screenAudioT };
    this.peerMeta.set(socketId, meta);

    // Seed any already-active local tracks (e.g. joining with camera already on)
    this._replaceTrack(micT, (this.localMicStream && this.localMicStream.getAudioTracks()[0]) || null);
    this._replaceTrack(camT, (this.localCamStream && this.localCamStream.getVideoTracks()[0]) || null);
    if (this.localScreenStream) {
      this._replaceTrack(screenVideoT, this.localScreenStream.getVideoTracks()[0] || null);
      this._replaceTrack(screenAudioT, this.localScreenStream.getAudioTracks()[0] || null);
    }

    const ensureRemoteStream = (map) => {
      let s = map.get(socketId);
      if (!s) {
        s = new MediaStream();
        map.set(socketId, s);
      }
      return s;
    };

    // Receive remote tracks, routed to 'cam' or 'screen' by which transceiver they arrived on
    pc.ontrack = (event) => {
      let kind = null;
      let streamMap = null;
      if (event.transceiver === meta.camT || event.transceiver === meta.micT) {
        kind = 'cam';
        streamMap = this.remoteCamStreams;
      } else if (event.transceiver === meta.screenVideoT || event.transceiver === meta.screenAudioT) {
        kind = 'screen';
        streamMap = this.remoteScreenStreams;
      } else {
        return;
      }

      console.log(`[WebRTC] Received remote ${kind} track (${event.track.kind}) from ${socketId}`);
      const remoteStream = ensureRemoteStream(streamMap);
      const track = event.track;

      if (track.kind === 'video') {
        remoteStream.getVideoTracks().forEach(oldTrack => {
          if (oldTrack !== track) {
            remoteStream.removeTrack(oldTrack);
            try { oldTrack.stop(); } catch (e) {}
          }
        });
      } else {
        remoteStream.getAudioTracks().forEach(oldTrack => {
          if (oldTrack !== track) remoteStream.removeTrack(oldTrack);
        });
      }
      remoteStream.addTrack(track);

      track.onended = () => {
        console.log(`[WebRTC] Remote ${kind} track ended (${track.kind}) from ${socketId}`);
        try { remoteStream.removeTrack(track); } catch (e) {}
        if (this.onRemoteStreamRemoved) this.onRemoteStreamRemoved(socketId, kind);
      };

      track.onmute = () => {
        if (track.kind === 'video' && this.onRemoteStreamRemoved) {
          this.onRemoteStreamRemoved(socketId, kind);
        }
      };

      track.onunmute = () => {
        if (this.onRemoteStreamAdded) this.onRemoteStreamAdded(socketId, kind, remoteStream);
      };

      if (this.onRemoteStreamAdded) this.onRemoteStreamAdded(socketId, kind, remoteStream);
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

  async connectToPeer(socketId) {
    console.log(`[WebRTC] Initiating connection to peer ${socketId}`);
    const pc = this.getOrCreatePeer(socketId);

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

    this.peerMeta.delete(socketId);
    this.iceCandidateQueues.delete(socketId);

    [this.remoteCamStreams, this.remoteScreenStreams].forEach(map => {
      const stream = map.get(socketId);
      if (stream) {
        stream.getTracks().forEach(t => {
          try { t.stop(); } catch (e) {}
        });
        map.delete(socketId);
      }
    });

    if (this.onRemoteStreamRemoved) {
      this.onRemoteStreamRemoved(socketId, 'cam');
      this.onRemoteStreamRemoved(socketId, 'screen');
    }
  }

  cleanupAll() {
    this.peers.forEach((pc) => pc.close());
    this.peers.clear();
    this.peerMeta.clear();
    this.iceCandidateQueues.clear();

    [this.remoteCamStreams, this.remoteScreenStreams].forEach(map => {
      map.forEach(stream => {
        stream.getTracks().forEach(t => {
          try { t.stop(); } catch (e) {}
        });
      });
      map.clear();
    });

    if (this.localMicStream) {
      this.localMicStream.getTracks().forEach(t => t.stop());
      this.localMicStream = null;
    }
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
