import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createBridge } from './bridge';
import { fixtureSession } from './fixtures';
import { SessionStore } from './store';
import { startVideo } from './video';
import './index.css';

// Keep the first paint aligned with the dark default; saved account preferences arrive from the core.
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';

const bridge = createBridge(() => fixtureSession(params.get('fixture') ?? 'default'));
const store = new SessionStore(() => bridge.send({ name: 'requestSnapshot' }));
bridge.onMessage(message => store.receive(message));
startVideo(bridge);
bridge.send({ name: 'requestSnapshot' }); // the core answers with the current session

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App store={store} bridge={bridge} />
    </StrictMode>,
);

(window as unknown as { __triscord?: unknown }).__triscord = { bridge, store };