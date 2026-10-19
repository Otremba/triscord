"""Own GIF avatar visibly animates in a real call; no real account, hardware or screen capture source."""
import argparse
import base64
import hashlib
import io
import json
import shutil
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers
from run_web_call_e2e import account, profile
from run_web_e2e import request
from run_web_resource_benchmark import Tree, launch, parse_probe
from run_web_popout_e2e import top_windows
from run_web_video_menu_e2e import save_window

SCRIPT = r"""(()=>{
const log=window.__perf={},s=()=>window.__triscord.store.current,b=window.__triscord.bridge;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test,label){const end=Date.now()+12000;while(Date.now()<end){if(test())return;await sleep(70);}throw Error(label);}
const img=()=>document.querySelector('.tri-call-card[aria-label="Alice"] img');
async function phase(name){
 await wait(()=>img()?.complete&&img().naturalWidth>0,'image decoded '+name);
 const r=img().getBoundingClientRect();log.rect={x:r.x,y:r.y,w:r.width,h:r.height};log.viewport={w:innerWidth,h:innerHeight};
 log.phase=name;await sleep(4800);
}
async function upload(encoded){
 const first=await b.request({name:'beginProfileMedia',kind:'avatar',size:atob(encoded).length});
 await b.request({name:'appendProfileMedia',uploadId:first.uploadId,offset:0,data:encoded});
 await b.request({name:'finishProfileMedia',uploadId:first.uploadId});
}
(async()=>{
 await wait(()=>s().auth?.state==='signedIn'&&s().profile?.avatarDataUrl?.startsWith('data:image/gif;'),'own GIF');
 await wait(()=>s().connection==='connected','hub connected');
 b.send({name:'createChannel',channelName:'Avatar GIF E2E'});await wait(()=>s().connectedChannelId&&img(),'call');
 const room=s().connectedChannelId;
 await wait(()=>img().src.startsWith('data:image/gif;'),'GIF in call');log.gif=true;
 log.staticThumbnail=s().account.avatarUrl.startsWith('data:image/png;');
 await phase('gif');
 await upload('PNG_BYTES');await wait(()=>s().profile.avatarDataUrl.startsWith('data:image/png;')&&img()?.src===s().account.avatarUrl,'PNG replacement');log.png=true;await phase('png');
 await b.request({name:'removeProfileMedia',kind:'avatar'});await wait(()=>!s().profile.hasAvatar&&!img(),'avatar removed');log.removed=true;
 await upload('GIF_BYTES');await wait(()=>s().profile.avatarDataUrl.startsWith('data:image/gif;'),'GIF restored');
 b.send({name:'leaveVoice'});await wait(()=>!s().connectedChannelId,'left');b.send({name:'selectChannel',channelId:room});
 await wait(()=>s().connectedChannelId===room&&img()?.src.startsWith('data:image/gif;'),'GIF after rejoin');log.rejoin=true;await phase('rejoin');
 log.done=true;log.phase='complete';
})().catch(e=>{log.error=e.message;log.phase='error';});
return 'animated avatar driver started';})()"""
PROBE = "JSON.stringify(window.__perf || {})"


def fixtures():
    frames = []
    for n in range(8):
        frame = Image.new("RGB", (96, 96), "#23384b")
        ImageDraw.Draw(frame).rectangle((n * 12, 0, n * 12 + 11, 95), fill="#42647c")
        frames.append(frame)
    gif = io.BytesIO()
    frames[0].save(gif, format="GIF", save_all=True, append_images=frames[1:], duration=120, loop=0)
    png = io.BytesIO()
    Image.new("RGB", (96, 96), "#35566d").save(png, format="PNG")
    return gif.getvalue(), png.getvalue()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web/dist"))
    args = parser.parse_args()
    work = Path(tempfile.mkdtemp(prefix="triscord-gif-avatar-"))
    report = DESKTOP / "out/web-animated-avatar-e2e-report"
    report.mkdir(parents=True, exist_ok=True)
    backend, process, tree = None, None, None
    crops = {phase: [] for phase in ["gif", "png", "rejoin"]}
    result = {}
    try:
        gif, png = fixtures()
        backend = Backend(*bundle_workers(DESKTOP / "out/animated-avatar-e2e-backend"), report / "backend.log")
        config = backend.config
        token, acct = account(config, config["googleAuthUrl"].rsplit("/", 1)[0], "gif-alice", "Alice")
        acct["nick"] = "Alice"
        server = request(config["hubUrl"] + "/servers", "POST", {"name": "Avatar animado"}, token)
        req = urllib.request.Request(config["authUrl"] + "/profile/avatar", data=gif, method="PUT",
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "image/gif"})
        with urllib.request.urlopen(req, timeout=15) as response:
            assert response.status == 200
        script = SCRIPT.replace("PNG_BYTES", base64.b64encode(png).decode()).replace("GIF_BYTES", base64.b64encode(gif).decode())
        (work / "driver.js").write_text(script, encoding="utf8")
        (work / "probe.js").write_text(PROBE, encoding="utf8")
        with (report / "client.log").open("w", encoding="utf8") as log:
            process = launch(args.exe, args.assets, config, profile(work, "alice", token, acct, server["id"]),
                             work / "driver.js", work / "probe.js", log, probe_interval=1000, probe_after=1000)
            tree = Tree(process.pid)
            end = time.monotonic() + 65
            while process.poll() is None and time.monotonic() < end:
                tree.sample()
                result = parse_probe(report / "client.log")
                phase = result.get("phase")
                if phase in crops and len(crops[phase]) < 12:
                    windows = top_windows(process.pid)
                    if windows:
                        shot = report / "window.png"
                        save_window(windows[0][0], shot)
                        with Image.open(shot) as image:
                            rect, viewport = result["rect"], result["viewport"]
                            sx, sy = image.width / viewport["w"], image.height / viewport["h"]
                            # Interior of the avatar: no changing speaking ring, text, controls or cursor.
                            box = (round((rect["x"] + 8) * sx), round((rect["y"] + 8) * sy),
                                   round((rect["x"] + rect["w"] - 8) * sx), round((rect["y"] + rect["h"] - 8) * sy))
                            crop = image.crop(box)
                            crop.save(report / f"{phase}-{len(crops[phase])}.png")
                            crops[phase].append(hashlib.sha256(crop.tobytes()).hexdigest())
                if result.get("done") or result.get("error"):
                    break
                time.sleep(.22)
        checks = {key: result.get(key) is True for key in ["gif", "staticThumbnail", "png", "removed", "rejoin", "done"]}
        for phase in crops:
            checks[phase + " pixels sampled"] = len(crops[phase]) >= 4
        checks["GIF visibly animates in call"] = len(set(crops["gif"])) >= 2
        checks["GIF visibly animates after rejoining"] = len(set(crops["rejoin"])) >= 2
        checks["PNG replacement stays still"] = len(set(crops["png"])) == 1
        checks["no driver error"] = not result.get("error")
        summary = {"passed": all(checks.values()), "checks": checks, "driver": result,
                   "distinct_avatar_frames": {key: len(set(value)) for key, value in crops.items()}}
        (report / "result.json").write_text(json.dumps(summary, indent=2), encoding="utf8")
        for key, passed in checks.items():
            print(("PASS: " if passed else "FAIL: ") + key)
        print(json.dumps(summary["distinct_avatar_frames"]), result.get("error", ""))
        return 0 if summary["passed"] else 1
    finally:
        if tree:
            tree.sample()
            tree.stop_owned()
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        if backend:
            backend.close()
        assert work.resolve().parent == Path(tempfile.gettempdir()).resolve() and work.name.startswith("triscord-gif-avatar-")
        for attempt in range(10):
            try:
                shutil.rmtree(work)
                break
            except OSError:
                if attempt == 9:
                    raise
                time.sleep(.5)


if __name__ == "__main__":
    sys.exit(main())
