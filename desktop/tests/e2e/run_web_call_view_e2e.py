"""Native fullscreen + locally hidden camera: two real clients and local Workers/D1, silent synthetic media."""
import argparse,json,re,shutil,sys,tempfile,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from run_e2e import Backend,DESKTOP,bundle_workers
from run_web_call_e2e import account,profile,launch
from run_web_e2e import request
from run_web_profile_e2e import last
COMMON=r"""
const log=window.__e2e={},s=()=>window.__triscord.store.current,b=window.__triscord.bridge;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test,label){const end=Date.now()+14000;while(Date.now()<end){if(test())return;await sleep(80);}throw Error(label);}
const tile=()=>document.querySelector('.tri-video-tile');
const stream=()=>s().streams?.find(x=>x.kind==='camera');
const click=label=>document.querySelector(`[aria-label="${label}"]`).click();
async function cardMenu(label){tile().dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:250}));await wait(()=>document.querySelector('[role="menu"]'),'card menu');const item=[...document.querySelectorAll('[role="menuitem"]')].find(x=>x.textContent.trim()===label);if(!item)throw Error('missing menu '+label);item.click();}
const reject=command=>b.request(command).then(()=>false,()=>true);
async function enter(){click('Tela cheia');await wait(()=>s().callFullscreen===true,'native fullscreen');await sleep(300);}
async function exit(){click('Sair da tela cheia');await wait(()=>!s().callFullscreen,'exit fullscreen');await sleep(300);}
"""
ALICE=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().auth?.state==='signedIn','auth');log.noCall=await reject({name:'setCallFullscreen',on:true});
log.badFullscreen=await reject({name:'setCallFullscreen',on:1});
b.send({name:'createChannel',channelName:'Tela E2E'});await wait(()=>stream()&&tile(),'Bob camera');await sleep(1200);
const room=s().connectedChannelId,id=stream().id,initial={w:innerWidth,h:innerHeight};
click('Mostrar chat');await wait(()=>document.querySelector('.tri-composer__input'),'chat');const input=document.querySelector('.tri-composer__input');input.value='Rascunho preservado';input.dispatchEvent(new Event('input',{bubbles:true}));await sleep(100);
await enter();log.fullscreen=getComputedStyle(document.querySelector('.tri-sidebar')).display==='none'&&getComputedStyle(document.querySelector('.tri-titlebar')).display==='none';
log.stage=document.querySelector('.tri-page').getBoundingClientRect().width>=innerWidth-2;
log.chatHidden=getComputedStyle(document.querySelector('.tri-chat-panel')).display==='none';log.connection=s().connectedChannelId===room&&s().connection==='connected';
await cardMenu('Perfil');await wait(()=>document.querySelector('.tri-participant-profile'),'profile from camera');log.profile=true;
dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('.tri-participant-profile'),'modal Escape');log.modalFirst=s().callFullscreen===true;
dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!s().callFullscreen&&innerWidth===initial.w&&innerHeight===initial.h,'restored geometry');
log.restore=true;log.draft=document.querySelector('.tri-composer__input')===input&&input.value==='Rascunho preservado'&&getComputedStyle(document.querySelector('.tri-chat-panel')).display!=='none';
b.send({name:'window',action:'maximize'});await sleep(900);const maximized={w:innerWidth,h:innerHeight};await enter();await exit();await wait(()=>innerWidth===maximized.w&&innerHeight===maximized.h,'restore maximized');log.maximized=true;
b.send({name:'window',action:'maximize'});await wait(()=>innerWidth===initial.w&&innerHeight===initial.h,'normal again');document.querySelector('.tri-chat-panel__close').click();
log.badStream=await reject({name:'setStreamHidden',streamId:'unknown',hidden:true});log.badHidden=await reject({name:'setStreamHidden',streamId:id,hidden:'yes'});
await cardMenu('Ocultar vídeo para mim');await wait(()=>stream().hidden===true&&tile().dataset.hidden==='true','hidden');log.hidden=tile().textContent.includes('Vídeo oculto para você');
await sleep(4200);log.cameraStillOn=s().categories.flatMap(c=>c.channels).flatMap(c=>c.users).find(u=>u.name==='Bob').camera===true;
click('Mostrar vídeo');await wait(()=>stream().hidden===false,'shown');await sleep(4200);log.shown=tile().dataset.hidden==='false';
await cardMenu('Áudio do participante');await wait(()=>document.querySelector('[role="dialog"][aria-label="Áudio de Bob"]'),'audio from camera');log.audio=true;
dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('.tri-modal-backdrop'),'close audio');
await enter();b.send({name:'leaveVoice'});await wait(()=>!s().connectedChannelId&&!s().callFullscreen&&innerWidth===initial.w&&innerHeight===initial.h,'leave exits');log.leave=true;
b.send({name:'selectChannel',channelId:room});await wait(()=>s().connectedChannelId===room&&stream(),'rejoin');log.reset=!stream().hidden&&!s().callFullscreen;
await enter();b.send({name:'createChannel',channelName:'Outra sala'});await wait(()=>s().connectedChannelId&&s().connectedChannelId!==room&&!s().callFullscreen,'room change exits fullscreen');log.roomChange=true;
b.send({name:'selectChannel',channelId:room});await wait(()=>s().connectedChannelId===room&&stream(),'return from second room');
await enter();await sleep(2200);await wait(()=>document.querySelector('.tri-call').classList.contains('is-idle'),'idle controls');window.__triscord.store.receive({v:1,type:'event',name:'callActivity'});await wait(()=>!document.querySelector('.tri-call').classList.contains('is-idle'),'native activity event');log.activity=true;log.final=true;log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()""".replace('COMMON',COMMON)
BOB=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().categories.flatMap(c=>c.channels).some(c=>c.name==='Tela E2E'),'room');const room=s().categories.flatMap(c=>c.channels).find(c=>c.name==='Tela E2E').id;
b.send({name:'selectChannel',channelId:room});await wait(()=>s().connectedChannelId===room,'joined');b.send({name:'setCamera',on:true});await wait(()=>s().camera===true,'camera');
log.unaffected=true;window.__triscord.store.subscribe(state=>{if(state.connectedChannelId!==room||!state.camera||state.streams?.some(x=>x.hidden))log.unaffected=false;});log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()""".replace('COMMON',COMMON)
PROBE="JSON.stringify({...window.__e2e,nativeFullscreen:window.__triscord.store.current.callFullscreen,streams:window.__triscord.store.current.streams})"
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--exe',required=True);parser.add_argument('--assets',default=str(DESKTOP/'web/dist'));args=parser.parse_args()
    work=Path(tempfile.mkdtemp(prefix='triscord-call-view-'));report=DESKTOP/'out/web-call-view-e2e-report';report.mkdir(parents=True,exist_ok=True)
    backend=None;processes=[];logs=[];passed=False
    try:
        backend=Backend(*bundle_workers(DESKTOP/'out/call-view-e2e-backend'),report/'backend.log');config=backend.config;google=config['googleAuthUrl'].rsplit('/',1)[0]
        at,a=account(config,google,'call-view-alice','Alice');bt,bob=account(config,google,'call-view-bob','Bob');a['nick']='Alice';bob['nick']='Bob'
        server=request(config['hubUrl']+'/servers','POST',{'name':'Visualização'},at);code=request(f"{config['hubUrl']}/servers/{server['id']}/invites",'POST',{},at)['code'];request(config['hubUrl']+'/invites/'+code+'/accept','POST',{},bt)
        (work/'probe.js').write_text(PROBE,encoding='utf8');(work/'alice.js').write_text(ALICE,encoding='utf8');(work/'bob.js').write_text(BOB,encoding='utf8')
        for name,token,acct,delay in [('alice',at,a,0),('bob',bt,bob,5)]:
            if delay:time.sleep(delay)
            log=(report/f'{name}.log').open('w',encoding='utf8');logs.append(log)
            processes.append(launch(args.exe,args.assets,config,profile(work,name,token,acct,server['id']),work/f'{name}.js',2500,work/'probe.js',37000 if name=='alice' else 32000,report/f'{name}.png',40 if name=='alice' else 35,log))
        for p in processes:p.wait(timeout=65)
        for log in logs:log.close()
        ar=last(report/'alice.log');br=last(report/'bob.log');print('Alice:',json.dumps(ar,ensure_ascii=False));print('Bob:',json.dumps(br,ensure_ascii=False))
        keys=['noCall','badFullscreen','fullscreen','stage','chatHidden','connection','profile','modalFirst','restore','draft','maximized','badStream','badHidden','hidden','cameraStillOn','shown','audio','leave','reset','roomChange','activity','final','done']
        checks={key:ar.get(key) is True for key in keys};checks.update({f'Bob {key}':br.get(key) is True for key in ['unaffected','done']})
        native=(report/'alice.log').read_text(encoding='utf8',errors='replace')
        hidden=native.split('video hidden=1',1)[-1].split('video hidden=0',1)[0]
        shown=native.split('video hidden=0',1)[-1]
        checks['fullscreen remains active at capture']=ar.get('nativeFullscreen') is True
        checks['native overlay absent while hidden']='video hidden=1' in native and 'overlays visible=0' in hidden
        checks['native frames resumed']='video hidden=0' in native and any(int(n)>5 for n in re.findall(r'overlay cam:\S+ painted=(\d+)',shown))
        checks['native fullscreen transitions']='window fullscreen=1' in native and 'window fullscreen=0' in native
        for name,ok in checks.items():print(('PASS: ' if ok else 'FAIL: ')+name)
        passed=all(checks.values())
    finally:
        for p in processes:
            if p.poll() is None:p.kill();p.wait()
        for log in logs:
            if not log.closed:log.close()
        if backend:backend.close()
        if work.resolve().parent!=Path(tempfile.gettempdir()).resolve() or not work.name.startswith('triscord-call-view-'):raise RuntimeError('Unsafe cleanup')
        shutil.rmtree(work)
    return 0 if passed else 1
if __name__=='__main__':sys.exit(main())
