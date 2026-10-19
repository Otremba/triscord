"""Local participant audio controls, real native web clients + isolated Workers/D1, silent audio."""
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
async function wait(test,label){const end=Date.now()+14000;while(Date.now()<end){if(test())return;await sleep(60);}throw Error(label);}
const users=()=>s().categories.flatMap(c=>c.channels).flatMap(c=>c.users),bob=()=>users().find(u=>u.name==='Bob');
const row=()=>document.querySelector('[aria-label="Ver perfil de Bob"]');
const dialog=()=>document.querySelector('[role="dialog"][aria-label="Áudio de Bob"]');
async function menu(anchor){anchor.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:240}));await wait(()=>document.querySelector('[role="menuitem"]'),'menu');
[...document.querySelectorAll('[role="menuitem"]')].find(x=>x.textContent.includes('Áudio do participante')).click();await wait(()=>dialog(),'audio dialog');}
async function range(label,value){const input=document.querySelector(`[aria-label="${label}"]`);input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));await sleep(80);}
const reject=command=>b.request(command).then(()=>false,()=>true);
"""
ALICE=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().auth?.state==='signedIn','auth');b.send({name:'createChannel',channelName:'Áudio E2E'});
await wait(()=>bob(),'Bob');const room=s().connectedChannelId,id=bob().id,self=users().find(u=>u.self).id;
await menu(row());log.menu=true;log.focus=document.activeElement?.getAttribute('aria-label')==='Volume do usuário';
await range('Volume do usuário',35);await wait(()=>bob().volume===35,'volume');
await range('Posição do áudio',-60);await wait(()=>bob().pan===-60,'pan');
dialog().querySelector('input[type=checkbox]').click();await wait(()=>bob().localMuted===true,'local muted');
log.settings=true;log.badge=!!row().querySelector('[aria-label="Silenciado para você"]');log.remoteMicUnchanged=bob().muted===false;
dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!dialog(),'closed');log.escape=document.activeElement===row();
row().click();await wait(()=>document.querySelector('.tri-participant-profile .tri-peer-audio'),'profile audio');
log.profile=+document.querySelector('[aria-label="Volume do usuário"]').value===35&&+document.querySelector('[aria-label="Posição do áudio"]').value===-60&&document.querySelector('.tri-peer-audio input[type=checkbox]').checked;
await range('Volume do usuário',125);await range('Posição do áudio',60);document.querySelector('.tri-peer-audio input[type=checkbox]').click();await wait(()=>bob().volume===125&&bob().pan===60&&!bob().localMuted,'profile changes');log.profileChanges=true;
document.querySelector('.tri-peer-audio__reset').click();await wait(()=>bob().volume===100&&bob().pan===0&&!bob().localMuted,'reset');log.reset=true;
dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('.tri-participant-profile'),'profile closed');
for(const [key,fields] of Object.entries({tooLoud:{volume:201},negative:{volume:-1},fraction:{volume:1.5},badPan:{pan:101},badBool:{muted:1},badString:{volume:'20'},empty:{},extra:{volume:20,accountId:'other'}}))log[key]=await reject({name:'setPeerAudio',socketId:id,...fields});
log.selfRejected=await reject({name:'setPeerAudio',socketId:self,muted:true});log.unknownRejected=await reject({name:'setPeerAudio',socketId:'unknown',volume:0});
await b.request({name:'setPeerAudio',socketId:id,volume:200,pan:100,muted:true});await menu(row());b.send({name:'sendChatMessage',text:'audio-e2e-cycle'});
await wait(()=>!bob(),'Bob left');await wait(()=>!dialog(),'closed after peer left');log.departure=true;
await wait(()=>bob(),'Bob rejoined');log.peerReset=bob().volume===100&&bob().pan===0&&!bob().localMuted;
await b.request({name:'setPeerAudio',socketId:id,volume:55,pan:-50,muted:true});b.send({name:'leaveVoice'});await wait(()=>!s().connectedChannelId,'left call');
log.outsideRejected=await reject({name:'setPeerAudio',socketId:id,volume:5});b.send({name:'selectChannel',channelId:room});await wait(()=>s().connectedChannelId===room,'rejoined');
await wait(()=>users().some(u=>u.self)&&bob(),'directory');log.ownReset=bob().volume===100&&bob().pan===0&&!bob().localMuted;
await menu(document.querySelector('.tri-call-card[aria-label="Bob"]'));log.callMenu=true;
await range('Volume do usuário',80);await range('Posição do áudio',20);await wait(()=>bob().volume===80&&bob().pan===20,'final values');
log.visible=!!dialog();log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()""".replace('COMMON',COMMON)
BOB=r"""(()=>{COMMON
log.localOnly=true;window.__triscord.store.subscribe(state=>{if(state.categories.flatMap(c=>c.channels).flatMap(c=>c.users).some(u=>(u.volume??100)!==100||(u.pan??0)!==0||u.localMuted))log.localOnly=false;});
(async()=>{
await wait(()=>s().categories.flatMap(c=>c.channels).some(c=>c.name==='Áudio E2E'),'room');const channel=s().categories.flatMap(c=>c.channels).find(c=>c.name==='Áudio E2E');
b.send({name:'selectChannel',channelId:channel.id});await wait(()=>s().connectedChannelId===channel.id,'joined');const muted=s().muted;
await wait(()=>s().chat?.some(m=>m.text==='audio-e2e-cycle'),'Alice ready');log.micUnchanged=s().muted===muted;b.send({name:'leaveVoice'});await sleep(1800);
b.send({name:'selectChannel',channelId:channel.id});await wait(()=>s().connectedChannelId===channel.id,'rejoined');log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()""".replace('COMMON',COMMON)
PROBE="JSON.stringify({...window.__e2e,visible:!!document.querySelector('[role=dialog][aria-label=\"Áudio de Bob\"]')})"
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--exe',required=True);parser.add_argument('--assets',default=str(DESKTOP/'web/dist'));args=parser.parse_args()
    work=Path(tempfile.mkdtemp(prefix='triscord-peer-audio-'));report=DESKTOP/'out/web-peer-audio-e2e-report';report.mkdir(parents=True,exist_ok=True)
    backend=None;processes=[];logs=[];passed=False
    try:
        backend=Backend(*bundle_workers(DESKTOP/'out/peer-audio-e2e-backend'),report/'backend.log');config=backend.config;google=config['googleAuthUrl'].rsplit('/',1)[0]
        at,a=account(config,google,'peer-audio-alice','Alice');bt,bobacct=account(config,google,'peer-audio-bob','Bob');a['nick']='Alice';bobacct['nick']='Bob'
        server=request(config['hubUrl']+'/servers','POST',{'name':'Áudio local'},at);code=request(f"{config['hubUrl']}/servers/{server['id']}/invites",'POST',{},at)['code'];request(config['hubUrl']+'/invites/'+code+'/accept','POST',{},bt)
        (work/'probe.js').write_text(PROBE,encoding='utf8');(work/'alice.js').write_text(ALICE,encoding='utf8');(work/'bob.js').write_text(BOB,encoding='utf8')
        for name,token,acct,delay in [('alice',at,a,0),('bob',bt,bobacct,5)]:
            if delay:time.sleep(delay)
            log=(report/f'{name}.log').open('w',encoding='utf8');logs.append(log)
            processes.append(launch(args.exe,args.assets,config,profile(work,name,token,acct,server['id']),work/f'{name}.js',2500,work/'probe.js',29000 if name=='alice' else 24000,report/f'{name}.png',32 if name=='alice' else 27,log))
        for p in processes:p.wait(timeout=60)
        for log in logs:log.close()
        ar=last(report/'alice.log');br=last(report/'bob.log');print('Alice:',json.dumps(ar,ensure_ascii=False));print('Bob:',json.dumps(br,ensure_ascii=False))
        keys=['menu','focus','settings','badge','remoteMicUnchanged','escape','profile','profileChanges','reset','tooLoud','negative','fraction','badPan','badBool','badString','empty','extra','selfRejected','unknownRejected','departure','peerReset','outsideRejected','ownReset','callMenu','visible','done']
        checks={key:ar.get(key) is True for key in keys};checks.update({f'Bob {key}':br.get(key) is True for key in ['localOnly','micUnchanged','done']})
        for name,ok in checks.items():print(('PASS: ' if ok else 'FAIL: ')+name)
        passed=all(checks.values())
    finally:
        for p in processes:
            if p.poll() is None:p.kill();p.wait()
        for log in logs:
            if not log.closed:log.close()
        if backend:backend.close()
        if work.resolve().parent!=Path(tempfile.gettempdir()).resolve() or not work.name.startswith('triscord-peer-audio-'):raise RuntimeError('Unsafe cleanup')
        shutil.rmtree(work)
    return 0 if passed else 1
if __name__=='__main__':sys.exit(main())
