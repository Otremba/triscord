"""Real web/native client + two real Workers, local disposable accounts, injected (silent) audio.
Checks local preview isolation, room broadcast, catalog validation, deafen and popup behavior.
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers
from run_web_e2e import request
from run_web_call_e2e import account, profile, launch

COMMON = r"""
const log = window.__e2e = {};
const bridge = window.__triscord.bridge, s = () => window.__triscord.store.current;
const heard=new Set(); window.__triscord.store.subscribe(state=>{if(state?.soundboardPlayingId) heard.add(state.soundboardPlayingId);});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(test, label) { const until = Date.now()+18000; while(Date.now()<until) { if(test()) return; await sleep(70); } throw Error(label); }
const chat = text => bridge.request({name:'sendChatMessage',text});
const has = text => (s().chat||[]).some(m=>m.text===text);
"""
ALICE = r"""(() => { COMMON
(async () => {
  await bridge.request({name:'createChannel',channelName:'Soundboard E2E'});
  await wait(()=>s().categories.flatMap(c=>c.channels).some(c=>c.users.length===2),'two clients');
  document.querySelector('.tri-voice-panel [aria-label="Abrir efeitos sonoros"]').click();
  await wait(()=>document.querySelector('.tri-soundboard'),'popover');
  const panel = document.querySelector('.tri-soundboard'), box=panel.getBoundingClientRect();
  log.width=box.width; log.height=box.height; log.catalog=s().soundboard.length; log.firstId=s().soundboard[0].id; log.reverseId=s().soundboard[2].id;
  const input=panel.querySelector('input'), id=s().soundboard[0].id, name=s().soundboard[0].name;
  input.value=name; input.dispatchEvent(new Event('input',{bubbles:true}));
  await sleep(100); log.filtered=panel.querySelectorAll('.tri-soundboard__tile').length;
  panel.querySelector('.tri-soundboard__preview').click();
  await wait(()=>s().soundboardPlayingId===id,'local preview'); log.preview=true;
  await chat('preview ready');
  await wait(()=>has('preview isolated'),'preview isolation');
  await bridge.request({name:'stopSoundPreview'});
  await sleep(1100); panel.querySelector('.tri-soundboard__play').click();
  await wait(()=>s().soundboardPlayingId===id,'self broadcast');
  try { await bridge.request({name:'playSound',soundId:id}); log.rateLimited=false; }
  catch { log.rateLimited=true; }
  await wait(()=>has('deafened ready'),'remote heard and deafened');
  input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); await sleep(1100);
  panel.querySelectorAll('.tri-soundboard__play')[1].click();
  await sleep(300); await chat('second sent');
  await wait(()=>has('complete'),'deafen isolation');
  await wait(()=>has('reverse sent'),'reverse broadcast marker');
  log.reverse=heard.has(s().soundboard[2].id);
  await sleep(700); await chat('reverse received');
  await wait(()=>has('rejoined'),'peer left and rejoined');
  await sleep(350);
  await bridge.request({name:'setMuted',muted:true}); await sleep(350);
  await bridge.request({name:'setMuted',muted:false}); await sleep(350);
  await bridge.request({name:'setSetting',key:'callSounds',value:false});
  await bridge.request({name:'setMuted',muted:true}); await sleep(350);
  await bridge.request({name:'setMuted',muted:false}); await sleep(350);
  log.cuesDisabled=s().settings.callSounds===false;
  await bridge.request({name:'setSetting',key:'callSounds',value:true});
  await chat('all complete');
  try { await bridge.request({name:'playSound',soundId:'../not-in-catalog'}); log.invalidRejected=false; }
  catch { log.invalidRejected=true; }
  dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await wait(()=>!document.querySelector('.tri-soundboard'),'escape'); log.escape=true;
  log.focus=document.activeElement?.getAttribute('aria-label'); log.done=true;
  document.querySelector('.tri-voice-panel [aria-label="Abrir efeitos sonoros"]').click();
})().catch(e=>log.error=e.message); return 'started'; })()""".replace('COMMON', COMMON)
BOB = r"""(() => { COMMON
(async()=>{
  await wait(()=>s().categories.flatMap(c=>c.channels).some(c=>c.name==='Soundboard E2E'),'room');
  const room=s().categories.flatMap(c=>c.channels).find(c=>c.name==='Soundboard E2E');
  await bridge.request({name:'joinVoice',channelId:room.id});
  await wait(()=>has('preview ready'),'preview marker');
  log.previewIsolated=!s().soundboardPlayingId; await chat('preview isolated');
  await wait(()=>!!s().soundboardPlayingId,'broadcast'); log.broadcast=true;
  log.soundId=s().soundboardPlayingId;
  await bridge.request({name:'setMuted',muted:true}); await sleep(350);
  log.cueKeepsSoundboard=s().soundboardPlayingId===log.soundId;
  await bridge.request({name:'setMuted',muted:false}); await sleep(350);
  await bridge.request({name:'setDeafened',deafened:true});
  await wait(()=>!s().soundboardPlayingId,'deafen stop');
  await sleep(700); await chat('deafened ready');
  await wait(()=>has('second sent'),'second sound'); await sleep(400);
  log.deafenedSilent=!s().soundboardPlayingId;
  await sleep(700); await chat('complete');
  await bridge.request({name:'setDeafened',deafened:false}); await sleep(400);
  await bridge.request({name:'playSound',soundId:s().soundboard[2].id});
  await sleep(700); await chat('reverse sent');
  await wait(()=>has('reverse received'),'Alice received Bob sound');
  await bridge.request({name:'leaveVoice'}); await sleep(600);
  await bridge.request({name:'joinVoice',channelId:room.id}); await sleep(700);
  await chat('rejoined'); await wait(()=>has('all complete'),'cue checks'); log.done=true;
})().catch(e=>log.error=e.message); return 'started'; })()""".replace('COMMON', COMMON)
PROBE = "JSON.stringify(window.__e2e || {})"

def result(path):
    lines = [x[8:] for x in path.read_text(encoding='utf-8', errors='replace').splitlines() if x.startswith('script: ')]
    return json.loads(json.loads(lines[-1])) if lines else {}

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--exe',required=True)
    parser.add_argument('--assets',default=str(DESKTOP/'web/dist'))
    args=parser.parse_args(); work=Path(tempfile.mkdtemp(prefix='triscord-soundboard-'))
    report=DESKTOP/'out'/'web-soundboard-e2e-report'; report.mkdir(parents=True,exist_ok=True)
    backend=None; processes=[]; passed=False
    os.environ['TRISCORD_TEST_DECODE_AUDIO']='1'
    os.environ['TRISCORD_TEST_SOUND_CACHE']=str(work/'sound-cache')
    try:
        backend=Backend(*bundle_workers(DESKTOP/'out'/'soundboard-e2e-backend'),report/'backend.log')
        config=backend.config; google=config['googleAuthUrl'].rsplit('/',1)[0]
        ta,a=account(config,google,'sb-alice','Alice'); tb,b=account(config,google,'sb-bob','Bob')
        a['nick']='Alice'; b['nick']='Bob'
        server=request(config['hubUrl']+'/servers','POST',{'name':'Soundboard E2E'},ta)
        code=request(config['hubUrl']+f"/servers/{server['id']}/invites",'POST',{},ta)['code']
        request(config['hubUrl']+f'/invites/{code}/accept','POST',{},tb)
        (work/'probe.js').write_text(PROBE,encoding='utf-8')
        for name,script,token,user in [('alice',ALICE,ta,a),('bob',BOB,tb,b)]:
            (work/f'{name}.js').write_text(script,encoding='utf-8')
            with (report/f'{name}.log').open('w',encoding='utf-8') as log:
                processes.append(launch(args.exe,args.assets,config,profile(work,name,token,user,server['id']),
                    work/f'{name}.js',2500,work/'probe.js',42000,report/f'{name}.png',45,log))
        for p in processes: p.wait(timeout=65)
        a=result(report/'alice.log'); b=result(report/'bob.log')
        print('Alice:',json.dumps(a,ensure_ascii=False)); print('Bob:',json.dumps(b,ensure_ascii=False))
        checks={'flow complete':a.get('done') and b.get('done'), 'geometry':a.get('width')==532 and a.get('height')==522,
                'catalog and filter':a.get('catalog',0)>1 and a.get('filtered',0)>=1 and a.get('filtered',0)<a.get('catalog',0),
                'preview isolated':a.get('preview') and b.get('previewIsolated'), 'broadcast received':b.get('broadcast'), 'reverse broadcast received':a.get('reverse'), 'cue toggle saved':a.get('cuesDisabled'), 'cue does not interrupt soundboard':b.get('cueKeepsSoundboard'),
                'deafen stops and suppresses':b.get('deafenedSilent'), 'invalid ID rejected':a.get('invalidRejected'),
                'no playback errors':all('notice:' not in (report/f'{name}.log').read_text(encoding='utf-8',errors='replace') for name in ['alice','bob']),
                'local broadcast rate limit':a.get('rateLimited'),
                'Escape and focus':a.get('escape') and a.get('focus')=='Abrir efeitos sonoros'}
        traces={name:re.findall(r'audio decoded kind=(\w+) id=([a-z0-9]+) samples=(\d+) peak=([\d.e+-]+)',(report/f'{name}.log').read_text(encoding='utf-8',errors='replace')) for name in ['alice','bob']}
        for name,events in traces.items():
            boards={id for kind,id,samples,peak in events if kind=='soundboard' and int(samples)>0 and float(peak)>0}
            cues=[id for kind,id,samples,peak in events if kind=='cue' and int(samples)>0 and float(peak)>0]
            checks[name+' real MP3 decoded in both directions']={a.get('firstId'),a.get('reverseId')} <= boards
            checks[name+' real join and leave cues decoded']='join' in cues and ('leave' if name=='alice' else 'disconnect') in cues
            if name=='alice': checks['mute/unmute decode once, disabled cues suppressed']=cues.count('mute')==1 and cues.count('unmute')==1
        (report/'result.json').write_text(json.dumps({'checks':checks,'alice':a,'bob':b,'decoded':traces},indent=2),encoding='utf-8')
        for name,ok in checks.items(): print(('PASS: ' if ok else 'FAIL: ')+name)
        passed=all(checks.values())
    finally:
        for p in processes:
            if p.poll() is None: p.kill(); p.wait()
        if backend: backend.close()
        # Only remove the exact mkdtemp path, after checking its intended parent.
        if work.resolve().parent != Path(tempfile.gettempdir()).resolve() or not work.name.startswith('triscord-soundboard-'): raise RuntimeError('Unsafe cleanup path')
        shutil.rmtree(work)
    return 0 if passed else 1
if __name__=='__main__': sys.exit(main())
