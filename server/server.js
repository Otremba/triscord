const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());

// Serve static renderer files so friends can also join via browser if desired!
app.use(express.static(path.join(__dirname, '../src/renderer')));
app.use('/socket.io-client', express.static(path.join(__dirname, '../node_modules/socket.io-client/dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e8 // 100MB for media/attachments if needed
});

// Rooms state: roomId -> { id, name, category, users: Map(socketId -> userData) }
const defaultRooms = [
  { id: 'geral', name: 'Geral', category: 'Canais de Voz', type: 'voice' },
  { id: 'jogos', name: 'Jogos & Gameplay', category: 'Canais de Voz', type: 'voice' },
  { id: 'cinema', name: 'Cinema & Streams', category: 'Canais de Voz', type: 'voice' },
  { id: 'musica', name: 'Lounge / Música', category: 'Canais de Voz', type: 'voice' },
  { id: 'reuniao', name: 'Sala de Foco', category: 'Canais de Voz', type: 'voice' }
];

const rooms = new Map();
defaultRooms.forEach(r => {
  rooms.set(r.id, { ...r, users: new Map() });
});

// Helper: get list of all rooms with connected user summaries
function getRoomsSummary() {
  const list = [];
  rooms.forEach((r, id) => {
    const userList = [];
    r.users.forEach((u, sockId) => {
      userList.push({
        socketId: sockId,
        userId: u.userId,
        username: u.username,
        avatar: u.avatar,
        isMuted: u.isMuted || false,
        isDeafened: u.isDeafened || false,
        isCameraOn: u.isCameraOn || false,
        isScreenSharing: u.isScreenSharing || false,
        isSpeaking: u.isSpeaking || false
      });
    });
    list.push({
      id: r.id,
      name: r.name,
      category: r.category,
      type: r.type,
      userCount: r.users.size,
      users: userList
    });
  });
  return list;
}

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // Send current room list and user state on connect
  socket.emit('rooms-update', getRoomsSummary());

  let currentRoomId = null;
  let currentUserData = null;

  // Handle joining a voice/video room
  socket.on('join-room', ({ roomId, userData }) => {
    // If already in a room, leave it first
    if (currentRoomId && currentRoomId !== roomId) {
      leaveCurrentRoom();
    }

    if (!rooms.has(roomId)) {
      // Create custom room if requested
      rooms.set(roomId, {
        id: roomId,
        name: roomId.charAt(0).toUpperCase() + roomId.slice(1),
        category: 'Canais Personalizados',
        type: 'voice',
        users: new Map()
      });
    }

    const room = rooms.get(roomId);
    currentRoomId = roomId;
    currentUserData = {
      ...userData,
      socketId: socket.id,
      joinedAt: Date.now()
    };

    socket.join(roomId);

    // Get all other existing users in this room to initiate WebRTC offers
    const existingUsers = [];
    room.users.forEach((u, sId) => {
      existingUsers.push({
        socketId: sId,
        userId: u.userId,
        username: u.username,
        avatar: u.avatar,
        isMuted: u.isMuted,
        isDeafened: u.isDeafened,
        isCameraOn: u.isCameraOn,
        isScreenSharing: u.isScreenSharing,
        isSpeaking: u.isSpeaking
      });
    });

    // Add current user to room
    room.users.set(socket.id, currentUserData);

    // 1. Tell the joining user who is already in the room
    socket.emit('room-joined', {
      roomId,
      existingUsers
    });

    // 2. Notify all existing peers in the room that a new user joined
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userData: currentUserData
    });

    // 3. Broadcast updated global room directory to everyone
    io.emit('rooms-update', getRoomsSummary());
    console.log(`[Join] ${currentUserData.username} joined room #${roomId} (${room.users.size} online)`);
  });

  // WebRTC Signaling: Offer
  socket.on('webrtc-offer', ({ targetSocketId, offer, type }) => {
    io.to(targetSocketId).emit('webrtc-offer', {
      senderSocketId: socket.id,
      offer,
      type // 'camera', 'screen', or 'mesh'
    });
  });

  // WebRTC Signaling: Answer
  socket.on('webrtc-answer', ({ targetSocketId, answer, type }) => {
    io.to(targetSocketId).emit('webrtc-answer', {
      senderSocketId: socket.id,
      answer,
      type
    });
  });

  // WebRTC Signaling: ICE Candidate
  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate, type }) => {
    io.to(targetSocketId).emit('webrtc-ice-candidate', {
      senderSocketId: socket.id,
      candidate,
      type
    });
  });

  // User state updates (mute, camera toggle, screenshare toggle, speaking indicator)
  socket.on('user-state-change', (stateUpdate) => {
    if (!currentRoomId || !currentUserData) return;

    const room = rooms.get(currentRoomId);
    if (room && room.users.has(socket.id)) {
      const user = room.users.get(socket.id);
      Object.assign(user, stateUpdate);
      Object.assign(currentUserData, stateUpdate);

      // Notify room members
      io.to(currentRoomId).emit('user-state-updated', {
        socketId: socket.id,
        state: stateUpdate
      });

      // Update global room lists if mute/camera/screen changed
      io.emit('rooms-update', getRoomsSummary());
    }
  });

  // Text Chat Messages in Room
  socket.on('send-chat-message', ({ message, roomId }) => {
    const targetRoom = roomId || currentRoomId;
    if (!targetRoom || !message || !message.trim()) return;

    const chatPayload = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      roomId: targetRoom,
      senderSocketId: socket.id,
      senderName: currentUserData ? currentUserData.username : 'Anônimo',
      senderAvatar: currentUserData ? currentUserData.avatar : '',
      text: message.trim(),
      timestamp: Date.now()
    };

    io.to(targetRoom).emit('new-chat-message', chatPayload);
  });

  // User explicitly leaves room
  socket.on('leave-room', () => {
    leaveCurrentRoom();
  });

  function leaveCurrentRoom() {
    if (!currentRoomId) return;

    const room = rooms.get(currentRoomId);
    if (room) {
      room.users.delete(socket.id);
      socket.leave(currentRoomId);

      socket.to(currentRoomId).emit('user-left', {
        socketId: socket.id,
        username: currentUserData ? currentUserData.username : 'Usuário'
      });
      console.log(`[Leave] ${currentUserData?.username || socket.id} left room #${currentRoomId}`);
    }

    currentRoomId = null;
    io.emit('rooms-update', getRoomsSummary());
  }

  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected] ID: ${socket.id}`);
    leaveCurrentRoom();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`🚀 Servidor Discord Voice Chat Ativo!`);
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🔗 Local: http://localhost:${PORT}`);
  console.log(`=========================================`);
});
