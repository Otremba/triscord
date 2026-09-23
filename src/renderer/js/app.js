/**
 * Main Application Coordinator
 */

document.addEventListener('DOMContentLoaded', () => {
  // Settings saved before the app was renamed still live under the old prefix
  Object.keys(localStorage)
    .filter(key => key.startsWith('discord_'))
    .forEach(key => {
      const renamed = 'triscord_' + key.slice('discord_'.length);
      if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(key));
      localStorage.removeItem(key);
    });

  // In a browser, use the server that served the page; the desktop app (file://) uses the hosted server
  const HOSTED_SERVER_URL = 'https://triscord.onrender.com';
  const defaultServerUrl = window.location.protocol.startsWith('http')
    ? window.location.origin
    : HOSTED_SERVER_URL;

  // Installs from the ngrok era saved a tunnel URL that no longer runs
  const savedServerUrl = localStorage.getItem('triscord_server_url');
  if (savedServerUrl && /ngrok/i.test(savedServerUrl)) {
    localStorage.removeItem('triscord_server_url');
  }

  function escapeHtml(string) {
    const div = document.createElement('div');
    div.innerText = string == null ? '' : String(string);
    return div.innerHTML;
  }

  function escapeRegExp(string) {
    return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Anything rendered as a CSS color value must be validated first: a peer
  // could send an arbitrary string trying to break out of a style attribute
  function safeColor(color) {
    return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#5865F2';
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
  }

  const KEY_CODE_LABELS = {
    Space: 'Barra de espaço',
    ControlLeft: 'Ctrl Esquerdo', ControlRight: 'Ctrl Direito',
    ShiftLeft: 'Shift Esquerdo', ShiftRight: 'Shift Direito',
    AltLeft: 'Alt Esquerdo', AltRight: 'Alt Direito',
    Backquote: '` (crase)'
  };
  function describeKeyCode(code) {
    if (KEY_CODE_LABELS[code]) return KEY_CODE_LABELS[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    return code;
  }

  // Built-in camera backgrounds, generated on the fly as gradients so no
  // extra image assets need to ship with the app
  const PRESET_BACKGROUNDS = {
    'gradient-blue': ['#1e3c72', '#2a5298'],
    'gradient-sunset': ['#ff7e5f', '#feb47b']
  };
  const presetDataUrlCache = {};
  function getPresetDataUrl(id) {
    const colors = PRESET_BACKGROUNDS[id];
    if (!colors) return null;
    if (presetDataUrlCache[id]) return presetDataUrlCache[id];
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(1, colors[1]);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    presetDataUrlCache[id] = dataUrl;
    return dataUrl;
  }

  function loadCameraEffect() {
    const type = localStorage.getItem('triscord_camera_effect');
    if (type === 'blur-light' || type === 'blur-strong') return { type };
    if (type === 'image') {
      const source = localStorage.getItem('triscord_camera_background_source') || 'custom';
      if (source === 'custom') {
        const image = localStorage.getItem('triscord_camera_background');
        if (image) return { type, image, source: 'custom' };
      } else {
        const image = getPresetDataUrl(source);
        if (image) return { type, image, source };
      }
    }
    return { type: 'none' };
  }

  function loadTheme() {
    return localStorage.getItem('triscord_theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  }

  // Application State
  const state = {
    serverUrl: localStorage.getItem('triscord_server_url') || defaultServerUrl,
    user: {
      userId: localStorage.getItem('triscord_user_id') || `user_${Math.random().toString(36).substr(2, 9)}`,
      username: localStorage.getItem('triscord_username') || `Amigo_${Math.floor(1000 + Math.random() * 9000)}`,
      avatarColor: localStorage.getItem('triscord_avatar_color') || '#5865F2',
      status: localStorage.getItem('triscord_status') || '',
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
    cameraEffect: loadCameraEffect(), // { type: 'none' | 'blur-light' | 'blur-strong' | 'image', image?, source? }
    effectsPreview: null, // own camera + processor while the effects modal is open with the camera off
    micSensitivity: parseInt(localStorage.getItem('triscord_mic_sens') || '15', 10),
    selectedAudioInput: localStorage.getItem('triscord_mic_device') || 'default',
    selectedAudioOutput: localStorage.getItem('triscord_spk_device') || 'default',
    selectedVideoInput: localStorage.getItem('triscord_cam_device') || 'default',
    noiseSuppression: localStorage.getItem('triscord_noise_suppression') !== 'false',
    theme: loadTheme(),
    pttMode: localStorage.getItem('triscord_voice_mode') === 'ptt' ? 'ptt' : 'vad',
    pttKey: localStorage.getItem('triscord_ptt_key') || 'Space',
    pttActive: false,
    turnServer: {
      url: localStorage.getItem('triscord_turn_url') || '',
      username: localStorage.getItem('triscord_turn_username') || '',
      credential: localStorage.getItem('triscord_turn_credential') || ''
    },
    isRoomOwner: false,
    currentRoomLocked: false,
    currentRoomMaxUsers: null,
    connectionQuality: new Map(), // socketId -> { level, rttMs, lossPct }
    chatMessagesById: new Map(), // messageId -> message (for re-rendering reactions)
    pendingAttachment: null, // image attachment staged for the next chat message
    recording: null, // { recorder, stop } while a call recording is in progress
    tileZoom: new Map(), // tileKey -> { scale: 1.0, panX: 0, panY: 0 }
    fullscreenTileKey: null, // tileKey da transmissão em tela cheia (ou null)
    suppressTileClickUntil: 0 // timestamp para suprimir clique após arrastar
  };

  applyTheme(state.theme);

  localStorage.setItem('triscord_user_id', state.user.userId);
  localStorage.setItem('triscord_username', state.user.username);
  localStorage.setItem('triscord_avatar_color', state.user.avatarColor);
  localStorage.setItem('triscord_status', state.user.status);

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
    userCustomStatus: document.getElementById('userCustomStatus'),
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
    btnToggleRecording: document.getElementById('btnToggleRecording'),
    btnDisconnect: document.getElementById('btnDisconnectVoice'),

    // Chat Drawer
    chatDrawer: document.getElementById('chatDrawer'),
    chatMessages: document.getElementById('chatMessages'),
    chatInput: document.getElementById('chatInput'),
    btnSendChat: document.getElementById('btnSendChat'),
    btnCloseChat: document.getElementById('btnCloseChat'),
    btnAttachImage: document.getElementById('btnAttachImage'),
    chatAttachmentInput: document.getElementById('chatAttachmentInput'),
    chatAttachmentPreview: document.getElementById('chatAttachmentPreview'),
    chatAttachmentThumb: document.getElementById('chatAttachmentThumb'),
    btnRemoveAttachment: document.getElementById('btnRemoveAttachment'),

    // Settings Modal
    settingsModal: document.getElementById('settingsModal'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    btnSaveSettings: document.getElementById('btnSaveSettings'),
    inputSettingsUsername: document.getElementById('settingsUsername'),
    inputSettingsStatus: document.getElementById('settingsStatus'),
    inputSettingsServerUrl: document.getElementById('settingsServerUrl'),
    selectAudioInput: document.getElementById('settingsAudioInput'),
    selectAudioOutput: document.getElementById('settingsAudioOutput'),
    selectVideoInput: document.getElementById('settingsVideoInput'),
    sliderSensitivity: document.getElementById('settingsSensitivity'),
    labelSensitivity: document.getElementById('labelSensitivity'),
    noiseSuppression: document.getElementById('settingsNoiseSuppression'),
    settingsLightTheme: document.getElementById('settingsLightTheme'),
    settingsModeVAD: document.getElementById('settingsModeVAD'),
    settingsModePTT: document.getElementById('settingsModePTT'),
    pttKeyRow: document.getElementById('pttKeyRow'),
    btnCapturePttKey: document.getElementById('btnCapturePttKey'),
    globalShortcutSection: document.getElementById('globalShortcutSection'),
    settingsGlobalShortcut: document.getElementById('settingsGlobalShortcut'),
    settingsTurnUrl: document.getElementById('settingsTurnUrl'),
    settingsTurnUsername: document.getElementById('settingsTurnUsername'),
    settingsTurnCredential: document.getElementById('settingsTurnCredential'),
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
    avatarColorPicker: document.querySelectorAll('.avatar-color-option'),
    toastContainer: document.getElementById('toastContainer')
  };

  // Initialize UI
  updateUserProfileUI();
  initSettingsUI();
  initPresetBackgroundButtons();

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
      state.webrtc = new window.WebRTCManager(state.socket, state.user.userId, {
        iceServers: buildCustomIceServers()
      });
      state.webrtc.cameraEffect = state.cameraEffect;
      state.webrtc.onConnectionQualityChanged = (socketId, quality) => {
        updateConnectionQualityIndicator(socketId, quality);
      };

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
      state.socket.on('room-joined', ({ roomId, existingUsers, chatHistory, isOwner, locked, maxUsers }) => {
        state.currentRoomId = roomId;
        state.roomMembers.clear();
        state.isRoomOwner = !!isOwner;
        state.currentRoomLocked = !!locked;
        state.currentRoomMaxUsers = maxUsers || null;

        existingUsers.forEach(u => {
          state.roomMembers.set(u.socketId, u);
        });

        window.SoundEffects.playJoin();
        updateStageView();

        clearChat();
        (chatHistory || []).forEach(msg => addChatMessage(msg));

        // Connect WebRTC to all existing members
        existingUsers.forEach(u => {
          state.webrtc.connectToPeer(u.socketId);
        });
      });

      // The server refused to let us in (room locked or at its user limit)
      state.socket.on('room-join-denied', ({ reason }) => {
        state.currentRoomId = null;
        state.currentRoomName = '';
        updateStageView();
        showToast(reason === 'locked' ? 'Esta sala está trancada pelo dono.' : 'Esta sala está cheia.', 'error');
      });

      // Another user joined our current room
      state.socket.on('user-joined', ({ socketId, userData }) => {
        state.roomMembers.set(socketId, userData);
        window.SoundEffects.playJoin();
        updateStageView();
        addChatMessage({
          senderName: 'Sistema',
          text: `<i data-lucide="log-in"></i><strong>${escapeHtml(userData.username)}</strong> entrou no canal de voz.`,
          timestamp: Date.now(),
          isSystem: true
        });
        notify('Triscord', `${userData.username} entrou no canal #${state.currentRoomName}`);
      });

      // A room owner kicked us out
      state.socket.on('kicked', ({ byUsername }) => {
        showToast(`Você foi removido da sala por ${byUsername}.`, 'error');
        leaveCurrentRoom();
      });

      // A room owner force-muted us
      state.socket.on('force-muted', ({ byUsername }) => {
        if (!state.user.isMuted) toggleMute();
        showToast(`${byUsername} silenciou seu microfone.`, 'error');
      });

      state.socket.on('chat-rate-limited', () => {
        showToast('Você está enviando mensagens rápido demais.', 'error');
      });

      // Someone reacted (or removed a reaction) on a chat message
      state.socket.on('message-reaction-updated', ({ messageId, reactions }) => {
        updateMessageReactionsUI(messageId, reactions);
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
          text: `<i data-lucide="log-out"></i><strong>${escapeHtml(username)}</strong> saiu do canal de voz.`,
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

        if (msg.senderSocketId !== state.socket.id && msg.text && state.user.username) {
          const mentionRe = new RegExp(`\\b${escapeRegExp(state.user.username)}\\b`, 'i');
          if (mentionRe.test(msg.text)) {
            notify(`${msg.senderName} mencionou você`, msg.text);
          }
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

  function buildCustomIceServers() {
    const { url, username, credential } = state.turnServer;
    if (!url) return [];
    return [{ urls: url, username: username || undefined, credential: credential || undefined }];
  }

  // ---- Toasts & desktop notifications ----

  function showToast(message, kind = 'info') {
    const toast = document.createElement('div');
    toast.className = `app-toast ${kind}`;
    toast.textContent = message;
    el.toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  function shouldSendDesktopNotification() {
    return document.hidden || !document.hasFocus();
  }

  function notify(title, body) {
    if (!shouldSendDesktopNotification()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body, icon: 'assets/icon.png' });
    } catch (err) {
      console.warn('Notification failed:', err);
    }
  }

  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  // ---- Per-peer connection quality indicator ----

  function updateConnectionQualityIndicator(socketId, quality) {
    state.connectionQuality.set(socketId, quality);
    const tile = document.getElementById(`tile-${socketId}`);
    if (!tile) return;
    const overlay = tile.querySelector('.tile-overlay');
    if (!overlay) return;

    let dot = overlay.querySelector('.quality-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'quality-dot';
      overlay.appendChild(dot);
    }
    dot.className = `quality-dot quality-${quality.level}`;
    dot.title = quality.rttMs != null
      ? `Conexão ${quality.level === 'good' ? 'boa' : quality.level === 'ok' ? 'razoável' : 'ruim'} • Ping: ${Math.round(quality.rttMs)}ms`
      : 'Qualidade da conexão';
  }

  // Render list of voice channels in the left sidebar
  function renderChannelsList() {
    el.channelsList.innerHTML = state.rooms.map(room => {
      const isCurrent = state.currentRoomId === room.id;
      const userCount = room.users ? room.users.length : 0;
      const iOwnThisRoom = !!room.ownerUserId && room.ownerUserId === state.user.userId;
      const isOwnerHere = isCurrent && state.isRoomOwner;

      return `
        <div class="channel-item ${isCurrent ? 'active' : ''}" data-room-id="${room.id}" data-room-name="${escapeHtml(room.name)}">
          <div class="channel-main">
            <div class="channel-icon"><i data-lucide="mic"></i></div>
            <span class="channel-name">${escapeHtml(room.name)}</span>
            ${room.maxUsers ? `<span class="channel-badge" title="Limite de usuários">${userCount}/${room.maxUsers}</span>`
              : userCount > 0 ? `<span class="channel-badge">${userCount}</span>` : ''}
            ${room.locked
              ? `<span class="status-mini-icon ${iOwnThisRoom ? 'yellow lock-toggle' : 'yellow'}" ${iOwnThisRoom ? `data-action="toggle-lock" data-room-id="${room.id}"` : ''} title="${iOwnThisRoom ? 'Sala trancada — clique para destrancar' : 'Sala trancada pelo dono'}"><i data-lucide="lock"></i></span>`
              : iOwnThisRoom ? `<span class="status-mini-icon lock-toggle" data-action="toggle-lock" data-room-id="${room.id}" title="Sala aberta — clique para trancar"><i data-lucide="lock-open"></i></span>` : ''}
            ${iOwnThisRoom ? `<span class="status-mini-icon lock-toggle" data-action="set-limit" data-room-id="${room.id}" title="Definir limite de usuários"><i data-lucide="users"></i></span>` : ''}
          </div>
          ${room.users && room.users.length > 0 ? `
            <div class="channel-user-list">
              ${room.users.map(u => `
                <div class="channel-user-item ${u.isSpeaking ? 'speaking' : ''}" data-socket-id="${u.socketId}" ${u.status ? `title="${escapeHtml(u.status)}"` : ''}>
                  <div class="channel-user-avatar" style="background-color: ${safeColor(u.avatar)}">
                    ${escapeHtml(u.username).charAt(0).toUpperCase()}
                  </div>
                  <span class="channel-user-name">${escapeHtml(u.username)}</span>
                  <div class="channel-user-icons">
                    ${u.isMuted ? '<span class="status-mini-icon red" title="Mutado"><i data-lucide="mic-off"></i></span>' : ''}
                    ${u.isDeafened ? '<span class="status-mini-icon red" title="Ensurdecido"><i data-lucide="headphone-off"></i></span>' : ''}
                    ${u.isCameraOn ? '<span class="status-mini-icon green" title="Câmera Ativa"><i data-lucide="video"></i></span>' : ''}
                    ${u.isScreenSharing ? '<span class="status-mini-icon blurple" title="Compartilhando Tela"><i data-lucide="screen-share"></i></span>' : ''}
                    ${isOwnerHere && u.socketId !== state.socket?.id ? `
                      <button type="button" class="status-mini-icon owner-action" data-action="force-mute" data-socket-id="${u.socketId}" title="Silenciar à força"><i data-lucide="mic-off"></i></button>
                      <button type="button" class="status-mini-icon owner-action" data-action="kick" data-socket-id="${u.socketId}" title="Expulsar da sala"><i data-lucide="user-x"></i></button>
                    ` : ''}
                  </div>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    window.renderIcons(el.channelsList);

    // Channel click listeners
    el.channelsList.querySelectorAll('.channel-item').forEach(item => {
      item.querySelector('.channel-main').addEventListener('click', (e) => {
        if (e.target.closest('[data-action]')) return; // lock/limit icon handled below
        const roomId = item.dataset.roomId;
        const roomName = item.dataset.roomName;
        if (state.currentRoomId !== roomId) {
          joinRoom(roomId, roomName);
        }
      });
    });
  }

  // Room owner controls + per-user moderation (event-delegated: the list is
  // rebuilt on every rooms-update, so per-node listeners would leak/vanish)
  el.channelsList.addEventListener('click', (e) => {
    const ownerBtn = e.target.closest('.owner-action');
    if (ownerBtn) {
      e.stopPropagation();
      const socketId = ownerBtn.dataset.socketId;
      if (ownerBtn.dataset.action === 'kick') {
        if (confirm('Expulsar este usuário da sala?')) state.socket.emit('kick-user', { socketId });
      } else if (ownerBtn.dataset.action === 'force-mute') {
        state.socket.emit('force-mute-user', { socketId });
      }
      return;
    }

    const lockToggle = e.target.closest('[data-action="toggle-lock"]');
    if (lockToggle) {
      e.stopPropagation();
      const room = state.rooms.find(r => r.id === lockToggle.dataset.roomId);
      if (room) state.socket.emit('update-room-settings', { locked: !room.locked });
      return;
    }

    const limitBtn = e.target.closest('[data-action="set-limit"]');
    if (limitBtn) {
      e.stopPropagation();
      const room = state.rooms.find(r => r.id === limitBtn.dataset.roomId);
      const current = room && room.maxUsers ? String(room.maxUsers) : '';
      const input = prompt('Limite de usuários nesta sala (deixe em branco para não ter limite):', current);
      if (input === null) return;
      const trimmed = input.trim();
      if (trimmed === '') {
        state.socket.emit('update-room-settings', { maxUsers: null });
      } else {
        const num = parseInt(trimmed, 10);
        if (Number.isFinite(num) && num >= 1) state.socket.emit('update-room-settings', { maxUsers: num });
      }
    }
  });

  // Join a voice channel
  async function joinRoom(roomId, roomName) {
    if (!state.socket || !state.socket.connected) {
      alert('Aguarde a conexão com o servidor...');
      return;
    }

    // Switching channels — or rejoining after a reconnect — leaves the peer
    // connections of the previous room behind, and connectToPeer() skips a
    // socketId it already has, so someone we meet again would stay silent.
    if (state.webrtc) {
      state.webrtc.resetPeers();
      state.remoteSpeakingDetectors.forEach(d => d.destroy());
      state.remoteSpeakingDetectors.clear();
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
        applyMicEnabledState();
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
        status: state.user.status,
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

    if (state.recording) stopRecording();

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
    state.isRoomOwner = false;
    state.currentRoomLocked = false;
    state.currentRoomMaxUsers = null;
    state.pttActive = false;
    state.user.isCameraOn = false;
    state.user.isScreenSharing = false;
    state.focusedTileId = null;

    if (state.fullscreenTileKey || document.fullscreenElement) {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      state.fullscreenTileKey = null;
    }
    state.tileZoom.clear();

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

  // ---- Stream Zoom, Pan & Fullscreen Engine ----

  function getTileZoom(tileKey) {
    if (!state.tileZoom.has(tileKey)) {
      state.tileZoom.set(tileKey, { scale: 1.0, panX: 0, panY: 0 });
    }
    return state.tileZoom.get(tileKey);
  }

  function applyTileTransform(tileKey, smooth = false) {
    const tile = document.querySelector(`.video-tile[data-tile-key="${CSS.escape(tileKey)}"]`);
    if (!tile) return;

    const zoom = getTileZoom(tileKey);
    const content = tile.querySelector('.tile-content');
    const video = tile.querySelector('.tile-content video');
    const badge = tile.querySelector(`#zoom-badge-${CSS.escape(tileKey)}`);

    if (badge) {
      badge.textContent = `${Math.round(zoom.scale * 100)}%`;
      badge.classList.toggle('zoomed', zoom.scale > 1.05);
    }

    if (content) {
      content.classList.toggle('is-zoomed', zoom.scale > 1.05);
    }

    tile.classList.toggle('is-zoomed', zoom.scale > 1.05);

    if (video) {
      if (smooth) {
        video.classList.add('transition-smooth');
        setTimeout(() => video.classList.remove('transition-smooth'), 220);
      }
      if (zoom.scale <= 1.01) {
        video.style.transform = '';
      } else {
        video.style.transform = `translate3d(${zoom.panX}px, ${zoom.panY}px, 0px) scale(${zoom.scale})`;
      }
    }
  }

  function showZoomPill(tile, scaleText) {
    let pill = tile.querySelector('.tile-zoom-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'tile-zoom-pill';
      tile.appendChild(pill);
    }
    pill.innerHTML = `<span class="pill-dot"></span><span>${escapeHtml(scaleText)}</span>`;
    pill.classList.add('visible');
    clearTimeout(pill._timer);
    pill._timer = setTimeout(() => {
      pill.classList.remove('visible');
    }, 1300);
  }

  function setTileZoom(tileKey, newScale, focalX = null, focalY = null, smooth = false) {
    const tile = document.querySelector(`.video-tile[data-tile-key="${CSS.escape(tileKey)}"]`);
    const zoom = getTileZoom(tileKey);
    const oldScale = zoom.scale;
    const clampedScale = Math.min(5.0, Math.max(1.0, newScale));

    if (clampedScale <= 1.01) {
      zoom.scale = 1.0;
      zoom.panX = 0;
      zoom.panY = 0;
      applyTileTransform(tileKey, smooth);
      if (tile && oldScale > 1.05) {
        showZoomPill(tile, '100% (Ajustado)');
      }
      return;
    }

    const content = tile ? tile.querySelector('.tile-content') : null;
    const cw = content ? content.clientWidth : 800;
    const ch = content ? content.clientHeight : 450;

    if (focalX !== null && focalY !== null) {
      // Zoom centered at mouse position
      const cx = focalX - cw / 2;
      const cy = focalY - ch / 2;
      const ratio = clampedScale / oldScale;
      zoom.panX = cx - (cx - zoom.panX) * ratio;
      zoom.panY = cy - (cy - zoom.panY) * ratio;
    }

    // Clamp pan bounds so video doesn't drift away
    const maxPanX = Math.max(0, (cw * clampedScale - cw) / 2);
    const maxPanY = Math.max(0, (ch * clampedScale - ch) / 2);
    zoom.panX = Math.max(-maxPanX, Math.min(maxPanX, zoom.panX));
    zoom.panY = Math.max(-maxPanY, Math.min(maxPanY, zoom.panY));
    zoom.scale = clampedScale;

    applyTileTransform(tileKey, smooth);
    if (tile) {
      showZoomPill(tile, `${Math.round(clampedScale * 100)}% • Arraste para mover`);
    }
  }

  function zoomTileByStep(tileKey, stepDelta) {
    const zoom = getTileZoom(tileKey);
    const nextScale = Math.round((zoom.scale + stepDelta) * 4) / 4;
    setTileZoom(tileKey, nextScale, null, null, true);
  }

  function resetTileZoom(tileKey) {
    setTileZoom(tileKey, 1.0, null, null, true);
  }

  function createTileActionsBar(tileKey, isVideoTile) {
    const bar = document.createElement('div');
    bar.className = 'tile-actions-bar';

    // 1. Zoom controls (only for video / stream tiles)
    if (isVideoTile) {
      const zoomGroup = document.createElement('div');
      zoomGroup.className = 'tile-action-group zoom-controls';

      const btnZoomOut = document.createElement('button');
      btnZoomOut.type = 'button';
      btnZoomOut.className = 'tile-action-btn';
      btnZoomOut.dataset.action = 'zoom-out';
      btnZoomOut.title = 'Diminuir zoom (Scroll para baixo)';
      btnZoomOut.innerHTML = '<i data-lucide="minus"></i>';
      btnZoomOut.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomTileByStep(tileKey, -0.25);
      });

      const zoomBadge = document.createElement('button');
      zoomBadge.type = 'button';
      zoomBadge.className = 'tile-zoom-badge';
      zoomBadge.id = `zoom-badge-${tileKey}`;
      zoomBadge.dataset.action = 'zoom-reset';
      zoomBadge.title = 'Redefinir zoom (100%)';
      const currentZoom = getTileZoom(tileKey);
      zoomBadge.textContent = `${Math.round(currentZoom.scale * 100)}%`;
      if (currentZoom.scale > 1.05) zoomBadge.classList.add('zoomed');
      zoomBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        resetTileZoom(tileKey);
      });

      const btnZoomIn = document.createElement('button');
      btnZoomIn.type = 'button';
      btnZoomIn.className = 'tile-action-btn';
      btnZoomIn.dataset.action = 'zoom-in';
      btnZoomIn.title = 'Aumentar zoom (Scroll para cima)';
      btnZoomIn.innerHTML = '<i data-lucide="plus"></i>';
      btnZoomIn.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomTileByStep(tileKey, 0.25);
      });

      zoomGroup.appendChild(btnZoomOut);
      zoomGroup.appendChild(zoomBadge);
      zoomGroup.appendChild(btnZoomIn);
      bar.appendChild(zoomGroup);

      const divider = document.createElement('div');
      divider.className = 'tile-action-divider';
      bar.appendChild(divider);
    }

    // 2. Fullscreen Button (for video / stream tiles)
    if (isVideoTile) {
      const isCurrentFs = state.fullscreenTileKey === tileKey;
      const btnFs = document.createElement('button');
      btnFs.type = 'button';
      btnFs.className = 'tile-action-btn tile-fullscreen-btn';
      btnFs.id = `btn-fs-${tileKey}`;
      btnFs.title = isCurrentFs ? 'Sair da tela cheia (Esc ou F)' : 'Tela cheia (F)';
      btnFs.innerHTML = `<i data-lucide="${isCurrentFs ? 'minimize' : 'maximize'}"></i>`;
      btnFs.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTileFullscreen(tileKey);
      });
      bar.appendChild(btnFs);
    }

    // 3. Spotlight / Focus Button
    const isFocused = state.focusedTileId === tileKey;
    const btnFocus = document.createElement('button');
    btnFocus.type = 'button';
    btnFocus.className = 'tile-action-btn tile-focus-btn';
    btnFocus.title = isFocused ? 'Sair do foco (Esc)' : 'Colocar em foco';
    btnFocus.innerHTML = `<i data-lucide="${isFocused ? 'minimize-2' : 'maximize-2'}"></i>`;
    btnFocus.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTileFocus(tileKey);
    });
    bar.appendChild(btnFocus);

    return bar;
  }

  function setupTileZoomAndPan(tile, tileKey, videoEl) {
    const content = tile.querySelector('.tile-content');
    if (!content || !videoEl) return;

    // Apply any existing zoom state on load
    applyTileTransform(tileKey, false);

    // 1. Mouse Wheel Zoom (centered at mouse cursor)
    content.addEventListener('wheel', (e) => {
      // Prevent page/grid scrolling
      e.preventDefault();
      e.stopPropagation();

      const rect = content.getBoundingClientRect();
      const focalX = e.clientX - rect.left;
      const focalY = e.clientY - rect.top;

      const zoom = getTileZoom(tileKey);
      const delta = -Math.sign(e.deltaY) * 0.25;
      const nextScale = zoom.scale + delta;

      setTileZoom(tileKey, nextScale, focalX, focalY, false);
    }, { passive: false });

    // 2. Drag to Pan (when zoomed in)
    let isMouseDown = false;
    let hasDragged = false;
    let startClientX = 0;
    let startClientY = 0;
    let startPanX = 0;
    let startPanY = 0;

    const onPointerDown = (e) => {
      if (e.button !== 0) return; // left click only
      const zoom = getTileZoom(tileKey);
      if (zoom.scale <= 1.01) return;

      // Don't drag if clicking buttons
      if (e.target.closest('.tile-actions-bar') || e.target.closest('.tile-volume-btn') || e.target.closest('.live-tag')) {
        return;
      }

      isMouseDown = true;
      hasDragged = false;
      startClientX = e.clientX;
      startClientY = e.clientY;
      startPanX = zoom.panX;
      startPanY = zoom.panY;
      content.classList.add('is-dragging');

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    };

    const onPointerMove = (e) => {
      if (!isMouseDown) return;
      const dx = e.clientX - startClientX;
      const dy = e.clientY - startClientY;

      if (!hasDragged && Math.hypot(dx, dy) > 4) {
        hasDragged = true;
      }

      if (hasDragged) {
        const zoom = getTileZoom(tileKey);
        const cw = content.clientWidth;
        const ch = content.clientHeight;
        const maxPanX = Math.max(0, (cw * zoom.scale - cw) / 2);
        const maxPanY = Math.max(0, (ch * zoom.scale - ch) / 2);

        zoom.panX = Math.max(-maxPanX, Math.min(maxPanX, startPanX + dx));
        zoom.panY = Math.max(-maxPanY, Math.min(maxPanY, startPanY + dy));
        applyTileTransform(tileKey, false);
      }
    };

    const onPointerUp = () => {
      if (isMouseDown) {
        isMouseDown = false;
        content.classList.remove('is-dragging');
        if (hasDragged) {
          state.suppressTileClickUntil = Date.now() + 250;
        }
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
      }
    };

    content.addEventListener('pointerdown', onPointerDown);

    // 3. Double-click:
    // If zoomed > 100%: reset zoom to 100%
    // If zoom === 100%: toggle fullscreen!
    content.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tile-actions-bar') || e.target.closest('.tile-volume-btn')) return;
      e.stopPropagation();
      const zoom = getTileZoom(tileKey);
      if (zoom.scale > 1.05) {
        resetTileZoom(tileKey);
      } else {
        toggleTileFullscreen(tileKey);
      }
    });
  }

  async function toggleTileFullscreen(tileKey) {
    const tile = document.querySelector(`.video-tile[data-tile-key="${CSS.escape(tileKey)}"]`);
    if (!tile) return;

    const isFullscreenCurrently = document.fullscreenElement === tile || tile.classList.contains('is-fullscreen');

    if (isFullscreenCurrently) {
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch (err) {
          console.warn('Exit fullscreen error:', err);
        }
      }
      tile.classList.remove('is-fullscreen', 'fullscreen-idle');
      state.fullscreenTileKey = null;
      updateFullscreenButtons();
    } else {
      // Exit any existing fullscreen first
      if (document.fullscreenElement) {
        try { await document.exitFullscreen(); } catch (e) {}
      }

      state.fullscreenTileKey = tileKey;
      tile.classList.add('is-fullscreen');

      if (tile.requestFullscreen) {
        try {
          await tile.requestFullscreen();
        } catch (err) {
          console.warn('requestFullscreen failed, fallback to CSS fullscreen:', err);
        }
      }

      setupFullscreenInactivity(tile);
      updateFullscreenButtons();
    }
  }

  function updateFullscreenButtons() {
    document.querySelectorAll('.tile-fullscreen-btn').forEach(btn => {
      const tile = btn.closest('.video-tile');
      const tileKey = tile ? tile.dataset.tileKey : null;
      const isFs = state.fullscreenTileKey === tileKey;
      btn.title = isFs ? 'Sair da tela cheia (Esc ou F)' : 'Tela cheia (F)';
      btn.innerHTML = `<i data-lucide="${isFs ? 'minimize' : 'maximize'}"></i>`;
      window.renderIcons(btn);
    });
  }

  let fullscreenInactivityTimer = null;
  function setupFullscreenInactivity(tile) {
    const resetIdle = () => {
      tile.classList.remove('fullscreen-idle');
      clearTimeout(fullscreenInactivityTimer);
      if (state.fullscreenTileKey && (document.fullscreenElement === tile || tile.classList.contains('is-fullscreen'))) {
        fullscreenInactivityTimer = setTimeout(() => {
          tile.classList.add('fullscreen-idle');
        }, 2500);
      }
    };

    tile.removeEventListener('mousemove', tile._resetIdleHandler || (() => {}));
    tile._resetIdleHandler = resetIdle;
    tile.addEventListener('mousemove', resetIdle);
    resetIdle();
  }

  document.addEventListener('fullscreenchange', () => {
    const fsEl = document.fullscreenElement;
    if (!fsEl) {
      if (state.fullscreenTileKey) {
        const prevTile = document.querySelector(`.video-tile[data-tile-key="${CSS.escape(state.fullscreenTileKey)}"]`);
        if (prevTile) prevTile.classList.remove('is-fullscreen', 'fullscreen-idle');
        state.fullscreenTileKey = null;
        updateFullscreenButtons();
      }
    } else {
      const tileKey = fsEl.dataset.tileKey;
      if (tileKey) {
        state.fullscreenTileKey = tileKey;
        fsEl.classList.add('is-fullscreen');
        setupFullscreenInactivity(fsEl);
        updateFullscreenButtons();
      }
    }
  });

  // Render all tiles in the stage grid.
  // Camera and screen share are independent tiles, like a real client: sharing your
  // screen while the webcam is on produces two tiles for the same person.
  function renderAllVideoTiles() {
    el.videoGrid.innerHTML = '';

    const tiles = [];

    // 1. Local user tile (avatar or webcam)
    tiles.push({
      key: 'local',
      node: createLocalUserTile(),
      isVideo: state.user.isCameraOn
    });

    // 2. Local screen share tile
    if (state.user.isScreenSharing) {
      tiles.push({
        key: 'screen-local',
        node: createScreenTile('local', `${state.user.username} (Você)`, state.webrtc.localScreenStream, true),
        isVideo: true
      });
    }

    // 3. Remote user tiles (+ their screen share tiles)
    state.roomMembers.forEach((member, socketId) => {
      tiles.push({
        key: socketId,
        node: createRemoteUserTile(socketId, member, state.webrtc.remoteStreams.get(socketId)),
        audio: { kind: 'voice', socketId },
        isVideo: !!member.isCameraOn
      });

      if (member.isScreenSharing) {
        tiles.push({
          key: `screen-${socketId}`,
          node: createScreenTile(socketId, member.username, state.webrtc.remoteScreenStreams.get(socketId), false),
          audio: { kind: 'stream', socketId },
          isVideo: true
        });
      }
    });

    // A focused tile can vanish (peer left, stopped sharing) — fall back to the grid
    if (state.focusedTileId && !tiles.some(t => t.key === state.focusedTileId)) {
      state.focusedTileId = null;
    }

    // Fullscreen tile could have stopped
    if (state.fullscreenTileKey && !tiles.some(t => t.key === state.fullscreenTileKey)) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      state.fullscreenTileKey = null;
    }

    // Same for the volume popover's target
    if (state.volumePopover && !tiles.some(t => t.audio &&
        t.audio.kind === state.volumePopover.kind && t.audio.socketId === state.volumePopover.socketId)) {
      closeVolumePopover();
    }

    tiles.forEach(({ key, node, audio, isVideo }) => {
      node.dataset.tileKey = key;
      node.addEventListener('click', (e) => {
        if (e.target.closest('.tile-actions-bar') || e.target.closest('.tile-volume-btn') || e.target.closest('.volume-popover')) {
          return;
        }
        if (Date.now() < state.suppressTileClickUntil) {
          return;
        }
        toggleTileFocus(key);
      });

      const content = node.querySelector('.tile-content');
      const videoEl = content ? content.querySelector('video') : null;
      const isActualVideo = !!isVideo;

      // Modern unified action bar (Zoom, Fullscreen, Spotlight)
      const actionsBar = createTileActionsBar(key, isActualVideo);
      content.appendChild(actionsBar);

      // Setup Zoom and Pan on video tiles
      if (isActualVideo && videoEl) {
        setupTileZoomAndPan(node, key, videoEl);
      }

      if (audio) {
        content.appendChild(createVolumeButton(audio.kind, audio.socketId));
        node.addEventListener('contextmenu', (e) => openVolumeAtPointer(audio.kind, audio.socketId, e));
      }

      if (state.fullscreenTileKey === key) {
        node.classList.add('is-fullscreen');
        setupFullscreenInactivity(node);
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
      window.renderIcons(el.videoGrid);
      return;
    }

    tiles.forEach(({ node }) => el.videoGrid.appendChild(node));
    adjustGridColumns();
    window.renderIcons(el.videoGrid);
  }

  // Spotlight a stream: clicking it again returns to the grid
  function toggleTileFocus(key) {
    state.focusedTileId = state.focusedTileId === key ? null : key;
    renderAllVideoTiles();
  }

  // ---- Per-user / per-stream volume ----

  function loadAudioPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem('triscord_audio_prefs'));
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
    localStorage.setItem('triscord_audio_prefs', JSON.stringify(state.audioPrefs));

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

    const icon = silenced ? 'volume-x' : pct < 100 ? 'volume-1' : 'volume-2';
    btn.innerHTML = `<i data-lucide="${icon}"></i>`;
    window.renderIcons(btn);
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

  function renderEffectOptions() {
    const supported = window.CameraEffectsProcessor.isSupported();
    const customImage = localStorage.getItem('triscord_camera_background');

    el.effectCustomImage.classList.toggle('hidden', !customImage);
    el.effectCustomImage.style.backgroundImage = customImage ? `url("${customImage}")` : '';

    el.effectOptions.forEach(btn => {
      let selected;
      if (btn.dataset.preset) {
        selected = state.cameraEffect.type === 'image' && state.cameraEffect.source === btn.dataset.preset;
      } else if (btn.id === 'effectCustomImage') {
        selected = state.cameraEffect.type === 'image' && state.cameraEffect.source === 'custom';
      } else {
        selected = btn.dataset.effect === state.cameraEffect.type;
      }
      btn.classList.toggle('selected', selected);
      if (btn.dataset.effect !== 'none') btn.disabled = !supported;
    });
    el.btnUploadBackground.disabled = !supported;
    el.effectsUnsupported.classList.toggle('hidden', supported);
  }

  // Built-in gradient presets share the effects grid with blur/upload, but are
  // wired up separately from the generic data-effect click handler below
  function initPresetBackgroundButtons() {
    document.querySelectorAll('.effect-option[data-preset]').forEach(btn => {
      const colors = PRESET_BACKGROUNDS[btn.dataset.preset];
      if (colors) btn.style.backgroundImage = `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`;
      btn.addEventListener('click', () => selectPresetBackground(btn.dataset.preset));
    });
  }

  function selectPresetBackground(id) {
    const image = getPresetDataUrl(id);
    if (!image) return;
    localStorage.setItem('triscord_camera_effect', 'image');
    localStorage.setItem('triscord_camera_background_source', id);
    selectCameraEffect({ type: 'image', image, source: id });
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
    localStorage.setItem('triscord_camera_effect', effect.type);
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
      localStorage.setItem('triscord_camera_background', image);
      localStorage.setItem('triscord_camera_background_source', 'custom');
      await selectCameraEffect({ type: 'image', image, source: 'custom' });
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
          <span><i data-lucide="monitor"></i>Tela de ${escapeHtml(label)}</span>
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
          <div class="tile-avatar" style="background-color: ${safeColor(state.user.avatarColor)}">
            ${escapeHtml(state.user.username).charAt(0).toUpperCase()}
          </div>
        </div>
      </div>
      <div class="tile-overlay">
        <div class="tile-username">
          <span>${escapeHtml(state.user.username)} (Você)</span>
          ${state.user.isMuted ? '<span class="status-badge-mini red" title="Mutado"><i data-lucide="mic-off"></i></span>' : ''}
          ${state.user.isDeafened ? '<span class="status-badge-mini red" title="Ensurdecido"><i data-lucide="headphone-off"></i></span>' : ''}
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
          <div class="tile-avatar" style="background-color: ${safeColor(member.avatar)}">
            ${escapeHtml(member.username).charAt(0).toUpperCase()}
          </div>
        </div>
      </div>
      <div class="tile-overlay">
        <div class="tile-username">
          <span>${escapeHtml(member.username)}</span>
          ${member.isMuted ? '<span class="status-badge-mini red" title="Mutado"><i data-lucide="mic-off"></i></span>' : ''}
          ${member.isDeafened ? '<span class="status-badge-mini red" title="Ensurdecido"><i data-lucide="headphone-off"></i></span>' : ''}
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

    const existingQuality = state.connectionQuality.get(socketId);
    if (existingQuality) updateConnectionQualityIndicator(socketId, existingQuality);

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
        <span>${escapeHtml(member.username)}</span>
        ${member.isMuted ? '<span class="status-badge-mini red" title="Mutado"><i data-lucide="mic-off"></i></span>' : ''}
        ${member.isDeafened ? '<span class="status-badge-mini red" title="Ensurdecido"><i data-lucide="headphone-off"></i></span>' : ''}
      `;
      window.renderIcons(usernameSpan);
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

  // ---- Push-to-talk ----
  // In VAD mode the mic track is always live (mute aside) and the amplitude
  // detector above decides when to show "speaking". In PTT mode the track
  // itself is only enabled while the key is held, so the same detector keeps
  // working unmodified — a disabled track just delivers silence to it.
  function applyMicEnabledState() {
    const track = state.webrtc && state.webrtc.localMicStream && state.webrtc.localMicStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !state.user.isMuted && (state.pttMode !== 'ptt' || state.pttActive);
  }

  function pttKeyDown() {
    if (state.pttMode !== 'ptt' || state.pttActive || state.user.isMuted || !state.currentRoomId) return;
    state.pttActive = true;
    applyMicEnabledState();
  }

  function pttKeyUp() {
    if (!state.pttActive) return;
    state.pttActive = false;
    applyMicEnabledState();
  }

  document.addEventListener('keydown', (e) => {
    if (state.pttMode !== 'ptt' || e.repeat || isTypingTarget(e.target)) return;
    if (e.code !== state.pttKey) return;
    e.preventDefault();
    pttKeyDown();
  });

  document.addEventListener('keyup', (e) => {
    if (state.pttMode !== 'ptt' || e.code !== state.pttKey) return;
    pttKeyUp();
  });

  // Releasing the key outside the window (alt-tab while holding it) would
  // otherwise leave the mic stuck open
  window.addEventListener('blur', () => pttKeyUp());

  // Toggle Microphone Mute
  function toggleMute() {
    state.user.isMuted = !state.user.isMuted;
    applyMicEnabledState();

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
    el.btnCamera.classList.toggle('active', state.user.isCameraOn);
    el.btnCamera.querySelector('.btn-label').textContent =
      state.user.isCameraOn ? 'Desligar Câmera' : 'Câmera';
    window.setIcon(el.btnCamera, state.user.isCameraOn ? 'video-off' : 'video');

    // Screen button
    el.btnScreenShare.classList.toggle('active', state.user.isScreenSharing);
    el.btnScreenShare.querySelector('.btn-label').textContent =
      state.user.isScreenSharing ? 'Parar Tela' : 'Compartilhar';
    window.setIcon(el.btnScreenShare, state.user.isScreenSharing ? 'screen-share-off' : 'screen-share');

    // Bottom user panel Mute/Deafen buttons
    el.btnMute.classList.toggle('muted', state.user.isMuted);
    window.setIcon(el.btnMute, state.user.isMuted ? 'mic-off' : 'mic');

    el.btnDeafen.classList.toggle('deafened', state.user.isDeafened);
    window.setIcon(el.btnDeafen, state.user.isDeafened ? 'headphone-off' : 'headphones');
  }

  function updateUserProfileUI() {
    el.userUsername.textContent = state.user.username;
    el.userAvatar.style.backgroundColor = safeColor(state.user.avatarColor);
    el.userAvatar.textContent = state.user.username.charAt(0).toUpperCase();

    if (state.user.isDeafened) {
      el.userStatusTag.textContent = 'Ensurdecido';
    } else if (state.user.isMuted) {
      el.userStatusTag.textContent = 'Mutado';
    } else {
      el.userStatusTag.textContent = 'Online';
    }

    el.userCustomStatus.textContent = state.user.status || '';
    el.userCustomStatus.classList.toggle('hidden', !state.user.status);
  }

  // Chat Functions
  const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

  function renderReactionsBar(msg) {
    const reactions = msg.reactions || {};
    const mine = state.user.userId;
    const pills = Object.keys(reactions)
      .filter(emoji => reactions[emoji] && reactions[emoji].length)
      .map(emoji => `
        <button type="button" class="reaction-pill ${reactions[emoji].includes(mine) ? 'mine' : ''}" data-emoji="${emoji}">
          <span>${emoji}</span><span class="reaction-count">${reactions[emoji].length}</span>
        </button>
      `).join('');

    const picker = ALLOWED_REACTIONS.map(emoji => `
      <button type="button" class="reaction-picker-option" data-emoji="${emoji}">${emoji}</button>
    `).join('');

    return `
      <div class="msg-reactions">
        ${pills}
        <div class="reaction-add-wrap">
          <button type="button" class="reaction-add-btn" title="Reagir"><i data-lucide="smile-plus"></i></button>
          <div class="reaction-picker hidden">${picker}</div>
        </div>
      </div>
    `;
  }

  function addChatMessage(msg) {
    const isSelf = msg.senderSocketId === state.socket?.id;
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const msgEl = document.createElement('div');
    msgEl.className = `chat-message-item ${msg.isSystem ? 'system-msg' : ''}`;
    if (msg.id) {
      msgEl.dataset.messageId = msg.id;
      state.chatMessagesById.set(msg.id, msg);
    }

    if (msg.isSystem) {
      msgEl.innerHTML = `
        <div class="system-msg-content">${msg.text}</div>
        <span class="msg-timestamp">${time}</span>
      `;
    } else {
      const attachmentHtml = msg.attachment && msg.attachment.dataUrl
        ? `<img class="msg-attachment-img" src="${msg.attachment.dataUrl}" alt="${escapeHtml(msg.attachment.name || 'imagem')}" />`
        : '';

      msgEl.innerHTML = `
        <div class="msg-avatar" style="background-color: ${safeColor(msg.senderAvatar)}">
          ${escapeHtml(msg.senderName || '?').charAt(0).toUpperCase()}
        </div>
        <div class="msg-body">
          <div class="msg-header">
            <span class="msg-sender ${isSelf ? 'self' : ''}">${escapeHtml(msg.senderName)}</span>
            <span class="msg-timestamp">${time}</span>
          </div>
          ${msg.text ? `<div class="msg-text">${escapeHtml(msg.text)}</div>` : ''}
          ${attachmentHtml}
          ${msg.id ? renderReactionsBar(msg) : ''}
        </div>
      `;

      const img = msgEl.querySelector('.msg-attachment-img');
      if (img) img.addEventListener('click', () => window.open(img.src, '_blank'));
    }

    el.chatMessages.appendChild(msgEl);
    window.renderIcons(msgEl);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  function updateMessageReactionsUI(messageId, reactions) {
    const msg = state.chatMessagesById.get(messageId);
    if (!msg) return;
    msg.reactions = reactions;

    const msgEl = el.chatMessages.querySelector(`.chat-message-item[data-message-id="${CSS.escape(messageId)}"]`);
    if (!msgEl) return;
    const oldBar = msgEl.querySelector('.msg-reactions');
    if (!oldBar) return;
    oldBar.outerHTML = renderReactionsBar(msg);
    window.renderIcons(msgEl);
  }

  // Delegated so it keeps working across every message the chat ever renders
  el.chatMessages.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.reaction-add-btn');
    if (addBtn) {
      const picker = addBtn.parentElement.querySelector('.reaction-picker');
      document.querySelectorAll('.reaction-picker').forEach(p => { if (p !== picker) p.classList.add('hidden'); });
      picker.classList.toggle('hidden');
      return;
    }

    const pickerOption = e.target.closest('.reaction-picker-option');
    if (pickerOption) {
      const messageId = pickerOption.closest('.chat-message-item').dataset.messageId;
      pickerOption.closest('.reaction-picker').classList.add('hidden');
      if (messageId && state.socket) state.socket.emit('add-reaction', { messageId, emoji: pickerOption.dataset.emoji });
      return;
    }

    const pill = e.target.closest('.reaction-pill');
    if (pill) {
      const messageId = pill.closest('.chat-message-item').dataset.messageId;
      if (messageId && state.socket) state.socket.emit('add-reaction', { messageId, emoji: pill.dataset.emoji });
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('.reaction-add-wrap')) return;
    document.querySelectorAll('.reaction-picker').forEach(p => p.classList.add('hidden'));
  });

  function clearChat() {
    el.chatMessages.innerHTML = '';
    state.chatMessagesById.clear();
  }

  const ATTACHMENT_MAX_DIMENSION = 1600;

  async function fileToAttachment(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, ATTACHMENT_MAX_DIMENSION / bitmap.width, ATTACHMENT_MAX_DIMENSION / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return { type: 'image', dataUrl: canvas.toDataURL('image/jpeg', 0.8), name: file.name };
  }

  function setPendingAttachment(attachment) {
    state.pendingAttachment = attachment;
    el.chatAttachmentPreview.classList.toggle('hidden', !attachment);
    el.chatAttachmentThumb.src = attachment ? attachment.dataUrl : '';
  }

  function sendChatMessage() {
    const text = el.chatInput.value.trim();
    if ((!text && !state.pendingAttachment) || !state.currentRoomId || !state.socket) return;

    state.socket.emit('send-chat-message', {
      message: text,
      roomId: state.currentRoomId,
      attachment: state.pendingAttachment
    });

    el.chatInput.value = '';
    setPendingAttachment(null);
  }

  // Initialize Settings UI & Audio Device Enumeration
  async function initSettingsUI() {
    el.inputSettingsUsername.value = state.user.username;
    el.inputSettingsStatus.value = state.user.status;
    el.inputSettingsServerUrl.value = state.serverUrl;
    el.noiseSuppression.checked = state.noiseSuppression;
    el.sliderSensitivity.value = state.micSensitivity;
    el.labelSensitivity.textContent = `${state.micSensitivity}%`;

    el.sliderSensitivity.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.micSensitivity = val;
      el.labelSensitivity.textContent = `${val}%`;
      localStorage.setItem('triscord_mic_sens', val);
      if (state.localSpeakingDetector) {
        state.localSpeakingDetector.setThreshold(val);
      }
    });

    // Appearance
    el.settingsLightTheme.checked = state.theme === 'light';

    // Push-to-talk
    el.settingsModeVAD.checked = state.pttMode !== 'ptt';
    el.settingsModePTT.checked = state.pttMode === 'ptt';
    el.pttKeyRow.style.display = state.pttMode === 'ptt' ? 'flex' : 'none';
    el.btnCapturePttKey.textContent = describeKeyCode(state.pttKey);

    [el.settingsModeVAD, el.settingsModePTT].forEach(radio => {
      radio.addEventListener('change', () => {
        el.pttKeyRow.style.display = el.settingsModePTT.checked ? 'flex' : 'none';
      });
    });

    el.btnCapturePttKey.addEventListener('click', () => {
      el.btnCapturePttKey.textContent = 'Pressione uma tecla...';
      const capture = (e) => {
        e.preventDefault();
        document.removeEventListener('keydown', capture, true);
        state.pttKey = e.code;
        localStorage.setItem('triscord_ptt_key', e.code);
        el.btnCapturePttKey.textContent = describeKeyCode(e.code);
      };
      document.addEventListener('keydown', capture, true);
    });

    // TURN server
    el.settingsTurnUrl.value = state.turnServer.url;
    el.settingsTurnUsername.value = state.turnServer.username;
    el.settingsTurnCredential.value = state.turnServer.credential;

    // Global mute shortcut (Electron only)
    if (window.electronAPI && window.electronAPI.isElectron) {
      el.globalShortcutSection.classList.remove('hidden');
      el.settingsGlobalShortcut.value = localStorage.getItem('triscord_global_shortcut') || 'CommandOrControl+Shift+M';
    }

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
    if (btn.dataset.preset) return; // wired separately by initPresetBackgroundButtons()
    btn.addEventListener('click', () => {
      const type = btn.dataset.effect;
      if (type === 'image') {
        const image = localStorage.getItem('triscord_camera_background');
        if (image) selectCameraEffect({ type, image, source: 'custom' });
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

  function getActiveStreamTileKey() {
    if (state.fullscreenTileKey) return state.fullscreenTileKey;
    const hoveredTile = document.querySelector('.video-tile:hover');
    if (hoveredTile && hoveredTile.dataset.tileKey) return hoveredTile.dataset.tileKey;
    if (state.focusedTileId) return state.focusedTileId;
    const screenTile = document.querySelector('.video-tile.screen-tile');
    if (screenTile && screenTile.dataset.tileKey) return screenTile.dataset.tileKey;
    return null;
  }

  // Keyboard shortcuts: Esc, F (fullscreen), +, -, 0 (zoom)
  document.addEventListener('keydown', (e) => {
    const isTyping = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) ||
      document.activeElement?.isContentEditable;

    if (e.key === 'Escape') {
      if (state.fullscreenTileKey || document.fullscreenElement) {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        }
        if (state.fullscreenTileKey) {
          const fsTile = document.querySelector(`.video-tile[data-tile-key="${CSS.escape(state.fullscreenTileKey)}"]`);
          if (fsTile) fsTile.classList.remove('is-fullscreen', 'fullscreen-idle');
          state.fullscreenTileKey = null;
          updateFullscreenButtons();
        }
      } else if (!el.effectsModal.classList.contains('hidden')) {
        closeEffectsModal();
      } else if (state.volumePopover) {
        closeVolumePopover();
      } else if (state.focusedTileId) {
        state.focusedTileId = null;
        renderAllVideoTiles();
      }
      return;
    }

    if (isTyping) return;

    // F key: Toggle Fullscreen on active stream
    if (e.key === 'f' || e.key === 'F') {
      const targetKey = getActiveStreamTileKey();
      if (targetKey) {
        e.preventDefault();
        toggleTileFullscreen(targetKey);
      }
      return;
    }

    // Zoom shortcuts
    if (e.key === '+' || e.key === '=') {
      const targetKey = getActiveStreamTileKey();
      if (targetKey) {
        e.preventDefault();
        zoomTileByStep(targetKey, 0.25);
      }
      return;
    }

    if (e.key === '-' || e.key === '_') {
      const targetKey = getActiveStreamTileKey();
      if (targetKey) {
        e.preventDefault();
        zoomTileByStep(targetKey, -0.25);
      }
      return;
    }

    if (e.key === '0') {
      const targetKey = getActiveStreamTileKey();
      if (targetKey) {
        e.preventDefault();
        resetTileZoom(targetKey);
      }
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
    if (e.key !== 'triscord_audio_prefs') return;
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
    const previousTurn = { ...state.turnServer };

    if (newUsername) {
      state.user.username = newUsername;
      localStorage.setItem('triscord_username', newUsername);
    }

    state.user.status = el.inputSettingsStatus.value.trim().slice(0, 64);
    localStorage.setItem('triscord_status', state.user.status);

    state.selectedAudioInput = el.selectAudioInput.value;
    state.selectedAudioOutput = el.selectAudioOutput.value;
    state.selectedVideoInput = el.selectVideoInput.value;
    state.noiseSuppression = el.noiseSuppression.checked;

    localStorage.setItem('triscord_mic_device', state.selectedAudioInput);
    localStorage.setItem('triscord_spk_device', state.selectedAudioOutput);
    localStorage.setItem('triscord_cam_device', state.selectedVideoInput);
    localStorage.setItem('triscord_noise_suppression', state.noiseSuppression);
    localStorage.setItem('triscord_avatar_color', state.user.avatarColor);

    // Appearance
    state.theme = el.settingsLightTheme.checked ? 'light' : 'dark';
    localStorage.setItem('triscord_theme', state.theme);
    applyTheme(state.theme);

    // Push-to-talk
    state.pttMode = el.settingsModePTT.checked ? 'ptt' : 'vad';
    localStorage.setItem('triscord_voice_mode', state.pttMode);
    state.pttActive = false;
    applyMicEnabledState();

    // TURN server
    state.turnServer = {
      url: el.settingsTurnUrl.value.trim(),
      username: el.settingsTurnUsername.value.trim(),
      credential: el.settingsTurnCredential.value.trim()
    };
    localStorage.setItem('triscord_turn_url', state.turnServer.url);
    localStorage.setItem('triscord_turn_username', state.turnServer.username);
    localStorage.setItem('triscord_turn_credential', state.turnServer.credential);
    const turnChanged = JSON.stringify(previousTurn) !== JSON.stringify(state.turnServer);
    if (turnChanged) {
      showToast('Servidor TURN atualizado — será usado na próxima conexão.');
    }

    // Global mute shortcut (Electron only)
    if (window.electronAPI && window.electronAPI.isElectron && window.electronAPI.setGlobalMuteShortcut) {
      const accelerator = el.settingsGlobalShortcut.value.trim() || 'CommandOrControl+Shift+M';
      localStorage.setItem('triscord_global_shortcut', accelerator);
      const result = await window.electronAPI.setGlobalMuteShortcut(accelerator);
      if (result && !result.ok) {
        showToast('Não foi possível registrar esse atalho global.', 'error');
      }
    }

    updateUserProfileUI();

    if (newServerUrl && newServerUrl !== state.serverUrl) {
      state.serverUrl = newServerUrl;
      localStorage.setItem('triscord_server_url', newServerUrl);
      connectToServer();
    } else if (state.socket && state.currentRoomId) {
      state.socket.emit('user-state-change', {
        username: state.user.username,
        avatar: state.user.avatarColor,
        status: state.user.status
      });

      if (previousNoiseSuppression !== state.noiseSuppression && state.webrtc.localMicStream) {
        try {
          const micStream = await state.webrtc.startMicrophone(
            state.selectedAudioInput,
            state.noiseSuppression
          );
          setupLocalSpeakingDetector(micStream);
          applyMicEnabledState();
        } catch (err) {
          console.warn('Could not restart microphone after changing noise suppression:', err);
        }
      }
    }

    el.settingsModal.classList.add('hidden');
  });

  // ---- Global mute shortcut (main process -> renderer) ----
  if (window.electronAPI && window.electronAPI.onGlobalMuteToggle) {
    window.electronAPI.onGlobalMuteToggle(() => toggleMute());
    const savedAccelerator = localStorage.getItem('triscord_global_shortcut');
    if (savedAccelerator && window.electronAPI.setGlobalMuteShortcut) {
      window.electronAPI.setGlobalMuteShortcut(savedAccelerator).catch(() => {});
    }
  }

  // ---- Auto-update ----
  if (window.electronAPI && window.electronAPI.onUpdateDownloaded) {
    window.electronAPI.onUpdateDownloaded(() => {
      const toast = document.createElement('div');
      toast.className = 'app-toast info visible';
      toast.innerHTML = `Uma atualização foi baixada. <button type="button" id="btnRestartUpdate" style="margin-left:8px; text-decoration:underline; background:none; border:none; color:inherit; cursor:pointer;">Reiniciar agora</button>`;
      el.toastContainer.appendChild(toast);
      toast.querySelector('#btnRestartUpdate').addEventListener('click', () => window.electronAPI.restartToUpdate());
    });
  }

  // ---- Call recording (composited grid video + mixed audio -> .webm) ----

  function isRecordingSupported() {
    return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  function startRecording() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    const dest = audioCtx.createMediaStreamDestination();
    const connectedTrackIds = new Set();

    function connectAudioSources() {
      const trackSources = [];
      document.querySelectorAll('#videoGrid audio, #videoGrid video').forEach(mediaEl => {
        if (mediaEl.srcObject) trackSources.push(...mediaEl.srcObject.getAudioTracks());
      });
      if (state.webrtc.localMicStream) trackSources.push(...state.webrtc.localMicStream.getAudioTracks());

      trackSources.forEach(track => {
        if (connectedTrackIds.has(track.id)) return;
        connectedTrackIds.add(track.id);
        try {
          audioCtx.createMediaStreamSource(new MediaStream([track])).connect(dest);
        } catch (err) { /* a track can briefly be in a bad state right after (re)negotiation */ }
      });
    }
    connectAudioSources();
    const rescanTimer = setInterval(connectAudioSources, 2000);

    let drawing = true;
    function drawFrame() {
      if (!drawing) return;
      const videos = Array.from(document.querySelectorAll('#videoGrid video'))
        .filter(v => v.srcObject && !v.classList.contains('hidden'));

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const n = videos.length || 1;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const cellW = canvas.width / cols;
      const cellH = canvas.height / rows;

      videos.forEach((v, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        try {
          const vw = v.videoWidth || 16;
          const vh = v.videoHeight || 9;
          const scale = Math.min(cellW / vw, cellH / vh);
          const dw = vw * scale;
          const dh = vh * scale;
          ctx.drawImage(v, col * cellW + (cellW - dw) / 2, row * cellH + (cellH - dh) / 2, dw, dh);
        } catch (err) { /* a track that just ended can throw mid-draw */ }
      });

      requestAnimationFrame(drawFrame);
    }
    drawFrame();

    const canvasStream = canvas.captureStream(30);
    const combined = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);

    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';
    const recorder = new MediaRecorder(combined, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      drawing = false;
      clearInterval(rescanTimer);
      audioCtx.close().catch(() => {});

      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Triscord-Gravacao-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast('Gravação salva no seu computador.');
    };

    recorder.start(1000);
    state.recording = { recorder, stop: () => { drawing = false; } };
    el.btnToggleRecording.classList.add('recording');
    showToast('Gravação iniciada.');
  }

  function stopRecording() {
    if (!state.recording) return;
    state.recording.stop();
    state.recording.recorder.stop();
    state.recording = null;
    el.btnToggleRecording.classList.remove('recording');
  }

  el.btnToggleRecording.addEventListener('click', () => {
    if (!state.currentRoomId) {
      alert('Entre em um canal de voz para gravar a chamada.');
      return;
    }
    if (state.recording) {
      stopRecording();
      return;
    }
    if (!isRecordingSupported()) {
      alert('A gravação não é suportada neste navegador/versão.');
      return;
    }
    startRecording();
  });

  // ---- Chat image attachments ----

  el.btnAttachImage.addEventListener('click', () => el.chatAttachmentInput.click());
  el.chatAttachmentInput.addEventListener('change', async () => {
    const file = el.chatAttachmentInput.files[0];
    el.chatAttachmentInput.value = '';
    if (!file) return;
    try {
      setPendingAttachment(await fileToAttachment(file));
    } catch (err) {
      showToast('Não foi possível usar essa imagem.', 'error');
    }
  });
  el.btnRemoveAttachment.addEventListener('click', () => setPendingAttachment(null));
});
