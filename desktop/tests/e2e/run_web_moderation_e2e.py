"""Room moderation through two real C++/WebView2 clients and local Workers/D1. No physical audio/video."""
import argparse,json,shutil,sys,tempfile,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from run_e2e import Backend,DESKTOP,bundle_workers
from run_web_call_e2e import account,profile,launch
from run_web_e2e import request
from run_web_profile_e2e import last
COMMON=r"""
const log=window.__e2e={},s=()=>window.__triscord.store.current,b=window.__triscord.bridge;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test,label){const end=Date.now()+16000;while(Date.now()<end){if(test())return;await sleep(60);}throw Error(label);}
const channel=()=>s().categories.flatMap(c=>c.channels).find(c=>c.name==='Moderação E2E');
const user=name=>channel()?.users.find(u=>u.name===name),me=()=>channel()?.users.find(u=>u.self);
const reject=command=>b.request(command).then(()=>false,()=>true);
async function chat(text){await sleep(550);b.send({name:'sendChatMessage',text});}
const said=text=>s().chat?.some(m=>m.text===text);
async function menu(name,card=false){const el=document.querySelector(card?`.tri-call-card[aria-label="${name}"]`:`.tri-voice-user[aria-label="Ver perfil de ${name}"]`);if(!el)throw Error('missing participant '+name);el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:240}));await wait(()=>document.querySelector('[role="menu"]'),'menu');}
const item=text=>[...document.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"]')].find(x=>x.textContent.trim()===text);
async function close(){dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('[role="menu"]'),'menu closed');}
"""
ALICE=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().auth?.state==='signedIn','auth');b.send({name:'createChannel',channelName:'Moderação E2E'});await wait(()=>user('Bob')&&said('bob-ready'),'Bob ready');
const room=channel().id,id=user('Bob').id,self=me().id;
log.owner=channel().ownerId===self;
log.unknown=await reject({name:'setServerMuted',socketId:'missing',muted:true});
log.badBool=await reject({name:'setServerMuted',socketId:id,muted:1});
log.extra=await reject({name:'setServerMuted',socketId:id,muted:true,role:'owner'});
log.noSelfKick=await reject({name:'disconnectParticipant',socketId:self});
await menu('Bob',true);log.callMenu=!!item('Desconectar');log.unchecked=item('Silenciar voz no servidor')?.getAttribute('aria-checked')==='false';
item('Silenciar voz no servidor').click();await wait(()=>user('Bob')?.serverMuted,'mute propagated');log.muted=user('Bob').muted;
const badge=document.querySelector('.tri-voice-user[aria-label="Ver perfil de Bob"] [aria-label="Silenciado na sala"]');log.badge=!!badge;
const colour=document.createElement('span');colour.style.color='var(--icon-feedback-critical)';document.body.append(colour);log.badgeColor=getComputedStyle(badge.querySelector('svg')).color===getComputedStyle(colour).color;colour.remove();
await wait(()=>said('bob-rejoined-muted'),'persistent mute');log.rejoin=user('Bob').serverMuted;
await menu('Bob');log.checked=item('Silenciar voz no servidor')?.getAttribute('aria-checked')==='true';item('Silenciar voz no servidor').click();
await wait(()=>said('bob-can-talk'),'unmuted');log.released=!user('Bob').serverMuted&&!user('Bob').muted;
await menu('Alice');log.selfMute=!!item('Silenciar voz no servidor')&&!item('Desconectar');await wait(()=>document.activeElement?.getAttribute('role')==='menu','keyboard menu focus');log.keyboard=true;
for(const key of ['ArrowDown','ArrowDown','ArrowDown','ArrowDown',' ']){document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));await sleep(80);} await wait(()=>me()?.serverMuted&&s().muted,'self muted');
log.selfUnmuteBlocked=await reject({name:'setMuted',muted:false});await b.request({name:'setServerMuted',socketId:self,muted:false});await wait(()=>!me()?.serverMuted,'self released');log.selfRemainsMuted=s().muted;await b.request({name:'setMuted',muted:false});
chat('camera-now');await wait(()=>s().streams?.some(x=>x.kind==='camera'),'camera');await menu('Bob');item('Desconectar').click();await wait(()=>!user('Bob'),'kicked');log.kick=true;
await wait(()=>said('bob-back'),'Bob back');
b.send({name:'leaveVoice'});await wait(()=>!s().connectedChannelId&&channel()?.ownerId===id,'owner moved');log.outside=await reject({name:'disconnectParticipant',socketId:id});
b.send({name:'selectChannel',channelId:room});await wait(()=>s().connectedChannelId===room&&me(),'rejoined');
log.lostAuthority=await reject({name:'setServerMuted',socketId:id,muted:true});await menu('Bob');log.ownerMenuGone=!item('Desconectar')&&!item('Silenciar voz no servidor');await close();
chat('ownership-checked');await wait(()=>me()?.serverMuted,'new owner muted me');log.newOwnerWorks=true;chat('new-owner-observed');
await wait(()=>!me()?.serverMuted,'new owner released me');log.done=true;
})().catch(e=>log.error=e.message);return 'moderation Alice started';})()""".replace('COMMON',COMMON)
BOB=r"""(()=>{COMMON
(async()=>{
await wait(()=>channel(),'room');const room=channel().id;b.send({name:'selectChannel',channelId:room});await wait(()=>s().connectedChannelId===room&&user('Alice')&&me(),'joined');
const alice=user('Alice').id,self=me().id;
await menu('Alice');log.noOwnerMenu=!item('Desconectar')&&!item('Silenciar voz no servidor');await close();
log.deniedMute=await reject({name:'setServerMuted',socketId:alice,muted:true});log.deniedKick=await reject({name:'disconnectParticipant',socketId:alice});log.deniedSelfMute=await reject({name:'setServerMuted',socketId:self,muted:true});chat('bob-ready');
await wait(()=>me()?.serverMuted&&s().muted,'muted');log.unmuteBlocked=await reject({name:'setMuted',muted:false});
b.send({name:'leaveVoice'});await wait(()=>!s().connectedChannelId,'left');await sleep(500);b.send({name:'selectChannel',channelId:room});await wait(()=>s().connectedChannelId===room&&me()?.serverMuted,'rejoined muted');log.persistent=s().muted;chat('bob-rejoined-muted');
await wait(()=>!me()?.serverMuted,'released');log.stillMuted=s().muted;await b.request({name:'setMuted',muted:false});chat('bob-can-talk');
await wait(()=>said('camera-now'),'camera requested');b.send({name:'setCamera',on:true});await wait(()=>s().camera,'camera on');
await wait(()=>!s().connectedChannelId,'kicked');log.kickClean=!s().camera&&!s().streams?.length&&!s().callPopout;await sleep(700);
b.send({name:'selectChannel',channelId:room});await wait(()=>s().connectedChannelId===room,'back');chat('bob-back');
await wait(()=>channel()?.ownerId===self,'owner transferred');log.newOwner=true;await wait(()=>said('ownership-checked'),'Alice ready');
await menu('Alice');log.ownerMenu=!!item('Desconectar')&&!!item('Silenciar voz no servidor');item('Silenciar voz no servidor').click();await wait(()=>said('new-owner-observed'),'Alice saw moderation');await b.request({name:'setServerMuted',socketId:alice,muted:false});await wait(()=>!user('Alice')?.serverMuted,'released');await menu('Alice');log.done=true;
})().catch(e=>log.error=e.message);return 'moderation Bob started';})()""".replace('COMMON',COMMON)
PROBE="JSON.stringify(window.__e2e)"

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--exe',required=True);parser.add_argument('--assets',default=str(DESKTOP/'web/dist'));args=parser.parse_args()
    work=Path(tempfile.mkdtemp(prefix='triscord-moderation-'));report=DESKTOP/'out/web-moderation-e2e-report';report.mkdir(parents=True,exist_ok=True)
    backend=None;processes=[];logs=[];passed=False
    try:
        backend=Backend(*bundle_workers(DESKTOP/'out/moderation-e2e-backend'),report/'backend.log');config=backend.config;google=config['googleAuthUrl'].rsplit('/',1)[0]
        at,a=account(config,google,'mod-alice','Alice');bt,bc=account(config,google,'mod-bob','Bob');a['nick']='Alice';bc['nick']='Bob'
        server=request(config['hubUrl']+'/servers','POST',{'name':'Moderação'},at);code=request(f"{config['hubUrl']}/servers/{server['id']}/invites",'POST',{},at)['code'];request(config['hubUrl']+'/invites/'+code+'/accept','POST',{},bt)
        (work/'probe.js').write_text(PROBE,encoding='utf8');(work/'alice.js').write_text(ALICE,encoding='utf8');(work/'bob.js').write_text(BOB,encoding='utf8')
        for name,token,acct,delay in [('alice',at,a,0),('bob',bt,bc,4)]:
            if delay:time.sleep(delay)
            log=(report/f'{name}.log').open('w',encoding='utf8');logs.append(log)
            processes.append(launch(args.exe,args.assets,config,profile(work,name,token,acct,server['id']),work/f'{name}.js',2500,work/'probe.js',62000 if name=='alice' else 58000,report/f'{name}.png',72 if name=='alice' else 68,log))  # quit-after counts from launch, the probe from the first snapshot: 10 s of margin
        for p in processes:p.wait(timeout=90)
        for log in logs:log.close()
        ar=last(report/'alice.log');br=last(report/'bob.log');print('Alice:',json.dumps(ar,ensure_ascii=False));print('Bob:',json.dumps(br,ensure_ascii=False))
        keys=['owner','unknown','badBool','extra','noSelfKick','callMenu','unchecked','muted','badge','badgeColor','rejoin','checked','released','selfMute','keyboard','selfUnmuteBlocked','selfRemainsMuted','kick','outside','lostAuthority','ownerMenuGone','newOwnerWorks','done']
        checks={key:ar.get(key) is True for key in keys};checks.update({f'Bob {key}':br.get(key) is True for key in ['noOwnerMenu','deniedMute','deniedKick','deniedSelfMute','unmuteBlocked','persistent','stillMuted','kickClean','newOwner','ownerMenu','done']});checks['no errors']=not ar.get('error') and not br.get('error')
        for name,ok in checks.items():print(('PASS: ' if ok else 'FAIL: ')+name)
        passed=all(checks.values());(report/'result.json').write_text(json.dumps({'passed':passed,'checks':checks,'alice':ar,'bob':br},ensure_ascii=False,indent=2),encoding='utf8')
    finally:
        for p in processes:
            if p.poll() is None:p.kill();p.wait()
        for log in logs:
            if not log.closed:log.close()
        if backend:backend.close()
        if work.resolve().parent!=Path(tempfile.gettempdir()).resolve() or not work.name.startswith('triscord-moderation-'):raise RuntimeError('Unsafe cleanup')
        shutil.rmtree(work)
    return 0 if passed else 1
if __name__=='__main__':sys.exit(main())
