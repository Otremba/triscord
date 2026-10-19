// Holds the session the core sent and applies its deltas in revision order (protocol.ts).
// Presentation-only state (hover, open menus, scroll, drafts) stays in components, not here.
import { useEffect, useState } from 'preact/hooks';
import type { CoreMessage, Session } from './protocol';
import { PROTOCOL_VERSION } from './protocol';

type Listener = (session: Session | null) => void;

export class SessionStore {
  private session: Session | null = null;
  private revision = -1;
  private listeners = new Set<Listener>();

  constructor(private readonly requestSnapshot: () => void) {}

  get current(): Session | null { return this.session; }

  private eventListeners = new Set<(message: Extract<CoreMessage, { type: 'event' }>) => void>();
  onEvent(listener: (message: Extract<CoreMessage, { type: 'event' }>) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  receive(message: CoreMessage): void {
    if (message.v !== PROTOCOL_VERSION) { this.requestSnapshot(); return; }
    if (message.type === 'event') { for (const listener of this.eventListeners) listener(message); return; }
    if (message.type === 'snapshot') {
      this.session = message.session;
      this.revision = message.revision;
      this.emit();
    } else if (message.type === 'delta') {
      if (!this.session || message.baseRevision !== this.revision) { this.requestSnapshot(); return; } // gap
      this.session = { ...this.session, ...message.patch };
      this.revision = message.revision;
      this.emit();
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() { for (const listener of this.listeners) listener(this.session); }
}

export function useSession(store: SessionStore): Session | null {
  const [session, setSession] = useState(store.current);
  useEffect(() => {
    const unsubscribe = store.subscribe(setSession);
    // Effects run after the first paint: a snapshot that arrived in between must not be lost.
    setSession(store.current);
    return unsubscribe;
  }, [store]);
  return session;
}
