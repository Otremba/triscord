/**
 * Screen Share Modal & Desktop Capturer Handler
 */

class ScreenSharePicker {
  constructor(options = {}) {
    this.modalEl = document.getElementById('screenShareModal');
    this.tabsEl = document.getElementById('screenShareTabs');
    this.gridEl = document.getElementById('screenSourcesGrid');
    this.audioCheckbox = document.getElementById('screenAudioCheckbox');
    this.btnCancel = document.getElementById('screenShareCancel');
    this.btnConfirm = document.getElementById('screenShareConfirm');

    this.activeTab = 'screens'; // 'screens' or 'windows'
    this.selectedSourceId = null;
    this.sources = [];
    this.resolvePromise = null;
    this.systemAudio = null;

    this.initEvents();
  }

  initEvents() {
    if (!this.modalEl) return;


    // Tab buttons
    document.querySelectorAll('.screen-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.screen-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeTab = btn.dataset.tab;
        this.renderSources();
      });
    });

    this.btnCancel.addEventListener('click', () => {
      this.closeModal(null);
    });

    this.btnConfirm.addEventListener('click', async () => {
      if (!this.selectedSourceId) return;
      const stream = await this.startCapture();
      this.closeModal(stream);
    });

    // Close on overlay click
    this.modalEl.addEventListener('click', (e) => {
      if (e.target === this.modalEl) {
        this.closeModal(null);
      }
    });
  }

  async open() {
    this.modalEl.classList.remove('hidden');
    this.selectedSourceId = null;
    this.btnConfirm.disabled = true;
    this.gridEl.innerHTML = '<div class="loading-sources"><div class="spinner"></div><p>Buscando telas e janelas...</p></div>';

    const opened = new Promise((resolve) => { this.resolvePromise = resolve; });

    // Check if Electron desktopCapturer is available
    if (window.electronAPI && window.electronAPI.getScreenSources) {
      try {
        this.sources = await window.electronAPI.getScreenSources();
        this.renderSources();
      } catch (err) {
        console.error('Failed to get Electron screen sources:', err);
        this.fallbackBrowserPicker();
      }
    } else {
      // Fallback for browser testing
      this.fallbackBrowserPicker();
    }

    return opened;
  }

  async fallbackBrowserPicker() {
    // The browser shows its own picker: hide ours, but resolve only once that
    // one returns (closeModal(null) here used to report a cancel right away)
    this.modalEl.classList.add('hidden');
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: true
      });
    } catch (err) {
      console.warn('Browser getDisplayMedia cancelled or error:', err);
    }
    this.closeModal(stream);
  }

  renderSources() {
    const isScreensTab = this.activeTab === 'screens';
    const filtered = this.sources.filter(s => isScreensTab ? s.isScreen : !s.isScreen);

    if (filtered.length === 0) {
      this.gridEl.innerHTML = `
        <div class="empty-sources">
          <p>Nenhuma ${isScreensTab ? 'tela' : 'janela'} encontrada.</p>
        </div>
      `;
      return;
    }

    const escapeHtml = (s) => {
      const div = document.createElement('div');
      div.innerText = s == null ? '' : String(s);
      return div.innerHTML;
    };

    // Capturing a game's window can deliver only a frame or two per second
    // (seen on a laptop with two GPUs), where the whole screen ran at 58 fps
    const windowsHint = isScreensTab ? '' : `
      <div class="sources-hint">
        <i data-lucide="gamepad-2"></i>
        <span>Vai transmitir um jogo? Prefira a <strong>tela inteira</strong>: em alguns PCs a janela do jogo é capturada a poucos quadros por segundo.</span>
      </div>`;

    this.gridEl.innerHTML = windowsHint + filtered.map(source => `
      <div class="source-card ${this.selectedSourceId === source.id ? 'selected' : ''}" data-id="${source.id}">
        <div class="source-thumb-container">
          <img src="${source.thumbnail}" class="source-thumbnail" alt="${escapeHtml(source.name)}" />
          ${source.appIcon ? `<img src="${source.appIcon}" class="source-app-icon" />` : ''}
        </div>
        <div class="source-info">
          <span class="source-name" title="${escapeHtml(source.name)}">${escapeHtml(source.name)}</span>
        </div>
      </div>
    `).join('');
    if (windowsHint && window.renderIcons) window.renderIcons(this.gridEl);

    // Attach click listeners
    this.gridEl.querySelectorAll('.source-card').forEach(card => {
      card.addEventListener('click', () => {
        this.gridEl.querySelectorAll('.source-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedSourceId = card.dataset.id;
        this.btnConfirm.disabled = false;
      });

      // Double-click to instantly share
      card.addEventListener('dblclick', async () => {
        this.selectedSourceId = card.dataset.id;
        const stream = await this.startCapture();
        this.closeModal(stream);
      });
    });
  }

  async startCapture() {
    if (!this.selectedSourceId) return null;

    // One setting for everyone: capture up to 1080p60 and let the encoder
    // adapt to each viewer (see SCREEN_ENCODING in webrtc.js)
    const width = 1920;
    const height = 1080;
    const frameRate = 60;

    try {
      // Chromium's desktop audio is a plain loopback of everything, including
      // the call's voices; system audio comes from attachSystemAudio instead.
      const constraints = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: this.selectedSourceId,
            maxWidth: width,
            maxHeight: height,
            maxFrameRate: frameRate
          }
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      if (this.audioCheckbox && this.audioCheckbox.checked) {
        await this.attachSystemAudio(stream);
      }

      return stream;
    } catch (err) {
      console.error('Error starting screen capture with constraints:', err);
      alert('Não foi possível iniciar o compartilhamento de tela: ' + err.message);
      return null;
    }
  }

  async attachSystemAudio(stream) {
    this.releaseSystemAudio();

    if (!window.SystemAudioCapture || !window.SystemAudioCapture.isSupported()) return;

    try {
      this.systemAudio = await window.SystemAudioCapture.start();
      stream.addTrack(this.systemAudio.stream.getAudioTracks()[0]);
    } catch (err) {
      console.warn('System audio capture unavailable:', err.reason, err);
      // Never fall back to the full loopback: it would echo the call's voices
      alert(ScreenSharePicker.systemAudioErrorMessage(err) + ' A tela será compartilhada sem áudio.');
    }
  }

  static systemAudioErrorMessage(err) {
    switch (err.reason) {
      case 'windows-too-old':
        return 'Compartilhar o áudio do PC sem as vozes da chamada requer o Windows 11 ' +
          `(ou Windows 10 build 20348+). Este PC está no build ${err.build || 'desconhecido'}.`;
      case 'helper-missing':
        return 'O componente de captura de áudio não veio nesta instalação do Triscord. ' +
          'Reinstale a versão mais recente.';
      case 'unsupported-platform':
        return 'Compartilhar o áudio do PC só funciona no Triscord para Windows.';
      default:
        return `Não foi possível capturar o áudio do PC (${err.message}).`;
    }
  }

  releaseSystemAudio() {
    if (this.systemAudio) {
      this.systemAudio.stop();
      this.systemAudio = null;
    }
  }

  closeModal(resultStream) {
    this.modalEl.classList.add('hidden');
    if (this.resolvePromise) {
      this.resolvePromise(resultStream);
      this.resolvePromise = null;
    }
  }
}

window.ScreenSharePicker = ScreenSharePicker;
