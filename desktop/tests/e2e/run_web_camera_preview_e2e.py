"""Two real Qt clients + local Workers: local camera preview never publishes to the peer.
Synthetic pixels only: settings/menu UI, close, reuse of publishing capture, leases, stale IDs and logout.
"""
import argparse,json,os,shutil,subprocess,sys,tempfile,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from run_e2e import Backend,DESKTOP,TOOLCHAIN,bundle_workers
from run_web_call_e2e import account,profile,launch
from run_web_e2e import request
from run_web_profile_e2e import last

COMMON=r"""
const log=window.__e2e={},s=()=>window.__triscord.store.current,b=window.__triscord.bridge;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test,label){const end=Date.now()+16000;while(Date.now()<end){if(test())return;await sleep(80);}throw Error(label);}
const click=label=>{const el=document.querySelector(`[aria-label="${label}"]`)??[...document.querySelectorAll('button,[role="menuitem"]')].find(e=>e.textContent.trim()===label);if(!el)throw Error('missing '+label);el.click();};
const reject=cmd=>b.request(cmd).then(()=>false,()=>true);
"""
ALICE=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().auth?.state==='signedIn','auth');
log.invalid=await reject({name:'startCameraPreview',previewId:'../invalid'});
log.extra=await reject({name:'startCameraPreview',previewId:'valid',publish:true});
const frames=new Map(),closed=new Set();window.__triscord.store.onEvent(e=>{
 if(e.name==='cameraPreviewFrame'){const a=frames.get(e.previewId)??[];a.push(e.image);frames.set(e.previewId,a);}
 if(e.name==='cameraPreviewClosed')closed.add(e.previewId);
});
dispatchEvent(new Event('tri-open-settings'));await wait(()=>document.querySelector('.tri-settings'),'settings');click('Testar vídeo');
await wait(()=>document.querySelector('.tri-camera-preview img')?.naturalWidth===640,'settings preview');
await sleep(650);const settingsId=[...frames.keys()].at(-1);const first=frames.get(settingsId);
log.settings=first.length>=3&&new Set(first).size>=2;
log.dimensions=document.querySelector('.tri-camera-preview img').naturalHeight===360;
log.outsideCall=!s().camera&&!s().cameraPending&&!s().connectedChannelId&&!(s().streams?.length);
click('Parar teste');await wait(()=>closed.has(settingsId),'stop settings');let count=frames.get(settingsId).length;await sleep(450);log.stopped=frames.get(settingsId).length===count;
dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('.tri-settings'),'settings closed');
b.send({name:'createChannel',channelName:'Preview E2E'});await wait(()=>s().connectedChannelId,'room');
await wait(()=>s().categories.flatMap(c=>c.channels).some(c=>c.users?.length===2),'Bob joined');
click('Opções de vídeo');await wait(()=>document.querySelector('[role="menu"]'),'camera menu');click('Prévia da câmera');
await wait(()=>document.querySelector('[role="dialog"][aria-label="Prévia da câmera"] img')?.naturalWidth===640,'menu preview');
const menuId=[...frames.keys()].at(-1);log.menu=true;
b.send({name:'sendChatMessage',text:'CHECK_PREVIEW'});await wait(()=>s().chat?.some(m=>m.text==='PREVIEW_IS_PRIVATE'),'peer check');log.private=true;
dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>closed.has(menuId),'escape cleanup');log.escape=true;
await wait(()=>!document.querySelector('[aria-label="Prévia da câmera"][role="dialog"]'),'modal gone');
b.send({name:'setCamera',on:true});await wait(()=>s().camera,'publishing');
dispatchEvent(new Event('tri-open-camera-preview'));await wait(()=>document.querySelector('.tri-camera-preview img')?.naturalWidth>0,'reuse publishing');
const reused=[...frames.keys()].at(-1);dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>closed.has(reused),'reuse closed');await sleep(400);
log.publishingPreserved=s().camera===true&&s().streams.some(x=>x.kind==='camera');b.send({name:'setCamera',on:false});await wait(()=>!s().camera,'camera stopped');
await b.request({name:'startCameraPreview',previewId:'lease'});await wait(()=>frames.has('lease'),'lease frames');await wait(()=>closed.has('lease'),'lease expires');
count=frames.get('lease').length;await sleep(450);log.lease=frames.get('lease').length===count;
await b.request({name:'startCameraPreview',previewId:'old'});await wait(()=>frames.has('old'),'old frames');
await b.request({name:'startCameraPreview',previewId:'new'});await b.request({name:'stopCameraPreview',previewId:'old'});
await wait(()=>(frames.get('new')?.length??0)>=3,'new survives stale stop');log.stale=closed.has('old')&&!closed.has('new');
await b.request({name:'stopCameraPreview',previewId:'new'});await wait(()=>closed.has('new'),'stop new');
await b.request({name:'startCameraPreview',previewId:'logout'});await wait(()=>frames.has('logout'),'logout preview');
await b.request({name:'signOut'});await wait(()=>s().auth?.state==='signedOut'&&closed.has('logout'),'logout closes preview');
count=frames.get('logout').length;await sleep(450);log.logout=frames.get('logout').length===count;
log.signedOut=await reject({name:'startCameraPreview',previewId:'denied'});log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()""".replace('COMMON',COMMON)
BOB=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().categories.flatMap(c=>c.channels).some(c=>c.name==='Preview E2E'),'room');
const room=s().categories.flatMap(c=>c.channels).find(c=>c.name==='Preview E2E').id;b.send({name:'selectChannel',channelId:room});
await wait(()=>s().connectedChannelId===room,'joined');await wait(()=>s().chat?.some(m=>m.text==='CHECK_PREVIEW'),'preview check');
log.noStream=!(s().streams?.length);log.noCamera=s().categories.flatMap(c=>c.channels).flatMap(c=>c.users).every(u=>!u.camera);
if(log.noStream&&log.noCamera)b.send({name:'sendChatMessage',text:'PREVIEW_IS_PRIVATE'});log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()""".replace('COMMON',COMMON)
PROBE='JSON.stringify(window.__e2e)'
UNAVAILABLE=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().auth?.state==='signedIn','auth');let frames=0;
window.__triscord.store.onEvent(e=>{if(e.name==='cameraPreviewFrame')frames++;});
dispatchEvent(new Event('tri-open-settings'));await wait(()=>document.querySelector('.tri-settings'),'settings');
click('Testar vídeo');await wait(()=>document.querySelector('.tri-camera-preview [role="alert"]'),'missing device error');
log.errorShown=document.querySelector('.tri-camera-preview [role="alert"]').textContent.includes('indisponível');
click('Parar teste');await wait(()=>!document.querySelector('.tri-camera-preview'),'closed');
click('Testar vídeo');await wait(()=>document.querySelector('.tri-camera-preview [role="alert"]'),'retry error');
log.retry=true;log.noFrames=frames===0;log.notPublishing=!s().camera&&!s().cameraPending;log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()""".replace('COMMON',COMMON)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--exe',required=True);parser.add_argument('--assets',default=str(DESKTOP/'web/dist'));args=parser.parse_args()
    work=Path(tempfile.mkdtemp(prefix='triscord-camera-preview-'));report=DESKTOP/'out/web-camera-preview-e2e';report.mkdir(exist_ok=True)
    backend=None;processes=[];logs=[]
    try:
        backend=Backend(*bundle_workers(DESKTOP/'out/camera-preview-backend'),report/'backend.log');config=backend.config;google=config['googleAuthUrl'].rsplit('/',1)[0]
        at,a=account(config,google,'preview-alice','Alice');bt,bob=account(config,google,'preview-bob','Bob');a['nick']='Alice';bob['nick']='Bob'
        server=request(config['hubUrl']+'/servers','POST',{'name':'Camera Preview'},at);code=request(f"{config['hubUrl']}/servers/{server['id']}/invites",'POST',{},at)['code'];request(config['hubUrl']+'/invites/'+code+'/accept','POST',{},bt)
        (work/'probe.js').write_text(PROBE,encoding='utf8')
        for name,token,acct,script,delay in [('alice',at,a,ALICE,0),('bob',bt,bob,BOB,4)]:
            if delay:time.sleep(delay)
            (work/f'{name}.js').write_text(script,encoding='utf8');log=(report/f'{name}.log').open('w',encoding='utf8');logs.append(log)
            processes.append(launch(args.exe,args.assets,config,profile(work,name,token,acct,server['id']),work/f'{name}.js',2000,work/'probe.js',48000 if name=='alice' else 44000,report/f'{name}.png',51 if name=='alice' else 47,log))
        for p in processes:p.wait(timeout=75)
        for log in logs:log.close()
        ar=last(report/'alice.log');br=last(report/'bob.log');print('Alice:',json.dumps(ar));print('Bob:',json.dumps(br))
        keys=['invalid','extra','settings','dimensions','outsideCall','stopped','menu','private','escape','publishingPreserved','lease','stale','logout','signedOut','done']
        checks={key:ar.get(key) is True for key in keys};checks.update({f'peer {key}':br.get(key) is True for key in ['noStream','noCamera','done']})
        # Real CameraService error path, with a guaranteed nonexistent ID: never opens a physical device.
        settings=profile(work,'unavailable',bt,bob,server['id']);ini=settings/'Triscord/TriscordNativePreview.ini'
        ini.write_text(ini.read_text(encoding='utf8').replace('[General]\n','[General]\ncameraDevice=@ByteArray(triscord-preview-missing-device)\n'),encoding='utf8')
        (work/'unavailable.js').write_text(UNAVAILABLE,encoding='utf8')
        env=dict(os.environ,TRISCORD_SETTINGS_PATH=str(settings),TRISCORD_AUTH_SERVER=config['authUrl'],TRISCORD_HUB_SERVER=config['hubUrl'],TRISCORD_AUDIO_MODE='injected',TRISCORD_VIDEO_SOURCE='devices')
        env.pop('TRISCORD_FORCE_UPDATE_CHECK',None)
        env['PATH']=str(TOOLCHAIN/'Qt/6.8.3/mingw_64/bin')+os.pathsep+str(TOOLCHAIN/'Qt/Tools/mingw1310_64/bin')+os.pathsep+env['PATH']
        with (report/'unavailable.log').open('w',encoding='utf8') as output:
            p=subprocess.Popen([str(Path(args.exe).resolve()),'--assets',args.assets,'--devtools','--script',str(work/'unavailable.js'),'--script-after','1800','--probe',str(work/'probe.js'),'--probe-after','7500','--quit-after','9'],env=env,stdout=output,stderr=subprocess.STDOUT)
            processes.append(p);p.wait(timeout=25)
        missing=last(report/'unavailable.log');print('Missing device:',json.dumps(missing))
        checks.update({f'missing device {key}':missing.get(key) is True for key in ['errorShown','retry','noFrames','notPublishing','done']})
        (report/'result.json').write_text(json.dumps({'passed':all(checks.values()),'checks':checks},indent=2),encoding='utf8')
        for name,ok in checks.items():print(('PASS: ' if ok else 'FAIL: ')+name)
        return 0 if all(checks.values()) else 1
    finally:
        for p in processes:
            if p.poll() is None:p.kill();p.wait()
        for log in logs:
            if not log.closed:log.close()
        if backend:backend.close()
        assert work.resolve().parent==Path(tempfile.gettempdir()).resolve() and work.name.startswith('triscord-camera-preview-')
        shutil.rmtree(work)

if __name__=='__main__':sys.exit(main())
