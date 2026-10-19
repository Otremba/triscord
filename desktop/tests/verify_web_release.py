"""Verify the shipped WebView2 client, its disabled test CLI and its actual portable entry point."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parent / "e2e"))
from run_web_popout_e2e import top_windows
from run_web_video_menu_e2e import save_window


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--launcher")
    parser.add_argument("--runtime")
    parser.add_argument("--report", required=True)
    parser.add_argument("--google-secret-file")
    args = parser.parse_args()
    exe = Path(args.exe).resolve()
    report = Path(args.report).resolve()
    report.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-release-"))
    checks, owned, process = {}, {}, None
    env = dict(os.environ, TRISCORD_SETTINGS_PATH=str(work / "settings"),
               TRISCORD_AUTH_SERVER="http://127.0.0.1:9", TRISCORD_HUB_SERVER="http://127.0.0.1:9",
               TRISCORD_AUDIO_MODE="injected", TRISCORD_VIDEO_SOURCE="synthetic",
               TRISCORD_SKIP_UPDATE="1")   # the update splash has its own test (run_web_updater_e2e.py)
    try:
        help_result = subprocess.run([str(exe), "--help"], env=env, capture_output=True, timeout=15)
        help_text = help_result.stdout + help_result.stderr
        checks["release identifies the WebView2 client"] = help_result.returncode == 0 and b"C++/WebView2" in help_text
        options = ["--assets", "--devtools", "--script", "--script-after", "--probe", "--probe-after",
                   "--probe-interval", "--capture", "--capture-after", "--quit-after",
                   "--popout-script", "--popout-script-after", "--popout-probe", "--popout-probe-after"]
        for option in options:
            result = subprocess.run([str(exe), option], env=env, capture_output=True, timeout=15)
            checks["rejects " + option] = option.encode() not in help_text and result.returncode != 0
        checks["one application executable"] = list(exe.parent.rglob("*.exe")) == [exe]
        checks["loader and web assets bundled"] = (exe.parent / "WebView2Loader.dll").is_file() and (exe.parent / "web/index.html").is_file()
        # "Supressão de ruído: Alta qualidade" is the default: without DeepFilterNet it would silently be RNNoise.
        checks["DeepFilterNet bundled with its licenses"] = all((exe.parent / name).is_file() for name in [
            "deepfilter/df.dll", "deepfilter/DeepFilterNet3_onnx.tar.gz", "media-licenses/DeepFilterNet/crates.txt"])
        checks["third party notices bundled"] = all((exe.parent / name).is_file() for name in [
            "THIRD_PARTY_NOTICES.md", "web-licenses/preact-LICENSE.txt",
            "web-licenses/WebView2-LICENSE.txt", "web-licenses/WebView2-NOTICE.txt",
            "media-licenses/Opus-license.txt", "media-licenses/libdatachannel-MPL-2.0.txt"])
        # A DLL copied from this machine's System32 (windeployqt's D3D/DXC compiler) is tied to this Windows build:
        # 18/10, D3DCompiler_47.dll from Windows 11 needed msvcp_win.dll exports missing on a friend's older Windows.
        system32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
        checks["no Windows system DLL bundled"] = not any(
            path.name.lower() in {"d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll"}
            or ((system32 / path.name).is_file() and digest(path) == digest(system32 / path.name))
            for path in exe.parent.rglob("*.dll"))
        if args.google_secret_file:
            # Without the built-in secret, Google sign-in fails on any computer without it in its settings (18/10).
            secret = Path(args.google_secret_file).read_text(encoding="utf8").strip().encode()
            checks["Google sign-in secret built in"] = bool(secret) and secret in exe.read_bytes()
        started = time.time()
        target = Path(args.runtime).resolve() if args.launcher else exe
        process = subprocess.Popen([str(Path(args.launcher).resolve() if args.launcher else exe)],
                                   env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        host = None
        renderer = False
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if host is None:
                if args.launcher:
                    for candidate in psutil.process_iter(["pid", "exe", "create_time"]):
                        try:
                            if (candidate.info["exe"] and Path(candidate.info["exe"]).resolve() == target.resolve()
                                    and candidate.info["create_time"] >= started - 1
                                    and candidate.environ().get("TRISCORD_SETTINGS_PATH") == env["TRISCORD_SETTINGS_PATH"]):
                                host = candidate
                                target = Path(candidate.info["exe"]).resolve()
                                break
                        except psutil.Error:
                            pass
                else:
                    host = psutil.Process(process.pid)
            if host is not None:
                try:
                    for child in [host] + host.children(recursive=True):
                        owned[(child.pid, child.create_time())] = child
                    windows = top_windows(host.pid)
                    renderer = any(p.name().lower() == "msedgewebview2.exe" and "--type=renderer" in p.cmdline()
                                   for p in host.children(recursive=True))
                    if windows and renderer:
                        time.sleep(3)
                        break
                except psutil.Error:
                    pass
            time.sleep(.2)
        checks["actual WebView2 renderer starts"] = host is not None and renderer
        windows = top_windows(host.pid) if host else []
        checks["main window has no native frame"] = bool(windows) and not (ctypes.windll.user32.GetWindowLongW(windows[0][0], -16) & (0x00C00000 | 0x00040000))
        if windows:
            save_window(windows[0][0], report / "release-login.png")
            checks["release capture saved"] = (report / "release-login.png").is_file()
        if args.launcher:
            checks["portable launcher succeeded"] = process.wait(timeout=10) == 0
            checks["portable extracted the tested runtime"] = target.is_file() and all(
                (target.parent / path.relative_to(exe.parent)).is_file()
                and digest(path) == digest(target.parent / path.relative_to(exe.parent))
                for path in exe.parent.rglob("*") if path.is_file())
        for name, ok in checks.items():
            print(("PASS: " if ok else "FAIL: ") + name, flush=True)
        result = {"passed": all(checks.values()), "checks": checks, "exe_sha256": digest(exe),
                  "tested_entry_point": str(target), "launcher": args.launcher}
        (report / "result.json").write_text(json.dumps(result, indent=2), encoding="utf8")
        return 0 if result["passed"] else 1
    finally:
        # The NSIS launcher exits and reparents its child. Even a failed startup
        # must clean only that test profile's processes, never a user's instance.
        if args.launcher:
            for candidate in psutil.process_iter(["name"]):
                try:
                    if ((candidate.info["name"] or "").lower() == exe.name.lower()
                            and candidate.environ().get("TRISCORD_SETTINGS_PATH") == env["TRISCORD_SETTINGS_PATH"]):
                        for child in [candidate] + candidate.children(recursive=True):
                            owned[(child.pid, child.create_time())] = child
                except psutil.Error:
                    pass
        if process and not args.launcher:
            try:
                root = psutil.Process(process.pid)
                for child in [root] + root.children(recursive=True):
                    owned[(child.pid, child.create_time())] = child
            except psutil.Error:
                pass
        for (pid, created), child in reversed(list(owned.items())):
            try:
                if child.is_running() and child.create_time() == created:
                    child.terminate()
            except psutil.Error:
                pass
        psutil.wait_procs(list(owned.values()), timeout=5)
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        assert work.resolve().parent == Path(tempfile.gettempdir()).resolve() and work.name.startswith("triscord-web-release-")
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
