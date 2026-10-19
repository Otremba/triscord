"""Real native/WebView2 audio menus with isolated settings and silent injected audio."""
import argparse,json,shutil,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from run_e2e import Backend,DESKTOP,bundle_workers
from run_web_call_e2e import account,profile,launch
from run_web_profile_e2e import last
SCRIPT=r"""(()=>{
const log=window.__e2e={},s=()=>window.__triscord.store.current;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test,label){const end=Date.now()+10000;while(Date.now()<end){if(test())return;await sleep(70);}throw Error(label);}
(async()=>{
  await wait(()=>s().auth?.state==='signedIn','signed in');
  document.querySelector('.tri-account [aria-label="Opções de entrada"]').click();
  await wait(()=>document.querySelector('.tri-audio-menu'),'input menu');
  log.width=document.querySelector('.tri-audio-menu').getBoundingClientRect().width;
  const input=document.querySelector('.tri-audio-menu input');input.value='35';input.dispatchEvent(new Event('input',{bubbles:true}));
  await wait(()=>s().settings.inputVolume===35,'input volume');
  document.querySelector('.tri-audio-menu__device').click();
  await wait(()=>document.querySelector('[role="menuitemradio"]'),'devices');
  [...document.querySelectorAll('[role="menuitemradio"]')].find(b=>b.textContent==='Padrão do Windows').click();
  await wait(()=>!document.querySelector('.tri-audio-menu'),'selection closes');log.input=true;
  document.querySelector('.tri-account [aria-label="Opções de saída"]').click();
  await wait(()=>document.querySelector('.tri-audio-menu'),'output menu');
  const output=document.querySelector('.tri-audio-menu input');output.value='145';output.dispatchEvent(new Event('input',{bubbles:true}));
  await wait(()=>s().settings.outputVolume===145,'output volume');log.output=true;
  dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await wait(()=>!document.querySelector('.tri-audio-menu'),'escape');
  log.focus=document.activeElement?.getAttribute('aria-label');
  document.querySelector('.tri-account [aria-label="Opções de saída"]').click();
  await wait(()=>document.querySelector('.tri-audio-menu__settings'),'voice settings');document.querySelector('.tri-audio-menu__settings').click();
  await wait(()=>document.querySelector('.tri-settings'),'settings');log.openedSettings=true;
  document.querySelector('.tri-settings__close').click();
  await wait(()=>!document.querySelector('.tri-settings'),'closed settings');
  document.querySelector('.tri-account [aria-label="Opções de saída"]').click();
  await wait(()=>document.querySelector('.tri-audio-menu'),'reopen');log.persisted=+document.querySelector('.tri-audio-menu input').value===145;log.done=true;
})().catch(e=>log.error=e.message);return 'started';})()"""
PROBE="JSON.stringify({...window.__e2e,settings:window.__triscord.store.current.settings})"
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--exe',required=True);parser.add_argument('--assets',default=str(DESKTOP/'web/dist'));args=parser.parse_args()
    work=Path(tempfile.mkdtemp(prefix='triscord-audio-menu-'));report=DESKTOP/'out/web-audio-menu-e2e-report';report.mkdir(parents=True,exist_ok=True)
    backend=None;p=None;passed=False
    try:
        backend=Backend(*bundle_workers(DESKTOP/'out/audio-menu-e2e-backend'),report/'backend.log');config=backend.config;google=config['googleAuthUrl'].rsplit('/',1)[0]
        token,a=account(config,google,'audio-menu-alice','Alice');a['nick']='Alice';settings=profile(work,'alice',token,a,'')
        (work/'driver.js').write_text(SCRIPT,encoding='utf8');(work/'probe.js').write_text(PROBE,encoding='utf8')
        with (report/'first.log').open('w',encoding='utf8') as log:
            p=launch(args.exe,args.assets,config,settings,work/'driver.js',2500,work/'probe.js',14000,report/'audio-menu.png',17,log);p.wait(timeout=35)
        first=last(report/'first.log');print(json.dumps(first,ensure_ascii=False))
        (work/'driver.js').write_text("'noop'",encoding='utf8')
        with (report/'second.log').open('w',encoding='utf8') as log:
            p=launch(args.exe,args.assets,config,settings,work/'driver.js',1000,work/'probe.js',3500,report/'restart.png',5,log);p.wait(timeout=20)
        second=last(report/'second.log');s=second.get('settings') or {}
        checks={key:first.get(key) is True for key in ['input','output','openedSettings','persisted','done']}
        checks.update({'menu width':first.get('width')==222,'escape focus':first.get('focus')=='Opções de saída',
                       'settings survive restart':s.get('inputVolume')==35 and s.get('outputVolume')==145 and s.get('inputDevice')==''})
        for name,ok in checks.items():print(('PASS: ' if ok else 'FAIL: ')+name)
        passed=all(checks.values())
    finally:
        if p and p.poll() is None:p.kill();p.wait()
        if backend:backend.close()
        if work.resolve().parent!=Path(tempfile.gettempdir()).resolve() or not work.name.startswith('triscord-audio-menu-'):raise RuntimeError('Unsafe cleanup')
        shutil.rmtree(work)
    return 0 if passed else 1
if __name__=='__main__':sys.exit(main())
