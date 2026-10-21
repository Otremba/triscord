// Unit checks of returned VNodes/handlers only. No DOM, browser or native bridge is started.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle=await build({stdin:{contents:`export {WorkspaceNav} from './components/WorkspaceNav';export {ShimmerButton} from './components/ui/ShimmerButton';`,resolveDir:fileURLToPath(new URL('../src/',import.meta.url)),loader:'tsx'},bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',jsxImportSource:'preact'});
const {WorkspaceNav,ShimmerButton}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
function nodes(root){if(!root||typeof root!=='object')return [];const children=[root.props?.children].flat(Infinity);return [root,...children.flatMap(nodes)];}
const sent=[];
const servers=Array.from({length:8},(_,i)=>({id:`server-${i}`,name:`Espaço ${i}`,owned:i===0}));
const view=WorkspaceNav({session:{servers,selectedServerId:'server-0'},bridge:{send:command=>sent.push(command)}});
const tree=nodes(view);
const picker=tree.find(node=>node.type==='select');
assert.deepEqual(nodes(picker).filter(node=>node.type==='option').map(node=>node.props.value),['@me',...servers.map(server=>server.id)],'every server remains reachable even when recent shortcuts are bounded');
picker.props.onChange({currentTarget:{value:'server-7'}});
assert.deepEqual(sent.pop(),{name:'selectServer',serverId:'server-7'});
const home=tree.find(node=>node.props?.['aria-label']==='Triscord, ir para o início');
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
