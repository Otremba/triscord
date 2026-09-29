/**
 * Triscord SFU media manager.
 *
 * Media path:
 *   client -> mediasoup WebRtcTransport -> Router/SFU -> consumers -> clients
 *
 * Socket.io remains signaling only. There is no peer-to-peer mesh here.
 */
class WebRTCManager {
  constructor(socket, currentUserId, options = {}) {
    this.socket = socket;
    this.currentUserId = currentUserId;

    this.device = null;
    this.sendTransport = null;
    this.recvTransport = null;
    this.joinedRoomId = null;
    this.transportReady = false;

    this.producers = new Map();
    this.consumers = new Map();
    this.remoteStreams = new Map();
    this.remoteScreenStreams = new Map();
    this.remoteProducerMeta = new Map();

    this.localMicStream = null;
    this.localCamStream = null;
    this.localScreenStream = null;

    this.rawCamStream = null;
    this.cameraEffects = null;
    this.cameraEffect = { type: 'none' };
    this.cameraEffectVersion = 0;
    this.micCapture = null;
    this.noiseSuppressionMode = null;

    this.onRemoteStreamAdded = null;
    this.onRemoteStreamRemoved = null;
    this.onConnectionQualityChanged = null;
    this.onLocalCameraChanged = null;

    this.userCustomIceServers = Array.isArray(options.iceServers) ? options.iceServers : [];
    this.iceServers = this.userCustomIceServers;
    this.iceTransportPolicy = options.iceTransportPolicy === 'relay' ? 'relay' : 'all';

    this._joinPromise = null;
    this._joinResolve = null;
    this._joinReject = null;
    this._setupSocketListeners();
  }

  updateIceServers(servers, policy = this.iceTransportPolicy) {
    if (!Array.isArray(servers) || !servers.length) return;
    this.iceServers = servers;
    this.iceTransportPolicy = policy === 'relay' ? 'relay' : 'all';

    [this.sendTransport, this.recvTransport].forEach(async transport => {
      if (!transport?.updateIceServers) return;
      try {
        await transport.updateIceServers({ iceServers: this.iceServers });
      } catch (error) {
        console.warn('[SFU] Failed to update ICE servers:', error);
      }
    });
  }

  _setupSocketListeners() {
    this.socket.on('sfu-router-capabilities', async data => {
      try {
        await this._loadDevice(data.routerRtpCapabilities);
        await this._ensureTransports();

        for (const producer of data.existingProducers || []) {
          await this._consumeProducer(producer);
        }

        await this._produceAllLocalTracks();
        this._joinResolve?.();
        this._joinResolve = null;
        this._joinReject = null;
      } catch (error) {
        console.error('[SFU] Initialization failed:', error);
        this._joinReject?.(error);
        this._joinResolve = null;
        this._joinReject = null;
      }
    });

    this.socket.on('sfu-new-producer', producer => {
      this._consumeProducer(producer).catch(error => {
        console.error('[SFU] New producer failed:', error);
      });
    });

    this.socket.on('sfu-producer-closed', ({ producerId }) => {
      this._closeConsumerByProducerId(producerId);
    });
  }

  async _loadDevice(routerRtpCapabilities) {
    if (this.device?.loaded) return;

    const mediasoupClient = window.mediasoupClient;
    if (!mediasoupClient?.Device) {
      throw new Error('mediasoup-client não foi carregado');
    }

    this.device = await mediasoupClient.Device.factory();
    await this.device.load({ routerRtpCapabilities });
    console.log('[SFU] Device loaded:', this.device.handlerName);
  }

  _request(event, payload) {
    return new Promise((resolve, reject) => {
      this.socket.emit(event, payload, response => {
        if (!response?.ok) {
          reject(new Error(response?.error || event + ' failed'));
          return;
        }
        resolve(response);
      });
    });
  }

  async _createTransport(direction) {
    const response = await this._request('sfu-create-transport', { direction });
    const params = {
      ...response.transport,
      iceServers: this.iceServers,
      iceTransportPolicy: this.iceTransportPolicy
    };

    const transport = direction === 'send'
      ? this.device.createSendTransport(params)
      : this.device.createRecvTransport(params);

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await this._request('sfu-connect-transport', {
          transportId: transport.id,
          dtlsParameters
        });
        callback();
      } catch (error) {
        errback(error);
      }
    });

    if (direction === 'send') {
      transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          const result = await this._request('sfu-produce', {
            transportId: transport.id,
            kind,
            rtpParameters,
            source: appData?.source
          });
          callback({ id: result.producerId });
        } catch (error) {
          errback(error);
        }
      });
    }

    transport.on('connectionstatechange', state => {
      console.log('[SFU] ' + direction + ' transport: ' + state);
      if (['failed', 'disconnected'].includes(state)) {
        this.onConnectionQualityChanged?.('sfu', {
          level: state === 'failed' ? 'bad' : 'ok',
          rttMs: null,
          lossPct: null
        });
      }
    });

    return transport;
  }  async _ensureTransports() {
    if (!this.sendTransport) this.sendTransport = await this._createTransport('send');
    if (!this.recvTransport) this.recvTransport = await this._createTransport('recv');
    this.transportReady = true;
  }

  async joinRoom(roomId) {
    if (!roomId) return;
    if (this.joinedRoomId === roomId && this.transportReady) return;

    this.resetPeers(false);
    this.joinedRoomId = roomId;

    this._joinPromise = new Promise((resolve, reject) => {
      this._joinResolve = resolve;
      this._joinReject = reject;
    });

    this.socket.emit('sfu-join-room', { roomId });

    return this._joinPromise;
  }

  _sourceStream(source) {
    if (source === 'mic') return this.localMicStream;
    if (source === 'cam') return this.localCamStream;
    if (source === 'screen') return this.localScreenStream;
    return this.localScreenStream;
  }

  async _produceSource(source, stream) {
    if (!this.sendTransport || !stream) return null;
    const track = stream.getTracks()[source === 'screenAudio' ? 0 : 0];
    if (!track) return null;

    const existing = this.producers.get(source);
    if (existing && !existing.closed) {
      await existing.replaceTrack({ track });
      return existing;
    }

    const producer = await this.sendTransport.produce({
      track,
      stopTracks: false,
      appData: { source },
      streamId: stream.id,
      ...(track.kind === 'video' && source === 'cam'
        ? {
            encodings: [
              { maxBitrate: 150000 },
              { maxBitrate: 500000 },
              { maxBitrate: 1200000 }
            ],
            codecOptions: { videoGoogleStartBitrate: 600 }
          }
        : {})
    });

    this.producers.set(source, producer);
    producer.on('transportclose', () => this.producers.delete(source));
    producer.on('trackended', () => {
      if (this.producers.get(source) === producer) this.producers.delete(source);
    });
    return producer;
  }

  async _produceAllLocalTracks() {
    if (!this.transportReady) return;
    if (this.localMicStream) await this._produceSource('mic', this.localMicStream);
    if (this.localCamStream) await this._produceSource('cam', this.localCamStream);
    if (this.localScreenStream) {
      await this._produceSource('screen', this.localScreenStream);
      const audioTrack = this.localScreenStream.getAudioTracks()[0];
      if (audioTrack) await this._produceTrack('screenAudio', audioTrack, this.localScreenStream);
    }
  }

  async _produceTrack(source, track, stream) {
    if (!this.sendTransport || !track) return null;
    const existing = this.producers.get(source);
    if (existing && !existing.closed) {
      await existing.replaceTrack({ track });
      return existing;
    }

    const producer = await this.sendTransport.produce({
      track,
      stopTracks: false,
      appData: { source },
      streamId: stream?.id || source
    });
    this.producers.set(source, producer);
    producer.on('transportclose', () => this.producers.delete(source));
    producer.on('trackended', () => {
      if (this.producers.get(source) === producer) this.producers.delete(source);
    });
    return producer;
  }

  async _consumeProducer(info) {
    if (!this.recvTransport || this.consumers.has(info.producerId)) return;

    const response = await this._request('sfu-consume', {
      producerId: info.producerId,
      rtpCapabilities: this.device.recvRtpCapabilities
    });

    const data = response.consumer;
    const consumer = await this.recvTransport.consume({
      id: data.id,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters
    });

    this.consumers.set(consumer.id, {
      consumer,
      socketId: info.socketId,
      source: info.source,
      producerId: info.producerId
    });

    this.remoteProducerMeta.set(info.producerId, info);

    consumer.on('transportclose', () => this._removeConsumer(consumer.id));
    consumer.on('producerclose', () => this._removeConsumer(consumer.id));

    await this._request('sfu-resume-consumer', { consumerId: consumer.id });
    this._addRemoteTrack(info.socketId, info.source, consumer.track);
  }

  _addRemoteTrack(socketId, source, track) {
    const isScreen = source === 'screen' || source === 'screenAudio';
    const map = isScreen ? this.remoteScreenStreams : this.remoteStreams;
    let stream = map.get(socketId);

    if (!stream) {
      stream = new MediaStream();
      map.set(socketId, stream);
    }

    if (!stream.getTracks().some(existing => existing.id === track.id)) {
      stream.addTrack(track);
    }

    this.onRemoteStreamAdded?.(socketId, stream, isScreen);
  }

  _removeConsumer(consumerId) {
    const entry = this.consumers.get(consumerId);
    if (!entry) return;

    const { socketId, source, consumer } = entry;
    const isScreen = source === 'screen' || source === 'screenAudio';
    const map = isScreen ? this.remoteScreenStreams : this.remoteStreams;
    const stream = map.get(socketId);

    if (stream) {
      const track = consumer.track;
      if (track) stream.removeTrack(track);
      if (!stream.getTracks().length) map.delete(socketId);
    }

    this.consumers.delete(consumerId);
    this.remoteProducerMeta.delete(entry.producerId);
    this.onRemoteStreamRemoved?.(socketId, isScreen);
  }

  _closeConsumerByProducerId(producerId) {
    for (const [consumerId, entry] of this.consumers) {
      if (entry.producerId === producerId) {
        entry.consumer.close();
        this._removeConsumer(consumerId);
      }
    }
  }  async startMicrophone(audioDeviceId = null, noiseSuppression = true) {
    const constraints = {
      echoCancellation: true,
      autoGainControl: true
    };
    if (audioDeviceId && !['default', 'communications'].includes(audioDeviceId)) {
      constraints.deviceId = { exact: audioDeviceId };
    }

    try {
      const mic = await window.captureMicrophone(constraints, noiseSuppression);
      this.stopMicrophone();
      this.micCapture = mic;
      this.localMicStream = mic.stream;
      this.noiseSuppressionMode = mic.mode;

      if (this.transportReady) await this._produceSource('mic', this.localMicStream);
      return this.localMicStream;
    } catch (error) {
      console.warn('[SFU] Mic capture fallback:', error);
      const fallback = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.stopMicrophone();
      this.localMicStream = fallback;
      this.noiseSuppressionMode = 'off';
      if (this.transportReady) await this._produceSource('mic', fallback);
      return fallback;
    }
  }

  stopMicrophone() {
    const producer = this.producers.get('mic');
    if (producer) {
      const producerId = producer.id;
      producer.close();
      this.producers.delete('mic');
      if (this.joinedRoomId) this.socket.emit('sfu-close-producer', { producerId });
    }

    if (this.micCapture) {
      this.micCapture.release();
      this.micCapture = null;
    }
    if (this.localMicStream) {
      this.localMicStream.getTracks().forEach(track => track.stop());
      this.localMicStream = null;
    }
    this.noiseSuppressionMode = null;
  }

  async startCamera(videoDeviceId = null) {
    const video = {
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      frameRate: { ideal: 30 }
    };

    if (videoDeviceId && videoDeviceId !== 'default') {
      video.deviceId = { exact: videoDeviceId };
    } else {
      video.facingMode = 'user';
    }

    try {
      this.rawCamStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video
      });
    } catch (error) {
      console.warn('[SFU] Constrained camera failed, using basic video:', error);
      this.rawCamStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }

    this.useCameraStream(this.rawCamStream);

    if (this.cameraEffect.type !== 'none') {
      this.setCameraEffect(this.cameraEffect).catch(err => {
        console.warn('[SFU] Camera effect unavailable:', err);
      });
    }

    return this.localCamStream;
  }

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

    if (version !== this.cameraEffectVersion || !this.rawCamStream) {
      processor.stop();
      return;
    }

    this.cameraEffects = processor;
    this.useCameraStream(processor.stream);
  }

  useCameraStream(stream) {
    this.localCamStream = stream;
    const track = stream?.getVideoTracks()[0] || null;
    if (track) track.contentHint = 'motion';

    const producer = this.producers.get('cam');
    if (producer && track) {
      producer.replaceTrack({ track }).catch(error =>
        console.error('[SFU] Camera replaceTrack failed:', error)
      );
    } else if (track && this.transportReady) {
      this._produceTrack('cam', track, stream).catch(error =>
        console.error('[SFU] Camera produce failed:', error)
      );
    }

    this.onLocalCameraChanged?.(stream);
  }

  stopCameraEffects() {
    if (this.cameraEffects) {
      this.cameraEffects.stop();
      this.cameraEffects = null;
    }
  }

  stopCamera() {
    const producer = this.producers.get('cam');
    if (producer) {
      const producerId = producer.id;
      producer.close();
      this.producers.delete('cam');
      if (this.joinedRoomId) this.socket.emit('sfu-close-producer', { producerId });
    }

    this.cameraEffectVersion++;
    this.stopCameraEffects();
    if (this.rawCamStream) this.rawCamStream.getTracks().forEach(track => track.stop());
    this.rawCamStream = null;
    this.localCamStream = null;
  }  setScreenStream(screenStream) {
    this.localScreenStream = screenStream;

    if (!screenStream) {
      this._closeProducer('screen');
      this._closeProducer('screenAudio');
      return;
    }

    const screenTrack = screenStream.getVideoTracks()[0];
    const audioTrack = screenStream.getAudioTracks()[0];

    if (screenTrack) {
      screenTrack.contentHint = 'detail';
      this._produceTrack('screen', screenTrack, screenStream).catch(error =>
        console.error('[SFU] Screen produce failed:', error)
      );
    }

    if (audioTrack) {
      this._produceTrack('screenAudio', audioTrack, screenStream).catch(error =>
        console.error('[SFU] Screen audio produce failed:', error)
      );
    }
  }

  stopScreenShare() {
    const stream = this.localScreenStream;
    this.setScreenStream(null);
    if (stream) stream.getTracks().forEach(track => track.stop());
    this.localScreenStream = null;
  }

  _closeProducer(source) {
    const producer = this.producers.get(source);
    if (!producer) return;

    const producerId = producer.id;
    producer.close();
    this.producers.delete(source);
    if (this.joinedRoomId) {
      this.socket.emit('sfu-close-producer', { producerId });
    }
  }

  applyTrackToPeers(source, track) {
    const producer = this.producers.get(source);
    if (!producer || !track) return;
    producer.replaceTrack({ track }).catch(error => {
      console.error('[SFU] replaceTrack failed:', source, error);
    });
  }

  async connectToPeer(socketId) {
    if (!this.joinedRoomId) return;
    return this._joinPromise;
  }

  removePeer(socketId) {
    for (const [consumerId, entry] of this.consumers) {
      if (entry.socketId === socketId) {
        entry.consumer.close();
        this._removeConsumer(consumerId);
      }
    }
  }

  resetPeers(sendLeave = true) {
    if (sendLeave && this.joinedRoomId) {
      this.socket.emit('sfu-leave-room');
    }

    this.consumers.forEach(entry => entry.consumer.close());
    this.consumers.clear();
    this.remoteStreams.clear();
    this.remoteScreenStreams.clear();
    this.remoteProducerMeta.clear();

    this.producers.forEach(producer => producer.close());
    this.producers.clear();

    if (this.sendTransport) this.sendTransport.close();
    if (this.recvTransport) this.recvTransport.close();

    this.sendTransport = null;
    this.recvTransport = null;
    this.transportReady = false;
    this.joinedRoomId = null;
    this.device = null;

    this._joinPromise = null;
    this._joinResolve = null;
    this._joinReject = null;
  }

  cleanupAll() {
    this.resetPeers(true);
    this.stopCamera();
    this.stopMicrophone();
    this.stopScreenShare();
  }
}

window.WebRTCManager = WebRTCManager;