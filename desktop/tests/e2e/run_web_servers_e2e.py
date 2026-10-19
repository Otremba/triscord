"""End-to-end test of servers in the new client: closing the creation flow, viewing another server during a call,
leaving and deleting a server.

Two triscord-web instances on the local backend. Alice owns "Servidor de Alice", "Segundo Servidor" and "Servidor
Temporario"; Bob joined the temporary one with an invite.
  Alice:
    1. "Criar seu servidor" -> "Criar o meu", then the X: nothing is created (the X used to submit the form); the
       same on "Entrar em um servidor";
    2. in a room of "Servidor de Alice", she opens "Segundo Servidor": still in the call (callServerId stays), the
       sidebar lists the other server's channels, the voice panel keeps "Sala A / Servidor de Alice" and the voice
       badge stays on the call's server tile; back on her server the room is there again;
    3. in "Segundo Servidor" she creates "Sala B": the call moves to that server;
    4. once Bob left, the temporary server's menu offers "Excluir servidor"; a wrong name is refused with Discord's
       text, the right one deletes it.
  Bob: the temporary server's menu offers "Sair do servidor" (not "Excluir servidor"); confirming removes it.
The hub is then asked directly: the deleted server answers 403 to Alice and Bob is no longer a member.

Usage (from desktop/): ../.toolchain/venv/Scripts/python.exe tests/e2e/run_web_servers_e2e.py --exe out/build-claude/triscord-web.exe
"""
import argparse
import json
import shutil
import sys
import tempfile
import time
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers  # noqa: E402
from run_web_e2e import request  # noqa: E402
from run_web_call_e2e import account, launch, profile  # noqa: E402

COMMON = """
  const b = window.__triscord.bridge, s = () => window.__triscord.store.current;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function wait(test, label, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return; await sleep(80); } throw Error(label); }
  const server = name => s().servers.find(x => x.name === name);
  const channels = () => s().categories.flatMap(c => c.channels).map(c => c.name);
  const button = (root, label) => [...root.querySelectorAll('button')].find(x => x.textContent.trim() === label);
  async function menuOf(name) {
    document.querySelector(`.tri-rail__button[aria-label="${name}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 200 }));
    await wait(() => document.querySelector('[role="menu"]'), 'server menu');
    return [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
  }
"""
ALICE = """(() => {""" + COMMON + """
  const log = window.__e2e = {};
  (async () => {
    await wait(() => s().connection === 'connected' && server('Servidor Temporario'), 'connected');
    const before = s().servers.length;
    // 1. closing the creation flow creates nothing
    dispatchEvent(new Event('tri-open-server-modal'));
    await wait(() => document.querySelector('.tri-modal__option'), 'server modal');
    document.querySelector('.tri-modal__option').click();
    await wait(() => document.querySelector('#tri-server-name'), 'customize page');
    document.querySelector('.tri-modal__close').click();
    await wait(() => !document.querySelector('.tri-modal'), 'modal closed');
    dispatchEvent(new Event('tri-open-server-modal'));
    await wait(() => document.querySelector('.tri-modal__secondary'), 'server modal again');
    document.querySelector('.tri-modal__secondary').click();
    await wait(() => document.querySelector('#tri-invite'), 'join page');
    document.querySelector('#tri-invite').value = '%(code)s';
    document.querySelector('.tri-modal__close').click();
    await wait(() => !document.querySelector('.tri-modal'), 'modal closed again');
    await sleep(2500);
    log.afterClose = { servers: s().servers.length, before, selected: s().selectedServerId === server('Servidor de Alice').id };
    // 2. another server during a call
    b.send({ name: 'createChannel', channelName: 'Sala A' });
    await wait(() => s().connectedChannelId && s().callChannel?.name === 'Sala A', 'in Sala A');
    const home = server('Servidor de Alice').id, second = server('Segundo Servidor').id, call = s().connectedChannelId;
    b.send({ name: 'selectServer', serverId: second });
    await wait(() => s().selectedServerId === second, 'viewing the second server');
    await sleep(2500);
    const tile = id => document.querySelector(`.tri-rail__button[aria-label="${s().servers.find(x => x.id === id).name}"]`)?.closest('.tri-rail__item');
    log.viewing = { inCall: s().connectedChannelId === call, callServer: s().callServerId === home, channels: channels(),
      panel: document.querySelector('.tri-voice-panel__room')?.textContent, badgeOnHome: !!tile(home)?.querySelector('.tri-rail__voice-badge'),
      badgeOnSecond: !!tile(second)?.querySelector('.tri-rail__voice-badge') };
    b.send({ name: 'selectServer', serverId: home });
    await wait(() => s().selectedServerId === home && channels().includes('Sala A'), 'back home');
    log.back = { inCall: s().connectedChannelId === call, connectedRow: !!document.querySelector('.tri-channel.is-connected') };
    // 3. a room created in the viewed server moves the call there
    b.send({ name: 'selectServer', serverId: second });
    await wait(() => s().selectedServerId === second, 'second again');
    await sleep(1500);
    b.send({ name: 'createChannel', channelName: 'Sala B' });
    await wait(() => s().callChannel?.name === 'Sala B', 'call moved', 20000);
    log.moved = { callServer: s().callServerId === second, channels: channels() };
    // 4. delete the temporary server once Bob left it
    await wait(() => window.__bobLeft || false, 'Bob left', 1).catch(() => {});
    await sleep(6000);
    const items = (await menuOf('Servidor Temporario')).map(x => x.textContent.trim());
    log.ownerMenu = items;
    [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(x => x.textContent.trim() === 'Excluir servidor').click();
    await wait(() => document.querySelector('#tri-server-confirm-name'), 'delete modal');
    log.deleteTitle = document.querySelector('.tri-dmodal__title')?.textContent;
    log.deleteSubtitle = document.querySelector('.tri-dmodal__subtitle')?.textContent;
    const input = document.querySelector('#tri-server-confirm-name');
    input.value = 'outro nome'; input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(100);
    button(document.querySelector('.tri-modal-backdrop'), 'Excluir servidor').click(); await sleep(400);
    log.wrongName = { error: document.querySelector('.tri-field__error')?.textContent, stillThere: !!server('Servidor Temporario') };
    input.value = 'Servidor Temporario'; input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(100);
    button(document.querySelector('.tri-modal-backdrop'), 'Excluir servidor').click();
    await wait(() => !server('Servidor Temporario') && !document.querySelector('.tri-modal-backdrop'), 'server deleted');
    log.deleted = true;
  })().catch(e => log.error = e.message);
  return 'servers Alice started';
})()"""
BOB = """(() => {""" + COMMON + """
  const log = window.__e2e = {};
  (async () => {
    await wait(() => s().connection === 'connected' && server('Servidor Temporario'), 'connected');
    log.memberMenu = (await menuOf('Servidor Temporario')).map(x => x.textContent.trim());
    [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(x => x.textContent.trim() === 'Sair do servidor').click();
    await wait(() => document.querySelector('.tri-dmodal__title'), 'leave modal');
    log.leaveTitle = document.querySelector('.tri-dmodal__title').textContent;
    log.leaveSubtitle = document.querySelector('.tri-dmodal__subtitle')?.textContent;
    button(document.querySelector('.tri-modal-backdrop'), 'Sair do servidor').click();
    await wait(() => !server('Servidor Temporario'), 'left');
    log.left = true;
  })().catch(e => log.error = e.message);
  return 'servers Bob started';
})()"""
PROBE = "JSON.stringify(window.__e2e || {})"


def last(path):
    rows = [l[len("script: "):] for l in path.read_text(encoding="utf-8", errors="replace").splitlines() if l.startswith("script: ") and "{" in l]
    return json.loads(json.loads(rows[-1])) if rows else {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-servers-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-servers-"))
    backend, passed, processes, logs = None, False, [], []
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        alice_session, alice = account(config, google, "servers-alice", "Alice")
        bob_session, bob = account(config, google, "servers-bob", "Bob")
        alice["nick"], bob["nick"] = "Alice", "Bob"
        hub = config["hubUrl"]
        home = request(f"{hub}/servers", "POST", {"name": "Servidor de Alice"}, alice_session)
        request(f"{hub}/servers", "POST", {"name": "Segundo Servidor"}, alice_session)
        temp = request(f"{hub}/servers", "POST", {"name": "Servidor Temporario"}, alice_session)
        code = request(f"{hub}/servers/{temp['id']}/invites", "POST", {}, alice_session)["code"]
        request(f"{hub}/invites/{code}/accept", "POST", {}, bob_session)
        spare = request(f"{hub}/servers/{home['id']}/invites", "POST", {}, alice_session)["code"]   # pasted, never sent
        print("  ok: Alice owns three servers; Bob joined the temporary one", flush=True)
        (work / "alice.js").write_text(ALICE % {"code": spare}, encoding="utf-8")
        (work / "bob.js").write_text(BOB, encoding="utf-8")
        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        for name, token, acct, server, delay, probe_at, quit_at in [("alice", alice_session, alice, home["id"], 0, 52000, 60),
                                                                    ("bob", bob_session, bob, temp["id"], 2, 20000, 28)]:
            time.sleep(delay)
            log = (report / f"{name}.log").open("w", encoding="utf-8"); logs.append(log)
            processes.append(launch(args.exe, args.assets, config, profile(work, name, token, acct, server),
                                    work / f"{name}.js", 3000, work / "probe.js", probe_at, report / f"{name}.png", quit_at, log))
        for process in processes:
            process.wait(timeout=90)
        for log in logs:
            log.close()
        a, b = last(report / "alice.log"), last(report / "bob.log")
        print("  alice:", json.dumps(a, ensure_ascii=False), flush=True)
        print("  bob:  ", json.dumps(b, ensure_ascii=False), flush=True)

        def status(path, token):
            try:
                request(f"{hub}{path}", "GET", None, token); return 200
            except urllib.error.HTTPError as error:
                return error.code
        listed = request(f"{hub}/servers", "GET", None, alice_session)["servers"]
        hub_state = {"deleted": status(f"/servers/{temp['id']}", alice_session), "alice": sorted(s["name"] for s in listed),
                     "home member": status(f"/servers/{home['id']}", bob_session)}
        print("  hub:", hub_state, flush=True)
        v = a.get("viewing", {})
        checks = {
            "closing 'Criar seu servidor' / 'Entrar em um servidor' with the X creates and joins nothing":
                a.get("afterClose") == {"servers": a.get("afterClose", {}).get("before"), "before": a.get("afterClose", {}).get("before"), "selected": True},
            "viewing another server keeps the call (same channel, callServerId stays)": v.get("inCall") is True and v.get("callServer") is True,
            # A new server comes with the hub's default rooms (Geral, Jogos); Sala A belongs to the other server.
            "the sidebar lists the viewed server's channels": v.get("channels") == ["Geral", "Jogos"],
            "voice panel keeps the call's room and server": v.get("panel") == "Sala A / Servidor de Alice",
            "voice badge stays on the call's server": v.get("badgeOnHome") is True and v.get("badgeOnSecond") is False,
            "back on the call's server: its room, marked connected": a.get("back") == {"inCall": True, "connectedRow": True},
            "a room created in the viewed server moves the call there": a.get("moved") == {"callServer": True, "channels": ["Geral", "Jogos", "Sala B"]},
            "member menu: 'Sair do servidor', no 'Excluir servidor'": "Sair do servidor" in b.get("memberMenu", []) and "Excluir servidor" not in b.get("memberMenu", []),
            "leave modal with Discord's texts": b.get("leaveTitle") == 'Sair de "Servidor Temporario"'
                and b.get("leaveSubtitle") == "Deseja mesmo sair de Servidor Temporario? Você não poderá entrar neste servidor até ser convidado(a) novamente.",
            "Bob left the server": b.get("left") is True and not b.get("error"),
            "owner menu: 'Excluir servidor', no 'Sair do servidor'": "Excluir servidor" in a.get("ownerMenu", []) and "Sair do servidor" not in a.get("ownerMenu", []),
            "delete modal with Discord's texts": a.get("deleteTitle") == 'Excluir "Servidor Temporario"'
                and a.get("deleteSubtitle") == "Deseja mesmo excluir Servidor Temporario? Esta ação é irreversível.",
            "a wrong name is refused": a.get("wrongName") == {"error": "Você não digitou o nome do servidor corretamente", "stillThere": True},
            "the right name deletes it": a.get("deleted") is True and not a.get("error"),
            "hub: deleted server gone, the others kept": hub_state == {"deleted": 403, "alice": ["Segundo Servidor", "Servidor de Alice"], "home member": 403},
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
    print(f"WEB SERVERS E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
