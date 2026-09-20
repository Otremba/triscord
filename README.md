# Triscord 🎙️📹🖥️

O **Triscord** é um aplicativo desktop de voz, vídeo e compartilhamento de tela construído com **Electron**, **WebRTC** e **Node.js** com suporte a chat de voz em tempo real, compartilhamento de tela com 60 FPS, webcam, indicador de fala e chat de texto integrado.

---

## ✨ Funcionalidades

- **🎙️ Canais de Voz Multi-usuário**: Salas dedicadas (#Geral, #Jogos, #Cinema, #Música, etc.) ou criação de canais personalizados.
- **🟢 Indicador de Fala em Tempo Real**: Anel verde luminoso ao redor do avatar usando Web Audio API (`AnalyserNode`) quando você ou seus amigos falam.
- **🎚️ Push-to-Talk**: alterne entre detecção automática de voz e "falar para transmitir" com uma tecla configurável (Configurações > Modo de Transmissão de Voz).
- **🖥️ Compartilhamento de Tela & Janelas**: Seletor visual moderno com miniaturas de todas as janelas abertas e telas completas via Electron `desktopCapturer` com opções de 720p/1080p a 30fps/60fps e áudio do sistema. Câmera e tela podem ficar ativas ao mesmo tempo (modo streamer).
- **📹 Câmera (Webcam)**: Ativação/desativação instantânea com grid dinâmico e responsivo, além de efeitos de fundo (desfoque ou imagem, incluindo fundos prontos).
- **🔕 Controles de Áudio**: Mutar microfone, ensurdecer (*Deafen*), cancelamento de eco e supressão de ruído nativos.
- **📶 Indicador de Qualidade de Conexão**: um ponto colorido por pessoa mostra ping/perda de pacotes em tempo real.
- **🌐 Servidor TURN configurável**: além de um relay público de teste incluso por padrão, é possível apontar para seu próprio TURN em Configurações > Servidor para maior confiabilidade atrás de NAT/firewalls restritos.
- **🔊 Efeitos Sonoros**: Sons sintetizados para entrada/saída de canal, mute e mensagens.
- **💬 Chat de Texto**: Mensagens em tempo real com histórico por sala, reações em emoji e envio de imagens.
- **🔴 Gravação de Chamada**: grava vídeo (grid composto) + áudio de todos os participantes em um `.webm` salvo localmente.
- **👑 Dono de Sala**: quem cria uma sala personalizada pode trancá-la, limitar o número de usuários, expulsar ou silenciar à força outros membros.
- **🔔 Notificações & Status**: notificações do sistema quando alguém entra na sala ou menciona seu nome (com o app em segundo plano), além de status personalizado no perfil.
- **🎨 Tema Claro/Escuro** e **atalho global para mutar** (funciona com o app minimizado, no Electron).
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

- **Desktop Framework**: Electron (+ `electron-updater` para atualizações automáticas via GitHub Releases)
- **Mídia em Tempo Real**: WebRTC (`RTCPeerConnection`, `getUserMedia`, `desktopCapturer`), STUN + TURN configurável
- **Backend & Sinalização**: Node.js, Express, Socket.io
- **Áudio & Processamento**: Web Audio API
- **Design & UI**: HTML5, Vanilla CSS com tema escuro/claro
- **Qualidade**: Jest (testes do servidor) + ESLint

---

## 🧪 Desenvolvimento

```bash
npm test    # roda os testes do servidor (server/*.test.js)
npm run lint  # ESLint em server/ e src/
```

O servidor (`server/server.js`) valida e sanitiza tudo que chega dos clientes (nome de usuário, cor do avatar, mensagens, anexos e mudanças de estado) — veja `server/sanitize.js`. Nunca confie apenas na validação do lado do cliente: qualquer pessoa pode falar diretamente com o Socket.io.
