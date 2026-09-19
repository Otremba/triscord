/**
 * WebRTC Multi-Peer Mesh Manager
 * Manages RTCPeerConnections for all peers in the voice/video room.
 */

class WebRTCManager {
  constructor(socket, currentUserId) {
    this.socket = socket;
    this.currentUserId = currentUserId;

    // Map: socketId -> RTCPeerConnection
    this.peers = new Map();
    // Map: socketId -> remote MediaStream
    this.remoteStreams = new Map();
    // Map: socketId -> remote Screen MediaStream (if any)
    this.remoteScreenStreams = new Map();

    // Local streams
    this.localMicStream = null;
    this.localCamStream = null;
    this.localScreenStream = null;

    // Combined local stream that gets sent to peers
    this.localCombinedStream = new MediaStream();

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
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
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
   * Acquire local microphone audio stream with noise suppression & echo cancellation
   */
  async startMicrophone(audioDeviceId = null, noiseSuppression = true) {
    try {
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression,
          autoGainControl: true,
          ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {})
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
          ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {})
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
   * Update active tracks in all peer connections
   */
  updateLocalCombinedTracks() {
    // Collect all active local tracks
    const activeTracks = [];

    if (this.localMicStream) {
      const audioTrack = this.localMicStream.getAudioTracks()[0];
      if (audioTrack) activeTracks.push(audioTrack);
    }

    if (this.localCamStream) {
      const camTrack = this.localCamStream.getVideoTracks()[0];
      if (camTrack) {
        camTrack.contentHint = 'motion';
        activeTracks.push(camTrack);
      }
    }

    if (this.localScreenStream) {
      const screenTrack = this.localScreenStream.getVideoTracks()[0];
      if (screenTrack) {
        screenTrack.contentHint = 'detail';
        activeTracks.push(screenTrack);
      }
      const screenAudioTrack = this.localScreenStream.getAudioTracks()[0];
      if (screenAudioTrack) activeTracks.push(screenAudioTrack);
    }

    // Update each existing peer connection
    this.peers.forEach((pc, targetSocketId) => {
      const senders = pc.getSenders();
      const currentSenderTracks = senders.map(s => s.track).filter(Boolean);

      // Remove senders for tracks that are no longer active
      senders.forEach(sender => {
        if (sender.track && !activeTracks.includes(sender.track)) {
          try {
            pc.removeTrack(sender);
          } catch (e) {}
        }
      });

      // Add senders for newly active tracks
      activeTracks.forEach(track => {
        if (!currentSenderTracks.includes(track)) {
          try {
            pc.addTrack(track, this.localCombinedStream);
          } catch (e) {}
        }
      });

      // Renegotiate offer with peer
      this.renegotiatePeer(targetSocketId);
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

    // Receive remote tracks
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Received remote track from ${socketId}:`, event.track.kind);
      
      let remoteStream = this.remoteStreams.get(socketId);
      if (!remoteStream) {
        remoteStream = new MediaStream();
        this.remoteStreams.set(socketId, remoteStream);
      }

      remoteStream.addTrack(event.track);

      event.track.onended = () => {
        console.log(`[WebRTC] Remote track ended from ${socketId}`);
        if (this.onRemoteStreamRemoved) {
          this.onRemoteStreamRemoved(socketId, false);
        }
      };

      if (this.onRemoteStreamAdded) {
        this.onRemoteStreamAdded(socketId, remoteStream);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state with ${socketId}: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removePeer(socketId);
      }
    };

    // Add current local tracks to new peer connection
    if (this.localMicStream) {
      this.localMicStream.getAudioTracks().forEach(track => pc.addTrack(track, this.localCombinedStream));
    }
    if (this.localCamStream) {
      this.localCamStream.getVideoTracks().forEach(track => pc.addTrack(track, this.localCombinedStream));
    }
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(track => pc.addTrack(track, this.localCombinedStream));
    }

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
    if (!pc || pc.signalingState !== 'stable') return;

    try {
      const offer = await pc.createOffer();
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

    if (this.remoteStreams.has(socketId)) {
      const stream = this.remoteStreams.get(socketId);
      stream.getTracks().forEach(t => t.stop());
      this.remoteStreams.delete(socketId);
    }

    if (this.onRemoteStreamRemoved) {
      this.onRemoteStreamRemoved(socketId);
    }
  }

  cleanupAll() {
    this.peers.forEach((pc) => pc.close());
    this.peers.clear();

    this.remoteStreams.forEach(stream => {
      stream.getTracks().forEach(t => t.stop());
    });
    this.remoteStreams.clear();

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
