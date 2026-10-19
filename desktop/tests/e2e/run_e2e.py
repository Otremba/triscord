"""End-to-end test of the native client: real executable, real auth + hub Workers run locally.

Two clients (Alice and Bob) are launched from the given executable, each with its own INI settings
directory, synthetic audio and the local backend (tests/e2e/backend.mjs). The test drives the real UI
through Windows UI Automation (pywinauto, Invoke/Value patterns, so the mouse is not moved) and checks:

  1. login      - "Entrar com Google" -> OAuth against a fake Google -> the real auth Worker verifies the
                  RS256 id_token -> nick chooser -> main window.
  2. server     - "Adicionar um servidor" -> "Criar o meu" -> "Criar" -> the server shows in the rail/header.
  3. invite     - the owner's invite button copies a code; Bob joins with "Entrar em um servidor".
  4. room       - Alice creates a voice room and joins it; Bob opens the same server and joins the room;
                  both see two people in the room.

Nothing reaches Google or the production Workers. The clipboard is used by the invite step and restored.
Screenshots of every window at each step (and at failure) go to --report.

Usage (from desktop/):
  .toolchain/venv/Scripts/python.exe tests/e2e/run_e2e.py --exe dist/triscord-native.exe
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
import urllib.request
from pathlib import Path

from pywinauto import Application, Desktop

ROOT = Path(__file__).resolve().parents[3]          # repository root (desktop/ is one level below)
DESKTOP = ROOT / "desktop"
TOOLCHAIN = ROOT / ".toolchain"


class E2EFailure(AssertionError):
    pass


def wait_for(probe, timeout, what, interval=0.25):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            value = probe()
            if value:
                return value
        except Exception as error:  # UIA lookups raise while a window is still being built
            last_error = error
        time.sleep(interval)
    raise E2EFailure(f"timed out after {timeout}s waiting for {what}" + (f" (last error: {last_error})" if last_error else ""))


def bundle_workers(out_dir: Path):
    """Bundles both Workers with their own pinned wrangler (dry run: nothing is published)."""
    for name, folder in (("auth", "cloudflare-auth"), ("hub", "cloudflare")):
        wrangler = ROOT / folder / "node_modules" / ".bin" / "wrangler.cmd"
        result = subprocess.run([str(wrangler), "deploy", "--dry-run", "--outdir", str(out_dir / name)],
                                cwd=ROOT / folder, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
        if result.returncode != 0:
            raise E2EFailure(f"bundling {folder} failed:\n{result.stdout}\n{result.stderr}")
    return out_dir / "auth" / "worker.js", out_dir / "hub" / "worker.js"


class Backend:
    def __init__(self, auth_bundle: Path, hub_bundle: Path, log: Path):
        self.log = log.open("w", encoding="utf-8")
        self.process = subprocess.Popen(["node", str(DESKTOP / "tests" / "e2e" / "backend.mjs"), str(auth_bundle), str(hub_bundle)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True,
                                        creationflags=subprocess.CREATE_NO_WINDOW)
        line = self.process.stdout.readline()
        if not line:
            raise E2EFailure("local backend did not start; see " + str(log))
        self.config = json.loads(line)

    def close(self):
        try:
            self.process.stdin.close()
            self.process.wait(timeout=10)
        except Exception:
            self.process.kill()
        self.log.close()


class Client:
    def __init__(self, name: str, exe: Path, backend: Backend, work: Path, report: Path):
        self.name, self.report = name, report
        self.settings = work / f"settings-{name}"
        self.url_file = work / f"oauth-url-{name}.txt"
        self.settings.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env["PATH"] = os.pathsep.join([str(TOOLCHAIN / "Qt" / "6.8.3" / "mingw_64" / "bin"),
                                       str(TOOLCHAIN / "Qt" / "Tools" / "mingw1310_64" / "bin"), env.get("PATH", "")])
        env.update(TRISCORD_SETTINGS_PATH=str(self.settings), TRISCORD_AUDIO_MODE="injected",
                   TRISCORD_AUTH_SERVER=backend.config["authUrl"], TRISCORD_HUB_SERVER=backend.config["hubUrl"],
                   TRISCORD_GOOGLE_AUTH_URL=backend.config["googleAuthUrl"],
                   TRISCORD_GOOGLE_TOKEN_URL=backend.config["googleTokenUrl"],
                   TRISCORD_GOOGLE_CLIENT_SECRET="native-e2e-not-a-secret",
                   TRISCORD_OPEN_URL_FILE=str(self.url_file))
        env.pop("TRISCORD_ICE_SERVERS", None)
        self.process = subprocess.Popen([str(exe)], env=env)
        self.app = Application(backend="uia").connect(process=self.process.pid, timeout=30)

    # --- lookup helpers -------------------------------------------------------------------------
    def window(self, object_name: str, timeout=20):
        """A window whose objectName path ends with `object_name`; modal dialogs appear either as
        top-level UIA windows or nested under their owner, depending on how Qt parents them."""
        def probe():
            for w in Desktop(backend="uia").windows(process=self.process.pid):
                for candidate in [w, *w.descendants(control_type="Window"), *w.descendants(control_type="Pane")]:
                    ei = candidate.element_info
                    if object_name in (ei.automation_id.split(".")[-1], ei.class_name.split("::")[-1]) and candidate.is_visible():
                        return candidate
            return None
        return wait_for(probe, timeout, f"{self.name}: window {object_name}")

    def control(self, parent, timeout=15, visible=True, **criteria):
        def probe():
            for c in parent.descendants(**{k: v for k, v in criteria.items() if k in ("control_type", "title")}):
                ei = c.element_info
                if "auto_id_suffix" in criteria and not ei.automation_id.endswith(criteria["auto_id_suffix"]):
                    continue
                if visible and not c.is_visible():
                    continue
                return c
            return None
        return wait_for(probe, timeout, f"{self.name}: control {criteria}")

    def texts(self, parent):
        return [c.window_text() for c in parent.descendants(control_type="Text")]

    def screenshot(self, label: str):
        """Captures only this client's own windows through PrintWindow (the window renders itself into a
        bitmap). A screen grab would also capture whatever other app happens to cover the window."""
        import ctypes
        import win32gui, win32ui
        from PIL import Image
        for index, w in enumerate(Desktop(backend="uia").windows(process=self.process.pid)):
            try:
                hwnd = w.handle
                left, top, right, bottom = win32gui.GetWindowRect(hwnd)
                width, height = right - left, bottom - top
                window_dc = win32gui.GetWindowDC(hwnd)
                source = win32ui.CreateDCFromHandle(window_dc)
                memory = source.CreateCompatibleDC()
                bitmap = win32ui.CreateBitmap()
                bitmap.CreateCompatibleBitmap(source, width, height)
                memory.SelectObject(bitmap)
                ctypes.windll.user32.PrintWindow(hwnd, memory.GetSafeHdc(), 2)  # PW_RENDERFULLCONTENT
                info = bitmap.GetInfo()
                Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]), bitmap.GetBitmapBits(True), "raw", "BGRX", 0, 1)                     .save(self.report / f"{self.name}-{label}-{index}.png")
                win32gui.DeleteObject(bitmap.GetHandle()); memory.DeleteDC(); source.DeleteDC()
                win32gui.ReleaseDC(hwnd, window_dc)
            except Exception as error:
                print(f"  (screenshot {label} failed: {error})")

    def dump_tree(self, label: str):
        lines = []
        for w in Desktop(backend="uia").windows(process=self.process.pid):
            for c in [w, *w.descendants()]:
                ei = c.element_info
                if ei.name or ei.automation_id:
                    lines.append(f"{ei.control_type}\t{ei.name!r}\t{ei.automation_id}\tvisible={c.is_visible()}")
        (self.report / f"{self.name}-{label}-uia.txt").write_text("\n".join(lines), encoding="utf-8")

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=10)


def set_text(edit, text):
    edit.iface_value.SetValue(text)


def login(client: Client, google_user: str, nick: str, log):
    login_window = client.window("loginWindow")
    client.control(login_window, control_type="Button", auto_id_suffix="loginGoogleButton").invoke()
    url = wait_for(lambda: client.url_file.exists() and client.url_file.read_text(encoding="utf-8"), 15,
                   f"{client.name}: OAuth URL")
    # Plays the browser: fake Google redirects to the client's loopback with an authorization code.
    with urllib.request.urlopen(url + "&e2e_user=" + google_user, timeout=15) as response:
        page = response.read().decode("utf-8")
    if "Login concluído" not in page:
        raise E2EFailure(f"{client.name}: loopback page did not confirm the login: {page[:200]}")
    nick_dialog = client.window("nickChooserDialog")
    set_text(client.control(nick_dialog, control_type="Edit", auto_id_suffix="nickChooserInput"), nick)
    client.control(nick_dialog, control_type="Button", auto_id_suffix="nickChooserContinue").invoke()
    main = client.window("MainWindow", timeout=30)
    log(f"{client.name}: signed in through the fake Google and the real auth Worker as {nick}")
    return main


def rail_server(client: Client, main, name: str, timeout=20):
    return client.control(main, timeout=timeout, control_type="Button", title=name)


def create_server(client: Client, main, log):
    client.control(main, control_type="Button", title="Adicionar um servidor").invoke()
    dialog = client.window("serverDialog")
    client.screenshot("create-step1")
    client.control(dialog, control_type="Button", title="Criar o meu").invoke()
    name_input = client.control(dialog, control_type="Edit", auto_id_suffix="serverNameInput")
    name = name_input.get_value()
    if name != "Servidor de Alice":
        raise E2EFailure(f"server name should be prefilled with 'Servidor de Alice', got {name!r}")
    client.screenshot("create-step3")
    client.control(dialog, control_type="Button", title="Criar").invoke()
    rail_server(client, main, name)
    wait_for(lambda: name in client.texts(main), 15, "server title in the header")
    log(f"{client.name}: created '{name}'; it is in the rail and the header")
    return name


def copy_invite(client: Client, main, log):
    import win32clipboard
    client.control(main, control_type="Button", title="Convidar pessoas").invoke()

    def read():
        win32clipboard.OpenClipboard()
        try:
            return win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
        finally:
            win32clipboard.CloseClipboard()
    code = wait_for(lambda: (lambda t: t if re.fullmatch(r"[0-9a-f]{32}", t or "") else None)(read()), 15,
                    "invite code on the clipboard")
    log(f"{client.name}: invite code copied ({code[:6]}...)")
    return code


def create_room(client: Client, main, room: str, log):
    client.control(main, control_type="Button", title="Criar canal").invoke()
    dialog = client.window("QInputDialog")
    if dialog.window_text() != "Nova Sala":
        raise E2EFailure(f"expected the 'Nova Sala' dialog, got {dialog.window_text()!r}")
    set_text(client.control(dialog, control_type="Edit"), room)
    client.control(dialog, control_type="Button", title="OK").invoke()
    log(f"{client.name}: created room '{room}'")


def join_server(client: Client, main, code: str, server: str, log):
    client.control(main, control_type="Button", title="Adicionar um servidor").invoke()
    dialog = client.window("serverDialog")
    client.control(dialog, control_type="Button", title="Entrar em um servidor").invoke()
    set_text(client.control(dialog, control_type="Edit", auto_id_suffix="inviteCodeInput"), code)
    client.screenshot("join")
    client.control(dialog, control_type="Button", title="Entrar no servidor").invoke()
    rail_server(client, main, server)
    wait_for(lambda: server in client.texts(main), 15, f"{client.name}: '{server}' in the header")
    log(f"{client.name}: joined '{server}' with the invite")


def join_room(client: Client, main, room: str, log):
    rooms = client.control(main, control_type="List", auto_id_suffix="roomList", timeout=20)
    item = wait_for(lambda: next((i for i in rooms.children(control_type="ListItem") if i.window_text() == room), None),
                    20, f"{client.name}: room '{room}' in the channel list")
    item.click_input()  # the list joins on itemClicked; selection through UIA alone does not emit it
    log(f"{client.name}: clicked room '{room}'")


def room_count(client: Client, main):
    for text in client.texts(main):
        match = re.fullmatch(r"ONLINE — (\d+)", text)
        if match:
            return int(match.group(1))
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True, help="triscord-native.exe to test (the packaged dist/ one for releases)")
    parser.add_argument("--report", default=str(DESKTOP / "out" / "e2e-report"))
    parser.add_argument("--keep", action="store_true", help="keep the settings/work directory")
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-e2e-"))
    steps = []
    log = lambda message: (steps.append(message), print("  ok:", message, flush=True))

    import win32clipboard
    try:
        win32clipboard.OpenClipboard()
        saved_clipboard = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
    except Exception:
        saved_clipboard = None
    finally:
        try:
            win32clipboard.CloseClipboard()
        except Exception:
            pass

    backend = clients = None
    clients = []
    status = 1
    try:
        auth_bundle, hub_bundle = bundle_workers(DESKTOP / "out" / "e2e-backend")
        backend = Backend(auth_bundle, hub_bundle, report / "backend.log")
        log("real auth + hub Workers running locally (Miniflare, shared D1)")

        alice = Client("alice", Path(args.exe), backend, work, report); clients.append(alice)
        alice_main = login(alice, "e2e-alice", "Alice", log)
        server = create_server(alice, alice_main, log)
        code = copy_invite(alice, alice_main, log)
        create_room(alice, alice_main, "Sala E2E", log)
        wait_for(lambda: room_count(alice, alice_main) == 1, 20, "Alice alone in the room (ONLINE — 1)")
        log("alice: in the room (ONLINE — 1)")
        alice.screenshot("in-room")

        bob = Client("bob", Path(args.exe), backend, work, report); clients.append(bob)
        bob_main = login(bob, "e2e-bob", "Bob", log)
        join_server(bob, bob_main, code, server, log)
        join_room(bob, bob_main, "Sala E2E", log)
        wait_for(lambda: room_count(bob, bob_main) == 2, 30, "Bob sees two people (ONLINE — 2)")
        wait_for(lambda: room_count(alice, alice_main) == 2, 30, "Alice sees two people (ONLINE — 2)")
        log("both clients see two people in 'Sala E2E'")
        for client in clients:
            client.screenshot("final")
        status = 0
    except Exception as error:
        print("FAIL:", error, flush=True)
        for client in clients:
            client.screenshot("failure")
            try:
                client.dump_tree("failure")
            except Exception as dump_error:
                print("  (tree dump failed:", dump_error, ")")
    finally:
        for client in clients:
            client.close()
        if backend:
            backend.close()
        if saved_clipboard is not None:
            try:
                win32clipboard.OpenClipboard(); win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardText(saved_clipboard, win32clipboard.CF_UNICODETEXT)
                win32clipboard.CloseClipboard()
            except Exception:
                pass
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)
        (report / "steps.json").write_text(json.dumps({"passed": status == 0, "steps": steps}, ensure_ascii=False, indent=1),
                                           encoding="utf-8")
    print(f"E2E {'PASSED' if status == 0 else 'FAILED'}: {len(steps)} steps; report in {report}")
    return status


if __name__ == "__main__":
    sys.exit(main())
