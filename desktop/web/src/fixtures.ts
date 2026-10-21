import type { Session } from './protocol';

// Deterministic sessions for development and the Playwright tests (no core, no network).
// "reference" mirrors the state of the Discord capture used by tests/frame.spec.ts (theme-dark,
// out/reference/discord-nav-client.png) so regions can be compared pixel by pixel.
export function fixtureSession(name: string): Session {
  const base: Session = {
    connection: 'connected',
    account: { id: '1', displayName: 'camargo', username: 'camargo', status: 'invisible' },
    settings: {
      inputDevices: [{ id: '01', name: 'Microfone (USB Audio)' }], outputDevices: [{ id: '02', name: 'Alto-falantes (Realtek)' }],
      cameraDevices: [{ id: '03', name: 'HD Webcam' }], inputDevice: '', outputDevice: '', cameraDevice: '',
      inputVolume: 100, outputVolume: 100, noiseSuppression: true, noiseSuppressionMode: 'high', noiseSuppressionHighAvailable: true, desktopNotifications: true, taskbarAlert: true, closeToTray: true, startMinimized: false, openAtLogin: false, loginSupported: true, soundboardVolume: 70, theme: 'dark', shareMode: 'game', shareHd: false, shareAudio: false,
    },
    servers: [
      { id: '', name: 'Triscord', owned: false },
      { id: 'srv1', name: 'gogó de ferro', owned: true },
    ],
    selectedServerId: 'srv1',
    categories: [{ id: 'voice', name: 'Canais de Voz', channels: [{ id: 'geral', name: 'Geral', kind: 'voice', users: [] }] }],
    selectedChannelId: 'geral',
    muted: false,
    deafened: false,
    profile: { display_name:'camargo',pronouns:null,bio:'Conversas e jogos com os amigos.',note:null,banner_color:null,profile_theme_start:null,profile_theme_end:null,
      avatarDataUrl:'',bannerDataUrl:'',hasAvatar:false,hasBanner:false,created_at:Date.UTC(2026,9,1) },
  };
  // In the capture the voice channel is not selected (the open channel is a text channel triscord lacks).
  if (name === 'reference') return { ...base, selectedChannelId: undefined };
  if (name === 'home') return { ...base, selectedServerId:'@me', categories:[] };
  if (name === 'empty') return { ...base, servers:[], selectedServerId:'@me', categories:[] };
  if (name === 'voice-error' || name === 'reconnecting') return { ...fixtureSession('call'), voiceRequested:true, voiceState:name==='voice-error'?'error':'reconnecting' };
  if (name === 'profile-error') return { ...base, profile:undefined };
  if (name === 'login') return { ...base, auth: { state: 'signedOut' } };
  // In a call with one other participant (UI development and tests of the call view).
  if (name === 'call') return {
    ...base, connectedChannelId: 'geral', connectedAt: Date.now() - 158_000,
    soundboard: ['risadas chaves', 'wow 8', 'atual matheus VpYtlYg', 'tururu', 'cavalo', 'aplausos'].map((name, i) => ({ id: String(i), name })),
    categories: [{ id: 'voice', name: 'Canais de Voz', channels: [{ id: 'geral', name: 'Geral', kind: 'voice', users: [
      { id: 'me', name: 'camargo', self: true, muted: false, deafened: false, speaking: true },
      { id: 'bob', name: 'Bob', muted: true, deafened: false, speaking: false },
    ] }] }],
    // Two groups on an earlier day, then a continuation within 7 minutes and a reaction.
    chat: [
      { id: 'm1', authorId: 'bob', authorName: 'Bob', text: 'bora jogar hoje?', timestamp: Date.UTC(2026, 9, 15, 22, 5), own: false, reactions: [] },
      { id: 'm2', authorId: 'me', authorName: 'camargo', text: 'bora, entra na call', timestamp: Date.UTC(2026, 9, 15, 22, 9), own: true,
        reactions: [{ emoji: '\u{1F44D}', count: 1, me: false }] },
      { id: 'm3', authorId: 'me', authorName: 'camargo', text: 'to compartilhando a tela', timestamp: Date.UTC(2026, 9, 15, 22, 12), own: true, reactions: [] },
    ],
  };
  // A call where Bob shares his screen (UI development of the stream card and the visão ampliada).
  if (name === 'stream') {
    const call = fixtureSession('call');
    const channel = call.categories[0].channels[0];
    return { ...call, categories: [{ ...call.categories[0], channels: [{ ...channel, users: channel.users.map(u => u.id === 'bob' ? { ...u, live: true } : u) }] }],
      streams: [{ id: 'scr:bob', kind: 'screen', ownerId: 'bob', title: 'Bob', width: 1920, height: 1080, path: 'native-overlay' }] };
  }
  return base;
}
