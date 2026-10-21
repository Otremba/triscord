import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { Icon } from './Icon';
import { openContextMenu } from './ContextMenu';
import { ServerIcon, serverMenuEntries } from './ServerRail';

/** Integrated workspace navigation. All actions use existing account/server contracts. */
export function WorkspaceNav({session,bridge}:{session:Session;bridge:Bridge}) {
  const current=session.servers.find(server=>server.id===session.selectedServerId);
  const recent=session.servers.filter(server=>server.id!==current?.id).slice(0,2);
  const select=(serverId:string)=>bridge.send({name:'selectServer',serverId});
  return <nav class="tri-workspace-nav" aria-label="Espaços">
    <button type="button" class="tri-workspace-brand" aria-label="Triscord, ir para o início" onClick={()=>select('@me')}>
      <span class="tri-workspace-mark" aria-hidden="true"><Icon name="Chat" size={21}/></span><span>triscord</span>
    </button>
    <label class="tri-workspace-label" for="tri-workspace-select">Seu espaço</label>
    <div class="tri-workspace-current">
      <span class="tri-workspace-current__icon" aria-hidden="true">{current?<ServerIcon server={current} size={36}/>:<Icon name="Friends" size={24}/>}</span>
      <select id="tri-workspace-select" value={current?.id??'@me'} onChange={event=>select(event.currentTarget.value)}>
        <option value="@me">Início</option>
        {session.servers.map(server=><option key={server.id} value={server.id}>{server.name}</option>)}
      </select>
      {current&&<button type="button" class="tri-icon-button" aria-label={`Opções de ${current.name}`} aria-haspopup="menu"
        onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();openContextMenu(event,serverMenuEntries(current,true),{label:current.name,at:{x:rect.left,y:rect.bottom+6}});}}><Icon name="MoreHorizontal" size={18}/></button>}
    </div>
    <div class="tri-workspace-shortcuts" aria-label="Atalhos de espaços">
      {current&&<button type="button" onClick={()=>select('@me')}>Início</button>}
      {recent.map(server=><button type="button" key={server.id} title={server.name} onClick={()=>select(server.id)}
        onContextMenu={event=>openContextMenu(event,serverMenuEntries(server,false),{label:server.name})}>{server.name}</button>)}
      <button type="button" class="tri-workspace-add" aria-label="Adicionar servidor ou aceitar convite" onClick={()=>dispatchEvent(new Event('tri-open-server-modal'))}><Icon name="PlusSmall" size={18}/></button>
    </div>
  </nav>;
}
