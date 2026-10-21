// Messages between the native core (C++, source of truth) and this interface (desktop/ARQUITETURA_WEBVIEW2.md).
//
// Core -> UI:  "snapshot" (full session state at `revision`) and "delta" (patch from `baseRevision` to
//              `revision`). A delta whose base is not the current revision is a gap: the UI asks for a new
//              snapshot instead of guessing.
// UI -> core:  "command" with a unique requestId; the core answers "result" with the same requestId.
// The UI is untrusted: the core validates every command and never hands it tokens, invites or TURN data.
// 64-bit ids/counters travel as strings.

export const PROTOCOL_VERSION = 1;

export type Id = string;

export interface Server {
  id: Id;               // '' = the legacy "Triscord" group
  name: string;
  iconUrl?: string;     // opaque local URL resolved by the core (never a remote URL from the renderer)
  owned: boolean;       // may mint invites
  unread?: boolean;
}

export interface VoiceUser {
  localMuted?: boolean;
  volume?: number;
  pan?: number;
  streamVolume?: number;   // their screen share's audio for you, 0..200 ("Volume da transmissão")
  streamMuted?: boolean;   // "Silenciar transmissão"
  profileAvailable?: boolean;
  customStatus?: string;
  id: Id;
  name: string;
  avatarUrl?: string;
  accountId?: string;           // signed-in account, key of Session.avatars
  self?: boolean;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  camera?: boolean;     // publishing a camera
  live?: boolean;       // sharing the screen ("AO VIVO")
  serverMuted?: boolean; // muted by the room owner ("Silenciar voz na sala"); the hub refuses to unmute
}

// The channel of the call. Viewing another server during a call (Discord keeps the call) replaces `categories` with that
// server's channels, so the call's own channel comes in `callChannel`.
export function callChannelOf(session: Session): Channel | undefined {
  return session.callChannel ?? session.categories.flatMap(c => c.channels).find(c => c.id === session.connectedChannelId);
}
export interface Channel {
  id: Id;
  name: string;
  kind: 'voice' | 'text';        // triscord rooms are voice channels with a chat, or text channels
  users: VoiceUser[];
  ownerId?: Id;         // participant who owns the room (first in; the hub moves it on) and may moderate it
}

export interface Category {
  id: Id;
  name: string;         // observed "Canais de Voz"
  channels: Channel[];
}

export interface Account {
  customStatus?: string;
  id: Id;
  displayName: string;
  username: string;
  avatarUrl?: string;
  status: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';
}

// A video the core is showing (camera or screen). Frames do not travel in JSON: path B posts them in
// shared buffers ("sharedbufferreceived"); path A draws them in a native window over the tile's rect.
export interface VideoStream {
  loading?: boolean;
  hidden?: boolean;
  id: Id;
  kind?: 'camera' | 'screen';
  ownerId?: Id;
  title: string;
  width: number;
  height: number;
  path: 'shared-buffer' | 'native-overlay';
}

// A message of the room's chat (only while in the room: the hub sends the history on joining).
export interface ChatMessage {
  id: Id;
  authorId: Id;
  authorName: string;
  text: string;
  timestamp: number;    // ms since epoch
  own: boolean;
  reactions: { emoji: string; count: number; me: boolean }[];
  markdown?: MarkdownNode[];
}

// Native Discord parser's finite, inert tree; no HTML or arbitrary attributes cross the bridge.
export interface MarkdownNode {
  type: 'text'|'paragraph'|'heading'|'subtext'|'codeBlock'|'inlineCode'|'quote'|'list'|'link'|'strong'|'em'|'underline'|'strike'|'spoiler'|'mention'|'timestamp'|'break';
  text?: string;
  children?: MarkdownNode[];
  level?: number;
  language?: string;
  href?: string;
  title?: string;
  ordered?: boolean;
  start?: number;
  items?: MarkdownNode[][];
  seconds?: string;
  format?: string;
}

// Settings page state, published by the core (device ids are hex strings; '' = Windows default).
export interface SettingsState {
  inputDevices: { id: string; name: string; isDefault?: boolean }[];   // isDefault: the Windows default device
  outputDevices: { id: string; name: string; isDefault?: boolean }[];
  cameraDevices: { id: string; name: string; isDefault?: boolean }[];
  inputDevice: string;
  outputDevice: string;
  cameraDevice: string;
  inputVolume: number;    // 0..100
  outputVolume: number;   // 0..200
  noiseSuppression: boolean;
  noiseSuppressionStrength?: number; // 0..100, before automatic gain control; persisted per user
  noiseSuppressionMode?: 'standard' | 'high';   // "Padrão" (RNNoise) or "Alta qualidade" (DeepFilterNet 3, default)
  noiseSuppressionHighAvailable?: boolean;      // DeepFilterNet ships with this installation
  automaticGainControl?: boolean;   // Discord's "Controle de ganho automático", on by default
  desktopNotifications: boolean; // Windows notifications for mentions and people entering your room
  taskbarAlert: boolean;         // flash the taskbar button for those notifications
  closeToTray?: boolean;         // "Minimizar para a bandeja": the close button hides the window, the call keeps running
  startMinimized?: boolean;      // "Abrir minimizado": a start at logon stays in the tray
  errorReports?: boolean;        // "Enviar relatórios de erro": the log of a session with signs of a bug goes to the hub
  errorReportsAvailable?: boolean; // this run writes a log file (false in development and most tests)
  openAtLogin?: boolean;         // "Abrir o Triscord": starts with Windows (read back from the Run key)
  loginSupported?: boolean;      // false in development builds, which must not register themselves
  callSounds?: boolean;
  soundboardVolume: number; // 0..100, read by the sound player when a sound starts
  theme: 'light' | 'dark' | 'darker' | 'midnight' | 'cotton-candy';
  shareMode: 'game' | 'screen'; // share picker's stream mode ("Jogos" / "Compartilhamento de tela")
  shareHd: boolean;             // HD (1080p) instead of SD (720p)
  shareAudio: boolean;          // share the system audio (unchecked "Silenciar áudio da transmissão")
}

export interface AuthState {
  state: 'signedOut' | 'signingIn' | 'needsNick' | 'signedIn';
  error?: string;
  suggestedNick?: string;
}

export interface PublicParticipantProfile {
  socketId: string; username: string; displayName: string; pronouns: string; bio: string;
  created_at?: number; avatarDataUrl: string; bannerDataUrl: string;
  banner_color?: string; profile_theme_start?: string; profile_theme_end?: string;
}
export interface Session {
  // The Rust (Tauri) core says which features it has; the C++ core never sends this and has them all. A feature that
  // is false is hidden instead of offering a button that cannot work (camera, soundboard, popout window).
  runtime?: { name: 'tauri'; preview: boolean; voice: boolean; screen: boolean; camera: boolean; googleLogin: boolean; screenAudio?: boolean;
    soundboard?: boolean; popout?: boolean };
  rooms?: { id: string; name: string; userCount: number }[];
  textRoomId?: string | null;
  voiceState?: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  voiceRequested?: boolean;
  avatars?: Record<string, { still?: string; animated?: string }>;   // by account id; animated = GIF
  cameraPending?: boolean;
  callFullscreen?: boolean;
  callPopout?: boolean;      // the call is in its own window (janela destacada, Discord "Nova Janela")
  callPopoutOnTop?: boolean; // that window stays above the others ("Mostrar sempre")
  callPopoutFullscreen?: boolean; // that window is fullscreen ("Tela cheia" inside it)
  callFocus?: { key: string | null; filmOpen: boolean } | null; // visão ampliada, shared by every window
  participantProfile?: PublicParticipantProfile | null;
  profile?: OwnProfile;
  soundboard?: { id: string; name: string }[];
  soundboardPlayingId?: string;
  soundboardError?: string;
  auth?: AuthState;
  connection: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  account: Account;
  servers: Server[];
  selectedServerId: Id;
  categories: Category[];
  selectedChannelId?: Id;
  connectedChannelId?: Id;  // the voice channel the user is in
  callChannel?: Channel;    // that channel with its users, also while another server is shown (callChannelOf)
  callServerId?: Id;        // the server of the call (the main connection); selectedServerId is the one shown
  muted: boolean;
  deafened: boolean;
  streams?: VideoStream[];
  camera?: boolean;     // our camera is on
  sharing?: boolean;    // we are sharing the screen
  sharingName?: string; // title of what we share (voice panel stream row)
  connectedAt?: number; // ms since epoch when we joined the room (call timer)
  chat?: ChatMessage[]; // the room we are in
  settings?: SettingsState;
}

export interface ShareSource { index: number; kind: 'screen' | 'window'; name: string }

export type CoreMessage =
  | { v: number; type: 'snapshot'; revision: number; session: Session }
  | { v: number; type: 'delta'; baseRevision: number; revision: number; patch: Partial<Session> }
  | { v: number; type: 'result'; requestId: string; ok: true; value?: unknown }
  | { v: number; type: 'event'; name: 'shareThumbnail'; generation: string; index: number; image: string }
  | { v: number; type: 'event'; name: 'chatRateLimited' | 'callActivity' }
  | { v: number; type: 'event'; name: 'cameraPreviewFrame'; previewId: string; image: string }
  | { v: number; type: 'event'; name: 'cameraPreviewClosed'; previewId: string; reason: string }
  // Right click on a native video window (the page cannot see it): x/y in CSS px of this page.
  | { v: number; type: 'event'; name: 'videoContextMenu'; streamId: Id; x: number; y: number }
  // Left click on a native video window: the page focuses that card (visão ampliada) or goes back to the grid.
  | { v: number; type: 'event'; name: 'videoClick'; streamId: Id }
  | { v: number; type: 'result'; requestId: string; ok: false; error: { code: string; message: string } };

export type Command =
  | { name: 'startCameraPreview' | 'keepCameraPreview' | 'stopCameraPreview'; previewId: string }
  | { name: 'getOwnProfile' }
  | { name: 'getParticipantProfile'; socketId: string }
  | { name: 'closeParticipantProfile' }
  | { name: 'saveOwnProfile'; fields: Partial<ProfileFields> }
  | { name: 'beginProfileMedia'; kind: 'avatar' | 'banner'; size: number }
  | { name: 'appendProfileMedia'; uploadId: string; offset: number; data: string }
  | { name: 'finishProfileMedia'; uploadId: string }
  | { name: 'cancelProfileMedia'; uploadId: string }
  | { name: 'removeProfileMedia'; kind: 'avatar' | 'banner' }
  | { name: 'playSound'; soundId: string }
  | { name: 'previewSound'; soundId: string }
  | { name: 'stopSoundPreview' }
  | { name: 'requestSnapshot' }
  | { name: 'refreshServers' }
  | { name: 'openTextRoom'; channelId: string }
  | { name: 'createTextRoom'; channelName: string }
  | { name: 'leaveTextRoom' }
  | { name: 'signIn' }                                // the core runs the Google flow in the browser
  | { name: 'setNick'; nick: string }
  | { name: 'signInNick'; nick: string; password?: string }   // value: { created }; no Google account needed
  | { name: 'setPassword'; password: string; currentPassword?: string }
  | { name: 'signOut' }
  | { name: 'setCustomStatus'; text: string }
  | { name: 'createServer'; serverName: string }      // value: { serverId }
  | { name: 'acceptInvite'; invite: string }          // value: { serverId }
  | { name: 'selectServer'; serverId: Id }
  | { name: 'selectChannel'; channelId: Id }
  | { name: 'joinVoice'; channelId: Id }
  | { name: 'createChannel'; channelName: string }   // "name" is the command discriminator
  | { name: 'sendChatMessage'; text: string }        // room we are in; hub limit 2000 characters
  | { name: 'deleteChatMessage'; messageId: Id }     // own messages only
  | { name: 'toggleReaction'; messageId: Id; emoji: string }
  | { name: 'copyMessageText'; messageId: Id }        // native clipboard; text of a chat message
  | { name: 'openChatLink'; messageId: Id; url: string } // core validates the target against this message's tree
  | { name: 'leaveVoice' }
  | { name: 'setCamera'; on: boolean }
  | { name: 'setCallFullscreen'; on: boolean }
  | { name: 'setCallPopout'; on: boolean }
  // Moderation, room owner only (core-checked): force-mute (also ourselves) and disconnect from the room.
  | { name: 'setServerMuted'; socketId: Id; muted: boolean }
  | { name: 'disconnectParticipant'; socketId: Id }
  | { name: 'setCallPopoutOnTop'; on: boolean }
  | { name: 'setStreamHidden'; streamId: string; hidden: boolean }
  | { name: 'listShareSources' }                      // value: { generation, sources: ShareSource[] }
  | { name: 'startScreenShare'; generation: string; index: number }
  | { name: 'startDeviceShare'; deviceId: string }
  | { name: 'stopScreenShare' }
  | { name: 'setMuted'; muted: boolean }
  | { name: 'setPeerAudio'; socketId: string; volume?: number; pan?: number; muted?: boolean; streamVolume?: number; streamMuted?: boolean }
  | { name: 'setDeafened'; deafened: boolean }
  | { name: 'openAudioMenu'; device: 'input' | 'output' }   // the core opens the device menu
  | { name: 'createInvite'; serverId: Id }       // value: { code }; only the owner may invite
  | { name: 'deleteServer'; serverId: string }
  | { name: 'leaveServer'; serverId: string }
  | { name: 'copyInvite'; code: string }         // native clipboard; only codes the core created
  | { name: 'openServerDialog' }
  | { name: 'openSettings' }
  | { name: 'sendErrorReport' }                    // the running session's log to the hub ("Enviar log agora")
  | { name: 'requestDevices' }                     // the camera list arrives in session.settings
  | { name: 'setSetting'; key: 'inputDevice' | 'outputDevice' | 'cameraDevice' | 'theme'; value: string }
  | { name: 'setSetting'; key: 'inputVolume' | 'outputVolume' | 'soundboardVolume' | 'noiseSuppressionStrength'; value: number }
  | { name: 'setSetting'; key: 'callSounds' | 'noiseSuppression' | 'automaticGainControl' | 'desktopNotifications' | 'taskbarAlert' | 'closeToTray' | 'startMinimized' | 'openAtLogin' | 'shareHd' | 'shareAudio' | 'errorReports'; value: boolean }
  | { name: 'setSetting'; key: 'shareMode'; value: 'game' | 'screen' }
  | { name: 'setSetting'; key: 'noiseSuppressionMode'; value: 'standard' | 'high' }
  | { name: 'window'; action: 'minimize' | 'maximize' | 'close' | 'move' | `resize-${'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'}` }
  | { name: 'videoAck'; index: number; seq: number }
  // Page layers floating over the native video windows (an open menu): they are cut out of the windows' masks.
  // Where a card's native window is shown: grid, the focused stage, or the filmstrip (changes what it draws).
  | { name: 'videoRole'; streamId: Id; role: 'grid' | 'stage' | 'film' }
  | { name: 'videoIdle'; idle: boolean }
  | { name: 'setCallFocus'; key: string | null; filmOpen: boolean }
  | { name: 'videoOccluders'; rects: { x: number; y: number; width: number; height: number }[] }
  | { name: 'videoStageOccluders'; rects: { x: number; y: number; width: number; height: number }[] }
  | { name: 'videoSurface'; streamId: Id; rect: { x: number; y: number; width: number; height: number }; scale: number }
  | { name: 'videoStats'; streamId: Id; presented: number; dropped: number };

export type UiMessage = { v: number; type: 'command'; requestId: string; command: Command };

export interface ProfileFields {
  display_name: string | null;
  pronouns: string | null;
  bio: string | null;
  note: string | null;
  banner_color: string | null;
  profile_theme_start: string | null;
  profile_theme_end: string | null;
}
export interface OwnProfile extends ProfileFields {
  avatarDataUrl: string;
  bannerDataUrl: string;
  hasAvatar: boolean;
  hasBanner: boolean;
  hasPassword?: boolean;   // a password lets this account sign in by nick on another computer
  google?: boolean;        // created through "Entrar com Google"
  created_at?: number;
}
