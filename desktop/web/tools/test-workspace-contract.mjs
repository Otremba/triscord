// Unit checks of returned VNodes/handlers only. No DOM, browser or native bridge is started.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle=await build({stdin:{contents:`export {WorkspaceNav} from './components/WorkspaceNav';export {ShimmerButton} from './components/ui/ShimmerButton';export {DeviceSelect,deviceChoices} from './components/ui/DeviceSelect';export {modalTabTarget} from './focus-policy';export {MemberList} from './components/MemberList';export {FixtureBridge} from './bridge';export {fixtureSession} from './fixtures';export {participantMenuEntries} from './components/ParticipantMenu';export {callTiles} from './components/CallView';`,resolveDir:fileURLToPath(new URL('../src/',import.meta.url)),loader:'tsx'},bundle:true,write:false,define:{'location.search':'""'},loader:{'.png':'dataurl','.css':'empty'},platform:'node',format:'esm',jsx:'automatic',jsxImportSource:'preact'});
const {WorkspaceNav,ShimmerButton,DeviceSelect,deviceChoices,modalTabTarget,MemberList,FixtureBridge,fixtureSession,participantMenuEntries,callTiles}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
function nodes(root){if(!root||typeof root!=='object')return [];const children=[root.props?.children].flat(Infinity);return [root,...children.flatMap(nodes)];}
const sent=[];
const servers=Array.from({length:8},(_,i)=>({id:`server-${i}`,name:`Espaço ${i}`,owned:i===0}));
const view=WorkspaceNav({session:{servers,selectedServerId:'server-0'},bridge:{send:command=>sent.push(command)}});
const tree=nodes(view);
const picker=tree.find(node=>node.type==='select');
assert.deepEqual(nodes(picker).filter(node=>node.type==='option').map(node=>node.props.value),['@me',...servers.map(server=>server.id)],'every server remains reachable even when recent shortcuts are bounded');
picker.props.onChange({currentTarget:{value:'server-7'}});
assert.deepEqual(sent.pop(),{name:'selectServer',serverId:'server-7'});
const home=tree.find(node=>node.props?.['aria-label']==='Ir para o início');
home.props.onClick();assert.deepEqual(sent.pop(),{name:'selectServer',serverId:'@me'});
const empty=WorkspaceNav({session:{servers:[],selectedServerId:''},bridge:{send:()=>{}}});
assert.equal(nodes(empty).find(node=>node.type==='select').props.value,'@me');
assert.ok(nodes(empty).some(node=>node.props?.['aria-label']==='Adicionar servidor ou aceitar convite'),'creation/invite entry remains available without servers');
const submit=ShimmerButton({class:'w-full',className:'profile-save',type:'submit',form:'profile',disabled:true,children:'Salvar'});
assert.match(submit.props.class,/tri-shimmer-btn/,'Preact class must not replace component styles');
assert.match(submit.props.class,/w-full/);assert.match(submit.props.class,/profile-save/);
assert.equal(submit.props.type,'submit');assert.equal(submit.props.form,'profile');assert.equal(submit.props.disabled,true);
assert.equal(ShimmerButton({children:'Abrir'}).props.type,'button','an action button must not submit an enclosing form implicitly');
console.log('Workspace contracts: complete server picker, native commands, empty navigation and button form semantics passed');

const devices=[{id:'mic-1',name:'Microfone USB',isDefault:true},{id:'mic-2',name:'Microfone da câmera'},{id:'mic-1',name:'Repeated provider entry'},{id:'',name:'Provider default alias'}];
const choices=deviceChoices('mic-1',devices);
assert.deepEqual(choices.map(option=>option.id),['','mic-1','mic-2'],'each physical id and system-default choice must appear once');
assert.match(choices[0].name,/Padrão do Windows.*Microfone USB/);
const removed=deviceChoices('disconnected-mic',devices);
assert.equal(removed.at(-1).id,'disconnected-mic');
assert.equal(removed.at(-1).unavailable,true,'disconnection must remain explicit rather than silently selecting default');
assert.deepEqual(deviceChoices('',[]),[{id:'',name:'Padrão do Windows',unavailable:false}]);
const changes=[];
const deviceView=DeviceSelect({value:'mic-1',options:devices,label:'Microfone',onChange:id=>changes.push(id)});
const devicePicker=nodes(deviceView).find(node=>node.type==='select');
assert.equal(devicePicker.props.value,'mic-1');
assert.equal(devicePicker.props['aria-label'],'Microfone');
devicePicker.props.onChange({currentTarget:{value:'mic-1'}});
assert.deepEqual(changes,[],'reselecting the same device must not reinitialize media');
devicePicker.props.onChange({currentTarget:{value:''}});
assert.deepEqual(changes,[''],'selecting the system default must preserve the empty-id contract');
console.log('Device selector: defaults, removed devices, duplicate ids and explicit changes passed without devices or DOM');

const focusControls=[{name:'first'},{name:'middle'},{name:'last'}];
assert.equal(modalTabTarget(focusControls,focusControls[0],true),focusControls[2],'Shift+Tab wraps to the last control');
assert.equal(modalTabTarget(focusControls,focusControls[2],false),focusControls[0],'Tab wraps to the first control');
assert.equal(modalTabTarget(focusControls,focusControls[1],false),undefined,'interior traversal stays native');
assert.equal(modalTabTarget(focusControls,focusControls[1],true),undefined);
assert.equal(modalTabTarget(focusControls,{name:'behind-modal'},false),focusControls[0],'focus outside is brought to the current dialog');
assert.equal(modalTabTarget(focusControls,null,true),focusControls[2]);
assert.equal(modalTabTarget([],null,false),null,'empty dialogs need a focusable fallback');
assert.equal(modalTabTarget([focusControls[0]],focusControls[0],false),focusControls[0]);
console.log('Modal focus policy: wrap, outside focus, empty and single-control dialogs passed without DOM');

const memberSession={servers:[{id:'space',name:'Space',owned:false}],selectedServerId:'space',account:{id:'account-me',displayName:'Alice',username:'alice',status:'invisible'},categories:[{channels:[{users:[
  {id:'socket-me',self:true,name:'Alice',muted:false,deafened:false},
  {id:'socket-bob-1',accountId:'account-bob',name:'Bob',muted:false,deafened:false},
  {id:'socket-bob-2',accountId:'account-bob',name:'Bob',muted:false,deafened:false},
]}]}]};
const memberButtons=nodes(MemberList({session:memberSession,bridge:{send:()=>{}}})).filter(node=>node.type==='button').map(node=>node.props['aria-label']);
assert.deepEqual(memberButtons.sort(),['Abrir perfil de Alice','Abrir perfil de Bob'],'account, self socket and extra sockets must not duplicate a member');
console.log('Member identities: self socket and repeated account connections deduplicated');

const fixtureBridge=new FixtureBridge(fixtureSession('home'));
const beforeProfile=await fixtureBridge.request({name:'getOwnProfile'});
assert.equal(beforeProfile.display_name,'camargo');
const afterProfile=await fixtureBridge.request({name:'saveOwnProfile',fields:{display_name:'Visual review'}});
assert.equal(afterProfile.display_name,'Visual review');
assert.equal(afterProfile.bio,beforeProfile.bio,'review saves must retain fields not edited');
await assert.rejects(new FixtureBridge(fixtureSession('profile-error')).request({name:'getOwnProfile'}),/simulada/);
console.log('Review fixtures: local profile save and explicit load failure passed without network');

const focusSession=fixtureSession('stream-focus');
assert.deepEqual(focusSession.callFocus,{key:'scr:bob',filmOpen:true},'stream-focus fixture specifies stage focus on bob stream');
const tiles=callTiles(focusSession);
assert.ok(tiles.some(t=>t.key==='scr:bob'&&t.kind==='stream'),'stream-focus includes bob stream card');

let patched=null;
const callBridge=new FixtureBridge(fixtureSession('stream'));
callBridge.onMessage(msg=>{if(msg.type==='delta')patched=msg.patch;});
callBridge.send({name:'setCallFocus',key:'scr:bob',filmOpen:false});
assert.deepEqual(patched,{callFocus:{key:'scr:bob',filmOpen:false}},'FixtureBridge updates callFocus');
callBridge.send({name:'setCallFullscreen',on:true});
assert.deepEqual(patched,{callFullscreen:true},'FixtureBridge updates callFullscreen');
callBridge.send({name:'setStreamHidden',streamId:'scr:bob',hidden:true});
assert.equal(patched?.streams?.[0]?.hidden,true,'FixtureBridge updates stream hidden state');

const tauriSession={...fixtureSession('call'),runtime:{name:'tauri',preview:true,voice:true,screen:true,camera:false,googleLogin:true}};
const peerUser=tauriSession.categories[0].channels[0].users.find(u=>u.id==='bob');
const tauriSent=[];
const tauriBridgeMock={send:cmd=>tauriSent.push(cmd)};
const tauriEntries=participantMenuEntries(peerUser,tauriSession,tauriBridgeMock);
const tauriLabels=tauriEntries.map(e=>e.label).filter(Boolean);
assert.ok(tauriLabels.includes('Silenciar para mim'),'Tauri runtime provides working local mute');
assert.ok(!tauriLabels.includes('Volume do usuário'),'Tauri runtime omits unsupported individual volume slider');
assert.ok(!tauriLabels.includes('Volume da transmissão'),'Tauri runtime omits unsupported stream volume slider');
assert.ok(!tauriLabels.includes('Silenciar transmissão'),'Tauri runtime omits stream mute');

const muteEntry=tauriEntries.find(e=>e.label==='Silenciar para mim');
muteEntry.action();
assert.deepEqual(tauriSent.pop(),{name:'setPeerAudio',socketId:'bob',muted:true});

const webSession={...fixtureSession('stream')};
const webPeerUser=webSession.categories[0].channels[0].users.find(u=>u.id==='bob');
const webEntries=participantMenuEntries(webPeerUser,webSession,tauriBridgeMock);
const webLabels=webEntries.map(e=>e.label).filter(Boolean);
assert.ok(webLabels.includes('Volume do usuário'),'Standard runtime includes user volume slider');
assert.ok(webLabels.includes('Volume da transmissão'),'Standard runtime includes stream volume slider for live users');
console.log('Call focus, stream hidden and participant actions: stage focus, fixture bridge and Tauri volume omission verified');

