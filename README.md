# Triscord 🎙️📹🖥️

O **Triscord** é um aplicativo desktop de voz, vídeo e compartilhamento de tela construído com **Electron**, **WebRTC** e **Node.js** com suporte a chat de voz em tempo real, compartilhamento de tela com 60 FPS, webcam, indicador de fala e chat de texto integrado.

---

## ✨ Funcionalidades

- **🎙️ Canais de Voz Multi-usuário**: Salas dedicadas (#Geral, #Jogos, #Cinema, #Música, etc.) ou criação de canais personalizados.
- **🟢 Indicador de Fala em Tempo Real**: Anel verde luminoso ao redor do avatar usando Web Audio API (`AnalyserNode`) quando você ou seus amigos falam.
- **🖥️ Compartilhamento de Tela & Janelas**: Seletor visual moderno com miniaturas de todas as janelas abertas e telas completas via Electron `desktopCapturer` com opções de 720p/1080p a 30fps/60fps e áudio do sistema.
- **📹 Câmera (Webcam)**: Ativação/desativação instantânea com grid dinâmico e responsivo.
- **🔕 Controles de Áudio**: Mutar microfone, ensurdecer (*Deafen*), cancelamento de eco e supressão de ruído nativos.
- **🔊 Efeitos Sonoros**: Sons sintetizados para entrada/saída de canal, mute e mensagens.
- **💬 Chat de Texto**: Envio de mensagens em tempo real no canal ativo.
- **🌐 Suporte a Amigos no Navegador**: Se algum amigo não puder abrir o Electron na hora, ele pode simplesmente acessar `http://SEU-IP:3000` no Chrome ou Edge e conversar normalmente!

---

## 🚀 Como Iniciar

No terminal, dentro da pasta do projeto:

### Iniciar Servidor e App Desktop juntos:
```bash
npm start
```

### Ou iniciar separadamente:
```bash
# Iniciar o servidor de sinalização:
npm run server

# Iniciar o cliente Electron:
npm run electron
```

---

## 👥 Como Conversar com seus Amigos

### 1. Na Mesma Rede Wi-Fi / Casa
1. Descubra o seu IP local (abra o Prompt de Comando e digite `ipconfig`, ex: `192.168.1.50`).
2. Seus amigos abrem o app ou navegador e, na tela de **Configurações ⚙️**, colocam:
   `http://192.168.1.50:3000`
3. Pronto! Todos entram na mesma sala e conversam.

### 2. Pela Internet (Amigos em outras cidades/casas)
Você pode usar qualquer uma dessas opções gratuitas:
- **Ngrok / Cloudflare Tunnel**:
  ```bash
  npx ngrok http 3000
  ```
  Copie o link gerado (ex: `https://abcd-123.ngrok-free.app`) e coloque nas Configurações do app.
- **Radmin VPN / Tailscale / Hamachi**: Crie uma rede virtual de jogos com seus amigos e use seu IP virtual (ex: `http://26.x.x.x:3000`).
- **Deploy na Nuvem**: Faça o deploy do `server/server.js` gratuitamente no Render, Railway ou VPS.

---

## 🛠️ Tecnologias Utilizadas

- **Desktop Framework**: Electron
- **Mídia em Tempo Real**: WebRTC (`RTCPeerConnection`, `getUserMedia`, `desktopCapturer`)
- **Backend & Sinalização**: Node.js, Express, Socket.io
- **Áudio & Processamento**: Web Audio API
- **Design & UI**: HTML5, Vanilla CSS com tema escuro Glassmorphism
