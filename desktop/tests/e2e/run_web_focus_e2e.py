"""End-to-end test of the visão ampliada (focused stream) in the new client.

Two triscord-web instances on the local backend. Alice turns her (synthetic) camera on; Bob shares his own triscord
window (default "Jogos", SD = 720p). Geometry from SHARE.md / the Qt ParticipantPane (see CallView.tsx).
  1. a real left click (WM_LBUTTONDOWN/UP posted to the native window of Bob's stream card) focuses it: the header
     shows "Tela de Bob" with "720p" and "AO VIVO", the stage fills the width of the call area (above the 119px kept
     for the filmstrip), the filmstrip has 195x112 thumbnails 8px apart whose top is 201px above the area's end, the
     toggle sits at filmstrip top + 8; the native windows change role (stage / film);
  2. collapsing the filmstrip turns Alice's own camera into a 162x92 preview 16/20px from the corner;
  3. clicking Alice's thumbnail moves the focus to her camera (header "Alice", no pills); clicking the stage goes
     back to the grid. A screenshot of Alice's window in the focused view is saved in the report.

Usage (from desktop/): ../.toolchain/venv/Scripts/python.exe tests/e2e/run_web_focus_e2e.py --exe out/build-claude/triscord-web.exe
"""
import argparse
import ctypes
import json
import re
import shutil
import sys
import tempfile
import threading
import time
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers  # noqa: E402
from run_web_e2e import request  # noqa: E402
from run_web_call_e2e import account, launch, profile  # noqa: E402
from run_web_popout_e2e import top_windows, user32  # noqa: E402
from run_web_video_menu_e2e import native_video_windows, save_window  # noqa: E402

ROOM = "Sala Ampliada E2E"
COMMON = """
  const b = window.__triscord.bridge, s = () => window.__triscord.store.current;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function wait(test, label, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return; await sleep(80); } throw Error(label); }
  const channel = () => s().categories.flatMap(c => c.channels).find(c => c.name === %s);
  const user = name => channel()?.users.find(u => u.name === name);
"""
ALICE = """(() => {""" + COMMON + """
  const log = window.__e2e = {};
  const rect = el => { if (!el) return null; const c = document.querySelector('.tri-call').getBoundingClientRect(), r = el.getBoundingClientRect();
    return [Math.round(r.x - c.x), Math.round(r.y - c.y), Math.round(r.width), Math.round(r.height)]; };
  const view = () => ({ focus: document.querySelector('.tri-call-focus')?.dataset.focus ?? null,
    title: document.querySelector('.tri-channel-header__focus')?.textContent ?? null,
    pills: [...document.querySelectorAll('.tri-header-pill')].map(x => x.textContent),
    call: rect(document.querySelector('.tri-call')), header: document.querySelector('.tri-channel-header').offsetHeight,
    stage: rect(document.querySelector('.tri-call-focus > .tri-video-tile--stage, .tri-call-focus > .tri-call-card--stage')),
    film: [...document.querySelectorAll('.tri-call-focus > [class*="--film"]')].map(rect),
    toggle: rect(document.querySelector('.tri-call-film-toggle')), grid: !!document.querySelector('.tri-call-grid') });
  (async () => {
    b.send({ name: 'createChannel', channelName: %s });
    await wait(() => s().connectedChannelId, 'joined');
    b.send({ name: 'setCamera', on: true });
    await wait(() => user('Bob')?.live && (s().streams || []).some(x => x.kind === 'screen'), 'Bob live', 45000);
    window.__readyForClick = true;
    await wait(() => document.querySelector('.tri-call-focus'), 'focused by the native click', 20000);
    await sleep(1500);
    log.focused = view();
    const q = document.querySelector('.tri-header-pill--quality'), l = document.querySelector('.tri-header-pill--live');
    log.capsule = q && l ? { join: Math.round(l.getBoundingClientRect().left - q.getBoundingClientRect().right),
      q: getComputedStyle(q).borderRadius, l: getComputedStyle(l).borderRadius } : null;
    await wait(() => document.querySelector('.tri-call.is-idle'), 'idle', 8000);
    await sleep(500);
    const toggleEl = document.querySelector('.tri-call-film-toggle');
    log.idle = { toggleOpacity: getComputedStyle(toggleEl).opacity, toggleClick: getComputedStyle(toggleEl).pointerEvents,
      placeholderName: getComputedStyle(document.querySelector('.tri-call-card--placeholder .tri-call-card__pill > span')).display };
    window.dispatchEvent(new Event('tri-call-activity')); await sleep(300);
    window.__shot = true; await sleep(2500);
    document.querySelector('.tri-call-film-toggle').click(); await sleep(1200);
    log.collapsed = view();
    document.querySelector('.tri-call-film-toggle').click(); await sleep(800);
    const thumb = [...document.querySelectorAll('.tri-call-focus > [class*="--film"]')].find(x => x.getAttribute('aria-label') === 'Alice');
    thumb?.click(); await sleep(1200);
    log.alice = view();
    document.querySelector('.tri-call-focus > .tri-video-tile--stage')?.click(); await sleep(800);
    log.back = view();
    log.done = true;
  })().catch(e => log.error = e.message);
  return 'focus Alice started';
})()"""
BOB = """(() => {""" + COMMON + """
  (async () => {
    await wait(() => channel(), 'room', 25000);
    b.send({ name: 'selectChannel', channelId: channel().id });
    await wait(() => s().connectedChannelId, 'joined');
    document.querySelector('.tri-call-controls button[aria-label="Compartilhar tela"]').click();
    await wait(() => [...document.querySelectorAll('.tri-share-source')].some(x => x.getAttribute('aria-label')?.includes('Triscord')), 'own window listed');
    [...document.querySelectorAll('.tri-share-source')].find(x => x.getAttribute('aria-label').includes('Triscord')).click();
  })().catch(e => window.__e2e = { error: e.message });
  return 'focus Bob started';
})()"""
PROBE = "JSON.stringify(window.__e2e || {})"
STATE = "JSON.stringify({ ready: !!window.__readyForClick, shot: !!window.__shot })"


def last(path, key):
    rows = [l[len("script: "):] for l in path.read_text(encoding="utf-8", errors="replace").splitlines() if l.startswith("script: ") and key in l]
    return json.loads(json.loads(rows[-1])) if rows else {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-focus-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-focus-"))
    backend, passed, processes, clicked = None, False, [], {}
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        alice_session, alice = account(config, google, "focus-alice", "Alice")
        bob_session, bob = account(config, google, "focus-bob", "Bob")
        alice["nick"], bob["nick"] = "Alice", "Bob"
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de Alice"}, alice_session)
        code = request(f"{config['hubUrl']}/servers/{server['id']}/invites", "POST", {}, alice_session)["code"]
        request(f"{config['hubUrl']}/invites/{code}/accept", "POST", {}, bob_session)
        room = json.dumps(ROOM)
        (work / "alice.js").write_text(ALICE % (room, room), encoding="utf-8")
        (work / "bob.js").write_text(BOB % room, encoding="utf-8")
        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        logs = []
        for name, token, acct, delay, probe_at, quit_at in [("alice", alice_session, alice, 0, 52000, 62), ("bob", bob_session, bob, 5, 48000, 58)]:
            if delay:
                time.sleep(delay)
            log = (report / f"{name}.log").open("w", encoding="utf-8")
            logs.append(log)
            processes.append(launch(args.exe, args.assets, config, profile(work, name, token, acct, server["id"]), work / f"{name}.js", 2500,
                                    work / "probe.js", probe_at, report / f"{name}-unused.png", quit_at, log))
        alice_process, alice_log = processes[0], report / "alice.log"

        # Native side: once Bob's stream paints on Alice's side, click it (the card of the stream is the topmost-left
        # native window: the stream comes first in the grid); later save Alice's window in the focused view.
        def drive():
            while alice_process.poll() is None and "shot" not in clicked:
                text = alice_log.read_text(encoding="utf-8", errors="replace")
                if "posted" not in clicked and re.search(r"overlay scr:\S+ painted=[1-9]", text):
                    time.sleep(1)
                    windows = top_windows(alice_process.pid)
                    video = native_video_windows(windows[0][0]) if windows else []
                    def origin(hwnd):
                        r = wintypes.RECT(); user32.GetWindowRect(hwnd, ctypes.byref(r)); return (r.top, r.left)
                    if len(video) >= 2:
                        hwnd, w, h = min(video, key=lambda v: origin(v[0]))
                        point = (h // 2) << 16 | (w // 2)
                        user32.PostMessageW(hwnd, 0x0201, 0x0001, point)   # WM_LBUTTONDOWN
                        time.sleep(0.05)
                        user32.PostMessageW(hwnd, 0x0202, 0, point)        # WM_LBUTTONUP
                        clicked["posted"] = True
                        clicked["at"] = time.time()
                if "posted" in clicked and time.time() - clicked["at"] > 3.5 and "shot" not in clicked:
                    windows = top_windows(alice_process.pid)
                    if windows:
                        save_window(windows[0][0], report / "focused-view.png")
                    clicked["shot"] = True
                time.sleep(0.3)
        driver = threading.Thread(target=drive, daemon=True)
        driver.start()
        for process in processes:
            process.wait(timeout=100)
        driver.join(timeout=5)
        for log in logs:
            log.close()
        for png in report.glob("*-unused.png*"):
            png.unlink()
        a = last(alice_log, "focused")
        text = alice_log.read_text(encoding="utf-8", errors="replace")
        print("  alice:", json.dumps(a, ensure_ascii=False), flush=True)
        f, c, al, back = a.get("focused", {}), a.get("collapsed", {}), a.get("alice", {}), a.get("back", {})
        call_w, call_h, top = (f.get("call") or [0, 0, 0, 0])[2], (f.get("call") or [0, 0, 0, 0])[3], f.get("header", 0)
        bottom = call_h - 50
        stage = f.get("stage") or [0, 0, 0, 0]
        film = f.get("film") or []
        roles = set(re.findall(r"overlay ((?:scr|cam):\S+) painted=\d+ ms=\d+ role=(stage|film)", text))
        idle_native = bool(re.search(r"overlay scr:\S+ painted=\d+ ms=\d+ role=stage idle=1", text))
        checks = {
            "a real click on the stream's native window focuses it": clicked.get("posted") is True and "video click scr:" in text and f.get("focus", "").startswith("scr:"),
            "header: Tela de Bob, 720p and AO VIVO": f.get("title") == "Tela de Bob" and f.get("pills") == ["720p", "AO VIVO"],
            "stage: full width of the area, centred above the 119px filmstrip reserve": abs(stage[2] - call_w) <= 1
                and abs((stage[1] - top) - ((bottom - top - 119) - stage[3]) / 2) <= 1.5,
            "filmstrip: every card, 195x112, 8px apart, top 182px above the area's end": len(film) == 3 and all(r[2:] == [195, 112] and r[1] == bottom - 182 for r in film)
                and all(film[i + 1][0] - film[i][0] == 203 for i in range(len(film) - 1)),
            "toggle 62x32 at filmstrip top + 8": (f.get("toggle") or [0])[1:] == [bottom - 182 + 8, 62, 32],
            "native windows: stream on the stage, camera in the filmstrip": any(r == "stage" for k, r in roles if k.startswith("scr:"))
                and any(r == "film" for k, r in roles if k.startswith("cam:")),
            "the toggle is cut out of the thumbnail's native window under it": bool(re.search(r"overlays visible=[2-9] occluded=[1-9]", text)),
            "header pills: one capsule (halves joined, outer corners rounded)": a.get("capsule") == {"join": 0, "q": "16px 0px 0px 16px", "l": "0px 16px 16px 0px"},
            "idle: toggle hidden and inert, names gone; native windows drop their name pill": a.get("idle") == {"toggleOpacity": "0", "toggleClick": "none", "placeholderName": "none"}
                and idle_native,
            "collapsed: no filmstrip, Alice's camera as a 162x92 preview": (c.get("film") or [[0, 0, 0, 0]]) == [[call_w - 16 - 162, bottom - 20 - 92, 162, 92]],
            "a thumbnail moves the focus (Alice's camera: her name, no pills)": (al.get("focus") or "").startswith("cam:") and al.get("title") == "Alice" and al.get("pills") == [],
            "clicking the stage goes back to the grid": back.get("grid") is True and back.get("focus") is None and back.get("title") is None and a.get("done") is True,
            "screenshot of the focused view saved": (report / "focused-view.png").exists(),
        }
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        passed = all(checks.values()) and not a.get("error")
        if a.get("error"):
            print("  error:", a["error"], flush=True)
    except Exception as error:
        print("FAIL:", error, flush=True)
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
        if backend:
            backend.close()
        shutil.rmtree(work, ignore_errors=True)
    print(f"WEB FOCUS E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
