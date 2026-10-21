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
    <header class="tri-workspace-home__header"><h1>Início</h1><p>Escolha um servidor para conversar.</p></header>
    {channel&&<section class="tri-workspace-home__call" aria-label="Sua chamada atual" data-connection-tone={voice.tone}>
      <Icon name="VoiceSpeaker" size={24}/><div><strong>{channel.name}</strong><p role="status">{voice.label}</p></div>
      <button type="button" onClick={()=>bridge.send({name:'leaveVoice'})}>Desconectar</button>
    </section>}
    <section class="tri-workspace-home__spaces" aria-labelledby="tri-workspace-home-title">
      <div class="tri-workspace-home__section"><h2 id="tri-workspace-home-title">Servidores</h2><button type="button" onClick={add}><Icon name="PlusSmall" size={18}/>Adicionar servidor</button></div>
      {session.servers.length?<ul>{session.servers.map(server=><li key={server.id}><button type="button" class="tri-workspace-space" onClick={()=>bridge.send({name:'selectServer',serverId:server.id})}>
        <span class="tri-workspace-space__icon"><ServerIcon server={server} size={40}/></span><span class="tri-workspace-space__name"><strong>{server.name}</strong>{server.owned&&<span>Administrador</span>}</span><Icon name="ChevronSmallRight" size={20}/>
      </button></li>)}</ul>:<StatePanel title="Você ainda não entrou em um servidor" description="Crie um servidor ou entre pelo convite de alguém para começar a conversar."><button type="button" onClick={add}>Criar ou entrar em um servidor</button></StatePanel>}
    </section>

  </main>;
}
