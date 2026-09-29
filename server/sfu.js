const mediasoup = require('mediasoup');

const peers = new Map();
let worker = null;
let router = null;

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {}
  }
];

async function init() {
  if (router) return router;

  worker = await mediasoup.createWorker({
    logLevel: process.env.MEDIASOUP_LOG_LEVEL || 'warn',
    rtcMinPort: Number(process.env.MEDIASOUP_MIN_PORT || 40000),
    rtcMaxPort: Number(process.env.MEDIASOUP_MAX_PORT || 40100)
  });

  worker.on('died', error => {
    console.error('[SFU] mediasoup worker died:', error);
    process.exit(1);
  });

  router = await worker.createRouter({ mediaCodecs });
  console.log('[SFU] mediasoup router ready:', router.id);
  return router;
}

function requireRouter() {
  if (!router) throw new Error('SFU not initialized');
  return router;
}function getPeer(socketId) {
  let peer = peers.get(socketId);
  if (!peer) {
    peer = {
      roomId: null,
      sendTransport: null,
      recvTransport: null,
      producers: new Map(),
      consumers: new Map()
    };
    peers.set(socketId, peer);
  }
  return peer;
}

async function createWebRtcTransport() {
  const listenIp = process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1';
  const announcedAddress = process.env.MEDIASOUP_ANNOUNCED_IP;
  const listenInfo = {
    protocol: 'udp',
    ip: listenIp
  };

  if (announcedAddress) listenInfo.announcedAddress = announcedAddress;

  return requireRouter().createWebRtcTransport({
    listenInfos: [listenInfo],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1500000
  });
}

function transportInfo(transport) {
  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    sctpParameters: transport.sctpParameters
  };
}function cleanupPeer(socketId) {
  const peer = peers.get(socketId);
  if (!peer) return;

  peer.producers.forEach(producer => producer.close());
  peer.consumers.forEach(consumer => consumer.close());
  if (peer.sendTransport) peer.sendTransport.close();
  if (peer.recvTransport) peer.recvTransport.close();
  peers.delete(socketId);
}

async function createConsumer(socketId, producerId, rtpCapabilities) {
  const peer = getPeer(socketId);
  if (!peer.recvTransport) throw new Error('Receive transport not created');

  const producer = findProducer(producerId);
  if (!producer) throw new Error('Producer not found');

  const r = requireRouter();
  if (!r.canConsume({ producerId, rtpCapabilities })) {
    throw new Error('Cannot consume producer with current RTP capabilities');
  }

  const consumer = await peer.recvTransport.consume({
    producerId,
    rtpCapabilities,
    paused: true
  });

  peer.consumers.set(consumer.id, consumer);
  consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
  consumer.on('producerclose', () => {
    peer.consumers.delete(consumer.id);
  });

  return consumer;
}

function findProducer(producerId) {
  for (const peer of peers.values()) {
    for (const producer of peer.producers.values()) {
      if (producer.id === producerId) return producer;
    }
  }
  return null;
}function attachSocket(socket) {
  getPeer(socket.id);

  socket.on('sfu-join-room', ({ roomId } = {}) => {
    if (typeof roomId !== 'string' || !socket.rooms.has(roomId)) return;

    const peer = getPeer(socket.id);
    peer.roomId = roomId;

    const existingProducers = [];
    for (const [otherSocketId, otherPeer] of peers.entries()) {
      if (otherSocketId === socket.id || otherPeer.roomId !== roomId) continue;
      for (const producer of otherPeer.producers.values()) {
        existingProducers.push({
          producerId: producer.id,
          socketId: otherSocketId,
          kind: producer.kind,
          source: producer.appData.source
        });
      }
    }

    socket.emit('sfu-router-capabilities', {
      routerRtpCapabilities: requireRouter().rtpCapabilities,
      existingProducers
    });
  });

  socket.on('sfu-create-transport', async ({ direction } = {}, callback) => {
    try {
      if (direction !== 'send' && direction !== 'recv') throw new Error('Invalid transport direction');
      const peer = getPeer(socket.id);
      const transport = await createWebRtcTransport();

      if (direction === 'send') {
        if (peer.sendTransport) peer.sendTransport.close();
        peer.sendTransport = transport;
      } else {
        if (peer.recvTransport) peer.recvTransport.close();
        peer.recvTransport = transport;
      }

      transport.on('dtlsstatechange', state => {
        if (state === 'failed' || state === 'closed') transport.close();
      });

      callback({ ok: true, transport: transportInfo(transport) });
    } catch (error) {
      console.error('[SFU] create transport:', error);
      callback({ ok: false, error: error.message });
    }
  });  socket.on('sfu-connect-transport', async ({ transportId, dtlsParameters } = {}, callback) => {
    try {
      const peer = getPeer(socket.id);
      const transport = [peer.sendTransport, peer.recvTransport].find(t => t && t.id === transportId);
      if (!transport) throw new Error('Transport not found');
      await transport.connect({ dtlsParameters });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on('sfu-produce', async ({ transportId, kind, rtpParameters, source } = {}, callback) => {
    try {
      const peer = getPeer(socket.id);
      if (!peer.roomId) throw new Error('Not in an SFU room');
      if (!['audio', 'video'].includes(kind)) throw new Error('Invalid media kind');

      if (!peer.sendTransport || peer.sendTransport.id !== transportId) {
        throw new Error('Send transport not found');
      }

      const producer = await peer.sendTransport.produce({
        kind,
        rtpParameters,
        appData: { socketId: socket.id, source: String(source || 'unknown').slice(0, 32) }
      });

      peer.producers.set(producer.id, producer);
      producer.on('transportclose', () => peer.producers.delete(producer.id));
      producer.on('close', () => peer.producers.delete(producer.id));

      socket.to(peer.roomId).emit('sfu-new-producer', {
        producerId: producer.id,
        socketId: socket.id,
        kind: producer.kind,
        source: producer.appData.source
      });

      callback({ ok: true, producerId: producer.id });
    } catch (error) {
      console.error('[SFU] produce:', error);
      callback({ ok: false, error: error.message });
    }
  });  socket.on('sfu-consume', async ({ producerId, rtpCapabilities } = {}, callback) => {
    try {
      const consumer = await createConsumer(socket.id, producerId, rtpCapabilities);
      callback({
        ok: true,
        consumer: {
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          producerPaused: consumer.producerPaused
        }
      });
    } catch (error) {
      console.error('[SFU] consume:', error);
      callback({ ok: false, error: error.message });
    }
  });

  socket.on('sfu-resume-consumer', async ({ consumerId } = {}, callback) => {
    try {
      const peer = getPeer(socket.id);
      const consumer = peer.consumers.get(consumerId);
      if (!consumer) throw new Error('Consumer not found');
      await consumer.resume();
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on('sfu-close-producer', ({ producerId } = {}) => {
    const peer = getPeer(socket.id);
    const producer = peer.producers.get(producerId);
    if (!producer) return;
    producer.close();
    peer.producers.delete(producerId);
    if (peer.roomId) {
      socket.to(peer.roomId).emit('sfu-producer-closed', {
        producerId,
        socketId: socket.id,
        source: producer.appData.source
      });
    }
  });  socket.on('sfu-leave-room', () => {
    const peer = getPeer(socket.id);
    peer.roomId = null;
    peer.producers.forEach(producer => producer.close());
    peer.producers.clear();
    peer.consumers.forEach(consumer => consumer.close());
    peer.consumers.clear();
    if (peer.sendTransport) {
      peer.sendTransport.close();
      peer.sendTransport = null;
    }
    if (peer.recvTransport) {
      peer.recvTransport.close();
      peer.recvTransport = null;
    }
  });

  socket.on('disconnect', () => cleanupPeer(socket.id));
}

function close() {
  peers.forEach((_, socketId) => cleanupPeer(socketId));
  peers.clear();
  if (router) router.close();
  if (worker) worker.close();
  router = null;
  worker = null;
}

module.exports = {
  init,
  attachSocket,
  close
};