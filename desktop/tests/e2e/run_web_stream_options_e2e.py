"""End-to-end test of the stream options in the new client: share picker's stream mode block and, for viewers,
"Volume da transmissão" / "Silenciar transmissão".

Two triscord-web instances on the local backend. Alice shares her own triscord window (no personal content; nothing
of the stream is saved in the report) without system audio, so nothing plays on the machine's speakers:
  1. the picker shows "Jogos" / "Vídeo mais suave · 720p · 30fps" with SD selected by default; HD changes the line to
     1080p · 60fps; the gear opens "Modo de transmissão" (Jogos, Compartilhamento de tela, Silenciar áudio da
     transmissão), and "Compartilhamento de tela" gives "Texto mais claro · 1080p · 15fps"; the choices are saved;
  2. back to "Jogos" in HD, Alice starts sharing: Bob receives a 1080p stream;
  3. Bob sets the stream volume to 40% and mutes it: the core keeps both for Alice, the menu shows "Silenciar
     transmissão" checked and the participant audio dialog shows "Volume da transmissão"; bad values are refused;
  4. card badges (SHARE.md): the stream's native window shows "AO VIVO" and, hovered, the quality before it — Bob
     sees "1080P" (frame rate unknown for remote streams), Alice's own share "1080P 60FPS". The real cursor is moved
     over Bob's card for a moment (his window briefly topmost; the cursor goes back where it was): the saved card,
     stream-card-hover.png, must show the grey quality pill before the red badge. Posted WM_MOUSEMOVE does not hover a
     Qt window (Qt checks the real cursor), so the test moves it.

Usage (from desktop/): ../.toolchain/venv/Scripts/python.exe tests/e2e/run_web_stream_options_e2e.py --exe out/build-claude/triscord-web.exe
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
from PIL import Image  # noqa: E402

ROOM = "Sala Transmissao E2E"
COMMON = """
  const b = window.__triscord.bridge, s = () => window.__triscord.store.current;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function wait(test, label, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return; await sleep(80); } throw Error(label); }
  const channel = () => s().categories.flatMap(c => c.channels).find(c => c.name === %s);
  const user = name => channel()?.users.find(u => u.name === name);
  const text = sel => document.querySelector(sel)?.textContent.trim() ?? null;
"""
ALICE = """(() => {""" + COMMON + """
  const log = window.__e2e = {};
  (async () => {
    b.send({ name: 'createChannel', channelName: %s });
    await wait(() => user('Bob'), 'Bob in the room', 25000);
    document.querySelector('.tri-call-controls button[aria-label="Compartilhar tela"]').click();
    await wait(() => document.querySelector('.tri-share-mode'), 'picker');
    const line = () => text('.tri-share-mode__text span'), title = () => text('.tri-share-mode__text strong');
    // Tabs as in Discord (Aplicativos, Tela Inteira, Dispositivos); monitors named "Tela N"; devices or the empty text.
    const tab = label => [...document.querySelectorAll('.tri-share-tabs [role="tab"]')].find(x => x.textContent.trim() === label);
    log.tabs = [...document.querySelectorAll('.tri-share-tabs [role="tab"]')].map(x => x.textContent.trim());
    tab('Tela Inteira').click(); await wait(() => document.querySelector('.tri-share-source'), 'monitors');
    log.monitors = [...document.querySelectorAll('.tri-share-source__caption span:last-child')].map(x => x.textContent);
    const grid = document.querySelector('.tri-share-grid').getBoundingClientRect(), thumb = document.querySelector('.tri-share-source__thumb').getBoundingClientRect();
    log.outlineRoom = Math.round(thumb.left - grid.left);   // the 2px outline 2px away needs 4px inside the scroller
    tab('Dispositivos').click(); await sleep(300);
    log.devices = { tiles: [...document.querySelectorAll('.tri-share-source')].map(x => x.getAttribute('aria-label')), known: (s().settings?.cameraDevices || []).length,
      empty: text('.tri-share-empty'), cta: text('.tri-share-source__cta') };
    tab('Aplicativos').click(); await sleep(150);
    log.defaults = { title: title(), line: line(), sd: document.querySelector('.tri-share-quality [aria-checked="true"]')?.textContent };
    [...document.querySelectorAll('.tri-share-quality button')].find(x => x.textContent === 'HD').click(); await sleep(150);
    log.hd = line();
    document.querySelector('.tri-share-mode__gear').click(); await wait(() => document.querySelector('.tri-share-mode__menu'), 'mode menu');
    log.menu = [...document.querySelectorAll('.tri-share-mode__menu [role^="menuitem"] strong')].map(x => x.textContent);
    log.menuLines = [...document.querySelectorAll('.tri-share-mode__menu small')].map(x => x.textContent);
    log.audioMutedDefault = document.querySelector('.tri-share-mode__menu [role="menuitemcheckbox"]').getAttribute('aria-checked');
    document.querySelectorAll('.tri-share-mode__menu [role="menuitemradio"]')[1].click(); await sleep(150);
    log.screen = { title: title(), line: line() };
    document.querySelector('.tri-share-mode__menu [role="menuitemcheckbox"]').click(); await sleep(150);   // share audio on...
    log.audioSaved = s().settings?.shareAudio;
    document.querySelector('.tri-share-mode__menu [role="menuitemcheckbox"]').click(); await sleep(150);   // ...and off again
    document.querySelectorAll('.tri-share-mode__menu [role="menuitemradio"]')[0].click();
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(200);
    log.menuClosedPickerOpen = !document.querySelector('.tri-share-mode__menu') && !!document.querySelector('.tri-share-picker');
    log.saved = { mode: s().settings?.shareMode, hd: s().settings?.shareHd, audio: s().settings?.shareAudio };
    await wait(() => [...document.querySelectorAll('.tri-share-source')].some(x => x.getAttribute('aria-label')?.includes('Triscord')), 'own window listed');
    [...document.querySelectorAll('.tri-share-source')].find(x => x.getAttribute('aria-label').includes('Triscord')).click();
    await wait(() => s().sharing, 'sharing');
    log.sharing = true;
    await wait(() => window.__bobDone || false, 'Bob checks', 30000).catch(() => {});
  })().catch(e => log.error = e.message);
  return 'stream options Alice started';
})()"""
BOB = """(() => {""" + COMMON + """
  const log = window.__e2e = {};
  (async () => {
    await wait(() => channel(), 'room', 20000);
    b.send({ name: 'selectChannel', channelId: channel().id });
    await wait(() => user('Alice')?.live && (s().streams || []).some(x => x.kind === 'screen'), 'Alice live', 40000);
    await sleep(8500);   // the test hovers the card and saves it first (menus and dialogs move the native video aside)
    const stream = s().streams.find(x => x.kind === 'screen'); log.stream = { width: stream.width, height: stream.height };
    const alice = user('Alice').id;
    log.badVolume = await b.request({ name: 'setPeerAudio', socketId: alice, streamVolume: 250 }).then(() => 'accepted', e => 'rejected');
    log.badMuted = await b.request({ name: 'setPeerAudio', socketId: alice, streamMuted: 1 }).then(() => 'accepted', e => 'rejected');
    const row = document.querySelector('.tri-voice-user[aria-label="Ver perfil de Alice"]');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 300 }));
    await wait(() => document.querySelector('[role="menu"]'), 'menu');
    // Volumes right in the menu (18/10): "Volume do usuário" and, while Alice streams, "Volume da transmissão".
    const slider = document.querySelector('[role="menu"] input[aria-label="Volume da transmissão"]');
    log.menuSliders = !!document.querySelector('[role="menu"] input[aria-label="Volume do usuário"]') && !!slider;
    slider.value = '40'; slider.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(() => user('Alice').streamVolume === 40, 'stream volume from the menu');
    log.menuStillOpen = !!document.querySelector('[role="menu"]');
    const item = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(x => x.textContent.includes('Silenciar transmissão'));
    log.menuItem = item?.getAttribute('aria-checked');
    item.click();
    await wait(() => user('Alice').streamMuted, 'stream muted');
    log.state = { volume: user('Alice').streamVolume, muted: user('Alice').streamMuted, voiceVolume: user('Alice').volume };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 300 }));
    await wait(() => document.querySelector('[role="menu"]'), 'menu again');
    log.menuChecked = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(x => x.textContent.includes('Silenciar transmissão'))?.getAttribute('aria-checked');
    [...document.querySelectorAll('[role="menuitem"]')].find(x => x.textContent.includes('Áudio do participante')).click();
    await wait(() => document.querySelector('input[aria-label="Volume da transmissão"]'), 'dialog');
    log.dialog = { volume: document.querySelector('input[aria-label="Volume da transmissão"]').value,
      muted: [...document.querySelectorAll('.tri-peer-audio__mute')].find(x => x.textContent.includes('Silenciar transmissão'))?.querySelector('input').checked };
    log.done = true;
  })().catch(e => log.error = e.message);
  return 'stream options Bob started';
})()"""
PROBE = "JSON.stringify(window.__e2e || {})"


def last(path):
    rows = [l[len("script: "):] for l in path.read_text(encoding="utf-8", errors="replace").splitlines() if l.startswith("script: ") and "{" in l]
    return json.loads(json.loads(rows[-1])) if rows else {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-stream-options-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-stream-"))
    backend, passed, processes = None, False, []
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        alice_session, alice = account(config, google, "stream-alice", "Alice")
        bob_session, bob = account(config, google, "stream-bob", "Bob")
        alice["nick"], bob["nick"] = "Alice", "Bob"
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de Alice"}, alice_session)
        code = request(f"{config['hubUrl']}/servers/{server['id']}/invites", "POST", {}, alice_session)["code"]
        request(f"{config['hubUrl']}/invites/{code}/accept", "POST", {}, bob_session)
        room = json.dumps(ROOM)
        (work / "alice.js").write_text(ALICE % (room, room), encoding="utf-8")
        (work / "bob.js").write_text(BOB % room, encoding="utf-8")
        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        logs = []
        for name, token, acct, delay, probe_at, quit_at in [("alice", alice_session, alice, 0, 50000, 60), ("bob", bob_session, bob, 5, 44000, 54)]:
            if delay:
                time.sleep(delay)
            log = (report / f"{name}.log").open("w", encoding="utf-8")
            logs.append(log)
            # No --capture of the page: the stream shows a window of this machine.
            processes.append(launch(args.exe, args.assets, config, profile(work, name, token, acct, server["id"]), work / f"{name}.js", 2500,
                                    work / "probe.js", probe_at, report / f"{name}-unused.png", quit_at, log))
        # Hover Bob's stream card for real once its badge shows, then save his window (the card shows Alice's own
        # triscord window, from the test accounts only).
        hovered = {}
        def hover():
            bob_process, bob_log = processes[1], report / "bob.log"
            while bob_process.poll() is None:
                if "badges=AO VIVO" in bob_log.read_text(encoding="utf-8", errors="replace"):
                    time.sleep(1)
                    windows = top_windows(bob_process.pid)
                    video = sorted(native_video_windows(windows[0][0]), key=lambda w: -w[1] * w[2]) if windows else []
                    if video:
                        hwnd, w, h = video[0]
                        main = windows[0][0]
                        before = wintypes.POINT(); user32.GetCursorPos(ctypes.byref(before))
                        center = wintypes.POINT(w // 2, h // 2); user32.ClientToScreen(hwnd, ctypes.byref(center))
                        user32.SetWindowPos(main, -1, 0, 0, 0, 0, 0x0013)   # HWND_TOPMOST, no move/size/activate
                        try:
                            for dx in (0, 6, 12):
                                user32.SetCursorPos(center.x + dx, center.y); time.sleep(0.25)
                            time.sleep(0.6)
                            save_window(hwnd, report / "stream-card-hover.png")
                        finally:
                            user32.SetCursorPos(before.x, before.y)
                            user32.SetWindowPos(main, -2, 0, 0, 0, 0, 0x0013)   # HWND_NOTOPMOST
                        hovered["done"] = True
                    return
                time.sleep(0.3)
        hoverer = threading.Thread(target=hover, daemon=True)
        hoverer.start()
        for process in processes:
            process.wait(timeout=90)
        hoverer.join(timeout=5)
        for log in logs:
            log.close()
        for png in report.glob("*-unused.png*"):
            png.unlink()
        a, b = last(report / "alice.log"), last(report / "bob.log")
        badge = lambda name, own: next((m.groups() for m in re.finditer(r"overlay (scr:\S+) badges=(.*) hover=(.*?)(?: hovered=\d)?$", (report / f"{name}.log").read_text(encoding="utf-8", errors="replace"), re.M)
                                        if m.group(1).endswith("$local") == own), (None, None, None))
        bob_badge, alice_badge = badge("bob", False), badge("alice", True)
        print("  badges: bob", bob_badge[1:], "alice (own)", alice_badge[1:], "| hovered:", hovered.get("done"), flush=True)
        # In the saved card, along the badges' row (8..24px from the top): red badge pixels at the right and the grey
        # quality pill (#4f505a) before it.
        pill = red = 0
        if (report / "stream-card-hover.png").exists():
            image = Image.open(report / "stream-card-hover.png").convert("RGB")
            for x in range(max(0, image.width - 260), image.width):
                r, g, b_ = image.getpixel((x, 12))
                pill += abs(r - 0x4f) < 8 and abs(g - 0x50) < 8 and abs(b_ - 0x5a) < 8
                red += r > 180 and g < 80 and b_ < 90
        print(f"  card pixels: grey pill {pill}, red badge {red}", flush=True)
        print("  alice:", json.dumps(a, ensure_ascii=False), flush=True)
        print("  bob:  ", json.dumps(b, ensure_ascii=False), flush=True)
        checks = {
            "picker tabs: Aplicativos, Tela Inteira, Dispositivos": a.get("tabs") == ["Aplicativos", "Tela Inteira", "Dispositivos"],
            "monitors captioned Tela 1, Tela 2...": bool(a.get("monitors")) and a.get("monitors") == [f"Tela {i + 1}" for i in range(len(a.get("monitors")))],
            "hover outline fits inside the grid (4px)": a.get("outlineRoom") == 4,
            "Dispositivos lists the cameras (Selecionar), or Discord's empty state": (lambda d: d.get("tiles") is not None and len(d["tiles"]) == d.get("known")
                and ((d.get("empty") or "").startswith("Você não tem nenhum dispositivo de captura disponível.") if d.get("known") == 0 else d.get("cta") == "Selecionar"))(a.get("devices", {})),
            "picker defaults: Jogos, 720p · 30fps, SD": a.get("defaults") == {"title": "Jogos", "line": "Vídeo mais suave · 720p · 30fps", "sd": "SD"},
            "HD: 1080p · 60fps": a.get("hd") == "Vídeo mais suave · 1080p · 60fps",
            "gear menu: the two modes with their quality and the audio checkbox": a.get("menu") == ["Jogos", "Compartilhamento de tela", "Silenciar áudio da transmissão"]
                and a.get("menuLines") == ["Vídeo mais suave (1080p, 60fps)", "Texto mais claro (1080p, 15fps)"] and a.get("audioMutedDefault") == "true",
            "Compartilhamento de tela: Texto mais claro · 1080p · 15fps": a.get("screen") == {"title": "Compartilhamento de tela", "line": "Texto mais claro · 1080p · 15fps"},
            "choices saved (audio toggled on and off)": a.get("audioSaved") is True and a.get("saved") == {"mode": "game", "hd": True, "audio": False},
            "Escape closes the mode menu, not the picker": a.get("menuClosedPickerOpen") is True,
            "sharing started with the saved mode": a.get("sharing") is True and not a.get("error"),
            "Bob receives a 1080p stream (HD)": b.get("stream", {}).get("height") == 1080,
            "bad stream audio values refused": b.get("badVolume") == "rejected" and b.get("badMuted") == "rejected",
            "menu sliders set the stream volume (menu stays open)": b.get("menuSliders") is True and b.get("menuStillOpen") is True,
            "menu 'Silenciar transmissão' (unchecked, then checked)": b.get("menuItem") == "false" and b.get("menuChecked") == "true",
            "core keeps stream volume and mute apart from the voice": b.get("state") == {"volume": 40, "muted": True, "voiceVolume": 100},
            "remote stream card: AO VIVO, and 1080P before it on hover": bob_badge[1:] == ("AO VIVO", "1080P | AO VIVO"),
            "own stream card: 1080P 60FPS on hover": alice_badge[1:] == ("AO VIVO", "1080P 60FPS | AO VIVO"),
            "real hover draws the quality pill before the badge": hovered.get("done") is True and pill > 20 and red > 20,
            "audio dialog shows the stream controls": b.get("dialog") == {"volume": "40", "muted": True} and b.get("done") is True and not b.get("error"),
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
    print(f"WEB STREAM OPTIONS E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
