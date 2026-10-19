"""End-to-end chat test of the new client: two triscord-web instances in one room, driven by the web UI.

Local backend only (real auth + hub Workers in Miniflare, fake Google). Alice and Bob are created through the
auth Worker and Bob joins Alice's server with a real invite. Then, only through clicks and typing in the UI:

  1. Alice creates a room and, once in it, opens "Mostrar chat" and sends two messages (the second within 7
     minutes, so it continues her group);
  2. Bob clicks the room in the sidebar, opens the chat with the row's "Abrir chat" action, sees Alice's
     messages (history from the hub) and reacts to the first one with the quick reaction of the hover bar;
  3. checked on Alice's side: her two messages, one group, Bob's reaction (count 1, not hers); on Bob's side:
     the two messages in order and his reaction marked as his;
  4. context menus: Alice sends a third message, right-clicks it, uses "Copiar texto" (the copy goes to a file,
     never to the user's clipboard), right-clicks it again, picks "Excluir mensagem" and confirms in the
     "Excluir mensagem" modal; the message disappears for both.

Usage (from desktop/): ../.toolchain/venv/Scripts/python.exe tests/e2e/run_web_chat_e2e.py --exe out/build/triscord-web.exe
"""
import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers  # noqa: E402
from run_web_e2e import request  # noqa: E402
from run_web_call_e2e import account, launch, profile  # noqa: E402

ROOM = "Sala Chat E2E"
HELPERS = r"""
  const log = window.__e2e = { steps: [] };
  const wait = (test, then, label, ms = 20000) => {
    const start = Date.now();
    const timer = setInterval(() => {
      let found; try { found = test(); } catch {}
      if (found) { clearInterval(timer); log.steps.push(label); then(found); }
      else if (Date.now() - start > ms) { clearInterval(timer); log.steps.push('TIMEOUT ' + label); }
    }, 200);
  };
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const send = (value, then) => {
    const input = document.querySelector('.tri-chat-panel .tri-composer__input');
    type(input, value);
    input.form.requestSubmit();
    then && setTimeout(then, 800);   // the hub accepts one message per 500ms
  };
"""
ALICE = """(() => {%s
  window.__triscord.bridge.send({ name: 'createChannel', channelName: %s });
  wait(() => document.querySelector('[aria-label="Mostrar chat"]'), b => {
    b.click();
    wait(() => document.querySelector('.tri-chat-panel .tri-composer__input'), () => {
      send('oi bob, chat do triscord', () => send('segunda mensagem do mesmo grupo', () => setTimeout(() => send('mensagem para excluir', () => {
        const last = () => [...document.querySelectorAll('.tri-chat-panel .tri-message')].find(m => m.textContent.includes('mensagem para excluir'));
        const menu = el => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 80, clientY: r.top + 10 })); };
        const pick = label => [...document.querySelectorAll('.tri-menu__item')].find(i => i.textContent.trim() === label);
        wait(() => last(), m => {
          menu(m);
          wait(() => pick('Copiar texto'), item => {
            log.menuItems = [...document.querySelectorAll('.tri-menu__item')].map(i => i.textContent.trim());
            log.reactionsInMenu = document.querySelectorAll('.tri-menu__reaction').length;
            item.click();
            wait(() => !document.querySelector('.tri-menu'), () => {
              menu(last());
              wait(() => pick('Excluir mensagem'), del => {
                del.click();
                wait(() => document.querySelector('.tri-dmodal'), modal => {
                  log.deleteTitle = modal.querySelector('.tri-dmodal__title')?.textContent;
                  log.deleteSubtitle = modal.querySelector('.tri-dmodal__subtitle')?.textContent;
                  [...modal.querySelectorAll('button')].find(b => b.textContent === 'Excluir').click();
                  wait(() => !last() && !document.querySelector('.tri-dmodal'), () => { log.deleted = true; }, 'message deleted');
                }, 'delete modal');
              }, 'menu reopened');
            }, 'menu closed');
          }, 'message menu');
        }, 'third message');
      }), 2500)));
    }, 'chat open');
  }, 'in room');
  return 'started';
})()"""
BOB = """(() => {%s
  wait(() => [...document.querySelectorAll('.tri-channel__name')].find(n => n.textContent === %s), name => {
    name.closest('.tri-channel__link').click();
    wait(() => document.querySelector('.tri-channel.is-connected [aria-label="Abrir chat"]'), b => {
      b.click();
      wait(() => document.querySelectorAll('.tri-chat-panel .tri-message').length >= 2, () => {
        document.querySelector('.tri-chat-panel .tri-message [aria-label^="Reagir com"]').click();
      }, 'messages shown');
    }, 'in room');
  }, 'room listed');
  return 'started';
})()"""
PROBE = """JSON.stringify({
  steps: (window.__e2e || {}).steps,
  messages: [...document.querySelectorAll('.tri-chat-panel .tri-message')].map(m => ({
    text: m.querySelector('.tri-message__content')?.textContent,
    groupStart: m.classList.contains('is-group-start'),
    author: m.querySelector('.tri-message__username')?.textContent,
    reactions: [...m.querySelectorAll('.tri-reaction')].map(r => ({ emoji: r.querySelector('.tri-reaction__emoji').textContent,
      count: +r.querySelector('.tri-reaction__count').textContent, me: r.classList.contains('is-me') })),
  })),
  dividers: document.querySelectorAll('.tri-chat-panel .tri-divider').length,
  menuItems: (window.__e2e || {}).menuItems, reactionsInMenu: (window.__e2e || {}).reactionsInMenu,
  deleteTitle: (window.__e2e || {}).deleteTitle, deleteSubtitle: (window.__e2e || {}).deleteSubtitle, deleted: (window.__e2e || {}).deleted,
})"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-chat-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-chat-"))
    backend, passed, processes = None, False, []
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        alice_session, alice = account(config, google, "chat-alice", "Alice")
        bob_session, bob = account(config, google, "chat-bob", "Bob")
        alice["nick"], bob["nick"] = "Alice", "Bob"
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de Alice"}, alice_session)
        code = request(f"{config['hubUrl']}/servers/{server['id']}/invites", "POST", {}, alice_session)["code"]
        request(f"{config['hubUrl']}/invites/{code}/accept", "POST", {}, bob_session)
        print("  ok: Alice and Bob on the local backend; Bob joined Alice's server with an invite", flush=True)

        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        (work / "alice.js").write_text(ALICE % (HELPERS, json.dumps(ROOM)), encoding="utf-8")
        (work / "bob.js").write_text(BOB % (HELPERS, json.dumps(ROOM)), encoding="utf-8")
        alice_log = (report / "alice.log").open("w", encoding="utf-8")
        bob_log = (report / "bob.log").open("w", encoding="utf-8")
        import os
        os.environ["TRISCORD_CLIPBOARD_FILE"] = str(work / "clipboard-alice.txt")
        processes.append(launch(args.exe, args.assets, config, profile(work, "alice", alice_session, alice, server["id"]),
                                work / "alice.js", 2500, work / "probe.js", 28000, report / "alice.png", 34, alice_log))
        time.sleep(8)
        os.environ.pop("TRISCORD_CLIPBOARD_FILE", None)
        processes.append(launch(args.exe, args.assets, config, profile(work, "bob", bob_session, bob, server["id"]),
                                work / "bob.js", 2500, work / "probe.js", 19000, report / "bob.png", 26, bob_log))
        for process in processes:
            process.wait(timeout=60)
        alice_log.close(); bob_log.close()

        def last_probe(path):
            lines = [line[len("script: "):] for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.startswith("script: ")]
            return json.loads(json.loads(lines[-1])) if lines else {}
        a, b = last_probe(report / "alice.log"), last_probe(report / "bob.log")
        print("  alice:", json.dumps(a, ensure_ascii=False), flush=True)
        print("  bob:  ", json.dumps(b, ensure_ascii=False), flush=True)
        texts = ["oi bob, chat do triscord", "segunda mensagem do mesmo grupo"]
        clip = work / "clipboard-alice.txt"
        copied = clip.read_text(encoding="utf-8") if clip.exists() else None
        am, bm = a.get("messages", []), b.get("messages", [])
        first_a = am[0]["reactions"] if am else []
        first_b = bm[0]["reactions"] if bm else []
        checks = {
            "alice sent two messages through the composer": [m["text"] for m in am] == texts,
            "one group: header on the first, continuation on the second": [m["groupStart"] for m in am] == [True, False] and am[0]["author"] == "Alice",
            "date divider before the first message": a.get("dividers") == 1,
            "bob sees the history in order": [m["text"] for m in bm] == texts,
            "bob's reaction reaches alice (count 1, not hers)": len(first_a) == 1 and first_a[0]["count"] == 1 and first_a[0]["me"] is False,
            "bob's reaction is marked as his": len(first_b) == 1 and first_b[0]["me"] is True,
            "message menu: 4 quick reactions, Adicionar reação, Copiar texto, Excluir mensagem":
                a.get("reactionsInMenu") == 4 and a.get("menuItems") == ["Adicionar reação", "Copiar texto", "Excluir mensagem"],
            "Copiar texto copied the message (test file, not the clipboard)": copied == "mensagem para excluir",
            "Excluir mensagem asks first ('Excluir mensagem' / 'Deseja mesmo excluir essa mensagem?')":
                a.get("deleteTitle") == "Excluir mensagem" and a.get("deleteSubtitle") == "Deseja mesmo excluir essa mensagem?",
            "deleted for both (only the two first messages remain)": a.get("deleted") is True and [m["text"] for m in bm] == texts,
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
    print(f"WEB CHAT E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
