import { render } from 'preact';
import { App } from './app';
import { createBridge } from './bridge';
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

// Theme comes from the core's settings. Until they arrive, Discord's default for an account with no preference:
// "Escuro" (ThemeStore maps UNSET to NJ8.DARK, whose class is theme-darker; web bundle, REA). Fixtures/tests may pick
// another one with ?theme= to compare with captures.
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'darker';

const bridge = createBridge(() => fixtureSession(params.get('fixture') ?? 'default'));
const store = new SessionStore(() => bridge.send({ name: 'requestSnapshot' }));
bridge.onMessage(message => store.receive(message));
startVideo(bridge);
bridge.send({ name: 'requestSnapshot' }); // the core answers with the current session
render(<App store={store} bridge={bridge} />, document.getElementById('app')!);
(window as unknown as { __triscord?: unknown }).__triscord = { bridge, store };
