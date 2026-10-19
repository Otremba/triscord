"""End-to-end test of notifications in the new client (no Qt Widgets): two triscord-web instances, local backend.

Alice runs with TRISCORD_TEST_BACKGROUND=1 (her window counts as inactive) and TRISCORD_NOTIFY_FILE, so the
Windows notifications and taskbar alerts are written to a file instead of being shown on the screen.
  1. Alice creates a room; Bob joins it            -> "Bob entrou na sala" + taskbar alert;
  2. Bob writes "oi @Alice tudo bem?"               -> "Triscord · Bob mencionou você" with the text + alert;
  3. Bob writes a message without a mention         -> nothing;
  4. Alice turns "Ativar notificações na área de trabalho" off (setSetting) and Bob mentions her again
                                                    -> only the taskbar alert.

Usage (from desktop/): ../.toolchain/venv/Scripts/python.exe tests/e2e/run_web_notifications_e2e.py --exe out/build/triscord-web.exe
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers  # noqa: E402
from run_web_e2e import request  # noqa: E402
from run_web_call_e2e import account, launch, profile  # noqa: E402

ROOM = "Sala Avisos E2E"
ALICE = """(() => {
  const b = window.__triscord.bridge;
  b.send({ name: 'createChannel', channelName: %s });
  setTimeout(() => b.send({ name: 'setSetting', key: 'desktopNotifications', value: false }), 14000);
  return 'started';
})()"""
BOB = """(() => {
  const b = window.__triscord.bridge, s = window.__triscord.store.current;
  const channel = s.categories.flatMap(c => c.channels).find(c => c.name === %s);
  if (!channel) return 'room not visible';
  b.send({ name: 'selectChannel', channelId: channel.id });
  setTimeout(() => b.send({ name: 'sendChatMessage', text: 'oi @Alice tudo bem?' }), 3000);
  setTimeout(() => b.send({ name: 'sendChatMessage', text: 'mensagem sem mencao' }), 4500);
  setTimeout(() => b.send({ name: 'sendChatMessage', text: 'Alice, de novo' }), 8000);
  return 'joining';
})()"""
PROBE = "JSON.stringify({ settings: window.__triscord.store.current.settings })"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-notifications-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-notify-"))
    backend, passed, processes = None, False, []
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        alice_session, alice = account(config, google, "notify-alice", "Alice")
        bob_session, bob = account(config, google, "notify-bob", "Bob")
        alice["nick"], bob["nick"] = "Alice", "Bob"
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de Alice"}, alice_session)
        code = request(f"{config['hubUrl']}/servers/{server['id']}/invites", "POST", {}, alice_session)["code"]
        request(f"{config['hubUrl']}/invites/{code}/accept", "POST", {}, bob_session)
        (work / "alice.js").write_text(ALICE % json.dumps(ROOM), encoding="utf-8")
        (work / "bob.js").write_text(BOB % json.dumps(ROOM), encoding="utf-8")
        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        notify = work / "alice-notify.txt"
        os.environ["TRISCORD_TEST_BACKGROUND"] = "1"
        os.environ["TRISCORD_NOTIFY_FILE"] = str(notify)
        alice_log = (report / "alice.log").open("w", encoding="utf-8")
        processes.append(launch(args.exe, args.assets, config, profile(work, "alice", alice_session, alice, server["id"]),
                                work / "alice.js", 2500, work / "probe.js", 24000, report / "alice.png", 27, alice_log))
        os.environ.pop("TRISCORD_TEST_BACKGROUND"); os.environ.pop("TRISCORD_NOTIFY_FILE")
        time.sleep(8)
        bob_log = (report / "bob.log").open("w", encoding="utf-8")
        processes.append(launch(args.exe, args.assets, config, profile(work, "bob", bob_session, bob, server["id"]),
                                work / "bob.js", 2500, work / "probe.js", 12000, report / "bob.png", 16, bob_log))
        for process in processes:
            process.wait(timeout=60)
        alice_log.close(); bob_log.close()
        lines = notify.read_text(encoding="utf-8").splitlines() if notify.exists() else []
        shutil.copy(notify, report / "alice-notify.txt") if notify.exists() else None
        print("  notifications:", json.dumps(lines, ensure_ascii=False), flush=True)
        toasts = [l for l in lines if l != "alert"]
        checks = {
            "Bob entering the room notifies Alice": "Triscord\tBob entrou na sala" in toasts,
            "a mention notifies with the sender and the text": "Triscord · Bob mencionou você\toi @Alice tudo bem?" in toasts,
            "a message without a mention does not notify": not any("mensagem sem mencao" in t for t in toasts),
            "desktop notifications off: no toast, the taskbar alert stays": not any("de novo" in t for t in toasts) and lines.count("alert") == 3,
            "exactly two toasts": len(toasts) == 2,
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
    print(f"WEB NOTIFICATIONS E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
