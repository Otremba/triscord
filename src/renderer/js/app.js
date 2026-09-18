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
    noiseSuppression: localStorage.getItem('discord_noise_suppression') !== 'false',
    userVolumes: JSON.parse(localStorage.getItem('discord_user_volumes') || '{}'),
    localMutedUsers: new Set(JSON.parse(localStorage.getItem('discord_local_mutes') || '[]'))
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
    // Auto-Updater Elements
    btnCheckUpdateTop: document.getElementById('btnCheckUpdateTop'),
    btnCheckUpdateSettings: document.getElementById('btnCheckUpdateSettings'),
    updateModal: document.getElementById('updateModal'),
    updateModalTitle: document.getElementById('updateModalTitle'),
    updateSpinner: document.getElementById('updateSpinner'),
    updateSuccessIcon: document.getElementById('updateSuccessIcon'),
    updateErrorIcon: document.getElementById('updateErrorIcon'),
    updateStatusTitle: document.getElementById('updateStatusTitle'),
    updateStatusDesc: document.getElementById('updateStatusDesc'),
    updateProgressContainer: document.getElementById('updateProgressContainer'),
    updateProgressBar: document.getElementById('updateProgressBar'),
    btnDismissUpdate: document.getElementById('btnDismissUpdate'),
    avatarColorPicker: document.querySelectorAll('.avatar-color-option'),
    // Context Menu Elements
    userContextMenu: document.getElementById('userContextMenu'),
    ctxAvatar: document.getElementById('ctxAvatar'),
    ctxUsername: document.getElementById('ctxUsername'),
    ctxStatusTag: document.getElementById('ctxStatusTag'),
    ctxVolSlider: document.getElementById('ctxVolSlider'),
    ctxVolVal: document.getElementById('ctxVolVal'),
    ctxMuteCheckbox: document.getElementById('ctxMuteCheckbox'),
    ctxCopyIdItem: document.getElementById('ctxCopyIdItem')
  };

  // Initialize UI
  updateUserProfileUI();
  initSettingsUI();
  initAutoUpdater();
  initContextMenu();

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

      // Handle Remote Stream Added (Dual Stream: Camera vs Screen)
      state.webrtc.onRemoteStreamAdded = (socketId, stream, isScreen) => {
        console.log(`[App] Remote stream received from ${socketId} (isScreen: ${isScreen})`);
        if (isScreen) {
          const screenVideoEl = document.getElementById(`video-screen-${socketId}`);
          if (screenVideoEl) {
            screenVideoEl.srcObject = stream;
            screenVideoEl.play().catch(e => console.warn('Play screen error:', e));
          } else {
            renderAllVideoTiles();
          }
        } else {
          renderUserTile(socketId, stream);
        }
      };

      // Handle Remote Stream Removed
      state.webrtc.onRemoteStreamRemoved = (socketId, isScreen) => {
        console.log(`[App] Remote stream removed from ${socketId} (isScreen: ${isScreen})`);
        if (isScreen) {
          const screenTile = document.getElementById(`tile-screen-${socketId}`);
          if (screenTile) {
            screenTile.remove();
            adjustGridColumns();
          }
        } else {
          renderUserTile(socketId, null);
        }
      };

      // Socket Events
      state.socket.on('connect', () => {
        console.log('Connected to server with ID:', state.socket.id);
        setConnectionStatus('connected', 'RTC Conectado');

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
          const screenChanged = newState.isScreenSharing !== undefined && newState.isScreenSharing !== user.isScreenSharing;
          Object.assign(user, newState);

          if (screenChanged) {
            renderAllVideoTiles();
          } else {
            updateUserTileState(socketId, user);
          }
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
                <div class="channel-user-item ${u.isSpeaking ? 'speaking' : ''}" data-user-name="${u.username}" data-socket-id="${u.socketId}">
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

    // Right-click context menu on sidebar channel users
    el.channelsList.querySelectorAll('.channel-user-item').forEach(uItem => {
      uItem.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sId = uItem.dataset.socketId;
        const member = state.roomMembers.get(sId);
        if (member && sId !== state.socket?.id) {
          openUserContextMenu(e.clientX, e.clientY, member, sId);
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
    const totalMembers = state.roomMembers.size + 1;
    el.stageUserCount.textContent = `${totalMembers} ${totalMembers === 1 ? 'membro' : 'membros'} no canal`;

    renderAllVideoTiles();
  }

  // Render all tiles in the stage grid (Simultaneous Camera + Screen Share)
  function renderAllVideoTiles() {
    el.videoGrid.innerHTML = '';

    // 1. Render Local User Camera/Avatar Tile
    const localTile = createLocalUserTile();
    el.videoGrid.appendChild(localTile);

    // 2. Render Local Screen Share Tile if sharing
    if (state.user.isScreenSharing) {
      const localScreenTile = createLocalScreenTile();
      el.videoGrid.appendChild(localScreenTile);
    }

    // 3. Render Remote User Tiles & Screen Share Tiles
    state.roomMembers.forEach((member, socketId) => {
      // User Camera/Avatar Tile
      const remoteStream = state.webrtc.remoteStreams.get(socketId);
      const remoteTile = createRemoteUserTile(socketId, member, remoteStream);
      el.videoGrid.appendChild(remoteTile);

      // User Screen Share Tile if friend is sharing screen
      if (member.isScreenSharing) {
        const screenStream = state.webrtc.remoteScreenStreams.get(socketId);
        const remoteScreenTile = createRemoteScreenTile(socketId, member, screenStream);
        el.videoGrid.appendChild(remoteScreenTile);
      }
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

  // Local Camera / Avatar Tile
  function createLocalUserTile() {
    const tile = document.createElement('div');
    tile.className = `video-tile local-tile ${state.user.isSpeaking ? 'speaking' : ''}`;
    tile.id = 'tile-local';

    const hasCam = state.user.isCameraOn;

    tile.innerHTML = `
      <div class="tile-content">
        <video id="video-local" autoplay playsinline muted class="${hasCam ? '' : 'hidden'}"></video>
        <div class="avatar-view ${hasCam ? 'hidden' : ''}">
          <div class="tile-avatar" style="background-color: ${state.user.avatarColor}">
            ${state.user.username.charAt(0).toUpperCase()}
          </div>
        </div>
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
    if (hasCam && state.webrtc.localCamStream) {
      videoEl.srcObject = state.webrtc.localCamStream;
      videoEl.play().catch(() => {});
    }

    return tile;
  }

  // Local Screen Share Tile
  function createLocalScreenTile() {
    const tile = document.createElement('div');
    tile.className = 'video-tile screen-share-tile local-screen-tile';
    tile.id = 'tile-local-screen';

    tile.innerHTML = `
      <div class="tile-content">
        <video id="video-local-screen" autoplay playsinline muted></video>
        <div class="live-tag">TRANSMITINDO TELA (VOCÊ)</div>
      </div>
      <div class="tile-overlay">
        <div class="tile-username">
          <span>Sua Transmissão</span>
        </div>
        <div class="tile-screen-actions">
          <button class="btn-tile-stop-screen" id="btnStopLocalScreenTile" title="Parar Transmissão">
            Parar Tela
          </button>
        </div>
      </div>
    `;

    const videoEl = tile.querySelector('#video-local-screen');
    if (state.webrtc.localScreenStream) {
      videoEl.srcObject = state.webrtc.localScreenStream;
      videoEl.play().catch(() => {});
    }

    tile.querySelector('#btnStopLocalScreenTile').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleScreenShare();
    });

    return tile;
  }

  // Individual User Volume Helpers
  function getUserVolume(userKey) {
    if (state.userVolumes[userKey] !== undefined) {
      return state.userVolumes[userKey];
    }
    return 100;
  }

  function isUserLocallyMuted(userKey) {
    return state.localMutedUsers.has(userKey);
  }

  function applyUserVolume(socketId, member) {
    const audioEl = document.getElementById(`audio-${socketId}`);
    if (!audioEl) return;

    const userKey = member.userId || member.username;
    const vol = getUserVolume(userKey);
    const isLocallyMuted = isUserLocallyMuted(userKey);

    if (state.user.isDeafened || isLocallyMuted || vol === 0) {
      audioEl.muted = true;
    } else {
      audioEl.muted = false;
      audioEl.volume = Math.max(0, Math.min(1, vol / 100));
    }
  }

  // Route a single remote <audio> element to the user-selected output device (speaker/headset)
  function applyAudioOutputDevice(audioEl) {
    if (!audioEl || typeof audioEl.setSinkId !== 'function') return;
    if (!state.selectedAudioOutput || state.selectedAudioOutput === 'default') return;

    audioEl.setSinkId(state.selectedAudioOutput).catch(e => {
      console.warn('[Audio] Error setting output device:', e);
    });
  }

  // Re-apply the selected output device to every remote audio tag currently on screen
  function applyAudioOutputDeviceToAll() {
    document.querySelectorAll('audio[id^="audio-"]').forEach(applyAudioOutputDevice);
  }

  // Remote User Camera / Avatar Tile
  function createRemoteUserTile(socketId, member, stream) {
    const tile = document.createElement('div');
    tile.className = `video-tile ${member.isSpeaking ? 'speaking' : ''}`;
    tile.id = `tile-${socketId}`;

    const hasCam = member.isCameraOn;
    const userKey = member.userId || member.username;
    const currentVolume = getUserVolume(userKey);
    const isLocallyMuted = isUserLocallyMuted(userKey);

    tile.innerHTML = `
      <div class="tile-content">
        <video id="video-${socketId}" autoplay playsinline class="${hasCam ? '' : 'hidden'}"></video>
        <audio id="audio-${socketId}" autoplay></audio>
        <div class="avatar-view ${hasCam ? 'hidden' : ''}">
          <div class="tile-avatar" style="background-color: ${member.avatar || '#5865F2'}">
            ${member.username.charAt(0).toUpperCase()}
          </div>
        </div>
      </div>
      <div class="tile-overlay">
        <div class="tile-username">
          <span>${member.username}</span>
          ${member.isMuted ? '<span class="status-badge-mini red" title="Mutado na chamada">🔇</span>' : ''}
          ${member.isDeafened ? '<span class="status-badge-mini red" title="Ensurdecido">🔕</span>' : ''}
        </div>
        
        <!-- Individual Friend Volume / Local Mute Controls -->
        <div class="tile-user-audio-controls">
          <button class="btn-tile-local-mute ${isLocallyMuted ? 'muted' : ''}" id="btn-local-mute-${socketId}" title="${isLocallyMuted ? 'Desmutar para mim' : 'Mutar apenas para mim (ou use Botão Direito)'}">
            <svg class="icon-vol-on" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            </svg>
            <svg class="icon-vol-off" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
            </svg>
          </button>
          <div class="tile-volume-slider-wrapper" title="Volume de ${member.username} (ou clique com Botão Direito!)">
            <input type="range" class="tile-volume-slider" id="slider-vol-${socketId}" min="0" max="200" value="${isLocallyMuted ? 0 : currentVolume}" />
            <span class="tile-volume-label" id="label-vol-${socketId}">${isLocallyMuted ? 'Mudo' : `${currentVolume}%`}</span>
          </div>
        </div>
      </div>
    `;

    const videoEl = tile.querySelector(`#video-${socketId}`);
    const audioEl = tile.querySelector(`#audio-${socketId}`);
    const muteBtn = tile.querySelector(`#btn-local-mute-${socketId}`);
    const volSlider = tile.querySelector(`#slider-vol-${socketId}`);
    const volLabel = tile.querySelector(`#label-vol-${socketId}`);

    if (stream) {
      videoEl.srcObject = stream;
      audioEl.srcObject = stream;
      applyUserVolume(socketId, member);
      applyAudioOutputDevice(audioEl);
      setupRemoteSpeakingDetector(socketId, stream);
    }

    // Volume Slider listener
    volSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.userVolumes[userKey] = val;
      localStorage.setItem('discord_user_volumes', JSON.stringify(state.userVolumes));

      if (val === 0) {
        state.localMutedUsers.add(userKey);
        muteBtn.classList.add('muted');
        volLabel.textContent = 'Mudo';
      } else {
        state.localMutedUsers.delete(userKey);
        muteBtn.classList.remove('muted');
        volLabel.textContent = `${val}%`;
      }
      localStorage.setItem('discord_local_mutes', JSON.stringify(Array.from(state.localMutedUsers)));
      applyUserVolume(socketId, member);
    });

    // Local Mute button listener
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.localMutedUsers.has(userKey)) {
        state.localMutedUsers.delete(userKey);
        muteBtn.classList.remove('muted');
        const restoredVol = state.userVolumes[userKey] > 0 ? state.userVolumes[userKey] : 100;
        volSlider.value = restoredVol;
        volLabel.textContent = `${restoredVol}%`;
      } else {
        state.localMutedUsers.add(userKey);
        muteBtn.classList.add('muted');
        volSlider.value = 0;
        volLabel.textContent = 'Mudo';
      }
      localStorage.setItem('discord_local_mutes', JSON.stringify(Array.from(state.localMutedUsers)));
      applyUserVolume(socketId, member);
    });

    // Right-Click Context Menu for volume & user settings
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openUserContextMenu(e.clientX, e.clientY, member, socketId);
    });

    return tile;
  }

  // Remote Screen Share Tile (Dedicated stream in grid)
  function createRemoteScreenTile(socketId, member, stream) {
    const tile = document.createElement('div');
    tile.className = 'video-tile screen-share-tile';
    tile.id = `tile-screen-${socketId}`;

    tile.innerHTML = `
      <div class="tile-content">
        <video id="video-screen-${socketId}" autoplay playsinline muted></video>
        <div class="live-tag">AO VIVO • TRANSMISSÃO</div>
      </div>
      <div class="tile-overlay">
        <div class="tile-username">
          <span>🖥️ Transmissão de ${member.username}</span>
        </div>
        <div class="tile-screen-actions">
          <button class="btn-tile-fullscreen" id="btnFullscreen-${socketId}" title="Tela Cheia">
            ⛶ Tela Cheia
          </button>
        </div>
      </div>
    `;

    const videoEl = tile.querySelector(`#video-screen-${socketId}`);
    if (stream) {
      videoEl.srcObject = stream;
      videoEl.onloadedmetadata = () => {
        videoEl.play().catch(e => console.warn('Play screen onloadedmetadata error:', e));
      };
      videoEl.play().catch(e => console.warn('Play screen error:', e));
    }

    tile.querySelector(`#btnFullscreen-${socketId}`).addEventListener('click', (e) => {
      e.stopPropagation();
      if (videoEl.requestFullscreen) {
        videoEl.requestFullscreen();
      }
    });

    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openUserContextMenu(e.clientX, e.clientY, member, socketId);
    });

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

      const hasCam = member.isCameraOn && stream && stream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);

      if (hasCam) {
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

      if (stream && audioEl) {
        if (audioEl.srcObject !== stream) {
          audioEl.srcObject = stream;
        }
        applyUserVolume(socketId, member);
        applyAudioOutputDevice(audioEl);
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

    const usernameSpan = tile.querySelector('.tile-username');
    if (usernameSpan) {
      usernameSpan.innerHTML = `
        <span>${member.username}</span>
        ${member.isMuted ? '<span class="status-badge-mini red">🔇</span>' : ''}
        ${member.isDeafened ? '<span class="status-badge-mini red">🔕</span>' : ''}
      `;
    }

    const videoEl = tile.querySelector(`#video-${socketId}`);
    const avatarView = tile.querySelector('.avatar-view');

    if (member.isCameraOn) {
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

    // Apply individual volume/mute preferences to all remote audio tags
    state.roomMembers.forEach((member, socketId) => {
      applyUserVolume(socketId, member);
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

  // Enumerate mic/speaker/camera devices and fill the Settings selectors.
  // Browsers only reveal device labels (and sometimes the full device list at all)
  // after mic/camera permission has been granted at least once, so request that
  // permission first if we don't already have an active stream to enumerate against.
  async function populateDeviceLists() {
    let probeStream = null;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasLabels = devices.some(d => d.label);

      if (!hasLabels && !state.webrtc?.localMicStream) {
        try {
          probeStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        } catch (e) {
          try {
            probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } catch (e2) {
            console.warn('Could not get mic/camera permission for device labels:', e2);
          }
        }
      }

      const finalDevices = probeStream ? await navigator.mediaDevices.enumerateDevices() : devices;

      const previousInput = el.selectAudioInput.value || state.selectedAudioInput;
      const previousOutput = el.selectAudioOutput.value || state.selectedAudioOutput;
      const previousVideo = el.selectVideoInput.value || state.selectedVideoInput;

      el.selectAudioInput.innerHTML = '';
      el.selectAudioOutput.innerHTML = '';
      el.selectVideoInput.innerHTML = '';

      finalDevices.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.text = device.label || `${device.kind} (${device.deviceId.slice(0, 5)}...)`;

        if (device.kind === 'audioinput') {
          if (device.deviceId === previousInput) opt.selected = true;
          el.selectAudioInput.appendChild(opt);
        } else if (device.kind === 'audiooutput') {
          if (device.deviceId === previousOutput) opt.selected = true;
          el.selectAudioOutput.appendChild(opt);
        } else if (device.kind === 'videoinput') {
          if (device.deviceId === previousVideo) opt.selected = true;
          el.selectVideoInput.appendChild(opt);
        }
      });
    } catch (err) {
      console.warn('Could not enumerate media devices:', err);
    } finally {
      if (probeStream) probeStream.getTracks().forEach(t => t.stop());
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

    // Populate Audio/Video Device Selectors (also re-usable on modal re-open / device change)
    await populateDeviceLists();
    navigator.mediaDevices.addEventListener('devicechange', populateDeviceLists);

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
    state.noiseSuppression = el.noiseSuppression ? el.noiseSuppression.checked : (state.noiseSuppression !== undefined ? state.noiseSuppression : true);

    localStorage.setItem('discord_mic_device', state.selectedAudioInput);
    localStorage.setItem('discord_spk_device', state.selectedAudioOutput);
    localStorage.setItem('discord_cam_device', state.selectedVideoInput);
    localStorage.setItem('discord_noise_suppression', state.noiseSuppression);
    localStorage.setItem('discord_avatar_color', state.user.avatarColor);

    applyAudioOutputDeviceToAll();
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

  // Auto-Updater Controller
  function initAutoUpdater() {
    async function triggerUpdate() {
      if (!window.electronAPI || !window.electronAPI.checkForUpdates) {
        alert('A atualização automática com reinicialização está disponível no aplicativo Desktop Electron.');
        return;
      }

      // Reset modal UI
      el.updateModal.classList.remove('hidden');
      el.updateModalTitle.textContent = 'Atualizando Aplicativo';
      el.updateStatusTitle.textContent = 'Buscando atualizações no GitHub...';
      el.updateStatusDesc.textContent = 'Aguarde enquanto verificamos se há novas versões disponíveis.';
      el.updateSpinner.classList.remove('hidden');
      el.updateSuccessIcon.classList.add('hidden');
      el.updateErrorIcon.classList.add('hidden');
      el.updateProgressContainer.classList.remove('hidden');
      el.updateProgressBar.style.width = '20%';
      el.btnDismissUpdate.classList.add('hidden');

      try {
        await window.electronAPI.checkForUpdates();
      } catch (err) {
        console.error('Error triggering auto update:', err);
        showUpdateError(err.message || 'Falha ao conectar com o GitHub.');
      }
    }

    // Attach click listeners to update buttons
    if (el.btnCheckUpdateTop) {
      el.btnCheckUpdateTop.addEventListener('click', triggerUpdate);
    }
    if (el.btnCheckUpdateSettings) {
      el.btnCheckUpdateSettings.addEventListener('click', () => {
        el.settingsModal.classList.add('hidden');
        triggerUpdate();
      });
    }

    // Close / Dismiss modal
    if (el.btnDismissUpdate) {
      el.btnDismissUpdate.addEventListener('click', () => {
        el.updateModal.classList.add('hidden');
      });
    }

    // Listen to real-time progress from Electron main process
    if (window.electronAPI && window.electronAPI.onUpdateProgress) {
      window.electronAPI.onUpdateProgress((data) => {
        console.log('[AutoUpdater]', data);
        const { stage, message, percent } = data;

        if (stage === 'checking') {
          el.updateStatusTitle.textContent = 'Verificando atualizações...';
          el.updateStatusDesc.textContent = message;
          el.updateProgressBar.style.width = '25%';
        } else if (stage === 'downloading') {
          el.updateStatusTitle.textContent = 'Baixando atualizações do GitHub...';
          el.updateStatusDesc.textContent = message;
          el.updateProgressBar.style.width = `${percent || 50}%`;
        } else if (stage === 'dependencies') {
          el.updateStatusTitle.textContent = 'Instalando novas dependências...';
          el.updateStatusDesc.textContent = message;
          el.updateProgressBar.style.width = `${percent || 80}%`;
        } else if (stage === 'restarting') {
          el.updateSpinner.classList.add('hidden');
          el.updateSuccessIcon.classList.remove('hidden');
          el.updateStatusTitle.textContent = 'Atualizado com Sucesso!';
          el.updateStatusDesc.textContent = message;
          el.updateProgressBar.style.width = '100%';
        } else if (stage === 'up-to-date') {
          el.updateSpinner.classList.add('hidden');
          el.updateSuccessIcon.classList.remove('hidden');
          el.updateStatusTitle.textContent = 'Você já está atualizado!';
          el.updateStatusDesc.textContent = message;
          el.updateProgressBar.style.width = '100%';
          el.btnDismissUpdate.classList.remove('hidden');
        } else if (stage === 'error') {
          showUpdateError(message);
        }
      });
    }

    function showUpdateError(errorMsg) {
      el.updateSpinner.classList.add('hidden');
      el.updateSuccessIcon.classList.add('hidden');
      el.updateErrorIcon.classList.remove('hidden');
      el.updateStatusTitle.textContent = 'Erro ao Atualizar';
      el.updateStatusDesc.textContent = errorMsg;
      el.updateProgressContainer.classList.add('hidden');
      el.btnDismissUpdate.classList.remove('hidden');
    }
  }

  // Discord-Style Right-Click Context Menu Controller
  let activeContextTarget = null;

  function openUserContextMenu(x, y, member, socketId) {
    if (!el.userContextMenu) return;

    const userKey = member.userId || member.username;
    activeContextTarget = { member, socketId, userKey };

    // Fill UI Info
    if (el.ctxAvatar) {
      el.ctxAvatar.textContent = member.username ? member.username.charAt(0).toUpperCase() : '?';
      el.ctxAvatar.style.backgroundColor = member.avatar || '#5865F2';
    }
    if (el.ctxUsername) {
      el.ctxUsername.textContent = member.username || 'Usuário';
    }
    if (el.ctxStatusTag) {
      let statusText = 'No Canal de Voz';
      if (member.isScreenSharing && member.isCameraOn) {
        statusText = 'Transmitindo Tela & Câmera';
      } else if (member.isScreenSharing) {
        statusText = 'Compartilhando Tela';
      } else if (member.isCameraOn) {
        statusText = 'Câmera Ativada';
      } else if (member.isSpeaking) {
        statusText = 'Falando no Canal';
      }
      el.ctxStatusTag.textContent = statusText;
    }

    const currentVol = getUserVolume(userKey);
    const isMuted = isUserLocallyMuted(userKey);

    if (el.ctxVolSlider) {
      el.ctxVolSlider.value = isMuted ? 0 : currentVol;
    }
    if (el.ctxVolVal) {
      el.ctxVolVal.textContent = isMuted ? 'Mudo' : `${currentVol}%`;
    }
    if (el.ctxMuteCheckbox) {
      el.ctxMuteCheckbox.checked = isMuted;
    }

    // Position Menu with viewport boundary clamping
    el.userContextMenu.classList.remove('hidden');
    const menuWidth = 240;
    const menuHeight = 220;

    let posX = x;
    let posY = y;

    if (posX + menuWidth > window.innerWidth - 10) {
      posX = window.innerWidth - menuWidth - 10;
    }
    if (posY + menuHeight > window.innerHeight - 10) {
      posY = window.innerHeight - menuHeight - 10;
    }
    if (posX < 10) posX = 10;
    if (posY < 10) posY = 10;

    el.userContextMenu.style.left = `${posX}px`;
    el.userContextMenu.style.top = `${posY}px`;
  }

  function closeUserContextMenu() {
    if (el.userContextMenu) {
      el.userContextMenu.classList.add('hidden');
    }
    activeContextTarget = null;
  }

  function initContextMenu() {
    if (!el.userContextMenu) return;

    // Volume Slider listener
    if (el.ctxVolSlider) {
      el.ctxVolSlider.addEventListener('input', (e) => {
        if (!activeContextTarget) return;
        const val = parseInt(e.target.value, 10);
        const { member, socketId, userKey } = activeContextTarget;

        state.userVolumes[userKey] = val;
        localStorage.setItem('discord_user_volumes', JSON.stringify(state.userVolumes));

        if (el.ctxVolVal) {
          el.ctxVolVal.textContent = val === 0 ? 'Mudo' : `${val}%`;
        }

        if (val === 0) {
          state.localMutedUsers.add(userKey);
          if (el.ctxMuteCheckbox) el.ctxMuteCheckbox.checked = true;
        } else {
          state.localMutedUsers.delete(userKey);
          if (el.ctxMuteCheckbox) el.ctxMuteCheckbox.checked = false;
        }
        localStorage.setItem('discord_local_mutes', JSON.stringify(Array.from(state.localMutedUsers)));

        // Sync corresponding in-tile slider & label in the grid if present
        const tileSlider = document.getElementById(`slider-vol-${socketId}`);
        const tileLabel = document.getElementById(`label-vol-${socketId}`);
        const tileMuteBtn = document.getElementById(`btn-local-mute-${socketId}`);

        if (tileSlider) tileSlider.value = val;
        if (tileLabel) tileLabel.textContent = val === 0 ? 'Mudo' : `${val}%`;
        if (tileMuteBtn) {
          if (val === 0) tileMuteBtn.classList.add('muted');
          else tileMuteBtn.classList.remove('muted');
        }

        applyUserVolume(socketId, member);
      });
    }

    // Local Mute Toggle Checkbox listener
    if (el.ctxMuteCheckbox) {
      el.ctxMuteCheckbox.addEventListener('change', (e) => {
        if (!activeContextTarget) return;
        const { member, socketId, userKey } = activeContextTarget;
        const isChecked = e.target.checked;

        if (isChecked) {
          state.localMutedUsers.add(userKey);
          if (el.ctxVolSlider) el.ctxVolSlider.value = 0;
          if (el.ctxVolVal) el.ctxVolVal.textContent = 'Mudo';
        } else {
          state.localMutedUsers.delete(userKey);
          const restoredVol = state.userVolumes[userKey] > 0 ? state.userVolumes[userKey] : 100;
          if (el.ctxVolSlider) el.ctxVolSlider.value = restoredVol;
          if (el.ctxVolVal) el.ctxVolVal.textContent = `${restoredVol}%`;
        }
        localStorage.setItem('discord_local_mutes', JSON.stringify(Array.from(state.localMutedUsers)));

        // Sync tile
        const tileSlider = document.getElementById(`slider-vol-${socketId}`);
        const tileLabel = document.getElementById(`label-vol-${socketId}`);
        const tileMuteBtn = document.getElementById(`btn-local-mute-${socketId}`);

        if (tileMuteBtn) {
          if (isChecked) tileMuteBtn.classList.add('muted');
          else tileMuteBtn.classList.remove('muted');
        }
        if (tileSlider && tileLabel) {
          if (isChecked) {
            tileSlider.value = 0;
            tileLabel.textContent = 'Mudo';
          } else {
            const restored = state.userVolumes[userKey] > 0 ? state.userVolumes[userKey] : 100;
            tileSlider.value = restored;
            tileLabel.textContent = `${restored}%`;
          }
        }

        applyUserVolume(socketId, member);
      });
    }

    // Toggle mute when clicking the whole row
    const ctxToggleMuteItem = document.getElementById('ctxToggleMuteItem');
    if (ctxToggleMuteItem) {
      ctxToggleMuteItem.addEventListener('click', (e) => {
        if (e.target === el.ctxMuteCheckbox) return;
        if (el.ctxMuteCheckbox) {
          el.ctxMuteCheckbox.checked = !el.ctxMuteCheckbox.checked;
          el.ctxMuteCheckbox.dispatchEvent(new Event('change'));
        }
      });
    }

    // Copy ID item listener
    if (el.ctxCopyIdItem) {
      el.ctxCopyIdItem.addEventListener('click', () => {
        if (!activeContextTarget) return;
        const idToCopy = activeContextTarget.member.userId || activeContextTarget.socketId || '';
        if (idToCopy && navigator.clipboard) {
          navigator.clipboard.writeText(idToCopy).then(() => {
            const span = el.ctxCopyIdItem.querySelector('span');
            const origText = span ? span.textContent : 'Copiar ID';
            if (span) span.textContent = '✓ ID Copiado!';
            setTimeout(() => {
              if (span) span.textContent = origText;
              closeUserContextMenu();
            }, 1000);
          });
        }
      });
    }

    // Dismiss context menu on click outside
    document.addEventListener('click', (e) => {
      if (el.userContextMenu && !el.userContextMenu.classList.contains('hidden')) {
        if (!el.userContextMenu.contains(e.target)) {
          closeUserContextMenu();
        }
      }
    });

    // Dismiss on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeUserContextMenu();
      }
    });

    // Dismiss on window resize
    window.addEventListener('resize', closeUserContextMenu);
  }
});
