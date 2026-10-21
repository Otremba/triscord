import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { callChannelOf } from '../protocol';
import { callStatus } from '../call-status';
import { Icon } from './Icon';
import { ServerIcon } from './ServerRail';
import { StatePanel } from './ui/StatePanel';

export function WorkspaceHome({session,bridge}:{session:Session;bridge:Bridge}) {
  const channel=callChannelOf(session);
  const voice=callStatus(session);
  const add=()=>dispatchEvent(new Event('tri-open-server-modal'));
  return <main class="tri-workspace-home">
    <header class="tri-workspace-home__header"><span class="tri-workspace-label">Seu início</span><h1>Bom te ver, {session.account.displayName}.</h1><p>Escolha um espaço e fique perto de quem importa.</p></header>
    {channel&&<section class="tri-workspace-home__call" aria-label="Sua chamada atual" data-connection-tone={voice.tone}>
      <Icon name="VoiceSpeaker" size={24}/><div><strong>{channel.name}</strong><p role="status">{voice.label}</p></div>
      <button type="button" onClick={()=>bridge.send({name:'leaveVoice'})}>Desconectar</button>
    </section>}
    <section class="tri-workspace-home__spaces" aria-labelledby="tri-workspace-home-title">
      <div class="tri-workspace-home__section"><h2 id="tri-workspace-home-title">Seus espaços</h2><button type="button" onClick={add}><Icon name="PlusSmall" size={18}/>Adicionar espaço</button></div>
      {session.servers.length?<ul>{session.servers.map(server=><li key={server.id}><button type="button" class="tri-workspace-space" onClick={()=>bridge.send({name:'selectServer',serverId:server.id})}>
        <span class="tri-workspace-space__icon"><ServerIcon server={server} size={40}/></span><span class="tri-workspace-space__name"><strong>{server.name}</strong><span>{server.owned?'Você administra este espaço':'Conversa, voz e transmissões'}</span></span><Icon name="ChevronSmallRight" size={20}/>
      </button></li>)}</ul>:<StatePanel title="Seu primeiro espaço começa aqui" description="Crie um servidor ou entre pelo convite de alguém para começar a conversar."><button type="button" onClick={add}>Criar ou entrar em um espaço</button></StatePanel>}
    </section>
    <footer class="tri-workspace-home__footer"><button type="button" onClick={()=>dispatchEvent(new Event('tri-open-profile'))}>Editar meu perfil</button><button type="button" onClick={()=>dispatchEvent(new Event('tri-open-settings'))}>Configurações</button></footer>
  </main>;
}
