"""End-to-end test of the new client (triscord-web: real native core + web interface in WebView2).

Uses the same local backend as run_e2e.py (real auth + hub Workers in Miniflare, fake Google). The
account is created directly through the auth Worker (the web login screen does not exist yet), then
triscord-web runs signed in with isolated settings and synthetic audio and is checked through its UI:

  1. the rail lists the account's server and the header shows it (servers from the real hub);
  2. the core's createChannel command makes a room, the hub answers room-joined and the UI shows the
     user connected in it (signaling + voice service + CoreSession deltas -> web store -> DOM).

Usage (from desktop/): .toolchain/venv/Scripts/python.exe tests/e2e/run_web_e2e.py --exe out/build/triscord-web.exe
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, TOOLCHAIN, bundle_workers  # noqa: E402


def request(url, method="GET", body=None, token=None):
    headers = {"Content-Type": "application/json"} if body is not None else {}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=headers), timeout=15) as response:
        return json.loads(response.read() or b"{}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-e2e-"))
    backend = None
    passed = False
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        id_token = request(f"{google}/e2e-id-token?sub=web-alice")["id_token"]
        login = request(f"{config['authUrl']}/auth/google", "POST", {"id_token": id_token})
        session, account = login["session"], login["account"]
        request(f"{config['authUrl']}/nick", "POST", {"nick": "Alice"}, session)
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de Alice"}, session)
        print("  ok: account and server created on the local backend", flush=True)

        # QSettings INI for the isolated profile (same keys AuthSession::persist writes).
        ini = work / "settings" / "Triscord" / "TriscordNativePreview.ini"
        ini.parent.mkdir(parents=True)
        ini.write_text("[General]\nlastServerId=%s\nusername=Alice\n\n[auth]\nsession=%s\nid=%s\nemail=%s\nnick=Alice\n"
                       % (server["id"], session, account["id"], account["email"]), encoding="utf-8")
        action = work / "action.js"
        action.write_text("window.__triscord.bridge.send({ name: 'createChannel', channelName: 'Sala Web E2E' }); 'sent'", encoding="utf-8")
        probe = work / "probe.js"
        probe.write_text("""JSON.stringify({
  rail: [...document.querySelectorAll('.tri-rail__button')].map(b => b.getAttribute('aria-label')),
  header: document.querySelector('.tri-server-header__name')?.textContent,
  channels: [...document.querySelectorAll('.tri-channel__name')].map(e => e.textContent),
  connected: document.querySelector('.tri-channel.is-connected .tri-channel__name')?.textContent ?? null,
  account: document.querySelector('.tri-account__display')?.textContent,
})""", encoding="utf-8")

        env = dict(os.environ)
        env["PATH"] = os.pathsep.join([str(TOOLCHAIN / "Qt" / "6.8.3" / "mingw_64" / "bin"), str(TOOLCHAIN / "Qt" / "Tools" / "mingw1310_64" / "bin"), env["PATH"]])
        env.update(TRISCORD_SETTINGS_PATH=str(work / "settings"), TRISCORD_AUTH_SERVER=config["authUrl"],
                   TRISCORD_HUB_SERVER=config["hubUrl"], TRISCORD_AUDIO_MODE="injected")
        result = subprocess.run([str(Path(args.exe).resolve()), "--assets", args.assets, "--devtools", "--quit-after", "16",
                                 "--script", str(action), "--script-after", "2500",
                                 "--probe", str(probe), "--probe-after", "9000",
                                 "--capture", str(report / "web-client.png"), "--capture-after", "9000"],
                                env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        (report / "client.log").write_text(result.stdout + result.stderr, encoding="utf-8")
        probes = [line[len("script: "):] for line in result.stdout.splitlines() if line.startswith("script: ")]
        state = json.loads(json.loads(probes[-1])) if probes else {}
        print("  ui state:", json.dumps(state, ensure_ascii=False), flush=True)
        checks = {
            "server listed in the rail": "Servidor de Alice" in (state.get("rail") or []),
            "server header": state.get("header") == "Servidor de Alice",
            "account name": state.get("account") == "Alice",
            "room created and listed": "Sala Web E2E" in (state.get("channels") or []),
            "connected to the room": state.get("connected") == "Sala Web E2E",
        }
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        passed = all(checks.values())
    except Exception as error:
        print("FAIL:", error, flush=True)
    finally:
        if backend:
            backend.close()
        shutil.rmtree(work, ignore_errors=True)
    print(f"WEB E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
