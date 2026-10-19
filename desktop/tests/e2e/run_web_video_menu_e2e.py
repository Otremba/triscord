"""End-to-end test of the participant menu on video cards (native video windows) in the new client.

Two triscord-web instances on the local backend; Bob turns his (synthetic) camera on, so Alice's call shows his card
as a native video window over the page. Alice owns the room, so the menu carries the moderation group.
  1. A real right click (WM_RBUTTONDOWN/UP posted to Alice's native video window, the mouse is not moved) opens Bob's
     menu in the page at that point: "Perfil", "Áudio do participante", "Silenciar voz no servidor", "Desconectar";
  2. while the menu is open the native video stays visible, with the menu's rectangle cut out of its mask (the page
     shows there), as Discord keeps the video under menus; the cut-out goes away when the menu closes. A screenshot
     of Alice's window with the menu over the video is saved in the report;
  3. the card's own control bar (page, not native) opens the same menu.

Usage (from desktop/): ../.toolchain/venv/Scripts/python.exe tests/e2e/run_web_video_menu_e2e.py --exe out/build-claude/triscord-web.exe
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
from run_web_popout_e2e import top_windows  # noqa: E402
from PIL import Image  # noqa: E402

ROOM = "Sala Menu Video E2E"
ALICE = """(() => {
  const b = window.__triscord.bridge, out = window.__videoMenuE2E = {};
  const menu = () => { const m = document.querySelector('[role="menu"]');
    return m ? { label: m.getAttribute('aria-label'), items: [...m.querySelectorAll('[role^="menuitem"]')].map(x => x.textContent.trim()) } : null; };
  const escape = () => dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  b.send({ name: 'createChannel', channelName: %s });
  // The test right-clicks the native window once Bob's video paints; keep that menu open 3.5 s (the host logs the
  // native windows every 3 s), close it, then right-click the card itself (page).
  const poll = setInterval(() => {
    const m = menu(); if (!m || out.native) return;
    out.native = m; clearInterval(poll);
    setTimeout(() => { escape(); setTimeout(() => {
      out.closed = !menu();
      const bar = document.querySelector('.tri-video-tile');
      bar?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
      setTimeout(() => { out.page = menu(); escape(); }, 500);
    }, 800); }, 3500);
  }, 100);
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
PROBE = "JSON.stringify(window.__videoMenuE2E || {})"

user32 = ctypes.windll.user32
ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def native_video_windows(parent):
    """Visible Qt child windows of `parent` (the native video windows; WebView2's children are Chromium classes)."""
    found = []

    def visit(hwnd, _):
        name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, name, 256)
        rect = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rect))
        if name.value.startswith("Qt") and user32.IsWindowVisible(hwnd) and rect.right > 50:
            found.append((hwnd, rect.right, rect.bottom))
        return True
    user32.EnumChildWindows(parent, ENUM(visit), 0)
    return found


def save_window(hwnd, path):
    gdi32 = ctypes.windll.gdi32
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    screen = user32.GetDC(None)
    dc = gdi32.CreateCompatibleDC(screen)
    bitmap = gdi32.CreateCompatibleBitmap(screen, w, h)
    gdi32.SelectObject(dc, bitmap)
    user32.PrintWindow(hwnd, dc, 2)   # PW_RENDERFULLCONTENT
    header = (ctypes.c_uint32 * 10)(40, w, (-h) & 0xFFFFFFFF, 1 | (32 << 16), 0, 0, 0, 0, 0, 0)
    pixels = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(dc, bitmap, 0, h, pixels, header, 0)
    gdi32.DeleteObject(bitmap); gdi32.DeleteDC(dc); user32.ReleaseDC(None, screen)
    Image.frombuffer("RGBA", (w, h), pixels, "raw", "BGRA", 0, 1).convert("RGB").save(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-video-menu-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-video-menu-"))
    backend, passed, processes, clicked = None, False, [], {}
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        alice_session, alice = account(config, google, "videomenu-alice", "Alice")
        bob_session, bob = account(config, google, "videomenu-bob", "Bob")
        alice["nick"], bob["nick"] = "Alice", "Bob"
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de Alice"}, alice_session)
        code = request(f"{config['hubUrl']}/servers/{server['id']}/invites", "POST", {}, alice_session)["code"]
        request(f"{config['hubUrl']}/invites/{code}/accept", "POST", {}, bob_session)
        (work / "alice.js").write_text(ALICE % json.dumps(ROOM), encoding="utf-8")
        (work / "bob.js").write_text(BOB % json.dumps(ROOM), encoding="utf-8")
        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        alice_log_path = report / "alice.log"
        alice_log = alice_log_path.open("w", encoding="utf-8")
        alice_process = launch(args.exe, args.assets, config, profile(work, "alice", alice_session, alice, server["id"]),
                               work / "alice.js", 2500, work / "probe.js", 34000, report / "alice.png", 42, alice_log)
        processes.append(alice_process)
        time.sleep(6)
        bob_log = (report / "bob.log").open("w", encoding="utf-8")
        processes.append(launch(args.exe, args.assets, config, profile(work, "bob", bob_session, bob, server["id"]),
                                work / "bob.js", 3500, work / "probe.js", 30000, report / "bob.png", 38, bob_log))

        def click():
            while alice_process.poll() is None and "posted" not in clicked:
                if "overlays visible=1" in alice_log_path.read_text(encoding="utf-8", errors="replace"):
                    time.sleep(1)
                    windows = top_windows(alice_process.pid)
                    video = native_video_windows(windows[0][0]) if windows else []
                    clicked["windows"] = len(video)
                    if video:
                        hwnd, w, h = video[0]
                        point = (h // 2) << 16 | (w // 2)
                        user32.PostMessageW(hwnd, 0x0204, 0x0002, point)   # WM_RBUTTONDOWN, MK_RBUTTON
                        time.sleep(0.05)
                        user32.PostMessageW(hwnd, 0x0205, 0, point)        # WM_RBUTTONUP
                        clicked["posted"] = True
                        # Screenshot with the menu open, of Alice's window even when Bob's covers it: PrintWindow with
                        # PW_RENDERFULLCONTENT includes the WebView2 composition and the native child windows.
                        time.sleep(1.2)
                        save_window(windows[0][0], report / "menu-over-video.png")
                    return
                time.sleep(0.3)
        clicker = threading.Thread(target=click, daemon=True)
        clicker.start()
        for process in processes:
            process.wait(timeout=70)
        clicker.join(timeout=5)
        alice_log.close(); bob_log.close()

        text = alice_log_path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        probes = [l[len("script: "):] for l in lines if l.startswith("script: ")]
        result = json.loads(json.loads(probes[-1])) if probes else {}
        print("  native windows found:", clicked.get("windows"), "| page:", json.dumps(result, ensure_ascii=False), flush=True)
        at = next((i for i, l in enumerate(lines) if l.startswith("video context menu cam:")), None)
        after = lines[at + 1:] if at is not None else []
        states = [(int(m.group(1)), int(m.group(2))) for l in after for m in [re.match(r"overlays visible=(\d+) occluded=(\d+)", l)] if m]
        expected = ["Perfil", "Áudio do participante", "Ocultar vídeo para mim", "Silenciar voz no servidor", "Desconectar"]
        checks = {
            "a right click on the native video window reaches the core's window": clicked.get("posted") is True and at is not None,
            "it opens Bob's menu in the page, with the moderation group": result.get("native", {}).get("label") == "Bob"
                and result.get("native", {}).get("items") == expected,
            "with the menu open the native video stays visible, the menu cut out of it": bool(states) and states[0] == (1, 1)
                and "ui -> core: videoOccluders" in text,
            "the cut-out goes away when the menu closes": result.get("closed") is True and (1, 0) in states[1:],
            "the card itself (page) opens the same menu": result.get("page", {}).get("label") == "Bob" and result.get("page", {}).get("items") == expected,
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
    print(f"WEB VIDEO MENU E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
