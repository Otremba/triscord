"""End-to-end test of the update check before opening (src/update_splash.*), against a local stand-in for the GitHub
releases API (TRISCORD_UPDATE_URL). The development build checks only with TRISCORD_FORCE_UPDATE_CHECK=1.
  1. nothing newer (desktop-v0.0.1, plus an Electron "v1.1.9" release that must be ignored): the 300x350 splash shows
     "Checking for updates…", then "Starting…", and the main window opens;
  2. the server fails (500): "Update failed — retrying in 10 sec…", the countdown runs and the check is retried;
  3. a newer release whose checksum does not match: the download is refused, nothing is started, a retry is scheduled;
  4. a newer release with the right checksum: "Downloading update 1 of 1…" with progress, "Installing update 1 of 1…",
     the harmless stand-in installer is started with /S /UPDATE and the app quits.
  5–6. stalled checksum and partial installer: each transfer times out, removes partial files and retries.
The splash of case 2 is saved (splash.png) and its background checked (#282b30).

Usage (from desktop/): ../.toolchain/venv/Scripts/python.exe tests/e2e/run_web_updater_e2e.py --exe out/build-claude/triscord-web.exe
"""
import argparse
import hashlib
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import DESKTOP, TOOLCHAIN  # noqa: E402
from run_web_popout_e2e import top_windows  # noqa: E402
from run_web_video_menu_e2e import save_window  # noqa: E402
from PIL import Image  # noqa: E402

STATE = {"mode": "none", "hits": 0}


def stand_in_installer(work: Path) -> bytes:
    """A harmless stand-in for the installer: a copy of whoami.exe, which the updater starts as `<file> /S /UPDATE`
    (it rejects the arguments and exits; nothing is installed)."""
    return (Path(os.environ["SystemRoot"]) / "System32" / "whoami.exe").read_bytes()


def make_handler(installer: bytes):
    good = hashlib.sha256(installer).hexdigest()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, code, body, kind="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            STATE["hits"] += 1
            base = f"http://127.0.0.1:{self.server.server_port}"
            mode = STATE["mode"]
            if self.path.startswith("/releases"):
                if mode == "fail":
                    return self.send(500, b"{}")
                version = "0.0.1" if mode == "none" else "9.9.9"
                assets = [{"name": f"Triscord-Setup-{version}.exe", "browser_download_url": f"{base}/setup.exe"},
                          {"name": f"Triscord-Setup-{version}.exe.sha256", "browser_download_url": f"{base}/setup.sha256"}]
                releases = [{"tag_name": "v1.1.9", "draft": False, "prerelease": False, "assets": []},   # the Electron client
                            {"tag_name": f"desktop-v{version}", "draft": False, "prerelease": False, "assets": assets}]
                return self.send(200, json.dumps(releases).encode())
            if self.path == "/setup.sha256":
                if mode == "stalled-checksum":
                    time.sleep(14)
                    return
                digest = good if mode in ("update", "stalled-installer") else "0" * 64
                return self.send(200, f"{digest}  Triscord-Setup-9.9.9.exe\n".encode(), "text/plain")
            if self.path == "/setup.exe":
                if mode == "stalled-installer":
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(installer)))
                    self.end_headers()
                    self.wfile.write(installer[:4])
                    self.wfile.flush()
                    time.sleep(14)
                    return
                return self.send(200, installer, "application/octet-stream")
            self.send(404, b"{}")
    return Handler


def run_case(args, work, port, mode, seconds, until=None):
    STATE["mode"] = mode
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(TOOLCHAIN / "Qt" / "6.8.3" / "mingw_64" / "bin"), str(TOOLCHAIN / "Qt" / "Tools" / "mingw1310_64" / "bin"), env["PATH"]])
    temp = work / f"temp-{mode}"
    temp.mkdir()
    env.update(TRISCORD_SETTINGS_PATH=str(work / f"settings-{mode}"), TRISCORD_FORCE_UPDATE_CHECK="1",
               TRISCORD_AUDIO_MODE="injected",
               TRISCORD_UPDATE_URL=f"http://127.0.0.1:{port}/releases", TEMP=str(temp), TMP=str(temp),
               TRISCORD_AUTH_SERVER="http://127.0.0.1:9", TRISCORD_HUB_SERVER="http://127.0.0.1:9")
    log = (work / f"{mode}.log").open("w", encoding="utf-8")
    process = subprocess.Popen([str(Path(args.exe).resolve()), "--assets", args.assets, "--quit-after", "40"], env=env, stdout=log, stderr=subprocess.STDOUT)
    seen, splash_png, end = [], None, time.time() + seconds
    while time.time() < end and process.poll() is None:
        windows = top_windows(process.pid)
        for hwnd, title, w, h, _ in windows:
            if (w, h) == (300, 350) and splash_png is None and mode == "fail":
                time.sleep(0.8)   # let it paint
                splash_png = work / "splash.png"
                save_window(hwnd, splash_png)
        seen.append([(t, w, h) for _, t, w, h, _ in windows])
        if until and until(seen):
            break
        time.sleep(0.25)
    exited = process.poll()
    if process.poll() is None:
        process.kill()
    process.wait(timeout=10)
    log.close()
    text = (work / f"{mode}.log").read_text(encoding="utf-8", errors="replace")
    states = [m.group(1) for m in re.finditer(r"splash: (.*)", text)]
    return {"states": states, "exited": exited, "seen": seen, "splash": splash_png, "temp": sorted(p.name for p in temp.iterdir()), "log": text}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-updater-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-updater-"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), make_handler(stand_in_installer(work)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port, passed = server.server_address[1], False
    try:
        main_open = lambda seen: any(any(t == "Triscord" and (w, h) != (300, 350) for t, w, h in s) for s in seen[-1:])
        none = run_case(args, work, port, "none", 20, main_open)
        fail = run_case(args, work, port, "fail", 14)
        bad = run_case(args, work, port, "bad", 8)
        update = run_case(args, work, port, "update", 15)
        stalled_checksum = run_case(args, work, port, "stalled-checksum", 13)
        stalled_installer = run_case(args, work, port, "stalled-installer", 13)
        for name, case in [("none", none), ("fail", fail), ("bad", bad), ("update", update),
                           ("stalled-checksum", stalled_checksum), ("stalled-installer", stalled_installer)]:
            print(f"  {name}: states {case['states'][:8]} exited={case['exited']} temp={case['temp']}", flush=True)
        background = None
        if fail["splash"] and fail["splash"].exists():   # the failure keeps the splash up long enough to save it
            shutil.copy(fail["splash"], report / "splash.png")
            background = Image.open(fail["splash"]).convert("RGB").getpixel((5, 5))
        print(f"  splash background {background}", flush=True)
        countdown = [s for s in fail["states"] if s.startswith("Update failed")]
        checks = {
            "stalled checksum and partial installer time out, schedule retry, remove partial files":
                all(any(s.startswith("Update failed") for s in c["states"])
                    and not any(s.startswith("Installing") for s in c["states"])
                    and c["temp"] == [] for c in (stalled_checksum, stalled_installer)),
            "nothing newer: Checking for updates…, Starting…, main window opens":
                none["states"][:2] == ["Checking for updates…", "Starting…"] and main_open(none["seen"]) and none["exited"] is None,
            "the splash is 300x350 on #282b30": background == (0x28, 0x2b, 0x30),
            "the splash closes when the main window is up": not any((w, h) == (300, 350) for _, w, h in (none["seen"][-1] if none["seen"] else [])),
            "server failure: retrying in 10 sec, counting down, then checking again":
                countdown[:3] == ["Update failed — retrying in 10 sec…", "Update failed — retrying in 9 sec…", "Update failed — retrying in 8 sec…"]
                and fail["states"].count("Checking for updates…") >= 2 and fail["exited"] is None,
            "wrong checksum: refused, nothing started, retry scheduled":
                "checksum mismatch" in bad["log"] and any(s.startswith("Update failed") for s in bad["states"]) and bad["exited"] is None and bad["temp"] == [],
            "update: downloads with progress, installs, quits":
                "Downloading update 1 of 1… 0%" in update["states"] and "Downloading update 1 of 1… 100%" in update["states"]
                and "Installing update 1 of 1… 100%" in update["states"] and update["exited"] == 0 and update["temp"] == ["Triscord-Setup-9.9.9.exe"],
        }
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        passed = all(checks.values())
        (report / 'result.json').write_text(json.dumps({'passed': passed, 'checks': checks}, indent=2), encoding='utf-8')
    except Exception as error:
        print("FAIL:", error, flush=True)
    finally:
        server.shutdown()
        for log in work.glob("*.log"):
            shutil.copy(log, report / log.name)
        shutil.rmtree(work, ignore_errors=True)
    print(f"WEB UPDATER E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
