import { useEffect, useState } from 'preact/hooks';
import type { Bridge } from './bridge';
import type { Command } from './protocol';
import { useSession, type SessionStore } from './store';
import { LoginScreen } from './components/LoginScreen';
import { ProfileEditor } from './components/ProfileEditor';
import { SharePicker } from './components/SharePicker';
import { VideoTile } from './components/VideoTile';
import './styles/rust-preview.css';

export function RustPreview({ store, bridge }: { store: SessionStore; bridge: Bridge }) {
  const session = useSession(store);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [roomName, setRoomName] = useState('');
  const [profileOpen,setProfileOpen]=useState(false);
  const [sharePickerOpen,setSharePickerOpen]=useState(false);
  const [pendingText, setPendingText] = useState<{ text: string; previousIds: string[] } | null>(null);
  useEffect(() => {
    const handler = (event: Event) => setNotice(String((event as CustomEvent).detail));
    addEventListener('tri-preview-notice', handler);
    return () => removeEventListener('tri-preview-notice', handler);
  }, []);
  useEffect(() => { setCode(''); setText(''); }, [session?.selectedServerId]);
  useEffect(() => { setText(''); setPendingText(null); setSharePickerOpen(false); }, [session?.textRoomId]);
  useEffect(() => { setPassword(''); setCurrentPassword(''); setInvite(''); setCode(''); setName(''); setProfileOpen(false); }, [session?.account.id]);
  useEffect(() => {
    if (pendingText && session?.chat?.some(message => message.own && message.text === pendingText.text && !pendingText.previousIds.includes(message.id))) {
      setText(current => current === pendingText.text ? '' : current); setPendingText(null);
    }
  }, [session?.chat, pendingText]);
  useEffect(() => {
    if (!pendingText) return;
    const timer = setTimeout(() => { setPendingText(null); setNotice('O servidor não confirmou a mensagem. Seu texto foi preservado; confira o chat antes de reenviar.'); }, 10000);
    return () => clearTimeout(timer);
  }, [pendingText]);
  const run = async <T,>(command: Command): Promise<T | undefined> => {
    setBusy(true); setNotice('');
    try { return await bridge.request<T>(command); }
    catch (error) { setNotice((error as Error).message); return undefined; }
    finally { setBusy(false); }
  };
  const signedIn = session?.auth?.state === 'signedIn';
  const server = session?.servers.find(s => s.id === session.selectedServerId);
  const room = session?.rooms?.find(r => r.id === session.textRoomId);
  const connected = session?.connection === 'connected';
  return <div class="rust-preview">
    <div class="rust-preview__banner" role="status">Prévia da reescrita Rust · mídia em desenvolvimento, sem validação em execução · câmera e transmissão pendentes</div>
    {notice && <div class="rust-preview__notice" role="alert">{notice}<button onClick={() => setNotice('')} aria-label="Fechar aviso">×</button></div>}
    {!session ? <div class="rust-preview__loading">Carregando… <button onClick={() => bridge.send({ name: 'requestSnapshot' })}>Tentar novamente</button></div> : !signedIn ?
      <LoginScreen auth={session.auth ?? { state: 'signedOut' }} bridge={bridge} googleLogin={session.runtime?.googleLogin ?? false} /> : <div class="rust-preview__layout">
      <aside class="rust-preview__servers">
        <h1>Triscord <small>Rust Preview</small></h1>
        <p>{session.account.displayName}</p>
        <button disabled={busy} onClick={() => setProfileOpen(true)}>Editar perfil</button>
        <button disabled={busy} onClick={() => void run({ name: 'signOut' })}>Sair da conta</button>
        <h2>Seus servidores</h2>
        <button disabled={busy} onClick={() => void run({ name: 'refreshServers' })}>Atualizar</button>
        <nav aria-label="Servidores">{session.servers.map(s => <button key={s.id} class={s.id === server?.id ? 'is-selected' : ''} disabled={busy}
          onClick={() => void run({ name: 'selectServer', serverId: s.id })}>{s.name}</button>)}</nav>
        {!session.servers.length && <p>Você ainda não participa de servidores.</p>}
        <form onSubmit={event => { event.preventDefault(); void run({ name: 'createServer', serverName: name }); }}>
          <label>Novo servidor<input value={name} onInput={e => setName(e.currentTarget.value)} maxLength={64} required /></label>
          <button disabled={busy || !name.trim()}>Criar servidor</button>
        </form>
        <form onSubmit={event => { event.preventDefault(); void run({ name: 'acceptInvite', invite }); }}>
          <label>Convite<input value={invite} onInput={e => setInvite(e.currentTarget.value)} maxLength={2048} required /></label>
          <button disabled={busy || !invite.trim()}>Entrar no servidor</button>
        </form>
        <details><summary>Senha da conta</summary>
          <form onSubmit={event => { event.preventDefault(); void run({ name: 'setPassword', password, currentPassword }).then(result => { if (result !== undefined) { setPassword(''); setCurrentPassword(''); setNotice('Senha salva.'); } }); }}>
            <label>Senha atual<input type="password" autoComplete="current-password" value={currentPassword} onInput={e => setCurrentPassword(e.currentTarget.value)} maxLength={128} /></label>
            <label>Nova senha<input type="password" autoComplete="new-password" value={password} onInput={e => setPassword(e.currentTarget.value)} minLength={6} maxLength={128} required /></label>
            <button disabled={busy}>Salvar senha</button>
          </form>
        </details>
        <details><summary>Áudio</summary>
          <button disabled={busy} onClick={() => void run({ name: 'requestDevices' })}>Atualizar dispositivos</button>
          <label>Microfone<select value={session.settings?.inputDevice ?? ''} onChange={event => void run({ name: 'setSetting', key: 'inputDevice', value: event.currentTarget.value })}>
            <option value="" disabled>Seleção inicial do Windows</option>
            {session.settings?.inputDevices.map(device => <option value={device.id} key={device.id}>{device.name}</option>)}
          </select></label>
          <label>Saída<select value={session.settings?.outputDevice ?? ''} onChange={event => void run({ name: 'setSetting', key: 'outputDevice', value: event.currentTarget.value })}>
            <option value="" disabled>Seleção inicial do Windows</option>
            {session.settings?.outputDevices.map(device => <option value={device.id} key={device.id}>{device.name}</option>)}
          </select></label>
          <label><input type="checkbox" checked={session.settings?.noiseSuppression ?? true} onChange={event => void run({ name: 'setSetting', key: 'noiseSuppression', value: event.currentTarget.checked })} />Supressão de ruído</label>
          <label><input type="checkbox" checked={session.settings?.automaticGainControl ?? true} onChange={event => void run({ name: 'setSetting', key: 'automaticGainControl', value: event.currentTarget.checked })} />Ganho automático</label>
        </details>
      </aside>
      <section class="rust-preview__rooms">
        <h2>{server?.name ?? 'Selecione um servidor'}</h2>
        {server && <>
          <p role="status">Controle: {{ connected: 'conectado', connecting: 'conectando', reconnecting: 'reconectando', offline: 'desconectado' }[session.connection]}</p>
          {!connected && <button disabled={busy} onClick={() => void run({ name: 'selectServer', serverId: server.id })}>Reconectar</button>}
          <nav aria-label="Salas">{session.rooms?.map(r => <button key={r.id} disabled={busy || !connected} class={r.id === room?.id ? 'is-selected' : ''}
            onClick={() => void run({ name: 'openTextRoom', channelId: r.id })}># {r.name} <small>{r.userCount} pessoa(s)</small></button>)}</nav>
          <p class="rust-preview__hint">Abrir uma sala entra somente no chat. Use Entrar em voz para ativar o áudio pelo SDK LiveKit. O microfone começa silenciado.</p>
          {room && <section aria-label="Controles de voz">
            <p role="status">Voz: {{ idle: 'desconectada', connecting: 'conectando', connected: 'conectada', reconnecting: 'reconectando', error: 'falha de conexão' }[session.voiceState ?? 'idle']}</p>
            {!session.voiceRequested || session.voiceState === 'error' ? <button disabled={busy || !connected} onClick={() => void run({ name: 'joinVoice', channelId: room.id })}>{session.voiceState === 'error' ? 'Reconectar voz' : 'Entrar em voz'}</button> : <>
              <button disabled={busy} onClick={() => void run({ name: 'leaveVoice' })}>Desconectar voz</button>
              <button disabled={busy || session.voiceState !== 'connected'} onClick={() => void run({ name: 'setMuted', muted: !session.muted })}>{session.muted ? 'Ativar microfone' : 'Silenciar microfone'}</button>
              <button disabled={busy || session.voiceState !== 'connected'} onClick={() => void run({ name: 'setDeafened', deafened: !session.deafened })}>{session.deafened ? 'Ativar áudio recebido' : 'Desativar áudio recebido'}</button>
            </>}
          </section>}
          <form onSubmit={e => { e.preventDefault(); void run({ name: 'createTextRoom', channelName: roomName }); }}>
            <label>Nova sala<input value={roomName} onInput={e => setRoomName(e.currentTarget.value)} maxLength={64} required /></label>
            <button disabled={busy || !connected || !roomName.trim()}>Criar sala e abrir chat</button>
          </form>
          {server.owned && <><button disabled={busy} onClick={() => void run<{ code: string }>({ name: 'createInvite', serverId: server.id }).then(result => { if (result) setCode(result.code); })}>Gerar convite</button>
            {code && <label>Código do convite<input readOnly value={code} onFocus={e => e.currentTarget.select()} /></label>}</>}
          <button class="rust-preview__danger" disabled={busy} onClick={() => {
            if (confirm(server.owned ? `Excluir permanentemente o servidor “${server.name}”?` : `Sair do servidor “${server.name}”?`))
              void run({ name: server.owned ? 'deleteServer' : 'leaveServer', serverId: server.id });
          }}>{server.owned ? 'Excluir servidor' : 'Sair do servidor'}</button>
        </>}
      </section>
      <main class="rust-preview__chat">
        <header><h2>{room ? `# ${room.name}` : 'Chat'}</h2>{room && <button disabled={busy} onClick={() => void run({ name: 'leaveTextRoom' })}>Sair da sala</button>}</header>
        {room && <div>
          <button disabled={busy || !connected} onClick={() => session.sharing ? void run({ name: 'stopScreenShare' }) : setSharePickerOpen(true)}>{session.sharing ? 'Parar transmissão' : 'Compartilhar tela'}</button>
          <p class="rust-preview__hint">Vídeo com exibição nativa por GPU em desenvolvimento. Prévia local e áudio da transmissão ainda pendentes.</p>
        </div>}
        {!!session.streams?.length && <section aria-label="Transmissões" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:'12px'}}>{session.streams.map(stream=><div key={stream.id}><p>{stream.title}</p><VideoTile stream={stream} bridge={bridge}/></div>)}</section>}
        <div class="rust-preview__messages" role="log" aria-label="Mensagens">
          {!room && <p>Abra uma sala para conversar. A voz é ativada separadamente e o vídeo ainda está em desenvolvimento.</p>}
          {session.chat?.map(message => <article key={message.id}><strong>{message.authorName}</strong> <time>{new Date(message.timestamp).toLocaleTimeString()}</time><p>{message.text}</p>
            {message.own && <button disabled={busy} onClick={() => void run({ name: 'deleteChatMessage', messageId: message.id })}>Excluir</button>}</article>)}
        </div>
        {room && <form onSubmit={event => {
          event.preventDefault();
          setPendingText({ text: text.trim(), previousIds: session.chat?.map(message => message.id) ?? [] });
          void run({ name: 'sendChatMessage', text }).then(result => { if (result === undefined) setPendingText(null); });
        }}>
          <label>Mensagem<textarea value={text} onInput={e => setText(e.currentTarget.value)} maxLength={2000} required /></label>
          <button disabled={busy || !!pendingText || !connected || !text.trim()}>{pendingText ? 'Aguardando confirmação…' : 'Enviar'}</button>
        </form>}
      </main>
    </div>}
    {signedIn && session && profileOpen && <ProfileEditor session={session} bridge={bridge} onClose={() => setProfileOpen(false)} />}
    {signedIn && session && sharePickerOpen && <SharePicker bridge={bridge} store={store} onClose={() => setSharePickerOpen(false)} />}
  </div>;
}
