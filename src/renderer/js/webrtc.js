/**
 * WebRTC Multi-Peer Mesh Manager
 * Manages RTCPeerConnections with Simultaneous Camera AND Screen Sharing (Dual Video Streams)
 */

class WebRTCManager {
  constructor(socket, currentUserId) {
    this.socket = socket;
    this.currentUserId = currentUserId;

    // Map: socketId -> RTCPeerConnection
    this.peers = new Map();
    // Map: socketId -> remote Camera/Voice MediaStream
    this.remoteStreams = new Map();
    // Map: socketId -> remote Screen Share MediaStream
    this.remoteScreenStreams = new Map();
    // Map: socketId -> Array<RTCIceCandidate>
    this.iceCandidateQueues = new Map();

    // Local streams
    this.localMicStream = null;
    this.localCamStream = null;
    this.localScreenStream = null;

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
      const pc = this.getOrCreatePeer(senderSocketId);

      try {
        if (pc.signalingState !== 'stable') {
          console.log(`[WebRTC] Rollback collision on ${senderSocketId}`);
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }).catch(() => {}),
            pc.setRemoteDescription(new RTCSessionDescription(offer))
          ]);
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
        }

        // Process queued ICE candidates
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
   * Acquire local microphone audio
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
   * Acquire local webcam video
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
      const camTrack = this.localCamStream.getVideoTracks()[0];
      if (camTrack) camTrack.contentHint = 'motion';

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
    const screenTrack = this.localScreenStream.getVideoTracks()[0];
    if (screenTrack) screenTrack.contentHint = 'detail';

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
   * Update tracks on all peer connections:
   * Senders are dedicated:
   * 1. Audio (mic)
   * 2. Camera Video
   * 3. Screen Share Video (+ optional Screen Audio)
   */
  updateLocalCombinedTracks() {
    const activeMicTrack = this.localMicStream ? this.localMicStream.getAudioTracks()[0] : null;
    const activeCamTrack = this.localCamStream ? this.localCamStream.getVideoTracks()[0] : null;
    const activeScreenTrack = this.localScreenStream ? this.localScreenStream.getVideoTracks()[0] : null;
    const activeScreenAudioTrack = this.localScreenStream ? this.localScreenStream.getAudioTracks()[0] : null;

    this.peers.forEach((pc, targetSocketId) => {
      let needsRenegotiation = false;
      const transceivers = pc.getTransceivers();

      // 1. Audio Transceiver (index 0)
      const audioT = transceivers[0];
      if (audioT) {
        if (audioT.sender.track !== activeMicTrack) {
          audioT.sender.replaceTrack(activeMicTrack).catch(e => console.warn('Audio replaceTrack error:', e));
          needsRenegotiation = true;
        }
      } else if (activeMicTrack) {
        try {
          pc.addTrack(activeMicTrack, new MediaStream([activeMicTrack]));
          needsRenegotiation = true;
        } catch (e) {}
      }

      // 2. Camera Video Transceiver (index 1)
      const camT = transceivers[1];
      if (camT) {
        if (camT.sender.track !== activeCamTrack) {
          camT.sender.replaceTrack(activeCamTrack).catch(e => console.warn('Cam replaceTrack error:', e));
          needsRenegotiation = true;
        }
      } else if (activeCamTrack) {
        try {
          pc.addTrack(activeCamTrack, new MediaStream([activeCamTrack]));
          needsRenegotiation = true;
        } catch (e) {}
      }

      // 3. Screen Share Video Transceiver (index 2)
      const screenT = transceivers[2];
      if (screenT) {
        if (screenT.sender.track !== activeScreenTrack) {
          screenT.sender.replaceTrack(activeScreenTrack).catch(e => console.warn('Screen replaceTrack error:', e));
          needsRenegotiation = true;
        }
      } else if (activeScreenTrack) {
        try {
          pc.addTrack(activeScreenTrack, new MediaStream([activeScreenTrack]));
          needsRenegotiation = true;
        } catch (e) {}
      }

      // Optional: Screen Audio Transceiver (index 3)
      const screenAudioT = transceivers[3];
      if (screenAudioT) {
        if (screenAudioT.sender.track !== activeScreenAudioTrack) {
          screenAudioT.sender.replaceTrack(activeScreenAudioTrack).catch(e => console.warn('Screen audio replaceTrack error:', e));
          needsRenegotiation = true;
        }
      } else if (activeScreenAudioTrack) {
        try {
          pc.addTrack(activeScreenAudioTrack, new MediaStream([activeScreenAudioTrack]));
          needsRenegotiation = true;
        } catch (e) {}
      }

      if (needsRenegotiation) {
        this.renegotiatePeer(targetSocketId);
      }
    });
  }

  getOrCreatePeer(socketId) {
    if (this.peers.has(socketId)) {
      return this.peers.get(socketId);
    }

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-ice-candidate', {
          targetSocketId: socketId,
          candidate: event.candidate,
          type: 'mesh'
        });
      }
    };

    // Pre-create 4 transceivers for clean, predictable m-lines:
    // 0: Audio (Mic)
    // 1: Video (Webcam)
    // 2: Video (Screen Share)
    // 3: Audio (Screen Audio)
    const activeMicTrack = this.localMicStream ? this.localMicStream.getAudioTracks()[0] : null;
    const activeCamTrack = this.localCamStream ? this.localCamStream.getVideoTracks()[0] : null;
    const activeScreenTrack = this.localScreenStream ? this.localScreenStream.getVideoTracks()[0] : null;
    const activeScreenAudioTrack = this.localScreenStream ? this.localScreenStream.getAudioTracks()[0] : null;

    if (activeMicTrack) pc.addTrack(activeMicTrack, new MediaStream([activeMicTrack]));
    else pc.addTransceiver('audio', { direction: 'sendrecv' });

    if (activeCamTrack) pc.addTrack(activeCamTrack, new MediaStream([activeCamTrack]));
    else pc.addTransceiver('video', { direction: 'sendrecv' });

    if (activeScreenTrack) pc.addTrack(activeScreenTrack, new MediaStream([activeScreenTrack]));
    else pc.addTransceiver('video', { direction: 'sendrecv' });

    if (activeScreenAudioTrack) pc.addTrack(activeScreenAudioTrack, new MediaStream([activeScreenAudioTrack]));
    else pc.addTransceiver('audio', { direction: 'sendrecv' });

    // Handle receiving remote tracks
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Received remote track (${event.track.kind}) from ${socketId}`);

      const transceivers = pc.getTransceivers();
      const transceiverIndex = transceivers.findIndex(t => t.receiver === event.receiver);

      // Determine if track is Screen Share (transceiver index 2 or 3, or contentHint detail)
      const isScreen = transceiverIndex === 2 || transceiverIndex === 3 || event.track.contentHint === 'detail';

      if (isScreen) {
        // Screen Share Stream
        let screenStream = this.remoteScreenStreams.get(socketId);
        if (!screenStream) {
          screenStream = new MediaStream();
          this.remoteScreenStreams.set(socketId, screenStream);
        }

        if (event.track.kind === 'video') {
          screenStream.getVideoTracks().forEach(t => {
            if (t !== event.track) screenStream.removeTrack(t);
          });
          screenStream.addTrack(event.track);
        } else if (event.track.kind === 'audio') {
          screenStream.getAudioTracks().forEach(t => {
            if (t !== event.track) screenStream.removeTrack(t);
          });
          screenStream.addTrack(event.track);
        }

        event.track.onended = () => {
          console.log(`[WebRTC] Screen track ended from ${socketId}`);
          try { screenStream.removeTrack(event.track); } catch (e) {}
          if (this.onRemoteStreamRemoved) {
            this.onRemoteStreamRemoved(socketId, true);
          }
        };

        event.track.onunmute = () => {
          console.log(`[WebRTC] Screen track unmuted from ${socketId}`);
          if (this.onRemoteStreamAdded) {
            this.onRemoteStreamAdded(socketId, screenStream, true);
          }
        };

        if (this.onRemoteStreamAdded) {
          this.onRemoteStreamAdded(socketId, screenStream, true);
        }
      } else {
        // Camera & Voice Stream
        let remoteStream = this.remoteStreams.get(socketId);
        if (!remoteStream) {
          remoteStream = new MediaStream();
          this.remoteStreams.set(socketId, remoteStream);
        }

        if (event.track.kind === 'video') {
          remoteStream.getVideoTracks().forEach(t => {
            if (t !== event.track) remoteStream.removeTrack(t);
          });
          remoteStream.addTrack(event.track);
        } else if (event.track.kind === 'audio') {
          remoteStream.getAudioTracks().forEach(t => {
            if (t !== event.track) remoteStream.removeTrack(t);
          });
          remoteStream.addTrack(event.track);
        }

        event.track.onended = () => {
          console.log(`[WebRTC] Cam/Voice track ended from ${socketId}`);
          try { remoteStream.removeTrack(event.track); } catch (e) {}
          if (this.onRemoteStreamRemoved) {
            this.onRemoteStreamRemoved(socketId, false);
          }
        };

        event.track.onunmute = () => {
          if (this.onRemoteStreamAdded) {
            this.onRemoteStreamAdded(socketId, remoteStream, false);
          }
        };

        if (this.onRemoteStreamAdded) {
          this.onRemoteStreamAdded(socketId, remoteStream, false);
        }
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

  async connectToPeer(socketId) {
    console.log(`[WebRTC] Initiating connection to peer ${socketId}`);
    const pc = this.getOrCreatePeer(socketId);

    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
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

  async renegotiatePeer(socketId) {
    const pc = this.peers.get(socketId);
    if (!pc) return;

    if (pc.signalingState !== 'stable') {
      console.log(`[WebRTC] Queuing renegotiation with ${socketId} (state: ${pc.signalingState})`);
      const checkInterval = setInterval(async () => {
        if (!this.peers.has(socketId)) {
          clearInterval(checkInterval);
          return;
        }
        if (pc.signalingState === 'stable') {
          clearInterval(checkInterval);
          this.renegotiatePeer(socketId);
        }
      }, 150);
      return;
    }

    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);

      this.socket.emit('webrtc-offer', {
        targetSocketId: socketId,
        offer: pc.localDescription,
        type: 'renegotiate'
      });
    } catch (err) {
      console.error(`[WebRTC] Error renegotiating with peer ${socketId}:`, err);
    }
  }

  removePeer(socketId) {
    if (this.peers.has(socketId)) {
      const pc = this.peers.get(socketId);
      pc.close();
      this.peers.delete(socketId);
    }

    this.iceCandidateQueues.delete(socketId);

    if (this.remoteStreams.has(socketId)) {
      const stream = this.remoteStreams.get(socketId);
      stream.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
      this.remoteStreams.delete(socketId);
    }

    if (this.remoteScreenStreams.has(socketId)) {
      const stream = this.remoteScreenStreams.get(socketId);
      stream.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
      this.remoteScreenStreams.delete(socketId);
    }

    if (this.onRemoteStreamRemoved) {
      this.onRemoteStreamRemoved(socketId, false);
      this.onRemoteStreamRemoved(socketId, true);
    }
  }

  cleanupAll() {
    this.peers.forEach((pc) => pc.close());
    this.peers.clear();
    this.iceCandidateQueues.clear();

    this.remoteStreams.forEach(stream => {
      stream.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
    });
    this.remoteStreams.clear();

    this.remoteScreenStreams.forEach(stream => {
      stream.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
    });
    this.remoteScreenStreams.clear();

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
