"""Build real NSIS wrappers/installers around harmless recording executables.
Only temporary program directories and a unique test registry key are modified.
Test first launch, real /UPDATE install, two subsequent launches, and missing-target fallback.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import time
import threading
import uuid
import winreg

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / 'desktop'
TOOLS = ROOT / '.toolchain'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--updater-exe', help='Also test the actual Qt updater handing off a portable update')
    args = parser.parse_args()
    package_id = 'review-' + uuid.uuid4().hex + ' with spaces'
    key = 'Software\\TriscordReviewTests\\' + package_id
    runtime = Path(os.environ['LOCALAPPDATA']) / 'TriscordNative/runtime' / package_id
    checks = []
    try:
        with tempfile.TemporaryDirectory(prefix='triscord portable update ') as temp:
            work = Path(temp)
            log = work / 'launches.txt'
            env = dict(os.environ, TRISCORD_TEST_LAUNCH_LOG=str(log))
            env['PATH'] = str(TOOLS / 'Qt/Tools/mingw1310_64/bin') + os.pathsep + env['PATH']
            for label in ('old', 'new'):
                stage = work / label
                stage.mkdir()
                source = work / f'{label}.cpp'
                source.write_text('#include <cstdio>\n#include <cstdlib>\nint main(){'
                    'auto*f=std::fopen(std::getenv("TRISCORD_TEST_LAUNCH_LOG"),"a");if(!f)return 2;'
                    f'std::fprintf(f,"{label}|%s\\n",std::getenv("TRISCORD_PORTABLE_RUNTIME")?'
                    'std::getenv("TRISCORD_PORTABLE_RUNTIME"):"");return std::fclose(f);}', encoding='utf-8')
                subprocess.run([str(TOOLS/'Qt/Tools/mingw1310_64/bin/g++.exe'),str(source),'-static','-o',str(stage/'triscord-web.exe')],env=env,check=True)
            def nsis(script, stage, output, extra):
                subprocess.run([str(TOOLS/'nsis-3.11/makensis.exe'),'/V2','/INPUTCHARSET','UTF8',
                    '/DAPP_VERSION=0.0.1',f'/DAPP_ICON={DESKTOP / "assets/triscord-app.ico"}',
                    f'/DPACKAGE_DIR={stage}',f'/DOUTPUT_EXE={output}', '/DAPP_EXE=triscord-web.exe',
                    *extra, str(DESKTOP/'packaging'/script)],check=True)
            portable, installer = work/'portable.exe', work/'setup.exe'
            nsis('portable.nsi',work/'old',portable,[f'/DPACKAGE_ID={package_id}'])
            nsis('installer.nsi',work/'new',installer,[f'/DUNINSTALL_KEY={key}'])
            def launch(expected):
                before = len(log.read_text().splitlines()) if log.exists() else 0
                subprocess.run([str(portable)],env=env,check=True,timeout=30)
                until=time.monotonic()+10
                while time.monotonic()<until:
                    rows=log.read_text().splitlines() if log.exists() else []
                    if len(rows)>before:
                        assert rows[-1].split('|')[0]==expected, rows
                        return rows[-1]
                    time.sleep(.05)
                raise AssertionError('No program launch recorded')
            first=launch('old')
            assert Path(first.split('|',1)[1])==runtime
            checks.append('portable supplies its runtime path to the updater')
            installed=work/'installed app'
            # NSIS /D must be the final, unquoted parameter (even when the path contains spaces).
            command = subprocess.list2cmdline([str(installer),'/S','/UPDATE','/NOLAUNCH','/PORTABLE'])
            subprocess.run(command + f' /D={installed}',env=dict(env,TRISCORD_PORTABLE_RUNTIME=str(runtime)),check=True,timeout=30)
            assert (runtime/'updated-app.txt').read_text()==str(installed/'triscord-web.exe')
            launch('new');launch('new')
            checks.append('real installer publishes redirect; two successive portable opens run the new version')
            (installed/'triscord-web.exe').unlink()
            launch('old')
            checks.append('missing installed target falls back to the original complete runtime')
            if args.updater_exe:
                test_qt_handoff(Path(args.updater_exe).resolve(),work,env,checks)
        report=DESKTOP/'out/portable-update-regression.json'
        report.write_text(json.dumps({'passed':True,'checks':checks},indent=2),encoding='utf-8')
        print('\n'.join('PASS: '+c for c in checks))
    finally:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER,key)
        except FileNotFoundError:
            pass
        # Only the explicitly generated test package's directory is eligible for removal.
        assert runtime.parent == Path(os.environ['LOCALAPPDATA'])/'TriscordNative/runtime'
        assert runtime.name == package_id and runtime.name.startswith('review-')
        if runtime.exists():
            shutil.rmtree(runtime)


def test_qt_handoff(exe, work, env, checks):
    """Real release updater with a harmless argument-recording replacement for the installer."""
    source=work/'record-args.cpp'
    source.write_text('#include <cstdio>\n#include <cstdlib>\nint main(int n,char**v){'
        'auto*f=std::fopen(std::getenv("TRISCORD_TEST_ARGS_LOG"),"w");if(!f)return 2;'
        'for(int i=1;i<n;++i)std::fprintf(f,"%s\\n",v[i]);'
        'return std::fclose(f);}',encoding='utf-8')
    recorder=work/'record-args.exe'
    subprocess.run([str(TOOLS/'Qt/Tools/mingw1310_64/bin/g++.exe'),str(source),'-static','-o',str(recorder)],env=env,check=True)
    payload=recorder.read_bytes()
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            base=f'http://127.0.0.1:{self.server.server_port}'
            if self.path=='/releases':
                data=json.dumps([{'tag_name':'desktop-v9.9.9','assets':[
                    {'name':'Triscord-Setup-9.9.9.exe','browser_download_url':base+'/setup'},
                    {'name':'Triscord-Setup-9.9.9.exe.sha256','browser_download_url':base+'/checksum'}]}]).encode()
            elif self.path=='/checksum':data=hashlib.sha256(payload).hexdigest().encode()
            else:data=payload
            self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    runtime=work/'Qt runtime with spaces';runtime.mkdir()
    shutil.copy2(exe,runtime/'triscord-web.exe')
    shutil.copy2(exe.parent/'WebView2Loader.dll',runtime/'WebView2Loader.dll')
    (runtime/'complete.marker').write_text('test')
    downloads=work/'downloads';downloads.mkdir()
    arguments=work/'installer-arguments.txt'
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    appenv=dict(env,TRISCORD_TEST_ARGS_LOG=str(arguments),TRISCORD_PORTABLE_RUNTIME=str(runtime),
        TRISCORD_SETTINGS_PATH=str(work/'settings'),TEMP=str(downloads),TMP=str(downloads),
        TRISCORD_FORCE_UPDATE_CHECK='1',TRISCORD_SKIP_UPDATE='0',TRISCORD_AUDIO_MODE='injected',
        TRISCORD_UPDATE_URL=f'http://127.0.0.1:{server.server_port}/releases')
    appenv['PATH']=str(TOOLS/'Qt/6.8.3/mingw_64/bin')+os.pathsep+appenv['PATH']
    process=None
    try:
        with (work/'updater.log').open('w',encoding='utf-8') as output:
            process=subprocess.Popen([str(runtime/'triscord-web.exe')],env=appenv,stdout=output,stderr=subprocess.STDOUT)
            assert process.wait(timeout=25)==0
        until=time.monotonic()+10
        while not arguments.exists() and time.monotonic()<until:time.sleep(.05)
        assert arguments.read_text().splitlines()==['/S','/UPDATE','/PORTABLE']
        checks.append('actual Qt updater verifies download, exits and forwards /PORTABLE for a runtime path with spaces')
    finally:
        if process and process.poll() is None:process.kill();process.wait()
        server.shutdown()


if __name__=='__main__':
    main()
