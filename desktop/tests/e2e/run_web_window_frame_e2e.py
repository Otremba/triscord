"""Read the real HWND corner policy while the Qt/WebView2 client maximizes/restores itself.
Uses isolated settings, no login and no audio devices. Window actions go through the app's own bridge.
"""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT=Path(__file__).resolve().parents[3]
user32=ctypes.windll.user32
dwm=ctypes.windll.dwmapi
dwm.DwmGetWindowAttribute.argtypes=[wintypes.HWND,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD]
user32.GetWindowRect.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.RECT)]


def sample(pid):
    rows=[]
    @ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
    def visit(hwnd,_):
        owner=wintypes.DWORD();user32.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
        if owner.value==pid and user32.IsWindowVisible(hwnd):
            text=ctypes.create_unicode_buffer(100);user32.GetWindowTextW(hwnd,text,100)
            if text.value=='Triscord':
                preference=ctypes.c_int(-1);rect=wintypes.RECT()
                hr=dwm.DwmGetWindowAttribute(hwnd,33,ctypes.byref(preference),4)
                user32.GetWindowRect(hwnd,ctypes.byref(rect))
                rows.append({'corner':preference.value,'hr':hr,'width':rect.right-rect.left,'height':rect.bottom-rect.top})
        return True
    user32.EnumWindows(visit,0)
    return rows[0] if rows else None


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--exe',required=True);args=parser.parse_args()
    report=ROOT/'desktop/out/web-window-frame-e2e';report.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='triscord-window-frame-') as temp:
        work=Path(temp);script=work/'driver.js'
        script.write_text("""(()=>{const b=window.__triscord.bridge;
for(const [delay,action] of [[600,'maximize'],[2200,'maximize'],[3800,'maximize'],[5400,'maximize']])
setTimeout(()=>b.send({name:'window',action}),delay);return 'frame transitions scheduled';})()""",encoding='utf-8')
        env=dict(os.environ,TRISCORD_SETTINGS_PATH=str(work/'settings'),TRISCORD_AUDIO_MODE='injected',
            TRISCORD_AUTH_SERVER='http://127.0.0.1:9',TRISCORD_HUB_SERVER='http://127.0.0.1:9')
        env.pop('TRISCORD_FORCE_UPDATE_CHECK',None)
        env['PATH']=str(ROOT/'.toolchain/Qt/6.8.3/mingw_64/bin')+os.pathsep+str(ROOT/'.toolchain/Qt/Tools/mingw1310_64/bin')+os.pathsep+env['PATH']
        with (report/'app.log').open('w',encoding='utf-8') as output:
            p=subprocess.Popen([str(Path(args.exe).resolve()),'--assets',str(ROOT/'desktop/web/dist'),
                '--devtools','--script',str(script),'--script-after','1800','--quit-after','10'],env=env,stdout=output,stderr=subprocess.STDOUT)
            transitions=[]
            try:
                end=time.monotonic()+20
                while p.poll() is None and time.monotonic()<end:
                    row=sample(p.pid)
                    if row and (not transitions or row!=transitions[-1]):transitions.append(row)
                    time.sleep(.08)
                assert p.wait(timeout=3)==0
            finally:
                if p.poll() is None:p.kill();p.wait()
        settled=[]
        for row in transitions:
            if row['hr']==0 and row['corner'] in (1,2) and (not settled or settled[-1]['corner']!=row['corner']):settled.append(row)
        sequence=[r['corner'] for r in settled]
        checks={'round restored, square maximized, repeated twice':sequence==[2,1,2,1,2],
            'restored geometry preserved':all(r['width']==1264 and r['height']==892 for r in settled if r['corner']==2),
            'maximized geometry expands':all(r['width']>1264 for r in settled if r['corner']==1)}
        (report/'result.json').write_text(json.dumps({'passed':all(checks.values()),'checks':checks,'transitions':transitions},indent=2),encoding='utf-8')
        for name,ok in checks.items():print(('PASS: ' if ok else 'FAIL: ')+name)
        assert all(checks.values()),transitions


if __name__=='__main__':main()
