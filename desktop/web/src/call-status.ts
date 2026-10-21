import type { Session } from './protocol';

export function callStatus(session: Pick<Session, 'voiceState' | 'voiceRequested' | 'camera' | 'connection'>) {
  // Voice and control are separate connections. An explicit media state is authoritative.
  const state = session.voiceState ?? (session.connection === 'offline' ? 'idle' : session.connection);
  switch (state) {
    case 'connected': return { state, label: session.camera ? 'Vídeo conectado' : 'Voz conectada', tone: 'positive' } as const;
    case 'connecting': return { state, label: 'Conectando à voz…', tone: 'pending' } as const;
    case 'reconnecting': return { state, label: 'Reconectando a voz…', tone: 'pending' } as const;
    case 'error': return { state, label: 'Falha na conexão de voz', tone: 'critical' } as const;
    default: return { state: 'idle', label: session.voiceRequested ? 'Aguardando conexão de voz' : 'Voz desconectada', tone: 'neutral' } as const;
  }
}
