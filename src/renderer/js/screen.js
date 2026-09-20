/**
 * Screen Share Modal & Desktop Capturer Handler
 */

class ScreenSharePicker {
  constructor(options = {}) {
    this.modalEl = document.getElementById('screenShareModal');
    this.tabsEl = document.getElementById('screenShareTabs');
    this.gridEl = document.getElementById('screenSourcesGrid');
    this.qualitySelect = document.getElementById('screenQualitySelect');
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
    this.closeModal(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: true
      });
      if (this.resolvePromise) {
        this.resolvePromise(stream);
      }
    } catch (err) {
      console.warn('Browser getDisplayMedia cancelled or error:', err);
      if (this.resolvePromise) {
        this.resolvePromise(null);
      }
    }
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

    this.gridEl.innerHTML = filtered.map(source => `
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

    const quality = this.qualitySelect.value; // '720p30', '1080p30', '1080p60'
    let width = 1920;
    let height = 1080;
    let frameRate = 30;

    if (quality === '720p30') {
      width = 1280;
      height = 720;
      frameRate = 30;
    } else if (quality === '1080p60') {
      width = 1920;
      height = 1080;
      frameRate = 60;
    }

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
      console.warn('System audio capture unavailable:', err);
      // Never fall back to the full loopback: it would echo the call's voices
      alert('Não foi possível capturar o áudio do PC sem as vozes da chamada ' +
        '(requer Windows 11 ou Windows 10 atualizado). A tela será compartilhada sem áudio.');
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
