import { render } from 'preact';
import { App } from './app';
import { createBridge, TauriBridge } from './bridge';
import { RustPreview } from './rust-preview';
import { NoticeToast } from './components/NoticeToast';
import { fixtureSession } from './fixtures';
import { SessionStore } from './store';
import { startVideo } from './video';
import './styles/base.css';
import './styles/frame.css';
import './styles/call.css';
import './styles/auth.css';
import './styles/modals.css';
import './styles/tooltip.css';
import './styles/chat.css';
import './styles/voice.css';
import './styles/menu.css';
import './styles/settings.css';
import './styles/soundboard.css';
import './styles/profile.css';
import './styles/audio-menu.css';
import './styles/account-popover.css';
import './styles/participant-profile.css';
import './styles/peer-audio.css';
import './styles/call-view-controls.css';
import './styles/motion.generated.css';
import './styles/custom-theme.css';
import './styles/camera-preview.css';
import './styles/member-list.css';
import './styles/friends-view.css';
import './styles/tailwind.generated.css';
import './styles/workspace.css';
import './styles/workspace-themes.css';
import './styles/conversation.css';

// Keep the first paint aligned with the midnight default; saved account preferences arrive from the core.
const params = new URLSearchParams(location.search);
document.documentElement.dataset.design='workspace';
document.documentElement.dataset.theme = params.get('theme') ?? 'midnight';

const bridge = createBridge(() => fixtureSession(params.get('fixture') ?? 'default'));
const store = new SessionStore(() => bridge.send({ name: 'requestSnapshot' }));
bridge.onMessage(message => store.receive(message));
startVideo(bridge);
bridge.send({ name: 'requestSnapshot' }); // the core answers with the current session
// The Rust core runs the real interface; ?preview opens the bare development page it started with.
const tauri = bridge instanceof TauriBridge;
render(tauri && params.has('preview') ? <RustPreview store={store} bridge={bridge} /> : <><App store={store} bridge={bridge} workspace />{tauri && <NoticeToast />}</>, document.getElementById('app')!);
(window as unknown as { __triscord?: unknown }).__triscord = { bridge, store };
