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
    // Map: socketId -> remote MediaStream
    this.remoteStreams = new Map();
    // Map: socketId -> Array<RTCIceCandidate> (queued candidates before remote description)
    this.iceCandidateQueues = new Map();

    // Local streams
    this.localMicStream = null;
    this.localCamStream = null;
    this.localScreenStream = null;

    // Combined local stream
    this.localCombinedStream = new MediaStream();

    // Callbacks
    this.onRemoteStreamAdded = null; // (socketId, stream)
    this.onRemoteStreamRemoved = null; // (socketId, isVideo)

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
   * Update active tracks in all peer connections using replaceTrack for seamless video toggling
   */
  updateLocalCombinedTracks() {
    // Determine active video track (screen share takes priority over camera)
    let activeVideoTrack = null;
    if (this.localScreenStream && this.localScreenStream.getVideoTracks().length > 0) {
      activeVideoTrack = this.localScreenStream.getVideoTracks()[0];
      activeVideoTrack.contentHint = 'detail';
    } else if (this.localCamStream && this.localCamStream.getVideoTracks().length > 0) {
      activeVideoTrack = this.localCamStream.getVideoTracks()[0];
      activeVideoTrack.contentHint = 'motion';
    }

    // Determine active audio track
    let activeAudioTrack = null;
    if (this.localMicStream && this.localMicStream.getAudioTracks().length > 0) {
      activeAudioTrack = this.localMicStream.getAudioTracks()[0];
    }

    // Update tracks on all peer connections
    this.peers.forEach((pc, targetSocketId) => {
      let videoNeedsRenegotiation = false;
      let audioNeedsRenegotiation = false;

      // 1. Handle Video Sender
      const videoTransceiver = pc.getTransceivers().find(
        t => (t.sender.track && t.sender.track.kind === 'video') || t.receiver.track.kind === 'video'
      );

      if (videoTransceiver) {
        // Use replaceTrack on existing transceiver (works without renegotiation glitch!)
        if (videoTransceiver.sender.track !== activeVideoTrack) {
          videoTransceiver.sender.replaceTrack(activeVideoTrack).catch(err => {
            console.warn('[WebRTC] Error replacing video track:', err);
          });
        }
      } else if (activeVideoTrack) {
        // No video transceiver exists yet, add track and trigger renegotiation
        try {
          pc.addTrack(activeVideoTrack, this.localCombinedStream);
          videoNeedsRenegotiation = true;
        } catch (e) {
          console.warn('[WebRTC] Error adding video track:', e);
        }
      }

      // 2. Handle Audio Sender
      const audioTransceiver = pc.getTransceivers().find(
        t => (t.sender.track && t.sender.track.kind === 'audio') || t.receiver.track.kind === 'audio'
      );

      if (audioTransceiver) {
        if (audioTransceiver.sender.track !== activeAudioTrack) {
          audioTransceiver.sender.replaceTrack(activeAudioTrack).catch(err => {
            console.warn('[WebRTC] Error replacing audio track:', err);
          });
        }
      } else if (activeAudioTrack) {
        try {
          pc.addTrack(activeAudioTrack, this.localCombinedStream);
          audioNeedsRenegotiation = true;
        } catch (e) {
          console.warn('[WebRTC] Error adding audio track:', e);
        }
      }

      if (videoNeedsRenegotiation || audioNeedsRenegotiation) {
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

    // Pre-create transceivers for both audio and video to ensure stable m-lines
    const activeVideoTrack = (this.localScreenStream && this.localScreenStream.getVideoTracks()[0]) ||
                             (this.localCamStream && this.localCamStream.getVideoTracks()[0]) ||
                             null;
    const activeAudioTrack = (this.localMicStream && this.localMicStream.getAudioTracks()[0]) || null;

    if (activeAudioTrack) {
      pc.addTrack(activeAudioTrack, this.localCombinedStream);
    } else {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
    }

    if (activeVideoTrack) {
      pc.addTrack(activeVideoTrack, this.localCombinedStream);
    } else {
      pc.addTransceiver('video', { direction: 'sendrecv' });
    }

    // Receive remote tracks
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Received remote track (${event.track.kind}) from ${socketId}`);

      let remoteStream = this.remoteStreams.get(socketId);
      if (!remoteStream) {
        remoteStream = new MediaStream();
        this.remoteStreams.set(socketId, remoteStream);
      }

      if (event.track.kind === 'video') {
        // Clean up any stale or previous video tracks in the stream
        remoteStream.getVideoTracks().forEach(oldTrack => {
          if (oldTrack !== event.track) {
            remoteStream.removeTrack(oldTrack);
            try { oldTrack.stop(); } catch (e) {}
          }
        });
        remoteStream.addTrack(event.track);
      } else if (event.track.kind === 'audio') {
        // Clean up stale audio tracks
        remoteStream.getAudioTracks().forEach(oldTrack => {
          if (oldTrack !== event.track) {
            remoteStream.removeTrack(oldTrack);
          }
        });
        remoteStream.addTrack(event.track);
      }

      event.track.onended = () => {
        console.log(`[WebRTC] Remote track ended (${event.track.kind}) from ${socketId}`);
        try { remoteStream.removeTrack(event.track); } catch (e) {}
        if (this.onRemoteStreamRemoved) {
          this.onRemoteStreamRemoved(socketId, event.track.kind === 'video');
        }
      };

      event.track.onmute = () => {
        console.log(`[WebRTC] Remote track muted (${event.track.kind}) from ${socketId}`);
        if (event.track.kind === 'video' && this.onRemoteStreamRemoved) {
          this.onRemoteStreamRemoved(socketId, true);
        }
      };

      event.track.onunmute = () => {
        console.log(`[WebRTC] Remote track unmuted (${event.track.kind}) from ${socketId}`);
        if (this.onRemoteStreamAdded) {
          this.onRemoteStreamAdded(socketId, remoteStream);
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
      pc.onnegotiationneeded = () => {
        pc.onnegotiationneeded = null;
        this.renegotiatePeer(socketId);
      };
      return;
    }

    try {
      const offer = await pc.createOffer();
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

    if (this.onRemoteStreamRemoved) {
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
