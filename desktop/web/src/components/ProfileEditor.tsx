import { useEffect, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { OwnProfile, ProfileFields, Session } from '../protocol';
import { Icon } from './Icon';
import { ModalLayer, useModalClose } from './ModalLayer';
import { Modal } from './Modal';
import { ShimmerButton } from './ui/ShimmerButton';

const EMPTY: ProfileFields = {display_name:null,pronouns:null,bio:null,note:null,banner_color:null,profile_theme_start:null,profile_theme_end:null};
function fields(profile: OwnProfile): ProfileFields {
  return Object.fromEntries(Object.keys(EMPTY).map(k=>[k,profile[k as keyof ProfileFields] ?? null])) as unknown as ProfileFields;
}
// The host keeps the 64 KiB message cap. A single bounded native upload receives sequential 24 KiB chunks.
export async function uploadProfileImage(bridge: Bridge, kind: 'avatar'|'banner', file: File): Promise<void> {
  const limit=kind==='avatar'?524288:1048576;
  if (!file.size || file.size>limit) throw Error(`Use uma imagem de até ${limit/1024} KB.`);
  const {uploadId}=await bridge.request<{uploadId:string}>({name:'beginProfileMedia',kind,size:file.size});
  try {
    const bytes=new Uint8Array(await file.arrayBuffer());
    for(let offset=0;offset<bytes.length;offset+=24576) {
      const chunk=bytes.subarray(offset,offset+24576); let text='';
      for(const byte of chunk) text+=String.fromCharCode(byte);
      await bridge.request({name:'appendProfileMedia',uploadId,offset,data:btoa(text)});
    }
    await bridge.request({name:'finishProfileMedia',uploadId});
  } catch(error) { bridge.send({name:'cancelProfileMedia',uploadId}); throw error; }
}
export function ProfileEditor({session,bridge,onClose}:{session:Session;bridge:Bridge;onClose:()=>void}) {
  const {closing,close}=useModalClose(onClose);
  const [draft,setDraft]=useState<ProfileFields>(EMPTY),[saved,setSaved]=useState<ProfileFields>(EMPTY);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [ready,setReady]=useState(false),[discard,setDiscard]=useState(false);
  const [loadAttempt,setLoadAttempt]=useState(0);
  const dirty=JSON.stringify(draft)!==JSON.stringify(saved);
  useEffect(()=>{let live=true;setLoading(true);setReady(false);setError('');bridge.request<OwnProfile>({name:'getOwnProfile'}).then(p=>{if(live){setDraft(fields(p));setSaved(fields(p));setReady(true);}})
    .catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[bridge,loadAttempt]);
  const change=(key:keyof ProfileFields,value:string)=>{setMessage('');setDraft(current=>({...current,[key]:value||null}));};
  const finish=()=>{if(busy)return;if(dirty)setDiscard(true);else close();};
  const media=async(kind:'avatar'|'banner',file?:File,remove=false)=>{
    setBusy(true);setError('');setMessage('');
    try { if(remove)await bridge.request({name:'removeProfileMedia',kind});else if(file)await uploadProfileImage(bridge,kind,file);setMessage('Imagem atualizada.'); }
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const profile=session.profile;
  const shown=draft.display_name||session.account.username;
  const theme=draft.profile_theme_start&&draft.profile_theme_end?`linear-gradient(${draft.profile_theme_start},${draft.profile_theme_end})`:undefined;
  return <ModalLayer closing={closing} onRequestClose={discard?()=>{}:finish}>
    <section class="tri-profile-editor" role="dialog" aria-label="Perfil principal">
      <header><h1>Perfil principal</h1></header>
      <button class="tri-profile-editor__close" aria-label="Fechar perfil" disabled={busy} onClick={finish}><Icon name="Close" size={24}/></button>
      <form id="tri-profile-form" class="tri-profile-editor__body" aria-busy={loading||busy} onSubmit={async e=>{
          e.preventDefault();setBusy(true);setError('');setMessage('');
          try{const p=await bridge.request<OwnProfile>({name:'saveOwnProfile',fields:draft});setDraft(fields(p));setSaved(fields(p));setMessage('Perfil salvo.');}
          catch(e){setError((e as Error).message);}finally{setBusy(false);}
        }}>
          <fieldset class="tri-profile-editor__fields tri-profile-editor__appearance" disabled={busy||!ready}>
            <legend class="tri-profile-editor__sr">Editar perfil</legend>
            <h2>Avatar e decorações</h2>
            <div class="tri-profile-editor__media">
              <label class="tri-button tri-button--secondary">Alterar avatar<input aria-label="Alterar avatar" type="file" accept="image/png,image/jpeg,image/gif" onChange={e=>{const f=e.currentTarget.files?.[0];e.currentTarget.value='';if(f)void media('avatar',f);}}/></label>
              <button type="button" class="tri-button tri-button--secondary" disabled={!profile?.hasAvatar} onClick={()=>void media('avatar',undefined,true)}>Remover avatar</button>
            </div>
            <h2>Faixa do perfil</h2>
            <div class="tri-profile-editor__media">
              <label class="tri-button tri-button--secondary">Alterar faixa<input aria-label="Alterar faixa" type="file" accept="image/png,image/jpeg,image/gif" onChange={e=>{const f=e.currentTarget.files?.[0];e.currentTarget.value='';if(f)void media('banner',f);}}/></label>
              <button type="button" class="tri-button tri-button--secondary" disabled={!profile?.hasBanner} onClick={()=>void media('banner',undefined,true)}>Remover faixa</button>
            </div>
            <p class="tri-profile-editor__hint">PNG, JPEG ou GIF. Avatar: até 512 KB. Faixa: até 1 MB. As imagens são atualizadas ao selecionar o arquivo.</p>
            <label>Cor da faixa<input aria-label="Cor da faixa" type="color" value={draft.banner_color||'#000000'} onInput={e=>change('banner_color',e.currentTarget.value)}/></label>
            <h2>Tema de perfil</h2><div class="tri-profile-editor__colors">
              <label>Cor primária<input type="color" aria-label="Cor primária" value={draft.profile_theme_start||'#111214'} onInput={e=>change('profile_theme_start',e.currentTarget.value)}/></label>
              <label>Cor secundária<input type="color" aria-label="Cor secundária" value={draft.profile_theme_end||'#111214'} onInput={e=>change('profile_theme_end',e.currentTarget.value)}/></label>
              <button type="button" onClick={()=>setDraft({...draft,profile_theme_start:null,profile_theme_end:null})}>Redefinir tema</button>
            </div>
          </fieldset>
        <aside class="tri-profile-preview" aria-label="Prévia do perfil" style={{background:theme}}>
          <div class="tri-profile-preview__banner" style={{backgroundColor:draft.banner_color||'#000000'}}>{profile?.bannerDataUrl&&<img src={profile.bannerDataUrl} alt="Faixa do perfil"/>}</div>
          <div class="tri-profile-preview__avatar">{profile?.avatarDataUrl?<img src={profile.avatarDataUrl} alt="Avatar"/>:<span>{shown.slice(0,1).toUpperCase()}</span>}</div>
          <div class="tri-profile-preview__text"><h2>{shown}</h2><p>{session.account.username}{draft.pronouns?` · ${draft.pronouns}`:''}</p>
            <h3>Bio</h3><p class={!draft.bio?'is-empty':''}>{draft.bio||'Escreva uma breve introdução'}</p>
            {!!profile?.created_at&&<><h3>Membro desde</h3><p>{new Date(profile.created_at).toLocaleDateString('pt-BR',{day:'numeric',month:'short',year:'numeric'})}</p></>}
            <h3>Nota (visível apenas para você)</h3><p class={!draft.note?'is-empty':''}>{draft.note||'Clique para adicionar uma nota'}</p>
          </div>
        </aside>
        <fieldset class="tri-profile-editor__fields tri-profile-editor__details" disabled={busy||!ready}>
          <legend class="tri-profile-editor__sr">Informações do perfil</legend>
          <h2>Informações do perfil</h2>
          {([['display_name','Nome de exibição',32],['pronouns','Pronomes',40],['bio','Bio',190],['note','Nota (visível apenas para você)',256]] as const).map(([key,label,max])=><label key={key}>{label}
            {key==='bio'||key==='note'?<textarea aria-label={label} value={draft[key]||''} maxLength={max} onInput={e=>change(key,e.currentTarget.value)}/>
              :<input aria-label={label} value={draft[key]||''} maxLength={max} onInput={e=>change(key,e.currentTarget.value)}/>}
          </label>)}
        </fieldset>
      </form>
      <footer><span role={error?'alert':'status'}>{loading?'Carregando perfil…':error||message|| (dirty?'Você tem alterações não salvas.':'')}</span>
        {!loading&&!ready&&<button type="button" class="tri-button tri-button--secondary" disabled={busy} onClick={()=>setLoadAttempt(attempt=>attempt+1)}>Tentar carregar novamente</button>}
        <button class="tri-button tri-button--secondary" disabled={busy||loading||!dirty} onClick={()=>{setDraft(saved);setMessage('');}}>Redefinir</button>
        <ShimmerButton type="submit" form="tri-profile-form" variant="aurora" disabled={busy||!ready||!dirty}>Salvar alterações</ShimmerButton>
      </footer>
    </section>
    {discard&&<Modal title="Descartar alterações?" subtitle="Suas alterações de texto não salvas serão perdidas." onClose={()=>setDiscard(false)}
      actions={[{label:'Cancelar',variant:'secondary',onClick:()=>setDiscard(false)},{label:'Descartar',variant:'critical',onClick:()=>{setDiscard(false);close();}}]}/>}
  </ModalLayer>;
}
