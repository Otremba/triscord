"""Account card + custom status, real WebView2/C++ clients and local Workers/D1."""
import argparse,json,re,shutil,sys,tempfile,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from run_e2e import Backend,DESKTOP,bundle_workers
from run_web_e2e import request
from run_web_call_e2e import account,profile,launch
from run_web_profile_e2e import last
COMMON=r"""
const log=window.__e2e={},s=()=>window.__triscord.store.current,b=window.__triscord.bridge;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test,label){const end=Date.now()+12000;while(Date.now()<end){if(test())return;await sleep(60);}throw Error(label);}
const card=()=>document.querySelector('.tri-account__popout');
async function open(){card().click();await wait(()=>document.querySelector('.tri-account-popover'),'account card');}
async function status(text){if(!document.querySelector('.tri-account-popover'))await open();
if(!document.querySelector('#account-custom-status')){document.querySelector('.tri-account-popover__status').click();await wait(()=>document.querySelector('#account-custom-status'),'status editor');}
const input=document.querySelector('#account-custom-status');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));await sleep(80);
document.querySelector('.tri-account-popover form').requestSubmit();await wait(()=>s().account.customStatus===text,'saved '+text);await sleep(100);}
"""
ALICE=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().auth?.state==='signedIn','signed in');await open();
log.focus=document.activeElement?.getAttribute('aria-label')==='Editar status personalizado';
const buttons=[...document.querySelectorAll('.tri-account-popover button:not(:disabled),.tri-account-popover input:not(:disabled)')];
buttons.at(-1).focus();dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));log.tab=document.activeElement===buttons[0];
dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('.tri-account-popover'),'escape');log.escape=document.activeElement===card();
await open();document.querySelector('.tri-account-popover__action').click();await wait(()=>document.querySelector('.tri-profile-editor'),'editor');
log.editor=true;dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('.tri-profile-editor'),'editor closed');
await open();document.querySelector('.tri-account-popover .is-danger').click();await wait(()=>document.querySelector('[role="dialog"][aria-label="Sair"]'),'sign out confirmation');
[...document.querySelectorAll('[role="dialog"] button')].find(x=>x.textContent==='Cancelar').click();await wait(()=>!document.querySelector('[aria-label="Sair"]'),'cancel sign out');log.cancel=s().auth.state==='signedIn';
log.invalidLong=await b.request({name:'setCustomStatus',text:'x'.repeat(65)}).then(()=>false,()=>true);
log.invalidControl=await b.request({name:'setCustomStatus',text:'bad\nstatus'}).then(()=>false,()=>true);
await status('Entrando na sala');b.send({name:'createChannel',channelName:'Status E2E'});
await wait(()=>s().categories.flatMap(c=>c.channels).some(c=>c.users.length===2),'two users');await sleep(1200);
await status('Testando o Triscord');log.live=true;await sleep(1300);
document.querySelector('.tri-account-popover__actions button').click();await wait(()=>s().account.customStatus==='','clear');log.clear=true;await sleep(1300);
await status('Construindo o Triscord');log.final=true;
log.panel=document.querySelector('.tri-account__status').textContent==='Construindo o Triscord';log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()""".replace('COMMON',COMMON)
BOB=r"""(()=>{COMMON
log.unrelatedUntouched=true;window.__triscord.store.subscribe(state=>{if(state.categories.flatMap(c=>c.channels).flatMap(c=>c.users).some(u=>u.name==='Bob' && u.customStatus))log.unrelatedUntouched=false;});
const other=()=>s().categories.flatMap(c=>c.channels).flatMap(c=>c.users).find(u=>u.name==='Alice');
(async()=>{
await wait(()=>s().categories.flatMap(c=>c.channels).some(c=>c.name==='Status E2E'),'room');
const channel=s().categories.flatMap(c=>c.channels).find(c=>c.name==='Status E2E');b.send({name:'selectChannel',channelId:channel.id});
await wait(()=>s().connectedChannelId===channel.id,'joined');log.ownEmpty=!s().account.customStatus;
await wait(()=>other()?.customStatus==='Entrando na sala','join payload');log.initial=true;
await wait(()=>other()?.customStatus==='Testando o Triscord','live status');log.live=true;
await wait(()=>other()?.customStatus==='','cleared');log.clear=true;
await wait(()=>other()?.customStatus==='Construindo o Triscord','final status');log.final=true;
log.tooltip=[...document.querySelectorAll('.tri-voice-user')].some(el=>el.title==='Construindo o Triscord');log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()""".replace('COMMON',COMMON)
PROBE="JSON.stringify({...window.__e2e,account:window.__triscord.store.current.account})"
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--exe',required=True);parser.add_argument('--assets',default=str(DESKTOP/'web/dist'));args=parser.parse_args()
    work=Path(tempfile.mkdtemp(prefix='triscord-account-card-'));report=DESKTOP/'out/web-account-e2e-report';report.mkdir(parents=True,exist_ok=True)
    backend=None;processes=[];passed=False;logs=[]
    try:
        backend=Backend(*bundle_workers(DESKTOP/'out/account-e2e-backend'),report/'backend.log');config=backend.config;google=config['googleAuthUrl'].rsplit('/',1)[0]
        at,a=account(config,google,'account-alice','Alice');bt,bob=account(config,google,'account-bob','Bob');a['nick']='Alice';bob['nick']='Bob'
        server=request(f"{config['hubUrl']}/servers",'POST',{'name':'Status'},at)
        code=request(f"{config['hubUrl']}/servers/{server['id']}/invites",'POST',{},at)['code'];request(f"{config['hubUrl']}/invites/{code}/accept",'POST',{},bt)
        settings=profile(work,'alice',at,a,server['id']);bobsettings=profile(work,'bob',bt,bob,server['id'])
        (work/'probe.js').write_text(PROBE,encoding='utf8');(work/'alice.js').write_text(ALICE,encoding='utf8');(work/'bob.js').write_text(BOB,encoding='utf8')
        for name,setting,delay in [('alice',settings,0),('bob',bobsettings,5)]:
            if delay:time.sleep(delay)
            log=(report/f'{name}.log').open('w',encoding='utf8');logs.append(log)
            processes.append(launch(args.exe,args.assets,config,setting,work/f'{name}.js',2500,work/'probe.js',28000 if name=='alice' else 23000,report/f'{name}.png',31 if name=='alice' else 26,log))
        for p in processes:p.wait(timeout=55)
        for log in logs:log.close()
        ar=last(report/'alice.log');br=last(report/'bob.log');print('Alice:',json.dumps(ar,ensure_ascii=False));print('Bob:',json.dumps(br,ensure_ascii=False))
        (work/'noop.js').write_text("'noop'",encoding='utf8')
        with (report/'restart.log').open('w',encoding='utf8') as log:
            p=launch(args.exe,args.assets,config,settings,work/'noop.js',1000,work/'probe.js',4000,report/'restart.png',6,log);processes.append(p);p.wait(timeout=20)
        rr=last(report/'restart.log')
        ini=settings/'Triscord/TriscordNativePreview.ini'
        contents=ini.read_text(encoding='utf8')
        for key,value in {'session':bt,'id':bob['id'],'email':bob['email'],'nick':'Bob','username':'Bob'}.items():
            contents=re.sub(r'(?m)^'+key+r'=.*$',lambda match:key+'='+value,contents)
        ini.write_text(contents,encoding='utf8')
        with (report/'other-account.log').open('w',encoding='utf8') as log:
            p=launch(args.exe,args.assets,config,settings,work/'noop.js',1000,work/'probe.js',4000,report/'other-account.png',6,log);processes.append(p);p.wait(timeout=20)
        other=last(report/'other-account.log')
        checks={f'Alice {key}' :ar.get(key) is True for key in ['focus','tab','escape','editor','cancel','invalidLong','invalidControl','live','clear','final','panel','done']}
        checks.update({f'Bob {key}':br.get(key) is True for key in ['ownEmpty','unrelatedUntouched','initial','live','clear','final','tooltip','done']})
        checks['restart persistence']=rr.get('account',{}).get('customStatus')=='Construindo o Triscord'
        checks['same settings, different account']=other.get('account',{}).get('id')==bob['id'] and other.get('account',{}).get('customStatus')==''
        for name,ok in checks.items():print(('PASS: ' if ok else 'FAIL: ')+name)
        passed=all(checks.values())
    finally:
        for p in processes:
            if p.poll() is None:p.kill();p.wait()
        for log in logs:
            if not log.closed:log.close()
        if backend:backend.close()
        if work.resolve().parent!=Path(tempfile.gettempdir()).resolve() or not work.name.startswith('triscord-account-card-'):raise RuntimeError('Unsafe cleanup')
        shutil.rmtree(work)
    return 0 if passed else 1
if __name__=='__main__':sys.exit(main())

