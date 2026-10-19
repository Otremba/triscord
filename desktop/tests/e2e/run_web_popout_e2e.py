"""End-to-end test of the call popout window (janela destacada, Discord "Nova Janela") in the new client.

Two triscord-web instances on the local backend (run_e2e.py's Backend), synthetic audio and camera:
  1. Alice creates a room; Bob joins it and turns his camera on, so Alice's call has video and offers "Nova Janela";
  2. Alice clicks "Nova Janela": a second window opens with its own WebView2 page (?popout=call), whose native video
     window paints Bob's frames; the main window shows "Você abriu uma janela separada para esta reprodução" instead
     of the grid, the button turns into "Voltar para o Triscord" and "Tela cheia" disappears;
  3. "Mostrar sempre" (setCallPopoutOnTop) makes the popout a topmost window (WS_EX_TOPMOST read from Windows);
     "Tela cheia" clicked inside the popout page makes the popout (not the main window) fullscreen, and Esc
     brings it back to its size;
  4. "Voltar para o Triscord" closes it and the grid comes back; the system close (WM_CLOSE) and leaving the call
     close it as well.

Usage (from desktop/): ../.toolchain/venv/Scripts/python.exe tests/e2e/run_web_popout_e2e.py --exe out/build-claude/triscord-web.exe
"""
import argparse
import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import ImageGrab  # noqa: E402
from run_e2e import Backend, DESKTOP, TOOLCHAIN, bundle_workers  # noqa: E402
from run_web_e2e import request  # noqa: E402
from run_web_call_e2e import account, launch, profile  # noqa: E402

ROOM = "Sala Janela E2E"
ALICE = """(() => {
  const b = window.__triscord.bridge, st = () => window.__triscord.store.current;
  const steps = window.__popoutE2E = [];
  const snap = tag => { const s = st(); steps.push({ tag, popout: !!s.callPopout, onTop: !!s.callPopoutOnTop,
    connected: !!s.connectedChannelId,
    tiles: document.querySelectorAll('.tri-call-grid .tri-video-tile, .tri-call-focus .tri-video-tile').length,
    focus: document.querySelector('.tri-call-focus')?.dataset.focus ?? null,
    message: document.querySelector('.tri-call-popped-out')?.textContent || '',
    buttons: [...document.querySelectorAll('.tri-call-bottom__right button')].map(x => x.getAttribute('aria-label')) }); };
  const click = label => document.querySelector(`.tri-call-bottom__right button[aria-label="${label}"]`)?.click();
  b.send({ name: 'createChannel', channelName: %s });
  setTimeout(() => snap('alone'), 6000);
  setTimeout(() => { snap('before'); const cam = (st().streams || []).find(x => x.kind === 'camera');
    b.send({ name: 'setCallFocus', key: cam?.id ?? null, filmOpen: true }); setTimeout(() => click('Nova Janela'), 400); }, 16000);
  setTimeout(() => { snap('popped'); b.send({ name: 'setCallPopoutOnTop', on: true }); }, 22000);
  setTimeout(() => { snap('ontop'); click('Voltar para o Triscord'); }, 26000);
  setTimeout(() => { snap('back'); b.send({ name: 'setCallFocus', key: null, filmOpen: true }); setTimeout(() => click('Nova Janela'), 400); }, 30000);
  setTimeout(() => { snap('closedBySystem'); click('Nova Janela'); }, 37000);
  setTimeout(() => { snap('reopened'); b.send({ name: 'leaveVoice' }); }, 41000);
  setTimeout(() => snap('left'), 43000);
  return 'started';
})()"""
BOB = """(() => {
  const b = window.__triscord.bridge, s = window.__triscord.store.current;
  const channel = s.categories.flatMap(c => c.channels).find(c => c.name === %s);
  if (!channel) return 'room not visible';
  b.send({ name: 'selectChannel', channelId: channel.id });
  setTimeout(() => b.send({ name: 'setCamera', on: true }), 2000);
  return 'joining';
})()"""
PROBE = "JSON.stringify(window.__popoutE2E || [])"
# Run in the popout page each time it opens (--popout-script): only the first opening goes fullscreen.
POPOUT_SCRIPT = """(() => {
  const buttons = () => [...document.querySelectorAll('.tri-call-bottom__right button')].map(x => x.getAttribute('aria-label'));
  const bar = document.querySelector('.tri-titlebar');
  const out = window.__popoutChecks = { buttons: buttons(), bar: { height: bar?.offsetHeight, text: bar?.textContent.trim(), buttons: bar?.querySelectorAll('button').length },
    focus: document.querySelector('.tri-call-focus')?.dataset.focus ?? null };
  if (localStorage.getItem('fullscreenDone')) { out.skipped = true; return 'skipped'; }
  localStorage.setItem('fullscreenDone', '1');
  document.querySelector('.tri-call-bottom__right button[aria-label="Tela cheia"]')?.click();
  setTimeout(() => {
    out.fullscreen = { state: !!window.__triscord.store.current.callPopoutFullscreen,
      layout: document.querySelector('.tri-app').classList.contains('tri-app--call-fullscreen'),
      titlebar: getComputedStyle(document.querySelector('.tri-titlebar')).display, hint: !!document.querySelector('.tri-fullscreen-hint'),
      buttons: buttons(), width: innerWidth };
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }, 1500);
  setTimeout(() => { out.after = { state: !!window.__triscord.store.current.callPopoutFullscreen, width: innerWidth }; }, 3000);
  return 'started';
})()"""
POPOUT_PROBE = "JSON.stringify(window.__popoutChecks || {})"

user32 = ctypes.windll.user32
ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def top_windows(pid, titles=("Triscord",)):
    """Visible top-level windows of `pid`: (hwnd, title, width, height, topmost)."""
    found = []

    def visit(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            title = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, title, length + 1)
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            found.append((hwnd, title.value, rect.right - rect.left, rect.bottom - rect.top, bool(user32.GetWindowLongW(hwnd, -20) & 0x8)))
        return True
    user32.EnumWindows(ENUM(visit), 0)
    return [w for w in found if w[1] in titles]


def launch_alice(exe, assets, config, settings, script, probe, capture, log):
    """Like run_web_call_e2e.launch, with the page capture taken while the call is popped out (script time +24 s)."""
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(TOOLCHAIN / "Qt" / "6.8.3" / "mingw_64" / "bin"), str(TOOLCHAIN / "Qt" / "Tools" / "mingw1310_64" / "bin"), env["PATH"]])
    env.update(TRISCORD_SETTINGS_PATH=str(settings), TRISCORD_AUTH_SERVER=config["authUrl"], TRISCORD_HUB_SERVER=config["hubUrl"],
               TRISCORD_AUDIO_MODE="injected", TRISCORD_VIDEO_SOURCE="synthetic")
    return subprocess.Popen([str(Path(exe).resolve()), "--assets", assets, "--devtools", "--quit-after", "50",
                             "--script", str(script), "--script-after", "2500", "--probe", str(probe), "--probe-after", "46500",
                             "--capture", str(capture), "--capture-after", "26500",
                             "--popout-script", str(Path(script).with_name("popout.js")), "--popout-script-after", "2500",
                             "--popout-probe", str(Path(script).with_name("popout-probe.js")), "--popout-probe-after", "7000"],
                            env=env, stdout=log, stderr=subprocess.STDOUT)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-popout-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-popout-"))
    backend, passed, processes = None, False, []
    samples, closed_by_system = [], {}
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        alice_session, alice = account(config, google, "popout-alice", "Alice")
        bob_session, bob = account(config, google, "popout-bob", "Bob")
        alice["nick"], bob["nick"] = "Alice", "Bob"
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de Alice"}, alice_session)
        code = request(f"{config['hubUrl']}/servers/{server['id']}/invites", "POST", {}, alice_session)["code"]
        request(f"{config['hubUrl']}/invites/{code}/accept", "POST", {}, bob_session)
        (work / "alice.js").write_text(ALICE % json.dumps(ROOM), encoding="utf-8")
        (work / "bob.js").write_text(BOB % json.dumps(ROOM), encoding="utf-8")
        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        (work / "popout.js").write_text(POPOUT_SCRIPT, encoding="utf-8")
        (work / "popout-probe.js").write_text(POPOUT_PROBE, encoding="utf-8")
        alice_log_path = report / "alice.log"
        alice_log = alice_log_path.open("w", encoding="utf-8")
        alice_process = launch_alice(args.exe, args.assets, config, profile(work, "alice", alice_session, alice, server["id"]),
                                     work / "alice.js", work / "probe.js", report / "main-popped-out.png", alice_log)
        processes.append(alice_process)
        time.sleep(6)
        bob_log = (report / "bob.log").open("w", encoding="utf-8")
        processes.append(launch(args.exe, args.assets, config, profile(work, "bob", bob_session, bob, server["id"]),
                                work / "bob.js", 3500, work / "probe.js", 40000, report / "bob.png", 47, bob_log))

        # Windows side, sampled while the clients run: the popout's size and WS_EX_TOPMOST; on the second opening the
        # popout gets a real WM_CLOSE, as from its system close button.
        def watch():
            start, main_hwnd = time.time(), None
            while alice_process.poll() is None:
                windows = top_windows(alice_process.pid, ("Triscord", ROOM))
                if len(windows) == 1:
                    main_hwnd = windows[0][0]
                others = [w for w in windows if w[0] != main_hwnd]
                if main_hwnd and others:
                    popout = others[0]
                    main = next(w for w in windows if w[0] == main_hwnd)
                    samples.append({"t": round(time.time() - start, 1), "width": popout[2], "height": popout[3], "topmost": popout[4], "title": popout[1],
                                    "mainWidth": main[2]})
                    log_text = alice_log_path.read_text(encoding="utf-8", errors="replace")
                    if "popout onTop=1" in log_text and "shot" not in closed_by_system:   # topmost by now: nothing covers it
                        time.sleep(1)
                        rect = wintypes.RECT()
                        user32.GetWindowRect(popout[0], ctypes.byref(rect))
                        ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom), all_screens=True).save(report / "popout-window.png")
                        closed_by_system["shot"] = True
                    opened = log_text.count("popout opened")
                    if opened == 2 and "sent" not in closed_by_system:
                        time.sleep(2)
                        closed_by_system["sent"] = bool(user32.PostMessageW(popout[0], 0x0010, 0, 0))
                time.sleep(0.3)
        watcher = threading.Thread(target=watch, daemon=True)
        watcher.start()
        for process in processes:
            process.wait(timeout=80)
        watcher.join(timeout=5)
        alice_log.close(); bob_log.close()

        text = alice_log_path.read_text(encoding="utf-8", errors="replace")
        probes = [line[len("script: "):] for line in text.splitlines() if line.startswith("script: ")]
        steps = {s["tag"]: s for s in (json.loads(json.loads(probes[-1])) if probes else [])}
        print("  steps:", json.dumps(steps, ensure_ascii=False), flush=True)
        painted = [int(m.group(2)) for m in re.finditer(r"popout overlay (cam:\S+) painted=(\d+)", text)]
        lines = text.splitlines()
        first_close = next((i for i, l in enumerate(lines) if l == "popout closed"), len(lines))
        main_after_back = any(re.match(r"overlay cam:\S+ painted=\d+", l) for l in lines[first_close:])
        topmost = [s for s in samples if s["topmost"]]
        popout_probes = [json.loads(json.loads(l[len("popout script: "):])) for l in lines if l.startswith("popout script: ") and "buttons" in l]
        pc = next((x for x in popout_probes if "fullscreen" in x), {})
        print("  popout page:", json.dumps(pc, ensure_ascii=False), flush=True)
        normal = samples[0]["width"] if samples else 0
        big = [i for i, x in enumerate(samples) if x["width"] > x["mainWidth"]]
        restored = bool(big) and any(x["width"] == normal for x in samples[big[-1] + 1:])
        print(f"  popout native video painted: {painted[-1] if painted else 0}; windows samples: {len(samples)}, topmost: {len(topmost)}", flush=True)
        print(f"  popout window size: {samples[0]['width']}x{samples[0]['height']}" if samples else "  popout window never seen", flush=True)
        message = "Você abriu uma janela separada para esta reprodução"
        get = lambda tag, key, default=None: steps.get(tag, {}).get(key, default)
        checks = {
            # Discord offers the pop-out without video too (audit 18/10, alone in a call with no camera).
            "alone without video: 'Nova Janela' offered too": "Nova Janela" in get("alone", "buttons", []),
            "with Bob's camera: 'Nova Janela' offered next to 'Tela cheia'": get("before", "buttons") == ["Nova Janela", "Tela cheia"] and get("before", "tiles", 0) >= 1,
            "the popout window opens with its own page": text.count("popout opened") >= 1 and "popout ui -> core: requestSnapshot" in text,
            "the popout's native video window paints Bob's frames": bool(painted) and max(painted) > 10,
            "main window: message instead of the grid": get("popped", "popout") is True and get("popped", "tiles") == 0 and get("popped", "message") == message,
            "main window: 'Voltar para o Triscord', no 'Tela cheia'": get("popped", "buttons") == ["Voltar para o Triscord"],
            "'Mostrar sempre' makes it a topmost window": "popout onTop=1" in text and get("ontop", "onTop") is True and len(topmost) > 0
                and not any(s["topmost"] for s in samples[:3]),
            "popout page: 'Mostrar sempre', 'Voltar para o Triscord', 'Tela cheia'": pc.get("buttons") == ["Mostrar sempre", "Voltar para o Triscord", "Tela cheia"],
            "'Tela cheia' in the popout: its window fullscreen, layout without title bar": pc.get("fullscreen", {}).get("state") is True
                and pc["fullscreen"].get("layout") is True and pc["fullscreen"].get("titlebar") == "none" and pc["fullscreen"].get("hint") is True
                and "Sair da tela cheia" in pc["fullscreen"].get("buttons", []) and "popout fullscreen=1" in text and bool(big),
            "Esc leaves it and the popout returns to its size": pc.get("after", {}).get("state") is False and "popout fullscreen=0" in text and restored,
            "the main window never goes fullscreen": "window fullscreen=1" not in text,
            "popout window: frameless 854x480, titled with the channel": any(s["title"] == ROOM and s["width"] == 854 and s["height"] == 480 for s in samples),
            "popout bar: 24px, window buttons only": pc.get("bar") == {"height": 24, "text": "", "buttons": 3},
            "popout opens on the card focused in the main window": (pc.get("focus") or "").startswith("cam:"),
            "'Voltar para o Triscord' brings it back, still focused": get("back", "popout") is False and (get("back", "focus") or "").startswith("cam:")
                and get("back", "tiles", 0) >= 1 and main_after_back,
            "the system close (WM_CLOSE) closes it": closed_by_system.get("sent") is True and get("closedBySystem", "popout") is False and text.count("popout closed") >= 2,
            "leaving the call closes it": get("reopened", "popout") is True and get("left", "popout") is False and get("left", "connected") is False
                and text.count("popout closed") >= 3,
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
    print(f"WEB POPOUT E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
