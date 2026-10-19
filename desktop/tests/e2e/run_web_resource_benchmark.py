"""Windows process-tree benchmark for the real native/web client, local Workers and synthetic media.

Private bytes = per-process committed private memory. Summed working sets include shared pages.
CPU is reported both as one-core=100% and divided by the logical processor count.
Only owned client trees are sampled; Worker/Python processes are excluded. No real account/hardware.
"""
import argparse,csv,hashlib,io,json,math,os,platform,re,shutil,subprocess,sys,tempfile,time,urllib.request
from datetime import datetime,timezone
from pathlib import Path
import psutil
from PIL import Image,ImageDraw
sys.path.insert(0,str(Path(__file__).resolve().parent))
from run_e2e import Backend,DESKTOP,TOOLCHAIN,bundle_workers
from run_web_call_e2e import account,profile
from run_web_e2e import request
MIB=1024*1024
COMMON=r"""
const log=window.__perf={phase:'startup',marks:[],cycles:[],done:false},s=()=>window.__triscord.store.current,b=window.__triscord.bridge;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test,label){const end=Date.now()+20000;while(Date.now()<end){if(test())return;await sleep(150);}throw Error(label);}
function mark(name){log.phase=name;log.marks.push({name,ms:Date.now()});}
"""
ALICE=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().auth?.state==='signedIn'&&s().profile?.avatarDataUrl&&s().profile?.bannerDataUrl,'auth and own media');
b.send({name:'createChannel',channelName:'Recursos E2E'});await wait(()=>s().connectedChannelId,'room created');const room=s().connectedChannelId;
b.send({name:'leaveVoice'});await wait(()=>!s().connectedChannelId,'setup left');mark('baseline_settle');await sleep(20000);mark('idle_baseline');await sleep(15000);
for(let cycle=1;cycle<=CYCLES;cycle++){
 b.send({name:'selectChannel',channelId:room});await wait(()=>s().connectedChannelId===room&&s().streams?.some(x=>x.kind==='camera'),'camera '+cycle);
 const camera=s().streams.find(x=>x.kind==='camera');mark('call_'+cycle);await sleep(6000);
 log.cycles.push({cycle,ms:Date.now(),streams:s().streams.map(x=>({kind:x.kind,width:x.width,height:x.height})),users:s().categories.flatMap(c=>c.channels).find(c=>c.id===room).users.length});
 mark('profile_'+cycle);dispatchEvent(new Event('tri-open-profile'));await wait(()=>document.querySelector('.tri-profile-editor img'),'own profile');await sleep(2000);
 dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('.tri-profile-editor'),'profile closed');
 mark('hidden_'+cycle);await b.request({name:'setStreamHidden',streamId:camera.id,hidden:true});await sleep(2000);await b.request({name:'setStreamHidden',streamId:camera.id,hidden:false});await sleep(1000);
 b.send({name:'leaveVoice'});await wait(()=>!s().connectedChannelId&&!s().streams?.length,'leave '+cycle);mark('recovery_'+cycle);await sleep(10000);
}
mark('post_settle');await sleep(20000);mark('idle_after');await sleep(15000);
mark('minimized');b.send({name:'window',action:'minimize'});await sleep(20000);
mark('restore_settle');b.send({name:'window',action:'maximize'});await sleep(500);b.send({name:'window',action:'maximize'});await sleep(10000);
mark('idle_restored');await sleep(15000);
log.clean=!s().connectedChannelId&&!s().streams?.length&&!document.querySelector('.tri-profile-editor')&&!s().callFullscreen;mark('complete');log.done=true;
setTimeout(()=>b.send({name:'window',action:'close'}),8000);
})().catch(e=>{log.error=e.message;mark('error');setTimeout(()=>b.send({name:'window',action:'close'}),8000);});return 'performance driver started';})()""".replace('COMMON',COMMON)
BOB=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().auth?.state==='signedIn','Bob auth');b.send({name:'window',action:'minimize'});log.joins=0;
let state='idle';
function update(){
 try {
  const room=s().categories.flatMap(c=>c.channels).find(c=>c.name==='Recursos E2E'),alice=room?.users.some(u=>u.name==='Alice');
  if(!alice){if(s().connectedChannelId&&state!=='leaving'){state='leaving';b.send({name:'leaveVoice'});}else if(!s().connectedChannelId)state='idle';return;}
  if(state==='idle'&&!s().connectedChannelId){state='joining';b.send({name:'selectChannel',channelId:room.id});return;}
  if(state==='joining'&&s().connectedChannelId===room.id){state='starting';b.send({name:'setCamera',on:true});return;}
  if(state==='starting'&&s().camera){state='publishing';log.joins++;}
 }catch(e){log.error=e.message;}
}
window.__triscord.store.subscribe(update);update();
})().catch(e=>log.error=e.message);return 'fixture started';})()""".replace('COMMON',COMMON)
PROBE="JSON.stringify({...window.__perf,session:{connected:window.__triscord.store.current.connectedChannelId,selected:window.__triscord.store.current.selectedChannelId,camera:window.__triscord.store.current.camera,pending:window.__triscord.store.current.cameraPending,rooms:window.__triscord.store.current.categories.flatMap(c=>c.channels).map(r=>({id:r.id,name:r.name,users:r.users.map(u=>u.name)}))},viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},resources:{images:document.images.length,videoTiles:document.querySelectorAll('.tri-video-tile').length}})"

def quantile(values,q):
    if not values:return None
    values=sorted(values);at=(len(values)-1)*q;lo=int(at);hi=min(lo+1,len(values)-1)
    return values[lo]+(values[hi]-values[lo])*(at-lo)

def parse_probe(path):
    result={}
    for line in path.read_text(encoding='utf8',errors='replace').splitlines():
        if not line.startswith('script: '):continue
        try:
            value=json.loads(line[8:]);value=json.loads(value) if isinstance(value,str) else value
            if isinstance(value,dict):result=value
        except (ValueError,TypeError):pass
    return result

class Tree:
    def __init__(self,pid):
        self.root=psutil.Process(pid);self.known={};self.previous={};self.last=time.monotonic();self.version='unknown';self.sampled=False
    def sample(self):
        now=time.monotonic();elapsed=max(now-self.last,.001);self.last=now
        try:found=[self.root]+self.root.children(recursive=True)
        except psutil.Error:found=[]
        for p in found:
            try:self.known[(p.pid,p.create_time())]=p
            except psutil.Error:pass
        rows=[];cpu=0
        for key,p in list(self.known.items()):
            try:
                with p.oneshot():
                    if p.create_time()!=key[1]:continue
                    mem=p.memory_info();times=p.cpu_times();seconds=times.user+times.system;name=p.name()
                    args=p.cmdline()
                role='host' if p.pid==self.root.pid else next((arg.split('=',1)[1] for arg in args if arg.startswith('--type=')),'browser')
                if name.lower()=='msedgewebview2.exe' and self.version=='unknown':self.version=Path(p.exe()).parent.name
                cpu+=max(0,seconds-self.previous.get(key,0));self.previous[key]=seconds
                rows.append({'pid':p.pid,'created':key[1],'role':role,'name':name,'private':getattr(mem,'private',mem.vms),'working_set':mem.rss})
            except psutil.Error:continue
        if not self.sampled:cpu=0;self.sampled=True
        return {'private':sum(r['private'] for r in rows),'working_set':sum(r['working_set'] for r in rows),'host_private':sum(r['private'] for r in rows if r['role']=='host'),
                'cpu_one_core':cpu/elapsed*100,'cpu_machine':cpu/elapsed*100/(psutil.cpu_count() or 1),'processes':rows}
    def stop_owned(self):
        # Identity includes creation time, so PID reuse cannot target a user's process.
        for (pid,created),p in reversed(list(self.known.items())):
            try:
                if p.is_running() and p.create_time()==created:p.terminate()
            except psutil.Error:pass


def launch(exe,assets,config,settings,driver,probe,log,probe_interval=5000,probe_after=5000):
    env=dict(os.environ);env['PATH']=os.pathsep.join([str(TOOLCHAIN/'Qt/6.8.3/mingw_64/bin'),str(TOOLCHAIN/'Qt/Tools/mingw1310_64/bin'),env['PATH']])
    env.update(TRISCORD_SETTINGS_PATH=str(settings),TRISCORD_AUTH_SERVER=config['authUrl'],TRISCORD_HUB_SERVER=config['hubUrl'],TRISCORD_AUDIO_MODE='injected',TRISCORD_VIDEO_SOURCE='synthetic')
    return subprocess.Popen([str(Path(exe).resolve()),'--assets',assets,'--devtools','--quit-after','420','--script',str(driver),'--script-after','2500','--probe',str(probe),'--probe-after',str(probe_after),'--probe-interval',str(probe_interval)],env=env,stdout=log,stderr=subprocess.STDOUT)

def media(config,token):
    import random
    rng=random.Random(41);avatar=io.BytesIO();Image.frombytes('RGB',(320,320),rng.randbytes(320*320*3)).save(avatar,format='PNG')
    frames=[]
    for n in range(8):
        frame=Image.new('RGB',(400,140),'#193a52');ImageDraw.Draw(frame).rectangle((n*40,0,n*40+24,140),fill='#24516e');frames.append(frame)
    banner=io.BytesIO();frames[0].save(banner,format='GIF',save_all=True,append_images=frames[1:],duration=200,loop=0)
    for kind,data,mime in [('avatar',avatar.getvalue(),'image/png'),('banner',banner.getvalue(),'image/gif')]:
        req=urllib.request.Request(config['authUrl']+'/profile/'+kind,data=data,method='PUT',headers={'Authorization':'Bearer '+token,'Content-Type':mime})
        with urllib.request.urlopen(req,timeout=15) as response:assert response.status==200
    return {'avatar_bytes':len(avatar.getvalue()),'banner_bytes':len(banner.getvalue()),'banner_frames':8}

def summaries(samples,marks):
    result={}
    for index,mark in enumerate(marks[:-1]):
        end=marks[index+1]['ms'];group=[s for s in samples if mark['ms']<=s['ms']<end]
        if not group:continue
        result[mark['name']]={'samples':len(group),'duration_s':(end-mark['ms'])/1000}
        for client in ['alice','bob']:
            stats={}
            for metric in ['private','working_set','host_private','cpu_one_core','cpu_machine']:
                values=[s[client][metric]/(MIB if metric in ['private','working_set','host_private'] else 1) for s in group]
                stats[metric]={'p50':quantile(values,.5),'p95':quantile(values,.95),'peak':max(values),'mean':sum(values)/len(values)}
            stats['process_count_max']=max(len(s[client]['processes']) for s in group);result[mark['name']][client]=stats
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--exe',required=True);parser.add_argument('--assets',default=str(DESKTOP/'web/dist'));parser.add_argument('--cycles',type=int,default=8);args=parser.parse_args()
    if not 3<=args.cycles<=10:raise ValueError('Use 3..10 cycles within the 420-second safety timeout')
    if os.name!='nt':raise RuntimeError('This benchmark requires Windows private-memory counters')
    work=Path(tempfile.mkdtemp(prefix='triscord-resource-'));report=DESKTOP/'out/web-resource-report'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ');report.mkdir(parents=True)
    backend=None;processes=[];logs=[];trees={};samples=[];passed=False
    try:
        backend=Backend(*bundle_workers(DESKTOP/'out/resource-e2e-backend'),report/'backend.log');config=backend.config;google=config['googleAuthUrl'].rsplit('/',1)[0]
        at,a=account(config,google,'resource-alice','Alice');bt,bob=account(config,google,'resource-bob','Bob');a['nick']='Alice';bob['nick']='Bob';fixtures=media(config,at)
        server=request(config['hubUrl']+'/servers','POST',{'name':'Recursos'},at);code=request(f"{config['hubUrl']}/servers/{server['id']}/invites",'POST',{},at)['code'];request(config['hubUrl']+'/invites/'+code+'/accept','POST',{},bt)
        (work/'probe.js').write_text(PROBE,encoding='utf8');(work/'alice.js').write_text(ALICE.replace('CYCLES',str(args.cycles)),encoding='utf8');(work/'bob.js').write_text(BOB,encoding='utf8')
        for name,token,acct in [('alice',at,a),('bob',bt,bob)]:
            log=(report/f'{name}.log').open('w',encoding='utf8');logs.append(log)
            p=launch(args.exe,args.assets,config,profile(work,name,token,acct,server['id']),work/f'{name}.js',work/'probe.js',log);processes.append(p);trees[name]=Tree(p.pid)
        started=time.monotonic();last_phase=None;last_notice=0
        while processes[0].poll() is None and time.monotonic()-started<435:
            item={'ms':time.time()*1000,'elapsed_s':time.monotonic()-started}
            for name,tree in trees.items():item[name]=tree.sample()
            ids=[{(p['pid'],p['created']) for p in item[name]['processes']} for name in ['alice','bob']]
            if ids[0]&ids[1]:raise RuntimeError('Client process trees overlap: attribution invalid')
            samples.append(item);probe=parse_probe(report/'alice.log');phase=probe.get('phase','starting')
            if phase!=last_phase or time.monotonic()-last_notice>25:
                print(f"{item['elapsed_s']:5.0f}s {phase}: Alice private={item['alice']['private']/MIB:.1f} MiB, WS={item['alice']['working_set']/MIB:.1f} MiB, CPU(one core)={item['alice']['cpu_one_core']:.2f}%",flush=True)
                last_phase=phase;last_notice=time.monotonic()
            fixture=parse_probe(report/'bob.log')
            if probe.get('error') or fixture.get('error'):
                print('Driver error:',probe.get('error') or fixture.get('error'),flush=True);break
            time.sleep(1)
        for log in logs:log.flush()
        ar=parse_probe(report/'alice.log');br=parse_probe(report/'bob.log');marks=ar.get('marks',[]);stages=summaries(samples,marks)
        checks={'driver completed':ar.get('done') is True,'clean idle state':ar.get('clean') is True,'all call cycles':len(ar.get('cycles',[]))==args.cycles,
                'two users per call':all(x.get('users')==2 for x in ar.get('cycles',[])),'camera in every cycle':all(any(s.get('kind')=='camera' for s in x.get('streams',[])) for x in ar.get('cycles',[])),
                'Bob joined every cycle':br.get('joins',0)>=args.cycles,'idle windows sampled':all(k in stages and stages[k]['samples']>=8 for k in ['idle_baseline','idle_after','minimized','idle_restored']),
                'independent browser trees':all(any(p['role']=='browser' for p in sample['alice']['processes']) and any(p['role']=='browser' for p in sample['bob']['processes']) for sample in samples[-10:]),
                'no driver errors':not ar.get('error') and not br.get('error')}
        native=(report/'alice.log').read_text(encoding='utf8',errors='replace')
        paint=[(int(ms),int(count)) for count,ms in re.findall(r'overlay cam:\S+ painted=(\d+) ms=(\d+)',native)]
        rendered=[]
        for i,mark in enumerate(marks[:-1]):
            if mark['name'].startswith('call_'):
                rendered.append(any(mark['ms']<=ms<marks[i+1]['ms'] and count>5 for ms,count in paint))
        checks['fresh native frames in every cycle']=len(rendered)==args.cycles and all(rendered)
        passed=all(checks.values());result={'checks':checks,'passed':passed,'stages':stages,'alice_driver':ar,'bob_driver':br,'fixtures':fixtures,
            'environment':{'platform':platform.platform(),'logical_processors':psutil.cpu_count(),'psutil':psutil.__version__,'webview2':{k:t.version for k,t in trees.items()},'exe_sha256':hashlib.sha256(Path(args.exe).read_bytes()).hexdigest()},
            'method':{'interval_s':1,'probe_interval_s':5,'private':'Windows private committed bytes; summed for owned tree','working_set':'sum of resident working sets; shared pages may be counted more than once','cpu':'process CPU time delta, one core=100%, machine normalized by logical processor count','excluded':'Workers, Python sampler, existing user apps, dedicated GPU memory; short-lived unsampled processes may be missed','media':'synthetic 640x360 camera source; actual received dimensions in cycle records; injected silent audio; not physical/WAN or 1080p performance'}}
        (report/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');(report/'samples.json').write_text(json.dumps(samples),encoding='utf8')
        with (report/'samples.csv').open('w',newline='',encoding='utf8') as f:
            fields=['elapsed_s','client','private_mib','working_set_mib','host_private_mib','cpu_one_core','cpu_machine','processes'];writer=csv.DictWriter(f,fieldnames=fields);writer.writeheader()
            for sample in samples:
                for client in ['alice','bob']:
                    row=sample[client];writer.writerow({'elapsed_s':sample['elapsed_s'],'client':client,'private_mib':row['private']/MIB,'working_set_mib':row['working_set']/MIB,'host_private_mib':row['host_private']/MIB,'cpu_one_core':row['cpu_one_core'],'cpu_machine':row['cpu_machine'],'processes':len(row['processes'])})
        for name,ok in checks.items():print(('PASS: ' if ok else 'FAIL: ')+name,flush=True)
        print('Report:',report,flush=True)
    finally:
        for tree in trees.values():tree.stop_owned()
        for p in processes:
            if p.poll() is None:p.terminate();p.wait(timeout=10)
        for log in logs:log.close()
        if backend:backend.close()
        if work.resolve().parent!=Path(tempfile.gettempdir()).resolve() or not work.name.startswith('triscord-resource-'):raise RuntimeError('Unsafe cleanup')
        for attempt in range(8):
            try:shutil.rmtree(work);break
            except OSError:
                if attempt==7:raise
                time.sleep(1)
    return 0 if passed else 1
if __name__=='__main__':sys.exit(main())
