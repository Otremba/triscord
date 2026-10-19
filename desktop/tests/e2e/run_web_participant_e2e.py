"""Public participant cards: two real native web clients, local Workers/D1 and synthetic media."""
import argparse,io,json,shutil,sys,tempfile,time,urllib.request
from pathlib import Path
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parent))
from run_e2e import Backend,DESKTOP,bundle_workers
from run_web_call_e2e import account,profile,launch
from run_web_e2e import request
from run_web_profile_e2e import last
COMMON=r"""
const log=window.__e2e={},s=()=>window.__triscord.store.current,b=window.__triscord.bridge;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test,label){const end=Date.now()+14000;while(Date.now()<end){if(test())return;await sleep(60);}throw Error(label);}
const users=()=>s().categories.flatMap(c=>c.channels).flatMap(c=>c.users);
const row=()=>document.querySelector('[aria-label="Ver perfil de Bob"]');
const card=()=>document.querySelector('.tri-participant-profile');
async function loaded(){await wait(()=>s().participantProfile?.displayName==='Bob Perfil'&&s().participantProfile.avatarDataUrl&&s().participantProfile.bannerDataUrl,'public data and images');await sleep(100);}
"""
ALICE=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().auth?.state==='signedIn','auth');b.send({name:'createChannel',channelName:'Perfis E2E'});
await wait(()=>users().some(u=>u.name==='Bob'),'Bob joined');log.authenticated=users().find(u=>u.name==='Bob').profileAvailable===true;
await wait(()=>row()?.querySelector('img'),'avatar before any click',10000);
log.prefetched=(row().querySelector('img').src||'').startsWith('data:image/png')&&(s().avatars?.[users().find(u=>u.name==='Bob').accountId]?.animated||'').startsWith('data:image/gif');
row().focus();row().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await loaded();
log.fields=card().textContent.includes('ele/dele')&&card().textContent.includes('Bio pública de Bob')&&card().textContent.includes('Jogando no Triscord');
log.width=card().getBoundingClientRect().width===400;log.date=card().textContent.includes(String(new Date(s().participantProfile.created_at).getFullYear()));
log.media=[...card().querySelectorAll('img')].length===2&&[...card().querySelectorAll('img')].every(i=>i.src.startsWith('data:image/gif;base64,'));
log.rowStatic=(row().querySelector('img')?.src||'').startsWith('data:image/png;base64,');
log.avatarRow=!!row().querySelector('img');log.avatarCall=!!document.querySelector('.tri-call-card[aria-label="Bob"] img');log.callGif=(document.querySelector('.tri-call-card[aria-label="Bob"] img')?.src||'').startsWith('data:image/gif');
const dto=JSON.stringify(s().participantProfile);log.privacy=!/PRIVATE_NOTE|email|session|token|https?:|avatar_url|banner_url/.test(dto)&&!card().textContent.includes('PRIVATE_NOTE');
const close=card().querySelector('button');close.focus();dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));log.tab=document.activeElement===card().querySelector('[aria-label="Volume do usuário"]');
dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!card(),'Escape');log.escape=document.activeElement===row();
log.badSocket=await b.request({name:'getParticipantProfile',socketId:'not-in-directory'}).then(()=>false,()=>true);
log.extraField=await b.request({name:'getParticipantProfile',socketId:users().find(u=>u.name==='Bob').id,accountId:'someone-else'}).then(()=>false,()=>true);
row().dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:220,cancelable:true}));await wait(()=>document.querySelector('[role="menuitem"]'),'context menu');
[...document.querySelectorAll('[role="menuitem"]')].find(el=>el.textContent.includes('Perfil')).click();await loaded();log.context=true;
card().querySelector('button').click();await wait(()=>!card(),'close context profile');
const pending=b.request({name:'getParticipantProfile',socketId:users().find(u=>u.name==='Bob').id}).catch(()=>null);b.send({name:'closeParticipantProfile'});await pending;await sleep(250);log.cancel=!s().participantProfile;
document.querySelector('.tri-call-card[aria-label="Bob"]').click();await loaded();log.call=true;
b.send({name:'sendChatMessage',text:'profile-e2e-cycle'});
document.querySelector('[aria-label="Mostrar chat"]')?.click();
const msg=t=>[...document.querySelectorAll('.tri-message')].find(m=>m.textContent.includes(t));
await wait(()=>msg('oi do Bob')?.querySelector('.tri-message__avatar-still')&&msg('profile-e2e-cycle')?.querySelector('.tri-message__avatar-still'),'chat avatars',15000);
log.chatAvatars=msg('oi do Bob').querySelector('.tri-message__avatar-still').src.startsWith('data:image/png')&&!!msg('oi do Bob').querySelector('.tri-message__avatar-animated')
  &&!!msg('profile-e2e-cycle').querySelector('.tri-message__avatar-animated');
await wait(()=>!users().some(u=>u.name==='Bob'),'Bob left');await wait(()=>!card()&&!s().participantProfile,'closed after departure');log.departure=true;
await wait(()=>users().some(u=>u.name==='Bob'),'Bob returned');row().click();await loaded();log.reopen=true;log.visible=!!card();log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()""".replace('COMMON',COMMON)
BOB=r"""(()=>{COMMON
(async()=>{
await wait(()=>s().categories.flatMap(c=>c.channels).some(c=>c.name==='Perfis E2E'),'room');
const channel=s().categories.flatMap(c=>c.channels).find(c=>c.name==='Perfis E2E');b.send({name:'selectChannel',channelId:channel.id});
await wait(()=>s().connectedChannelId===channel.id,'join');await b.request({name:'setCustomStatus',text:'Jogando no Triscord'});b.send({name:'sendChatMessage',text:'oi do Bob'});
await wait(()=>s().chat?.some(m=>m.text==='profile-e2e-cycle'),'Alice ready');b.send({name:'leaveVoice'});await sleep(1800);b.send({name:'selectChannel',channelId:channel.id});
await wait(()=>s().connectedChannelId===channel.id,'rejoin');log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()""".replace('COMMON',COMMON)
PROBE="JSON.stringify({...window.__e2e,visible:!!document.querySelector('.tri-participant-profile')})"
def upload(config,token,kind,size,color):
    # Animated GIF (two frames): the card must keep it animated, the lists show its first frame (18/10).
    data=io.BytesIO();frames=[Image.new('RGB',size,color),Image.new('RGB',size,'#2d7d46')]
    frames[0].save(data,format='GIF',save_all=True,append_images=frames[1:],duration=200,loop=0)
    req=urllib.request.Request(config['authUrl']+'/profile/'+kind,data=data.getvalue(),method='PUT',headers={'Authorization':'Bearer '+token,'Content-Type':'image/gif'})
    with urllib.request.urlopen(req,timeout=15) as response:assert response.status==200

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--exe',required=True);parser.add_argument('--assets',default=str(DESKTOP/'web/dist'));args=parser.parse_args()
    work=Path(tempfile.mkdtemp(prefix='triscord-public-profile-'));report=DESKTOP/'out/web-participant-e2e-report';report.mkdir(parents=True,exist_ok=True)
    backend=None;processes=[];logs=[];passed=False
    try:
        backend=Backend(*bundle_workers(DESKTOP/'out/participant-e2e-backend'),report/'backend.log');config=backend.config;google=config['googleAuthUrl'].rsplit('/',1)[0]
        at,a=account(config,google,'public-alice','Alice');bt,bob=account(config,google,'public-bob','Bob');a['nick']='Alice';bob['nick']='Bob'
        request(config['authUrl']+'/profile','PATCH',{'display_name':'Bob Perfil','pronouns':'ele/dele','bio':'Bio pública de Bob','note':'PRIVATE_NOTE_DO_NOT_EXPOSE','banner_color':'#123456','profile_theme_start':'#15344a','profile_theme_end':'#254331'},bt)
        upload(config,bt,'avatar',(128,128),'#e6b75a');upload(config,at,'avatar',(128,128),'#8a5ae6');upload(config,bt,'banner',(400,140),'#365e80')
        server=request(config['hubUrl']+'/servers','POST',{'name':'Perfis'},at);code=request(f"{config['hubUrl']}/servers/{server['id']}/invites",'POST',{},at)['code'];request(config['hubUrl']+'/invites/'+code+'/accept','POST',{},bt)
        (work/'probe.js').write_text(PROBE,encoding='utf8');(work/'alice.js').write_text(ALICE,encoding='utf8');(work/'bob.js').write_text(BOB,encoding='utf8')
        for name,token,acct,delay in [('alice',at,a,0),('bob',bt,bob,5)]:
            if delay:time.sleep(delay)
            log=(report/f'{name}.log').open('w',encoding='utf8');logs.append(log)
            processes.append(launch(args.exe,args.assets,config,profile(work,name,token,acct,server['id']),work/f'{name}.js',2500,work/'probe.js',26000 if name=='alice' else 21000,report/f'{name}.png',29 if name=='alice' else 24,log))
        for p in processes:p.wait(timeout=55)
        for log in logs:log.close()
        ar=last(report/'alice.log');br=last(report/'bob.log');print('Alice:',json.dumps(ar,ensure_ascii=False));print('Bob:',json.dumps(br,ensure_ascii=False))
        checks={key:ar.get(key) is True for key in ['authenticated','fields','width','date','prefetched','media','rowStatic','avatarRow','callGif','chatAvatars','avatarCall','privacy','tab','escape','badSocket','extraField','context','cancel','call','departure','reopen','visible','done']}
        checks['Bob rejoined']=br.get('done') is True
        checks['private data absent from Alice log']='PRIVATE_NOTE_DO_NOT_EXPOSE' not in (report/'alice.log').read_text(encoding='utf8',errors='replace')
        for name,ok in checks.items():print(('PASS: ' if ok else 'FAIL: ')+name)
        passed=all(checks.values())
    finally:
        for p in processes:
            if p.poll() is None:p.kill();p.wait()
        for log in logs:
            if not log.closed:log.close()
        if backend:backend.close()
        if work.resolve().parent!=Path(tempfile.gettempdir()).resolve() or not work.name.startswith('triscord-public-profile-'):raise RuntimeError('Unsafe cleanup')
        shutil.rmtree(work)
    return 0 if passed else 1
if __name__=='__main__':sys.exit(main())
