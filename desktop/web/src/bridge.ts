// Transport between this interface and the native core.
// - TauriBridge: the real Rust/Tauri core (invoke + events).
// - FixtureBridge: a fixed session for development and the Playwright tests (no core, no network).
import type { Command, CoreMessage, Session } from './protocol';
import { PROTOCOL_VERSION } from './protocol';

export interface Bridge {
  send(command: Command): string;                 // returns the requestId
  onMessage(handler: (message: CoreMessage) => void): void;
  // Resolves with the core result; profile timeouts cover the native network deadline.
  request<T = unknown>(command: Command): Promise<T>;
}

let counter = 0;
// The call popout page (?popout=call) shares the core with the main page and receives its late answers too: its own
// prefix keeps the two pages' request ids apart.
const idPrefix = new URLSearchParams(location.search).has('popout') ? 'p' : 'r';
const nextRequestId = () => `${idPrefix}${Date.now().toString(36)}-${(counter++).toString(36)}`;

export class FixtureBridge implements Bridge {
  readonly sent: Command[] = [];
  private handler: ((message: CoreMessage) => void) | null = null;
  constructor(private session: Session) { }
  send(command: Command): string {
    this.sent.push(command);
    const requestId = nextRequestId();
    if (command.name === 'requestSnapshot') queueMicrotask(() => this.push());
    if (command.name === 'selectServer') this.patch({ selectedServerId: command.serverId });
    if (command.name === 'selectChannel') this.patch({ selectedChannelId: command.channelId });
    if (command.name === 'setMuted') this.patch({ muted: command.muted });
    if (command.name === 'setDeafened') this.patch({ deafened: command.deafened });
    if (command.name === 'setCallFocus') this.patch({ callFocus: command.key ? { key: command.key, filmOpen: command.filmOpen ?? true } : null });
    if (command.name === 'setCallFullscreen') this.patch({ callFullscreen: command.on });
    if (command.name === 'setStreamHidden' && this.session.streams) {
      this.patch({ streams: this.session.streams.map(s => s.id === command.streamId ? { ...s, hidden: command.hidden } : s) });
    }
    return requestId;
  }
  onMessage(handler: (message: CoreMessage) => void): void { this.handler = handler; this.push(); }
  request<T>(command: Command): Promise<T> {
    this.send(command);
    if (command.name === 'getOwnProfile') return this.session.profile ? Promise.resolve(this.session.profile as T) : Promise.reject(new Error('Falha de carregamento simulada para revisão.'));
    if (command.name === 'saveOwnProfile' && this.session.profile) {
      this.patch({ profile: { ...this.session.profile, ...command.fields } });
      return Promise.resolve(this.session.profile as T);
    }
    if (command.name === 'listShareSources')
      return Promise.resolve({ generation: '1', sources: [{ index: 0, kind: 'screen', name: 'Tela 1' }, { index: 1, kind: 'window', name: 'Bloco de notas' }] } as T);
    if (command.name === 'createInvite') return Promise.resolve({ code: '3f9c2a7e5b1d4c8fa06e2b9d7c1f4a53' } as T);
    return Promise.resolve(undefined as T);
  }
  private revision = 0;
  private push() { this.handler?.({ v: PROTOCOL_VERSION, type: 'snapshot', revision: this.revision, session: this.session }); }
  private patch(patch: Partial<Session>) {
    this.session = { ...this.session, ...patch };
    const base = this.revision++;
    this.handler?.({ v: PROTOCOL_VERSION, type: 'delta', baseRevision: base, revision: this.revision, patch });
  }
}

export function createBridge(fixture: () => Session): Bridge {
  const tauri = (window as unknown as { __TAURI__?: TauriHost }).__TAURI__;
  return tauri ? new TauriBridge(tauri) : new FixtureBridge(fixture());
}

interface TauriHost {
  core: { invoke<T>(command: string, args: unknown): Promise<T> };
  event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
}

export function previewNotice(message: string): void {
  dispatchEvent(new CustomEvent('tri-preview-notice', { detail: message }));
}

// Register listeners before invoking the first command: the core can emit a snapshot before invoke resolves.
// Native failure never selects fixture data. Session tokens stay in Rust and never cross this bridge.
export class TauriBridge implements Bridge {
  private ready: Promise<unknown> = Promise.resolve();
  constructor(private readonly host: TauriHost) { }
  onMessage(handler: (message: CoreMessage) => void): void {
    this.ready = Promise.all([
      this.host.event.listen<CoreMessage>('triscord-core', event => handler(event.payload)),
      this.host.event.listen<string>('triscord-notice', event => previewNotice(event.payload)),
    ]);
  }
  send(command: Command): string {
    const id = nextRequestId();
    void this.request(command).catch((error: Error) => previewNotice(error.message));
    return id;
  }
  async request<T>(command: Command): Promise<T> {
    try {
      await this.ready;
      return await this.host.core.invoke<T>('dispatch', { command });
    } catch (error) {
      throw new Error(error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Não foi possível concluir a operação.');
    }
  }
}
