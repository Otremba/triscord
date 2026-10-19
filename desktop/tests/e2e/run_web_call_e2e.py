"""End-to-end call test of the new client: two triscord-web instances (real core + web UI) in one room.

Local backend only (run_e2e.py's Backend: real auth + hub Workers in Miniflare, fake Google). Alice and
Bob are created through the auth Worker; Bob joins Alice's server with a real invite. Both clients run
with isolated settings, synthetic audio and a synthetic camera (same encoder path as a real camera):

  1. Alice creates a room (core createChannel) and is connected in it;
  2. Bob opens the server, clicks the room (selectChannel) and turns his camera on (setCamera);
  3. checked on Alice's side: two participants under the channel, Bob's camera in the call grid, and the
     native video window (path A) actually painting Bob's frames; on Bob's side: connected, camera on;
  4. cancelling activation leaves no local stream, then off/on restarts the real publisher.

Usage (from desktop/): .toolchain/venv/Scripts/python.exe tests/e2e/run_web_call_e2e.py --exe out/build/triscord-web.exe
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, TOOLCHAIN, bundle_workers  # noqa: E402
from run_web_e2e import request  # noqa: E402

ROOM = "Sala Chamada E2E"
PROBE = """JSON.stringify((() => {
  const s = window.__triscord.store.current;
  const channel = s.categories.flatMap(c => c.channels).find(c => c.name === %s);
  return {
    connected: s.connectedChannelId === channel?.id,
    cameraLifecycle: window.__cameraLifecycle || {},
    users: channel ? channel.users.map(u => ({ name: u.name, camera: !!u.camera })) : [],
    streams: (s.streams || []).map(x => ({ id: x.id, kind: x.kind, title: x.title })),
    camera: !!s.camera,
    tiles: document.querySelectorAll('.tri-call-grid .tri-video-tile').length,
    cards: document.querySelectorAll('.tri-call-grid .tri-call-card').length,
    controls: !!document.querySelector('.tri-call-controls'),
  };
})())""" % json.dumps(ROOM)


def account(config, google, sub, nick):
    token = request(f"{google}/e2e-id-token?sub={sub}")["id_token"]
    login = request(f"{config['authUrl']}/auth/google", "POST", {"id_token": token})
    request(f"{config['authUrl']}/nick", "POST", {"nick": nick}, login["session"])
    return login["session"], login["account"]


def profile(work: Path, name: str, session: str, account: dict, server_id: str) -> Path:
    root = work / f"settings-{name}"
    ini = root / "Triscord" / "TriscordNativePreview.ini"
    ini.parent.mkdir(parents=True)
    ini.write_text("[General]\nlastServerId=%s\nusername=%s\n\n[auth]\nsession=%s\nid=%s\nemail=%s\nnick=%s\n"
                   % (server_id, account["nick"] or name, session, account["id"], account["email"], account["nick"] or name), encoding="utf-8")
    return root


def launch(exe, assets, config, settings, script, script_after, probe, probe_after, capture, quit_after, log):
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(TOOLCHAIN / "Qt" / "6.8.3" / "mingw_64" / "bin"), str(TOOLCHAIN / "Qt" / "Tools" / "mingw1310_64" / "bin"), env["PATH"]])
    env.update(TRISCORD_SETTINGS_PATH=str(settings), TRISCORD_AUTH_SERVER=config["authUrl"], TRISCORD_HUB_SERVER=config["hubUrl"],
               TRISCORD_AUDIO_MODE="injected", TRISCORD_VIDEO_SOURCE="synthetic")
    return subprocess.Popen([str(Path(exe).resolve()), "--assets", assets, "--devtools", "--quit-after", str(quit_after),
                             "--script", str(script), "--script-after", str(script_after), "--probe", str(probe), "--probe-after", str(probe_after),
                             "--capture", str(capture), "--capture-after", str(probe_after)],
                            env=env, stdout=log, stderr=subprocess.STDOUT)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-call-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-call-"))
    backend, passed, processes = None, False, []
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        alice_session, alice = account(config, google, "call-alice", "Alice")
        bob_session, bob = account(config, google, "call-bob", "Bob")
        alice["nick"], bob["nick"] = "Alice", "Bob"
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de Alice"}, alice_session)
        code = request(f"{config['hubUrl']}/servers/{server['id']}/invites", "POST", {}, alice_session)["code"]
        request(f"{config['hubUrl']}/invites/{code}/accept", "POST", {}, bob_session)
        print("  ok: Alice and Bob on the local backend; Bob joined Alice's server with an invite", flush=True)

        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        (work / "alice.js").write_text("window.__triscord.bridge.send({ name: 'createChannel', channelName: %s }); 'room requested'" % json.dumps(ROOM), encoding="utf-8")
        (work / "bob.js").write_text("""(() => {
  const checks = window.__cameraLifecycle = {}, state = () => window.__triscord.store.current, bridge = window.__triscord.bridge;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function wait(test, label) { const end=Date.now()+10000; while(Date.now()<end) { if(test())return; await sleep(80); } throw Error(label); }
  (async () => {
    const channel=state().categories.flatMap(c=>c.channels).find(c=>c.name === %s);
    if(!channel) throw Error('room not visible');
    bridge.send({name:'selectChannel',channelId:channel.id});
    await wait(()=>state().connectedChannelId===channel.id,'join');
    await bridge.request({name:'setCamera',on:true});
    await bridge.request({name:'setCamera',on:false});
    await wait(()=>!state().camera&&!state().cameraPending,'cancel camera');
    await sleep(600);
    checks.cancelled=!state().camera&&!state().cameraPending&&!state().streams.some(x=>x.kind==='camera');
    bridge.send({name:'setCamera',on:true});await wait(()=>state().camera,'first camera');
    bridge.send({name:'setCamera',on:false});await wait(()=>!state().camera&&!state().cameraPending,'off');
    bridge.send({name:'setCamera',on:true});await wait(()=>state().camera,'restart camera');checks.restarted=true;
  })().catch(e=>checks.error=e.message);
  return 'camera lifecycle started';
})()""" % json.dumps(ROOM), encoding="utf-8")

        alice_log = (report / "alice.log").open("w", encoding="utf-8")
        bob_log = (report / "bob.log").open("w", encoding="utf-8")
        processes.append(launch(args.exe, args.assets, config, profile(work, "alice", alice_session, alice, server["id"]),
                                work / "alice.js", 2500, work / "probe.js", 22000, report / "alice.png", 30, alice_log))
        time.sleep(6)
        processes.append(launch(args.exe, args.assets, config, profile(work, "bob", bob_session, bob, server["id"]),
                                work / "bob.js", 3500, work / "probe.js", 16000, report / "bob.png", 24, bob_log))
        for process in processes:
            process.wait(timeout=60)
        alice_log.close(); bob_log.close()

        def last_probe(path):
            lines = [line[len("script: "):] for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.startswith("script: ")]
            return json.loads(json.loads(lines[-1])) if lines else {}
        a, b = last_probe(report / "alice.log"), last_probe(report / "bob.log")
        painted = [int(m.group(2)) for m in re.finditer(r"overlay (cam:\S+) painted=(\d+)", (report / "alice.log").read_text(encoding="utf-8", errors="replace"))]
        print("  alice:", json.dumps(a, ensure_ascii=False), flush=True)
        print("  bob:  ", json.dumps(b, ensure_ascii=False), flush=True)
        print("  alice native camera window painted frames:", painted[-1] if painted else 0, flush=True)
        names = sorted(u["name"] for u in a.get("users", []))
        checks = {
            "alice connected to the room": a.get("connected") is True,
            "two participants under the channel (Alice, Bob)": names == ["Alice", "Bob"],
            "bob marked with camera on Alice's side": any(u["name"] == "Bob" and u["camera"] for u in a.get("users", [])),
            "bob's camera stream in Alice's call grid": any(s["kind"] == "camera" and s["title"] == "Bob" for s in a.get("streams", [])) and a.get("tiles", 0) >= 1,
            "native video window painting Bob's frames (path A)": bool(painted) and painted[-1] > 10,
            "call controls shown": a.get("controls") is True,
            "camera cancellation leaves no local stream": b.get("cameraLifecycle", {}).get("cancelled") is True,
            "camera restarts after off": b.get("cameraLifecycle", {}).get("restarted") is True and not b.get("cameraLifecycle", {}).get("error"),
            "bob connected with camera on": b.get("connected") is True and b.get("camera") is True,
        }
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        passed = all(checks.values())
    except Exception as error:
        print("FAIL:", error, flush=True)
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
        if backend:
            backend.close()
        shutil.rmtree(work, ignore_errors=True)
    print(f"WEB CALL E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
