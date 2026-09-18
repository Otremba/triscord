/**
 * Main Application Coordinator
 */

document.addEventListener('DOMContentLoaded', () => {
  // Smart server URL fallback (uses origin if loaded over HTTP/HTTPS, or localhost if Electron file://)
  const defaultServerUrl = window.location.protocol.startsWith('http') 
    ? window.location.origin 
    : 'http://localhost:3000';

  // Application State
  const state = {
    serverUrl: localStorage.getItem('discord_server_url') || defaultServerUrl,
    user: {
      userId: localStorage.getItem('discord_user_id') || `user_${Math.random().toString(36).substr(2, 9)}`,
      username: localStorage.getItem('discord_username') || `Amigo_${Math.floor(1000 + Math.random() * 9000)}`,
      avatarColor: localStorage.getItem('discord_avatar_color') || '#5865F2',
      isMuted: false,
      isDeafened: false,
      isCameraOn: false,
      isScreenSharing: false,
      isSpeaking: false
    },
    currentRoomId: null,
    currentRoomName: '',
    rooms: [],
    roomMembers: new Map(), // socketId -> memberData
    socket: null,
    webrtc: null,
    screenPicker: null,
    localSpeakingDetector: null,
    remoteSpeakingDetectors: new Map(), // socketId -> SpeakingDetector
    isChatOpen: false,
    micSensitivity: parseInt(localStorage.getItem('discord_mic_sens') || '15', 10),
    selectedAudioInput: localStorage.getItem('discord_mic_device') || 'default',
    selectedAudioOutput: localStorage.getItem('discord_spk_device') || 'default',
    selectedVideoInput: localStorage.getItem('discord_cam_device') || 'default',
    noiseSuppression: localStorage.getItem('discord_noise_suppression') !== 'false'
  };

  localStorage.setItem('discord_user_id', state.user.userId);
  localStorage.setItem('discord_username', state.user.username);
  localStorage.setItem('discord_avatar_color', state.user.avatarColor);

  // DOM Elements
  const el = {
    // Top / Header
    channelNameHeader: document.getElementById('currentChannelHeader'),
    channelTopicHeader: document.getElementById('channelTopicHeader'),
    connectionBadge: document.getElementById('connectionStatusBadge'),
    btnToggleChat: document.getElementById('btnToggleChat'),

    // Channels Sidebar
    channelsList: document.getElementById('channelsList'),
    btnCreateRoom: document.getElementById('btnCreateRoom'),

    // Bottom User Panel
    userAvatar: document.getElementById('userAvatar'),
    userUsername: document.getElementById('userUsername'),
    userStatusTag: document.getElementById('userStatusTag'),
    btnMute: document.getElementById('btnToggleMute'),
    btnDeafen: document.getElementById('btnToggleDeafen'),
    btnSettings: document.getElementById('btnOpenSettings'),

    // Stage / Voice Area
    welcomeStage: document.getElementById('welcomeStage'),
    voiceStage: document.getElementById('voiceStage'),
    videoGrid: document.getElementById('videoGrid'),
    stageChannelTitle: document.getElementById('stageChannelTitle'),
    stageUserCount: document.getElementById('stageUserCount'),

    // Voice Action Bar
    btnCamera: document.getElementById('btnToggleCamera'),
    btnScreenShare: document.getElementById('btnToggleScreenShare'),
    btnDisconnect: document.getElementById('btnDisconnectVoice'),

    // Chat Drawer
    chatDrawer: document.getElementById('chatDrawer'),
    chatMessages: document.getElementById('chatMessages'),
    chatInput: document.getElementById('chatInput'),
    btnSendChat: document.getElementById('btnSendChat'),
    btnCloseChat: document.getElementById('btnCloseChat'),

    // Settings Modal
    settingsModal: document.getElementById('settingsModal'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    btnSaveSettings: document.getElementById('btnSaveSettings'),
    inputSettingsUsername: document.getElementById('settingsUsername'),
    inputSettingsServerUrl: document.getElementById('settingsServerUrl'),
    selectAudioInput: document.getElementById('settingsAudioInput'),
    selectAudioOutput: document.getElementById('settingsAudioOutput'),
    selectVideoInput: document.getElementById('settingsVideoInput'),
    sliderSensitivity: document.getElementById('settingsSensitivity'),
    labelSensitivity: document.getElementById('labelSensitivity'),
    avatarColorPicker: document.querySelectorAll('.avatar-color-option')
  };

  // Initialize UI
  updateUserProfileUI();
  initSettingsUI();

  // Initialize Screen Share Picker
  state.screenPicker = new window.ScreenSharePicker();

  // Connect to Socket.io Server
  connectToServer();

  function connectToServer() {
    if (state.socket) {
      state.socket.disconnect();
    }

    setConnectionStatus('connecting', 'Conectando ao servidor...');

    try {
      // Connect using io() from socket.io
      state.socket = io(state.serverUrl, {
        reconnectionAttempts: 10,
        timeout: 10000,
        transportOptions: {
          polling: {
            extraHeaders: {
              'ngrok-skip-browser-warning': 'true'
            }
          }
        }
      });

      // Initialize WebRTC Manager with socket
      state.webrtc = new window.WebRTCManager(state.socket, state.user.userId);

      // Handle Remote Stream Added
      state.webrtc.onRemoteStreamAdded = (socketId, stream) => {
        console.log(`[App] Remote stream received from ${socketId}`);
        renderUserTile(socketId, stream);
      };

      // Handle Remote Stream Removed
      state.webrtc.onRemoteStreamRemoved = (socketId) => {
        console.log(`[App] Remote stream removed from ${socketId}`);
        renderUserTile(socketId, null);
      };

      // Socket Events
      state.socket.on('connect', () => {
        console.log('Connected to server with ID:', state.socket.id);
        setConnectionStatus('connected', 'RTC Conectado');

        // If we were previously in a room, rejoin it
        if (state.currentRoomId) {
          joinRoom(state.currentRoomId, state.currentRoomName);
        }
      });

      state.socket.on('connect_error', (err) => {
        console.warn('Socket connection error:', err);
        setConnectionStatus('disconnected', 'Erro de Conexão');
      });

      state.socket.on('disconnect', () => {
        setConnectionStatus('disconnected', 'Desconectado');
      });

      // Rooms update broadcast
      state.socket.on('rooms-update', (roomsList) => {
        state.rooms = roomsList;
        renderChannelsList();
      });

      // Successfully joined room
      state.socket.on('room-joined', ({ roomId, existingUsers }) => {
        state.currentRoomId = roomId;
        state.roomMembers.clear();

        existingUsers.forEach(u => {
          state.roomMembers.set(u.socketId, u);
        });

        window.SoundEffects.playJoin();
        updateStageView();

        // Connect WebRTC to all existing members
        existingUsers.forEach(u => {
          state.webrtc.connectToPeer(u.socketId);
        });
      });

      // Another user joined our current room
      state.socket.on('user-joined', ({ socketId, userData }) => {
        state.roomMembers.set(socketId, userData);
        window.SoundEffects.playJoin();
        updateStageView();
        addChatMessage({
          senderName: 'Sistema',
          text: `👋 **${userData.username}** entrou no canal de voz.`,
          timestamp: Date.now(),
          isSystem: true
        });
      });

      // User state update (muted, camera, screen, speaking)
      state.socket.on('user-state-updated', ({ socketId, state: newState }) => {
        if (state.roomMembers.has(socketId)) {
          const user = state.roomMembers.get(socketId);
          Object.assign(user, newState);
          updateUserTileState(socketId, user);
        }
      });

      // User left room
      state.socket.on('user-left', ({ socketId, username }) => {
        state.webrtc.removePeer(socketId);
        state.roomMembers.delete(socketId);
        removeRemoteSpeakingDetector(socketId);
        window.SoundEffects.playLeave();
        updateStageView();
        addChatMessage({
          senderName: 'Sistema',
          text: `🚪 **${username}** saiu do canal de voz.`,
          timestamp: Date.now(),
          isSystem: true
        });
      });

      // Incoming Chat Message
      state.socket.on('new-chat-message', (msg) => {
        addChatMessage(msg);
        if (!state.isChatOpen && msg.senderSocketId !== state.socket.id) {
          window.SoundEffects.playMessage();
          el.btnToggleChat.classList.add('has-unread');
        }
      });

    } catch (err) {
      console.error('Error establishing socket connection:', err);
      setConnectionStatus('disconnected', 'Erro no Servidor');
    }
  }

  function setConnectionStatus(status, text) {
    el.connectionBadge.className = `connection-status-badge ${status}`;
    el.connectionBadge.querySelector('.status-text').textContent = text;
  }

  // Render list of voice channels in the left sidebar
  function renderChannelsList() {
    el.channelsList.innerHTML = state.rooms.map(room => {
      const isCurrent = state.currentRoomId === room.id;
      const userCount = room.users ? room.users.length : 0;

      return `
        <div class="channel-item ${isCurrent ? 'active' : ''}" data-room-id="${room.id}" data-room-name="${room.name}">
          <div class="channel-main">
            <div class="channel-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3C10.34 3 9 4.34 9 6V12C9 13.66 10.34 15 12 15C13.66 15 15 13.66 15 12V6C15 4.34 13.66 3 12 3ZM19 11C19 14.53 16.39 17.44 13 17.93V21H11V17.93C7.61 17.44 5 14.53 5 11H7C7 13.76 9.24 16 12 16C14.76 16 17 13.76 17 11H19Z"/>
              </svg>
            </div>
            <span class="channel-name">${room.name}</span>
            ${userCount > 0 ? `<span class="channel-badge">${userCount}</span>` : ''}
          </div>
          ${room.users && room.users.length > 0 ? `
            <div class="channel-user-list">
              ${room.users.map(u => `
                <div class="channel-user-item ${u.isSpeaking ? 'speaking' : ''}">
                  <div class="channel-user-avatar" style="background-color: ${u.avatar || '#5865F2'}">
                    ${u.username.charAt(0).toUpperCase()}
                  </div>
                  <span class="channel-user-name">${u.username}</span>
                  <div class="channel-user-icons">
                    ${u.isMuted ? '<span class="status-mini-icon red" title="Mutado">🔇</span>' : ''}
                    ${u.isDeafened ? '<span class="status-mini-icon red" title="Ensurdecido">🔕</span>' : ''}
                    ${u.isCameraOn ? '<span class="status-mini-icon green" title="Câmera Ativa">📹</span>' : ''}
                    ${u.isScreenSharing ? '<span class="status-mini-icon blurple" title="Compartilhando Tela">🖥️</span>' : ''}
                  </div>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    // Channel click listeners
    el.channelsList.querySelectorAll('.channel-item').forEach(item => {
      item.querySelector('.channel-main').addEventListener('click', () => {
        const roomId = item.dataset.roomId;
        const roomName = item.dataset.roomName;
        if (state.currentRoomId !== roomId) {
          joinRoom(roomId, roomName);
        }
      });
    });
  }

  // Join a voice channel
  async function joinRoom(roomId, roomName) {
    if (!state.socket || !state.socket.connected) {
      alert('Aguarde a conexão com o servidor...');
      return;
    }

    state.currentRoomId = roomId;
    state.currentRoomName = roomName;

    // Start local microphone if not started
    try {
      if (!state.webrtc.localMicStream) {
        const micStream = await state.webrtc.startMicrophone(
          state.selectedAudioInput,
          state.noiseSuppression
        );
        setupLocalSpeakingDetector(micStream);
      }
    } catch (err) {
      console.warn('Microphone permission denied or not found:', err);
    }

    // Emit join to server
    state.socket.emit('join-room', {
      roomId,
      userData: {
        userId: state.user.userId,
        username: state.user.username,
        avatar: state.user.avatarColor,
        isMuted: state.user.isMuted,
        isDeafened: state.user.isDeafened,
        isCameraOn: state.user.isCameraOn,
        isScreenSharing: state.user.isScreenSharing
      }
    });

    el.channelNameHeader.textContent = `# ${roomName}`;
    el.channelTopicHeader.textContent = `Canal de Voz Ativo • Baixa Latência WebRTC`;
  }

  // Leave room
  function leaveCurrentRoom() {
    if (state.currentRoomId && state.socket) {
      state.socket.emit('leave-room');
    }

    window.SoundEffects.playLeave();

    if (state.webrtc) {
      state.webrtc.cleanupAll();
    }

    if (state.localSpeakingDetector) {
      state.localSpeakingDetector.destroy();
      state.localSpeakingDetector = null;
    }

    state.remoteSpeakingDetectors.forEach(d => d.destroy());
    state.remoteSpeakingDetectors.clear();

    state.currentRoomId = null;
    state.currentRoomName = '';
    state.roomMembers.clear();
    state.user.isCameraOn = false;
    state.user.isScreenSharing = false;

    updateActionButtonsState();
    updateStageView();
    el.channelNameHeader.textContent = 'Nenhum canal selecionado';
    el.channelTopicHeader.textContent = 'Clique em um canal de voz à esquerda para entrar';
  }

  // Update Main Stage View (Welcome state vs Active Voice Grid)
  function updateStageView() {
    if (!state.currentRoomId) {
      el.welcomeStage.classList.remove('hidden');
      el.voiceStage.classList.add('hidden');
      return;
    }

    el.welcomeStage.classList.add('hidden');
    el.voiceStage.classList.remove('hidden');

    el.stageChannelTitle.textContent = `# ${state.currentRoomName}`;
    const totalMembers = state.roomMembers.size + 1; // peers + self
    el.stageUserCount.textContent = `${totalMembers} ${totalMembers === 1 ? 'membro' : 'membros'} no canal`;

    renderAllVideoTiles();
  }

  // Render all tiles in the stage grid
  function renderAllVideoTiles() {
    el.videoGrid.innerHTML = '';

    // 1. Render Local User Tile
    const localTile = createLocalUserTile();
    el.videoGrid.appendChild(localTile);

    // 2. Render Remote User Tiles
    state.roomMembers.forEach((member, socketId) => {
      const remoteStream = state.webrtc.remoteStreams.get(socketId);
      const remoteTile = createRemoteUserTile(socketId, member, remoteStream);
      el.videoGrid.appendChild(remoteTile);
    });

    adjustGridColumns();
  }

  function adjustGridColumns() {
    const totalTiles = el.videoGrid.children.length;
    el.videoGrid.className = 'video-grid';
    if (totalTiles === 1) el.videoGrid.classList.add('grid-1');
    else if (totalTiles === 2) el.videoGrid.classList.add('grid-2');
    else if (totalTiles <= 4) el.videoGrid.classList.add('grid-4');
    else if (totalTiles <= 6) el.videoGrid.classList.add('grid-6');
    else el.videoGrid.classList.add('grid-many');
  }

  function createLocalUserTile() {
    const tile = document.createElement('div');
    tile.className = `video-tile local-tile ${state.user.isSpeaking ? 'speaking' : ''}`;
    tile.id = 'tile-local';

    const hasVideo = state.user.isCameraOn || state.user.isScreenSharing;
    const isScreen = state.user.isScreenSharing;

    tile.innerHTML = `
      <div class="tile-content">
        <video id="video-local" autoplay playsinline muted class="${hasVideo ? '' : 'hidden'}"></video>
        <div class="avatar-view ${hasVideo ? 'hidden' : ''}">
          <div class="tile-avatar" style="background-color: ${state.user.avatarColor}">
            ${state.user.username.charAt(0).toUpperCase()}
          </div>
        </div>
        ${isScreen ? '<div class="live-tag">TRANSMITINDO TELA</div>' : ''}
      </div>
      <div class="tile-overlay">
        <div class="tile-username">
          <span>${state.user.username} (Você)</span>
          ${state.user.isMuted ? '<span class="status-badge-mini red">🔇</span>' : ''}
          ${state.user.isDeafened ? '<span class="status-badge-mini red">🔕</span>' : ''}
        </div>
      </div>
    `;

    const videoEl = tile.querySelector('#video-local');
    if (isScreen && state.webrtc.localScreenStream) {
      videoEl.srcObject = state.webrtc.localScreenStream;
    } else if (state.user.isCameraOn && state.webrtc.localCamStream) {
      videoEl.srcObject = state.webrtc.localCamStream;
    }

    return tile;
  }

  function createRemoteUserTile(socketId, member, stream) {
    const tile = document.createElement('div');
    tile.className = `video-tile ${member.isSpeaking ? 'speaking' : ''}`;
    tile.id = `tile-${socketId}`;

    const hasVideo = stream && stream.getVideoTracks().length > 0;

    tile.innerHTML = `
      <div class="tile-content">
        <video id="video-${socketId}" autoplay playsinline class="${hasVideo ? '' : 'hidden'}"></video>
        <audio id="audio-${socketId}" autoplay></audio>
        <div class="avatar-view ${hasVideo ? 'hidden' : ''}">
          <div class="tile-avatar" style="background-color: ${member.avatar || '#5865F2'}">
            ${member.username.charAt(0).toUpperCase()}
          </div>
        </div>
        ${member.isScreenSharing ? '<div class="live-tag">AO VIVO</div>' : ''}
      </div>
      <div class="tile-overlay">
        <div class="tile-username">
          <span>${member.username}</span>
          ${member.isMuted ? '<span class="status-badge-mini red">🔇</span>' : ''}
          ${member.isDeafened ? '<span class="status-badge-mini red">🔕</span>' : ''}
        </div>
      </div>
    `;

    const videoEl = tile.querySelector(`#video-${socketId}`);
    const audioEl = tile.querySelector(`#audio-${socketId}`);

    if (stream) {
      videoEl.srcObject = stream;
      audioEl.srcObject = stream;
      audioEl.muted = state.user.isDeafened;

      // Attach speaking detector to remote stream
      setupRemoteSpeakingDetector(socketId, stream);
    }

    return tile;
  }

  function renderUserTile(socketId, stream) {
    const existingTile = document.getElementById(`tile-${socketId}`);
    const member = state.roomMembers.get(socketId);
    if (!member) return;

    if (existingTile) {
      const videoEl = existingTile.querySelector(`#video-${socketId}`);
      const audioEl = existingTile.querySelector(`#audio-${socketId}`);
      const avatarView = existingTile.querySelector('.avatar-view');
      const tileContent = existingTile.querySelector('.tile-content');
      let liveTag = existingTile.querySelector('.live-tag');

      const hasVideo = stream && stream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
      const shouldShowVideo = hasVideo && (member.isCameraOn || member.isScreenSharing);

      if (shouldShowVideo) {
        if (videoEl.srcObject !== stream) {
          videoEl.srcObject = stream;
        }
        videoEl.classList.remove('hidden');
        avatarView.classList.add('hidden');
        videoEl.play().catch(e => console.warn('Video play error:', e));
      } else {
        videoEl.classList.add('hidden');
        videoEl.srcObject = null;
        avatarView.classList.remove('hidden');
      }

      if (member.isScreenSharing) {
        if (!liveTag && tileContent) {
          liveTag = document.createElement('div');
          liveTag.className = 'live-tag';
          liveTag.textContent = 'AO VIVO';
          tileContent.appendChild(liveTag);
        }
      } else if (liveTag) {
        liveTag.remove();
      }

      if (stream && audioEl) {
        if (audioEl.srcObject !== stream) {
          audioEl.srcObject = stream;
        }
        setupRemoteSpeakingDetector(socketId, stream);
      }
    } else {
      renderAllVideoTiles();
    }
  }

  function updateUserTileState(socketId, member) {
    const tile = document.getElementById(`tile-${socketId}`);
    if (!tile) return;

    if (member.isSpeaking) {
      tile.classList.add('speaking');
    } else {
      tile.classList.remove('speaking');
    }

    // Update icons in tag
    const usernameSpan = tile.querySelector('.tile-username');
    if (usernameSpan) {
      usernameSpan.innerHTML = `
        <span>${member.username}</span>
        ${member.isMuted ? '<span class="status-badge-mini red">🔇</span>' : ''}
        ${member.isDeafened ? '<span class="status-badge-mini red">🔕</span>' : ''}
      `;
    }

    // Update Video / Avatar visibility
    const videoEl = tile.querySelector(`#video-${socketId}`);
    const avatarView = tile.querySelector('.avatar-view');
    const tileContent = tile.querySelector('.tile-content');
    let liveTag = tile.querySelector('.live-tag');

    const hasVideo = member.isCameraOn || member.isScreenSharing;

    if (hasVideo) {
      const stream = state.webrtc.remoteStreams.get(socketId);
      if (stream && stream.getVideoTracks().length > 0) {
        if (videoEl.srcObject !== stream) {
          videoEl.srcObject = stream;
        }
        videoEl.classList.remove('hidden');
        avatarView.classList.add('hidden');
        videoEl.play().catch(e => console.warn('Video play error:', e));
      }
    } else {
      videoEl.classList.add('hidden');
      videoEl.srcObject = null;
      avatarView.classList.remove('hidden');
    }

    if (member.isScreenSharing) {
      if (!liveTag && tileContent) {
        liveTag = document.createElement('div');
        liveTag.className = 'live-tag';
        liveTag.textContent = 'AO VIVO';
        tileContent.appendChild(liveTag);
      }
    } else if (liveTag) {
      liveTag.remove();
    }
  }

  // Speaking Detection for Local Mic
  function setupLocalSpeakingDetector(stream) {
    if (state.localSpeakingDetector) {
      state.localSpeakingDetector.destroy();
    }

    state.localSpeakingDetector = new window.SpeakingDetector(stream, (isSpeaking) => {
      if (state.user.isMuted) isSpeaking = false;
      if (state.user.isSpeaking !== isSpeaking) {
        state.user.isSpeaking = isSpeaking;

        const localTile = document.getElementById('tile-local');
        if (localTile) {
          if (isSpeaking) localTile.classList.add('speaking');
          else localTile.classList.remove('speaking');
        }

        // Notify socket
        if (state.socket && state.currentRoomId) {
          state.socket.emit('user-state-change', { isSpeaking });
        }
      }
    }, { threshold: state.micSensitivity });
  }

  // Speaking Detection for Remote Peers
  function setupRemoteSpeakingDetector(socketId, stream) {
    if (state.remoteSpeakingDetectors.has(socketId)) {
      state.remoteSpeakingDetectors.get(socketId).destroy();
    }

    const detector = new window.SpeakingDetector(stream, (isSpeaking) => {
      const tile = document.getElementById(`tile-${socketId}`);
      if (tile) {
        if (isSpeaking) tile.classList.add('speaking');
        else tile.classList.remove('speaking');
      }
    }, { threshold: 12 });

    state.remoteSpeakingDetectors.set(socketId, detector);
  }

  function removeRemoteSpeakingDetector(socketId) {
    if (state.remoteSpeakingDetectors.has(socketId)) {
      state.remoteSpeakingDetectors.get(socketId).destroy();
      state.remoteSpeakingDetectors.delete(socketId);
    }
  }

  // Toggle Microphone Mute
  function toggleMute() {
    state.user.isMuted = !state.user.isMuted;

    if (state.webrtc.localMicStream) {
      state.webrtc.localMicStream.getAudioTracks().forEach(track => {
        track.enabled = !state.user.isMuted;
      });
    }

    window.SoundEffects.playMute(state.user.isMuted);
    updateUserProfileUI();
    updateActionButtonsState();

    if (state.socket && state.currentRoomId) {
      state.socket.emit('user-state-change', { isMuted: state.user.isMuted });
    }

    renderAllVideoTiles();
  }

  // Toggle Deafen
  function toggleDeafen() {
    state.user.isDeafened = !state.user.isDeafened;
    if (state.user.isDeafened && !state.user.isMuted) {
      // Deafen automatically mutes mic
      toggleMute();
    }

    // Mute all remote audio tags
    document.querySelectorAll('audio').forEach(audio => {
      audio.muted = state.user.isDeafened;
    });

    window.SoundEffects.playMute(state.user.isDeafened);
    updateUserProfileUI();
    updateActionButtonsState();

    if (state.socket && state.currentRoomId) {
      state.socket.emit('user-state-change', { isDeafened: state.user.isDeafened });
    }

    renderAllVideoTiles();
  }

  // Toggle Webcam
  async function toggleCamera() {
    if (!state.currentRoomId) {
      alert('Entre em um canal de voz primeiro para ligar a câmera.');
      return;
    }

    if (state.user.isCameraOn) {
      state.user.isCameraOn = false;
      state.webrtc.stopCamera();
    } else {
      try {
        await state.webrtc.startCamera(state.selectedVideoInput);
        state.user.isCameraOn = true;
      } catch (err) {
        alert('Não foi possível acessar a câmera: ' + err.message);
        return;
      }
    }

    updateActionButtonsState();
    renderAllVideoTiles();

    if (state.socket && state.currentRoomId) {
      state.socket.emit('user-state-change', { isCameraOn: state.user.isCameraOn });
    }
  }

  // Toggle Screen Share
  async function toggleScreenShare() {
    if (!state.currentRoomId) {
      alert('Entre em um canal de voz primeiro para compartilhar sua tela.');
      return;
    }

    if (state.user.isScreenSharing) {
      state.user.isScreenSharing = false;
      state.webrtc.stopScreenShare();
      updateActionButtonsState();
      renderAllVideoTiles();
      if (state.socket && state.currentRoomId) {
        state.socket.emit('user-state-change', { isScreenSharing: false });
      }
    } else {
      const stream = await state.screenPicker.open();
      if (!stream) return; // cancelled

      state.webrtc.setScreenStream(stream);
      state.user.isScreenSharing = true;

      // Handle user stopping stream from OS prompt
      stream.getVideoTracks()[0].onended = () => {
        state.user.isScreenSharing = false;
        state.webrtc.stopScreenShare();
        updateActionButtonsState();
        renderAllVideoTiles();
        if (state.socket && state.currentRoomId) {
          state.socket.emit('user-state-change', { isScreenSharing: false });
        }
      };

      updateActionButtonsState();
      renderAllVideoTiles();

      if (state.socket && state.currentRoomId) {
        state.socket.emit('user-state-change', { isScreenSharing: true });
      }
    }
  }

  function updateActionButtonsState() {
    // Camera button
    if (state.user.isCameraOn) {
      el.btnCamera.classList.add('active');
      el.btnCamera.querySelector('.btn-label').textContent = 'Desligar Câmera';
    } else {
      el.btnCamera.classList.remove('active');
      el.btnCamera.querySelector('.btn-label').textContent = 'Câmera';
    }

    // Screen button
    if (state.user.isScreenSharing) {
      el.btnScreenShare.classList.add('active');
      el.btnScreenShare.querySelector('.btn-label').textContent = 'Parar Tela';
    } else {
      el.btnScreenShare.classList.remove('active');
      el.btnScreenShare.querySelector('.btn-label').textContent = 'Compartilhar';
    }

    // Bottom user panel Mute/Deafen buttons
    if (state.user.isMuted) {
      el.btnMute.classList.add('muted');
    } else {
      el.btnMute.classList.remove('muted');
    }

    if (state.user.isDeafened) {
      el.btnDeafen.classList.add('deafened');
    } else {
      el.btnDeafen.classList.remove('deafened');
    }
  }

  function updateUserProfileUI() {
    el.userUsername.textContent = state.user.username;
    el.userAvatar.style.backgroundColor = state.user.avatarColor;
    el.userAvatar.textContent = state.user.username.charAt(0).toUpperCase();

    if (state.user.isDeafened) {
      el.userStatusTag.textContent = 'Ensurdecido';
    } else if (state.user.isMuted) {
      el.userStatusTag.textContent = 'Mutado';
    } else {
      el.userStatusTag.textContent = 'Online';
    }
  }

  // Chat Functions
  function addChatMessage(msg) {
    const isSelf = msg.senderSocketId === state.socket?.id;
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const msgEl = document.createElement('div');
    msgEl.className = `chat-message-item ${msg.isSystem ? 'system-msg' : ''}`;

    if (msg.isSystem) {
      msgEl.innerHTML = `
        <div class="system-msg-content">${msg.text}</div>
        <span class="msg-timestamp">${time}</span>
      `;
    } else {
      msgEl.innerHTML = `
        <div class="msg-avatar" style="background-color: ${msg.senderAvatar || '#5865F2'}">
          ${msg.senderName.charAt(0).toUpperCase()}
        </div>
        <div class="msg-body">
          <div class="msg-header">
            <span class="msg-sender ${isSelf ? 'self' : ''}">${msg.senderName}</span>
            <span class="msg-timestamp">${time}</span>
          </div>
          <div class="msg-text">${escapeHtml(msg.text)}</div>
        </div>
      `;
    }

    el.chatMessages.appendChild(msgEl);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  function sendChatMessage() {
    const text = el.chatInput.value.trim();
    if (!text || !state.currentRoomId || !state.socket) return;

    state.socket.emit('send-chat-message', {
      message: text,
      roomId: state.currentRoomId
    });

    el.chatInput.value = '';
  }

  function escapeHtml(string) {
    const div = document.createElement('div');
    div.innerText = string;
    return div.innerHTML;
  }

  // Enumerate and fill the microphone/speaker/camera dropdowns.
  // Chromium hides device labels (and sometimes the devices themselves)
  // until a getUserMedia permission has actually been granted, so we
  // request a throwaway audio+video stream first to unlock the real list.
  async function populateDeviceLists() {
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      const hasLabels = devices.some(d => d.label);

      if (!hasLabels) {
        let unlockStream = null;
        try {
          unlockStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        } catch (permErr) {
          try {
            unlockStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } catch (audioErr) {
            console.warn('Could not get device permission to list devices:', audioErr);
          }
        }
        if (unlockStream) {
          unlockStream.getTracks().forEach(t => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
        }
      }

      const prevAudioInput = el.selectAudioInput.value || state.selectedAudioInput;
      const prevAudioOutput = el.selectAudioOutput.value || state.selectedAudioOutput;
      const prevVideoInput = el.selectVideoInput.value || state.selectedVideoInput;

      el.selectAudioInput.innerHTML = '';
      el.selectAudioOutput.innerHTML = '';
      el.selectVideoInput.innerHTML = '';

      devices.forEach(device => {
        if (!device.kind) return;
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.text = device.label || `${device.kind} (${device.deviceId.slice(0, 5)}...)`;

        if (device.kind === 'audioinput') {
          if (device.deviceId === prevAudioInput) opt.selected = true;
          el.selectAudioInput.appendChild(opt);
        } else if (device.kind === 'audiooutput') {
          if (device.deviceId === prevAudioOutput) opt.selected = true;
          el.selectAudioOutput.appendChild(opt);
        } else if (device.kind === 'videoinput') {
          if (device.deviceId === prevVideoInput) opt.selected = true;
          el.selectVideoInput.appendChild(opt);
        }
      });

      if (!el.selectAudioInput.options.length) {
        const opt = document.createElement('option');
        opt.text = 'Nenhum microfone encontrado';
        opt.value = '';
        el.selectAudioInput.appendChild(opt);
      }
      if (!el.selectAudioOutput.options.length) {
        const opt = document.createElement('option');
        opt.text = 'Padrão do sistema';
        opt.value = '';
        el.selectAudioOutput.appendChild(opt);
      }
      if (!el.selectVideoInput.options.length) {
        const opt = document.createElement('option');
        opt.text = 'Nenhuma câmera encontrada';
        opt.value = '';
        el.selectVideoInput.appendChild(opt);
      }
    } catch (err) {
      console.warn('Could not enumerate media devices:', err);
    }
  }

  // Initialize Settings UI & Audio Device Enumeration
  async function initSettingsUI() {
    el.inputSettingsUsername.value = state.user.username;
    el.inputSettingsServerUrl.value = state.serverUrl;
    el.noiseSuppression.checked = state.noiseSuppression;
    el.sliderSensitivity.value = state.micSensitivity;
    el.labelSensitivity.textContent = `${state.micSensitivity}%`;

    el.sliderSensitivity.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.micSensitivity = val;
      el.labelSensitivity.textContent = `${val}%`;
      localStorage.setItem('discord_mic_sens', val);
      if (state.localSpeakingDetector) {
        state.localSpeakingDetector.setThreshold(val);
      }
    });

    // Populate Audio/Video Device Selectors
    await populateDeviceLists();

    // Refresh the list whenever a device is plugged/unplugged
    if (navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', populateDeviceLists);
    }

    // Avatar Color Selection
    el.avatarColorPicker.forEach(btn => {
      btn.addEventListener('click', () => {
        el.avatarColorPicker.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.user.avatarColor = btn.dataset.color;
      });
    });

    // Mic Test Button
    let testStream = null;
    let testDetector = null;
    el.btnTestMic.addEventListener('click', async () => {
      if (testStream) {
        testStream.getTracks().forEach(t => t.stop());
        testStream = null;
        if (testDetector) testDetector.destroy();
        el.btnTestMic.textContent = 'Testar Microfone';
        el.micVuMeter.style.width = '0%';
        return;
      }

      try {
        testStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: state.noiseSuppression,
            echoCancellation: true,
            autoGainControl: true,
            deviceId: el.selectAudioInput.value ? { exact: el.selectAudioInput.value } : undefined
          }
        });
        el.btnTestMic.textContent = 'Parar Teste';

        testDetector = new window.SpeakingDetector(testStream, (isSpeaking, level) => {
          const pct = Math.min(100, Math.round((level / 60) * 100));
          el.micVuMeter.style.width = `${pct}%`;
        }, { threshold: 0 });
      } catch (err) {
        alert('Erro ao testar microfone: ' + err.message);
      }
    });
  }

  // Event Listeners
  el.btnMute.addEventListener('click', toggleMute);
  el.btnDeafen.addEventListener('click', toggleDeafen);
  el.btnCamera.addEventListener('click', toggleCamera);
  el.btnScreenShare.addEventListener('click', toggleScreenShare);
  el.btnDisconnect.addEventListener('click', leaveCurrentRoom);

  // Chat Drawer Toggle
  el.btnToggleChat.addEventListener('click', () => {
    state.isChatOpen = !state.isChatOpen;
    el.chatDrawer.classList.toggle('hidden', !state.isChatOpen);
    el.btnToggleChat.classList.remove('has-unread');
    if (state.isChatOpen) {
      el.chatInput.focus();
    }
  });

  el.btnCloseChat.addEventListener('click', () => {
    state.isChatOpen = false;
    el.chatDrawer.classList.add('hidden');
  });

  el.btnSendChat.addEventListener('click', sendChatMessage);
  el.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Create Custom Room
  el.btnCreateRoom.addEventListener('click', () => {
    const name = prompt('Nome do novo canal de voz:');
    if (name && name.trim()) {
      const id = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '-');
      joinRoom(id, name.trim());
    }
  });

  // Open Settings Modal
  el.btnSettings.addEventListener('click', () => {
    el.settingsModal.classList.remove('hidden');
    populateDeviceLists();
  });

  el.btnCloseSettings.addEventListener('click', () => {
    el.settingsModal.classList.add('hidden');
  });

  el.btnSaveSettings.addEventListener('click', async () => {
    const newUsername = el.inputSettingsUsername.value.trim();
    const newServerUrl = el.inputSettingsServerUrl.value.trim();
    const previousNoiseSuppression = state.noiseSuppression;

    if (newUsername) {
      state.user.username = newUsername;
      localStorage.setItem('discord_username', newUsername);
    }

    state.selectedAudioInput = el.selectAudioInput.value;
    state.selectedAudioOutput = el.selectAudioOutput.value;
    state.selectedVideoInput = el.selectVideoInput.value;
    state.noiseSuppression = el.noiseSuppression.checked;

    localStorage.setItem('discord_mic_device', state.selectedAudioInput);
    localStorage.setItem('discord_spk_device', state.selectedAudioOutput);
    localStorage.setItem('discord_cam_device', state.selectedVideoInput);
    localStorage.setItem('discord_noise_suppression', state.noiseSuppression);
    localStorage.setItem('discord_avatar_color', state.user.avatarColor);

    updateUserProfileUI();

    if (newServerUrl && newServerUrl !== state.serverUrl) {
      state.serverUrl = newServerUrl;
      localStorage.setItem('discord_server_url', newServerUrl);
      connectToServer();
    } else if (state.socket && state.currentRoomId) {
      state.socket.emit('user-state-change', {
        username: state.user.username,
        avatar: state.user.avatarColor
      });

      if (previousNoiseSuppression !== state.noiseSuppression && state.webrtc.localMicStream) {
        state.webrtc.localMicStream.getTracks().forEach(track => track.stop());
        state.webrtc.localMicStream = null;

        try {
          const micStream = await state.webrtc.startMicrophone(
            state.selectedAudioInput,
            state.noiseSuppression
          );
          micStream.getAudioTracks().forEach(track => {
            track.enabled = !state.user.isMuted;
          });
          setupLocalSpeakingDetector(micStream);
        } catch (err) {
          console.warn('Could not restart microphone after changing noise suppression:', err);
        }
      }
    }

    el.settingsModal.classList.add('hidden');
  });
});
