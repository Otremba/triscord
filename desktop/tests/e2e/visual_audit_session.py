"""Long-lived session for the visual audit against Discord (desktop/AUDITORIA_VISUAL_*.md): the local backend, an
account named like the user's ("camargo"), a server "Servidor de camargo" with Discord's default rooms, and one
triscord-web (development build) whose WebView2 listens for the Chrome DevTools Protocol on --cdp-port, so a driver
(web/tools/audit-drive.mjs) can switch screens and take page screenshots at any time. The window itself is placed and
saved with PrintWindow by the auditor. Stops when --stop-file appears or after --minutes.

Usage (from desktop/): ../.toolchain/venv/Scripts/python.exe tests/e2e/visual_audit_session.py --exe out/build-claude/triscord-web.exe --info <file.json>
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, TOOLCHAIN, bundle_workers  # noqa: E402
from run_web_e2e import request  # noqa: E402
from run_web_call_e2e import account, profile  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--info", required=True)
    parser.add_argument("--stop-file", default="")
    parser.add_argument("--cdp-port", type=int, default=9333)
    parser.add_argument("--minutes", type=float, default=120)
    args = parser.parse_args()
    work = Path(tempfile.mkdtemp(prefix="triscord-audit-"))
    report = DESKTOP / "out" / "visual-audit"
    report.mkdir(parents=True, exist_ok=True)
    backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
    process = None
    try:
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        session, acct = account(config, google, "audit-camargo", "camargo")
        acct["nick"] = "camargo"
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de camargo"}, session)
        env = dict(os.environ)
        env["PATH"] = os.pathsep.join([str(TOOLCHAIN / "Qt" / "6.8.3" / "mingw_64" / "bin"), str(TOOLCHAIN / "Qt" / "Tools" / "mingw1310_64" / "bin"), env["PATH"]])
        env.update(TRISCORD_SETTINGS_PATH=str(profile(work, "camargo", session, acct, server["id"])),
                   TRISCORD_AUTH_SERVER=config["authUrl"], TRISCORD_HUB_SERVER=config["hubUrl"],
                   TRISCORD_AUDIO_MODE="injected", TRISCORD_VIDEO_SOURCE="synthetic",
                   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=f"--remote-debugging-port={args.cdp_port}")
        log = (report / "app.log").open("w", encoding="utf-8")
        process = subprocess.Popen([str(Path(args.exe).resolve()), "--assets", args.assets, "--devtools", "--quit-after", str(int(args.minutes * 60))],
                                   env=env, stdout=log, stderr=subprocess.STDOUT)
        Path(args.info).write_text(json.dumps({"pid": process.pid, "cdp": f"http://127.0.0.1:{args.cdp_port}", "serverId": server["id"],
                                               "hubUrl": config["hubUrl"], "session": session}), encoding="utf-8")
        print("audit session ready", flush=True)
        end = time.time() + args.minutes * 60
        while time.time() < end and process.poll() is None:
            if args.stop_file and Path(args.stop_file).exists():
                break
            time.sleep(1)
    finally:
        if process and process.poll() is None:
            process.kill()
        backend.close()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
