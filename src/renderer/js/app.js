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
    focusedTileId: null, // spotlighted tile key: 'local', 'screen-local', socketId or 'screen-<socketId>'
    // Per-person playback: { voice: { userId: { volume, muted } }, stream: { ... } }
    audioPrefs: loadAudioPrefs(),
    volumePopover: null, // { kind: 'voice' | 'stream', socketId } while the popover is open
    cameraEffect: loadCameraEffect(), // { type: 'none' | 'blur-light' | 'blur-strong' | 'image', image? }
    effectsPreview: null, // own camera + processor while the effects modal is open with the camera off
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
    noiseSuppression: document.getElementById('settingsNoiseSuppression'),
    micVuMeter: document.getElementById('micVuMeterFill'),

    // Camera effects modal
    btnCameraEffects: document.getElementById('btnCameraEffects'),
    effectsModal: document.getElementById('effectsModal'),
    btnCloseEffects: document.getElementById('btnCloseEffects'),
    effectsPreviewVideo: document.getElementById('effectsPreviewVideo'),
    effectsPreviewStatus: document.getElementById('effectsPreviewStatus'),
    effectOptions: document.querySelectorAll('.effect-option[data-effect]'),
    effectCustomImage: document.getElementById('effectCustomImage'),
    btnUploadBackground: document.getElementById('btnUploadBackground'),
    backgroundFileInput: document.getElementById('backgroundFileInput'),
    effectsUnsupported: document.getElementById('effectsUnsupported'),

    // Per-user / per-stream volume popover
    volumePopover: document.getElementById('volumePopover'),
    volumePopoverTitle: document.getElementById('volumePopoverTitle'),
    volumePopoverSlider: document.getElementById('volumePopoverSlider'),
    volumePopoverValue: document.getElementById('volumePopoverValue'),
    volumePopoverMute: document.getElementById('volumePopoverMute'),
    volumePopoverReset: document.getElementById('volumePopoverReset'),
    btnTestMic: document.getElementById('btnTestMic'),
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
      // Keep retrying: a free-tier host can take up to a minute to wake up
      state.socket = io(state.serverUrl, {
        reconnectionAttempts: Infinity,
        reconnectionDelayMax: 5000,
        timeout: 20000,
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
      state.webrtc.cameraEffect = state.cameraEffect;

      // The call's camera switched between raw and effect-processed video
      state.webrtc.onLocalCameraChanged = (stream) => {
        const localVideo = document.getElementById('video-local');
        if (localVideo) localVideo.srcObject = stream;
        if (!state.effectsPreview && !el.effectsModal.classList.contains('hidden')) {
          el.effectsPreviewVideo.srcObject = stream;
        }
      };

      // Handle Remote Stream Added
      state.webrtc.onRemoteStreamAdded = (socketId, stream, isScreen) => {
        console.log(`[App] Remote stream received from ${socketId} (${isScreen ? 'screen' : 'main'})`);
        renderUserTile(socketId, stream, isScreen);
      };

      // Handle Remote Stream Removed
      state.webrtc.onRemoteStreamRemoved = (socketId) => {
        console.log(`[App] Remote stream removed from ${socketId}`);
        renderAllVideoTiles();
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
        setConnectionStatus('connecting', 'Aguardando servidor...');
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

          // Camera/screen changes add or remove whole tiles, so they need a full pass
          const layoutChanged =
            ('isCameraOn' in newState && newState.isCameraOn !== user.isCameraOn) ||
            ('isScreenSharing' in newState && newState.isScreenSharing !== user.isScreenSharing);

          Object.assign(user, newState);

          if (layoutChanged) {
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
                <div class="channel-user-item ${u.isSpeaking ? 'speaking' : ''}" data-socket-id="${u.socketId}">
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

    state.screenPicker.releaseSystemAudio();

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
    state.focusedTileId = null;
    closeVolumePopover();
    closeEffectsModal();

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

  // Render all tiles in the stage grid.
  // Camera and screen share are independent tiles, like Discord: sharing your
  // screen while the webcam is on produces two tiles for the same person.
  function renderAllVideoTiles() {
    el.videoGrid.innerHTML = '';

    const tiles = [];

    // 1. Local user tile (avatar or webcam)
    tiles.push({ key: 'local', node: createLocalUserTile() });

    // 2. Local screen share tile
    if (state.user.isScreenSharing) {
      tiles.push({
        key: 'screen-local',
        node: createScreenTile('local', `${state.user.username} (Você)`, state.webrtc.localScreenStream, true)
      });
    }

    // 3. Remote user tiles (+ their screen share tiles)
    state.roomMembers.forEach((member, socketId) => {
      tiles.push({
        key: socketId,
        node: createRemoteUserTile(socketId, member, state.webrtc.remoteStreams.get(socketId)),
        audio: { kind: 'voice', socketId }
      });

      if (member.isScreenSharing) {
        tiles.push({
          key: `screen-${socketId}`,
          node: createScreenTile(socketId, member.username, state.webrtc.remoteScreenStreams.get(socketId), false),
          audio: { kind: 'stream', socketId }
        });
      }
    });

    // A focused tile can vanish (peer left, stopped sharing) — fall back to the grid
    if (state.focusedTileId && !tiles.some(t => t.key === state.focusedTileId)) {
      state.focusedTileId = null;
    }

    // Same for the volume popover's target
    if (state.volumePopover && !tiles.some(t => t.audio &&
        t.audio.kind === state.volumePopover.kind && t.audio.socketId === state.volumePopover.socketId)) {
      closeVolumePopover();
    }

    tiles.forEach(({ key, node, audio }) => {
      node.dataset.tileKey = key;
      node.addEventListener('click', () => toggleTileFocus(key));

      const content = node.querySelector('.tile-content');
      const hint = document.createElement('div');
      hint.className = 'tile-focus-hint';
      hint.textContent = state.focusedTileId === key ? '⤡' : '⤢';
      hint.title = state.focusedTileId === key ? 'Sair do foco (Esc)' : 'Colocar em foco';
      content.appendChild(hint);

      if (audio) {
        content.appendChild(createVolumeButton(audio.kind, audio.socketId));
        node.addEventListener('contextmenu', (e) => openVolumeAtPointer(audio.kind, audio.socketId, e));
      }
    });

    if (state.focusedTileId) {
      el.videoGrid.className = 'video-grid focus-mode';

      const main = document.createElement('div');
      main.className = 'focus-main';
      const strip = document.createElement('div');
      strip.className = 'focus-strip';

      tiles.forEach(({ key, node }) => {
        if (key === state.focusedTileId) {
          node.classList.add('focused');
          main.appendChild(node);
        } else {
          strip.appendChild(node);
        }
      });

      el.videoGrid.appendChild(main);
      if (strip.children.length) el.videoGrid.appendChild(strip);
      return;
    }

    tiles.forEach(({ node }) => el.videoGrid.appendChild(node));
    adjustGridColumns();
  }

  // Spotlight a stream, Discord-style: clicking it again returns to the grid
  function toggleTileFocus(key) {
    state.focusedTileId = state.focusedTileId === key ? null : key;
    renderAllVideoTiles();
  }

  // ---- Per-user / per-stream volume ----

  function loadAudioPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem('discord_audio_prefs'));
      if (saved && saved.voice && saved.stream) return saved;
    } catch (e) {}
    return { voice: {}, stream: {} };
  }

  // Keyed by userId so a friend's volume survives reconnects (socketIds change)
  function audioPrefKey(socketId) {
    const member = state.roomMembers.get(socketId);
    return (member && member.userId) || socketId;
  }

  function getAudioPref(kind, socketId) {
    return state.audioPrefs[kind][audioPrefKey(socketId)] || { volume: 1, muted: false };
  }

  function setAudioPref(kind, socketId, changes) {
    // Re-read first: another window may have saved since this one loaded, and
    // writing back a stale copy would erase those settings
    state.audioPrefs = loadAudioPrefs();

    const key = audioPrefKey(socketId);
    const pref = { ...getAudioPref(kind, socketId), ...changes };

    if (pref.volume === 1 && !pref.muted) {
      delete state.audioPrefs[kind][key];
    } else {
      state.audioPrefs[kind][key] = pref;
    }
    localStorage.setItem('discord_audio_prefs', JSON.stringify(state.audioPrefs));

    applyPeerAudio(socketId);
    refreshVolumeButtons(socketId);
  }

  function applyAudioPref(audioEl, kind, socketId) {
    const pref = getAudioPref(kind, socketId);
    audioEl.volume = pref.volume;
    audioEl.muted = state.user.isDeafened || pref.muted;
  }

  function applyPeerAudio(socketId) {
    const voiceEl = document.getElementById(`audio-${socketId}`);
    if (voiceEl) applyAudioPref(voiceEl, 'voice', socketId);

    const streamEl = document.getElementById(`audio-screen-${socketId}`);
    if (streamEl) applyAudioPref(streamEl, 'stream', socketId);
  }

  function applyAllPeerAudio() {
    state.roomMembers.forEach((_, socketId) => applyPeerAudio(socketId));
  }

  function createVolumeButton(kind, socketId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tile-volume-btn';
    btn.dataset.volumeKind = kind;
    btn.dataset.socketId = socketId;
    refreshVolumeButton(btn);

    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't toggle tile focus
      const current = state.volumePopover;
      if (current && current.kind === kind && current.socketId === socketId) {
        closeVolumePopover();
      } else {
        openVolumePopover(kind, socketId, btn.getBoundingClientRect());
      }
    });
    return btn;
  }

  function refreshVolumeButton(btn) {
    const pref = getAudioPref(btn.dataset.volumeKind, btn.dataset.socketId);
    const pct = Math.round(pref.volume * 100);
    const silenced = pref.muted || pct === 0;

    btn.textContent = silenced ? '🔇' : pct < 100 ? '🔉' : '🔊';
    btn.classList.toggle('adjusted', silenced || pct < 100);
    btn.title = pref.muted ? 'Silenciado por você' : `Volume: ${pct}%`;
    btn.setAttribute('aria-label', btn.title);
  }

  function refreshVolumeButtons(socketId) {
    document.querySelectorAll(`.tile-volume-btn[data-socket-id="${CSS.escape(socketId)}"]`)
      .forEach(refreshVolumeButton);
  }

  // anchorRect: a button's rect (opens above it), or a pointer position with
  // atPointer = true (opens down-right like a context menu)
  function openVolumePopover(kind, socketId, anchorRect, atPointer = false) {
    const member = state.roomMembers.get(socketId);
    if (!member) return;

    state.volumePopover = { kind, socketId };
    const pref = getAudioPref(kind, socketId);

    el.volumePopoverTitle.textContent = kind === 'voice'
      ? `Volume de ${member.username}`
      : `Transmissão de ${member.username}`;
    el.volumePopoverSlider.value = Math.round(pref.volume * 100);
    el.volumePopoverValue.textContent = `${Math.round(pref.volume * 100)}%`;
    el.volumePopoverMute.checked = pref.muted;

    const popover = el.volumePopover;
    popover.classList.remove('hidden');

    // Prefer above the button (flip below if there's no room), stay on screen
    const margin = 8;
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    let left = atPointer ? anchorRect.left : anchorRect.right - width;
    let top = atPointer ? anchorRect.top : anchorRect.top - height - margin;
    if (!atPointer && top < margin) top = anchorRect.bottom + margin;
    left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
    top = Math.min(Math.max(top, margin), window.innerHeight - height - margin);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    el.volumePopoverSlider.focus();
  }

  function closeVolumePopover() {
    state.volumePopover = null;
    el.volumePopover.classList.add('hidden');
  }

  function openVolumeAtPointer(kind, socketId, event) {
    event.preventDefault();
    event.stopPropagation();
    openVolumePopover(kind, socketId, {
      left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY
    }, true);
  }

  // ---- Camera background effects ----

  const BACKGROUND_MAX_WIDTH = 1280;
  const BACKGROUND_MAX_HEIGHT = 720;

  function loadCameraEffect() {
    const type = localStorage.getItem('discord_camera_effect');
    if (type === 'blur-light' || type === 'blur-strong') return { type };
    if (type === 'image') {
      const image = localStorage.getItem('discord_camera_background');
      if (image) return { type, image };
    }
    return { type: 'none' };
  }

  function renderEffectOptions() {
    const supported = window.CameraEffectsProcessor.isSupported();
    const image = localStorage.getItem('discord_camera_background');

    el.effectCustomImage.classList.toggle('hidden', !image);
    el.effectCustomImage.style.backgroundImage = image ? `url("${image}")` : '';

    el.effectOptions.forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.effect === state.cameraEffect.type);
      if (btn.dataset.effect !== 'none') btn.disabled = !supported;
    });
    el.btnUploadBackground.disabled = !supported;
    el.effectsUnsupported.classList.toggle('hidden', supported);
  }

  function setEffectsStatus(text) {
    el.effectsPreviewStatus.textContent = text || '';
    el.effectsPreviewStatus.classList.toggle('hidden', !text);
  }

  async function openEffectsModal() {
    el.effectsModal.classList.remove('hidden');
    renderEffectOptions();

    // Camera already on: preview exactly what the call is receiving
    if (state.user.isCameraOn && state.webrtc && state.webrtc.localCamStream) {
      el.effectsPreviewVideo.srcObject = state.webrtc.localCamStream;
      return;
    }

    // Camera off: open it just for the preview, without sending anything
    const preview = { raw: null, processor: null, version: 0 };
    state.effectsPreview = preview;
    setEffectsStatus('Abrindo câmera...');

    const deviceId = state.selectedVideoInput && state.selectedVideoInput !== 'default'
      ? { deviceId: { exact: state.selectedVideoInput } }
      : {};
    let raw;
    try {
      raw = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...deviceId },
        audio: false
      });
    } catch (err) {
      if (state.effectsPreview === preview) setEffectsStatus('Não foi possível abrir a câmera para a prévia.');
      return;
    }

    if (state.effectsPreview !== preview) { // closed while the camera was opening
      raw.getTracks().forEach(t => t.stop());
      return;
    }

    preview.raw = raw;
    el.effectsPreviewVideo.srcObject = raw;
    setEffectsStatus('');
    await applyPreviewEffect(state.cameraEffect).catch(err => {
      console.warn('Preview effect failed:', err);
    });
  }

  async function applyPreviewEffect(effect) {
    const preview = state.effectsPreview;
    if (!preview || !preview.raw) return;
    const version = ++preview.version;

    if (effect.type === 'none') {
      setEffectsStatus('');
      if (preview.processor) {
        preview.processor.stop();
        preview.processor = null;
      }
      el.effectsPreviewVideo.srcObject = preview.raw;
      return;
    }

    if (preview.processor) {
      await preview.processor.setEffect(effect);
      return;
    }

    setEffectsStatus('Carregando efeito...');
    try {
      const processor = await window.CameraEffectsProcessor.create(preview.raw.getVideoTracks()[0], effect);
      if (state.effectsPreview !== preview || version !== preview.version) {
        processor.stop();
        return;
      }
      preview.processor = processor;
      el.effectsPreviewVideo.srcObject = processor.stream;
    } finally {
      if (state.effectsPreview === preview && version === preview.version) setEffectsStatus('');
    }
  }

  function closeEffectsModal() {
    el.effectsModal.classList.add('hidden');

    const preview = state.effectsPreview;
    state.effectsPreview = null;
    if (preview) {
      if (preview.processor) preview.processor.stop();
      if (preview.raw) preview.raw.getTracks().forEach(t => t.stop());
    }

    el.effectsPreviewVideo.srcObject = null;
    setEffectsStatus('');
  }

  async function selectCameraEffect(effect) {
    state.cameraEffect = effect;
    localStorage.setItem('discord_camera_effect', effect.type);
    renderEffectOptions();

    const liveLoading = state.user.isCameraOn && state.webrtc &&
      effect.type !== 'none' && !state.webrtc.cameraEffects;
    if (liveLoading) setEffectsStatus('Carregando efeito...');

    try {
      await Promise.all([
        state.webrtc ? state.webrtc.setCameraEffect(effect) : null,
        applyPreviewEffect(effect)
      ]);
    } catch (err) {
      console.error('Camera effect failed:', err);
      alert('Não foi possível aplicar o efeito de câmera: ' + err.message);
    } finally {
      if (liveLoading) setEffectsStatus('');
    }
  }

  async function useBackgroundImageFile(file) {
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, BACKGROUND_MAX_WIDTH / bitmap.width, BACKGROUND_MAX_HEIGHT / bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();

      const image = canvas.toDataURL('image/jpeg', 0.85);
      localStorage.setItem('discord_camera_background', image);
      await selectCameraEffect({ type: 'image', image });
    } catch (err) {
      alert('Não foi possível usar essa imagem: ' + err.message);
    }
  }

  // Dedicated tile for a screen share, separate from the owner's camera tile
  function createScreenTile(id, label, stream, isLocal) {
    const tile = document.createElement('div');
    tile.className = 'video-tile screen-tile';
    tile.id = `tile-screen-${id}`;

    tile.innerHTML = `
      <div class="tile-content">
        <video id="video-screen-${id}" autoplay playsinline muted></video>
        ${isLocal ? '' : `<audio id="audio-screen-${id}" autoplay></audio>`}
        <div class="live-tag">${isLocal ? 'TRANSMITINDO TELA' : 'AO VIVO'}</div>
      </div>
      <div class="tile-overlay">
        <div class="tile-username">
          <span>🖥️ Tela de ${escapeHtml(label)}</span>
        </div>
      </div>
    `;

    if (stream) {
      tile.querySelector('video').srcObject = stream;

      const audioEl = tile.querySelector('audio');
      if (audioEl) {
        audioEl.srcObject = stream;
        applyAudioPref(audioEl, 'stream', id);
      }
    }

    return tile;
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

    const hasVideo = state.user.isCameraOn;

    tile.innerHTML = `
      <div class="tile-content">
        <video id="video-local" autoplay playsinline muted class="${hasVideo ? '' : 'hidden'}"></video>
        <div class="avatar-view ${hasVideo ? 'hidden' : ''}">
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

    if (hasVideo && state.webrtc.localCamStream) {
      tile.querySelector('#video-local').srcObject = state.webrtc.localCamStream;
    }

    return tile;
  }

  function createRemoteUserTile(socketId, member, stream) {
    const tile = document.createElement('div');
    tile.className = `video-tile ${member.isSpeaking ? 'speaking' : ''}`;
    tile.id = `tile-${socketId}`;

    // The receiving track exists from negotiation onward even while the peer's
    // camera is off, so visibility follows their broadcast state instead.
    const hasVideo = !!member.isCameraOn;

    tile.innerHTML = `
      <div class="tile-content">
        <video id="video-${socketId}" autoplay playsinline muted class="${hasVideo ? '' : 'hidden'}"></video>
        <audio id="audio-${socketId}" autoplay></audio>
        <div class="avatar-view ${hasVideo ? 'hidden' : ''}">
          <div class="tile-avatar" style="background-color: ${member.avatar || '#5865F2'}">
            ${member.username.charAt(0).toUpperCase()}
          </div>
        </div>
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
      applyAudioPref(audioEl, 'voice', socketId);

      // Attach speaking detector to remote stream
      setupRemoteSpeakingDetector(socketId, stream);
    }

    return tile;
  }

  function renderUserTile(socketId, stream, isScreen) {
    const member = state.roomMembers.get(socketId);
    if (!member) return;

    if (isScreen) {
      const videoEl = document.getElementById(`video-screen-${socketId}`);
      if (!videoEl) {
        if (member.isScreenSharing) renderAllVideoTiles();
        return;
      }

      if (videoEl.srcObject !== stream) videoEl.srcObject = stream;

      const audioEl = document.getElementById(`audio-screen-${socketId}`);
      if (audioEl && audioEl.srcObject !== stream) {
        audioEl.srcObject = stream;
        applyAudioPref(audioEl, 'stream', socketId);
      }
      return;
    }

    const existingTile = document.getElementById(`tile-${socketId}`);
    if (!existingTile) {
      renderAllVideoTiles();
      return;
    }

    const videoEl = existingTile.querySelector(`#video-${socketId}`);
    const audioEl = existingTile.querySelector(`#audio-${socketId}`);
    const avatarView = existingTile.querySelector('.avatar-view');

    if (videoEl && videoEl.srcObject !== stream) videoEl.srcObject = stream;

    if (audioEl && audioEl.srcObject !== stream) {
      audioEl.srcObject = stream;
      applyAudioPref(audioEl, 'voice', socketId);
    }

    if (member.isCameraOn) {
      videoEl.classList.remove('hidden');
      avatarView.classList.add('hidden');
    } else {
      videoEl.classList.add('hidden');
      avatarView.classList.remove('hidden');
    }

    if (stream) setupRemoteSpeakingDetector(socketId, stream);
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
    const existing = state.remoteSpeakingDetectors.get(socketId);

    // Tiles re-render often; rebuilding the AudioContext each time would glitch audio
    if (existing) {
      if (existing.stream === stream) return;
      existing.destroy();
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

    // Deafen overrides everyone; undeafening restores each person's own setting
    applyAllPeerAudio();

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
      state.screenPicker.releaseSystemAudio();
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
        state.screenPicker.releaseSystemAudio();
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
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      el.selectAudioInput.innerHTML = '';
      el.selectAudioOutput.innerHTML = '';
      el.selectVideoInput.innerHTML = '';

      devices.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.text = device.label || `${device.kind} (${device.deviceId.slice(0, 5)}...)`;

        if (device.kind === 'audioinput') {
          if (device.deviceId === state.selectedAudioInput) opt.selected = true;
          el.selectAudioInput.appendChild(opt);
        } else if (device.kind === 'audiooutput') {
          if (device.deviceId === state.selectedAudioOutput) opt.selected = true;
          el.selectAudioOutput.appendChild(opt);
        } else if (device.kind === 'videoinput') {
          if (device.deviceId === state.selectedVideoInput) opt.selected = true;
          el.selectVideoInput.appendChild(opt);
        }
      });
    } catch (err) {
      console.warn('Could not enumerate media devices:', err);
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
    let testCapture = null;
    let testDetector = null;
    el.btnTestMic.addEventListener('click', async () => {
      if (testCapture) {
        testCapture.release();
        testCapture = null;
        if (testDetector) testDetector.destroy();
        el.btnTestMic.textContent = 'Testar Microfone';
        el.micVuMeter.style.width = '0%';
        return;
      }

      try {
        // Uses the checkbox as it is right now, so the filter can be compared before saving
        testCapture = await window.captureMicrophone({
          echoCancellation: true,
          autoGainControl: true,
          ...(el.selectAudioInput.value ? { deviceId: { exact: el.selectAudioInput.value } } : {})
        }, el.noiseSuppression.checked);
        el.btnTestMic.textContent = 'Parar Teste';

        testDetector = new window.SpeakingDetector(testCapture.stream, (isSpeaking, level) => {
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

  // Camera effects
  el.btnCameraEffects.addEventListener('click', openEffectsModal);
  el.btnCloseEffects.addEventListener('click', closeEffectsModal);
  el.effectsModal.addEventListener('click', (e) => {
    if (e.target === el.effectsModal) closeEffectsModal();
  });

  el.effectOptions.forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.effect;
      if (type === 'image') {
        const image = localStorage.getItem('discord_camera_background');
        if (image) selectCameraEffect({ type, image });
        return;
      }
      selectCameraEffect({ type });
    });
  });

  el.btnUploadBackground.addEventListener('click', () => el.backgroundFileInput.click());
  el.backgroundFileInput.addEventListener('change', () => {
    useBackgroundImageFile(el.backgroundFileInput.files[0]);
    el.backgroundFileInput.value = '';
  });

  // Esc closes the effects modal, then the volume popover, then leaves spotlight mode
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.effectsModal.classList.contains('hidden')) {
      closeEffectsModal();
    } else if (state.volumePopover) {
      closeVolumePopover();
    } else if (state.focusedTileId) {
      state.focusedTileId = null;
      renderAllVideoTiles();
    }
  });

  // Right-click someone in your current channel to adjust their volume.
  // Delegated and checked at click time, so it never depends on whether the
  // sidebar was rendered before or after the room's members were known.
  el.channelsList.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.channel-user-item');
    if (!item || !state.roomMembers.has(item.dataset.socketId)) return;
    openVolumeAtPointer('voice', item.dataset.socketId, e);
  });

  // Volume changes made in another window apply here too
  window.addEventListener('storage', (e) => {
    if (e.key !== 'discord_audio_prefs') return;
    state.audioPrefs = loadAudioPrefs();
    applyAllPeerAudio();
    document.querySelectorAll('.tile-volume-btn').forEach(refreshVolumeButton);
  });

  // Volume popover
  el.volumePopoverSlider.addEventListener('input', () => {
    if (!state.volumePopover) return;
    const pct = parseInt(el.volumePopoverSlider.value, 10);
    el.volumePopoverValue.textContent = `${pct}%`;
    setAudioPref(state.volumePopover.kind, state.volumePopover.socketId, { volume: pct / 100 });
  });

  el.volumePopoverMute.addEventListener('change', () => {
    if (!state.volumePopover) return;
    setAudioPref(state.volumePopover.kind, state.volumePopover.socketId, { muted: el.volumePopoverMute.checked });
  });

  el.volumePopoverReset.addEventListener('click', () => {
    if (!state.volumePopover) return;
    setAudioPref(state.volumePopover.kind, state.volumePopover.socketId, { volume: 1, muted: false });
    el.volumePopoverSlider.value = 100;
    el.volumePopoverValue.textContent = '100%';
    el.volumePopoverMute.checked = false;
  });

  document.addEventListener('mousedown', (e) => {
    if (!state.volumePopover) return;
    if (el.volumePopover.contains(e.target) || e.target.closest('.tile-volume-btn')) return;
    closeVolumePopover();
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
