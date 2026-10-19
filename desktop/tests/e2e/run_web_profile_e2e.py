"""Native C++/WebView2 profile editor, real local Workers/D1, synthetic image files only."""
import argparse, base64, io, json, random, shutil, sys, tempfile
from pathlib import Path
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers
from run_web_call_e2e import account, profile, launch
from run_web_e2e import request

SCRIPT=r"""(()=>{
const log=window.__e2e={},bridge=window.__triscord.bridge,s=()=>window.__triscord.store.current;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test,label){const end=Date.now()+16000;while(Date.now()<end){if(test())return;await sleep(80);}throw Error(label);}
function input(label,value){const el=document.querySelector(`[aria-label="${label}"]`);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}
async function image(label,b64,type){const raw=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([raw],'fixture.'+(type==='image/gif'?'gif':'png'),{type}));const el=document.querySelector(`input[aria-label="${label}"]`);el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));}
(async()=>{
  await wait(()=>s().auth?.state==='signedIn','signed in');
  document.querySelector('[aria-label="Configurações de usuário"]').click();
  await wait(()=>document.querySelector('.tri-settings__profile'),'settings');document.querySelector('.tri-settings__profile').click();
  await wait(()=>document.querySelector('.tri-profile-editor fieldset:not(:disabled)'),'profile loaded');
  input('Nome de exibição','Alice Perfil');input('Pronomes','ela/dela');input('Bio','Bio de teste do cliente web');input('Nota (visível apenas para você)','PROFILE_PRIVATE_SENTINEL');
  input('Cor da faixa','#123456');input('Cor primária','#123456');input('Cor secundária','#654321');
  await sleep(100);log.preview=document.querySelector('.tri-profile-preview h2').textContent;
  document.querySelector('#tri-profile-form').requestSubmit();
  await wait(()=>s().profile?.display_name==='Alice Perfil'&&document.querySelector('.tri-profile-editor footer [role="status"]').textContent==='Perfil salvo.','save');
  log.saved=s().profile.bio==='Bio de teste do cliente web';
  input('Bio','rascunho descartado');await sleep(100);document.querySelector('[aria-label="Fechar perfil"]').click();
  await wait(()=>[...document.querySelectorAll('.tri-dmodal button')].some(b=>b.textContent==='Cancelar'),'discard dialog');
  [...document.querySelectorAll('.tri-dmodal button')].find(b=>b.textContent==='Cancelar').click();
  await sleep(300);log.discardCancelled=document.querySelector('textarea[aria-label="Bio"]').value==='rascunho descartado';
  [...document.querySelectorAll('.tri-profile-editor footer button')].find(b=>b.textContent==='Redefinir').click();
  await sleep(100);log.reset=document.querySelector('textarea[aria-label="Bio"]').value==='Bio de teste do cliente web';
  await image('Alterar avatar','AVATAR','image/png');
  await wait(()=>s().profile?.avatarDataUrl?.startsWith('data:image/png')&&!document.querySelector('.tri-profile-editor fieldset').disabled,'avatar');
  log.avatar=true;
  await image('Alterar faixa','BANNER','image/gif');
  await wait(()=>s().profile?.bannerDataUrl?.startsWith('data:image/gif')&&!document.querySelector('.tri-profile-editor fieldset').disabled,'banner');
  log.banner=true;
  await image('Alterar avatar',btoa('<svg onload="bad"></svg>'),'image/png');
  await wait(()=>document.querySelector('.tri-profile-editor footer [role="alert"]'),'invalid file');log.invalidRejected=true;
  [...document.querySelectorAll('.tri-profile-editor__media button')].find(b=>b.textContent==='Remover avatar').click();
  await wait(()=>!s().profile?.hasAvatar&&!document.querySelector('.tri-profile-editor fieldset').disabled,'remove');log.removed=true;
  await image('Alterar avatar','AVATAR','image/png');
  await wait(()=>s().profile?.hasAvatar&&!!s().profile?.avatarDataUrl&&!document.querySelector('.tri-profile-editor fieldset').disabled,'replace avatar');
  const begin=await bridge.request({name:'beginProfileMedia',kind:'avatar',size:4});
  try{await bridge.request({name:'appendProfileMedia',uploadId:begin.uploadId,offset:3,data:'YWJj'});log.badOffset=false;}catch{log.badOffset=true;}
  await bridge.request({name:'cancelProfileMedia',uploadId:begin.uploadId});
  try{await bridge.request({name:'saveOwnProfile',fields:{email:'forged@example.com'}});log.privateFieldRejected=false;}catch{log.privateFieldRejected=true;}
  const wire=JSON.stringify(s());log.noCredentials=!wire.includes('token_hash')&&!wire.includes('sessionHash')&&!wire.includes('Bearer');
  log.noUpsell=!document.querySelector('.tri-profile-editor').textContent.includes('Nitro');
  dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await wait(()=>!document.querySelector('.tri-profile-editor')&&!!document.querySelector('.tri-settings'),'only top modal closes');
  log.escapeKeepsSettings=true;
  document.querySelector('.tri-settings__profile').click();
  await wait(()=>document.querySelector('.tri-profile-editor fieldset:not(:disabled)'),'profile reloaded');
  log.reopened=document.querySelector('input[aria-label="Nome de exibição"]').value==='Alice Perfil';
  log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()"""
PROBE="JSON.stringify(window.__e2e || {})"

def last(path):
    rows=[x[8:] for x in path.read_text(encoding='utf8',errors='replace').splitlines() if x.startswith('script: ')]
    return json.loads(json.loads(rows[-1])) if rows else {}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--exe',required=True);parser.add_argument('--assets',default=str(DESKTOP/'web/dist'));args=parser.parse_args()
    work=Path(tempfile.mkdtemp(prefix='triscord-profile-'));report=DESKTOP/'out/web-profile-e2e-report';report.mkdir(parents=True,exist_ok=True)
    backend=None;p=None;passed=False
    try:
        rng=random.Random(42);im=Image.frombytes('RGB',(320,320),rng.randbytes(320*320*3));buf=io.BytesIO();im.save(buf,format='PNG');avatar=buf.getvalue()
        frames=[Image.new('RGB',(160,60),c) for c in ['#123456','#654321']];buf=io.BytesIO();frames[0].save(buf,format='GIF',save_all=True,append_images=frames[1:],duration=200,loop=0);banner=buf.getvalue()
        assert 65536<len(avatar)<524288
        backend=Backend(*bundle_workers(DESKTOP/'out/profile-e2e-backend'),report/'backend.log');config=backend.config;google=config['googleAuthUrl'].rsplit('/',1)[0]
        token,a=account(config,google,'profile-alice','Alice');a['nick']='Alice'
        script=SCRIPT.replace('AVATAR',base64.b64encode(avatar).decode()).replace('BANNER',base64.b64encode(banner).decode())
        (work/'driver.js').write_text(script,encoding='utf8');(work/'probe.js').write_text(PROBE,encoding='utf8')
        with (report/'profile.log').open('w',encoding='utf8') as log:
            p=launch(args.exe,args.assets,config,profile(work,'alice',token,a,''),work/'driver.js',2500,work/'probe.js',24000,report/'profile.png',27,log);p.wait(timeout=50)
        result=last(report/'profile.log');print(json.dumps(result,ensure_ascii=False))
        saved=request(config['authUrl']+'/me',token=token)['account'];public=request(config['authUrl']+'/profile/profile-alice')['profile']
        reloaded=request(config['authUrl']+'/auth/google','POST',{'id_token':request(google+'/e2e-id-token?sub=profile-alice')['id_token']})['account']
        checks={key:result.get(key) is True for key in ['saved','discardCancelled','reset','avatar','banner','invalidRejected','removed','badOffset','privateFieldRejected','noCredentials','noUpsell','escapeKeepsSettings','reopened','done']}
        checks.update({'live preview':result.get('preview')=='Alice Perfil','real database profile':saved.get('display_name')=='Alice Perfil' and saved.get('pronouns')=='ela/dela' and saved.get('note')=='PROFILE_PRIVATE_SENTINEL',
                       'public privacy':'note' not in public and 'email' not in public,
                       'custom avatar survives login':reloaded.get('avatar_url')==saved.get('avatar_url'),
                       'PNG/GIF byte roundtrip':bool(saved.get('avatar_url')) and bool(saved.get('banner_url'))})
        # Read the actual bytes returned by the two public media routes.
        import urllib.request
        if saved.get('avatar_url') and saved.get('banner_url'):
            checks['PNG/GIF byte roundtrip']=urllib.request.urlopen(saved['avatar_url'],timeout=10).read()==avatar and urllib.request.urlopen(saved['banner_url'],timeout=10).read()==banner
        text=(report/'profile.log').read_text(encoding='utf8',errors='replace')
        checks['private command payloads absent from logs']='PROFILE_PRIVATE_SENTINEL' not in text
        for name,ok in checks.items():print(('PASS: ' if ok else 'FAIL: ')+name)
        passed=all(checks.values())
    finally:
        if p and p.poll() is None:p.kill();p.wait()
        if backend:backend.close()
        if work.resolve().parent!=Path(tempfile.gettempdir()).resolve() or not work.name.startswith('triscord-profile-'):raise RuntimeError('Unsafe cleanup')
        shutil.rmtree(work)
    return 0 if passed else 1
if __name__=='__main__':sys.exit(main())
