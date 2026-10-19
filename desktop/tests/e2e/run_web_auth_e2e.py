"""End-to-end test of the new client's login and server modals, driven by clicks in the web UI.

Fresh, signed-out profile; local backend (real auth + hub Workers, fake Google). The page script clicks
"Entrar com Google"; this harness plays the browser (fake Google redirects to the client's loopback);
the real auth Worker verifies the RS256 id_token; then the script picks a nick, creates a server through
"Adicionar um servidor" > "Criar o meu" > "Criar", tries an invalid invite (error in the field), joins
Bob's server with a real invite through "Entrar em um servidor", goes back to its own server, opens the invite
modal (the code it shows is then redeemed by Bob on the hub, proving it is real), presses "Copiar" (the copy
goes to a file, never to the user's clipboard) and creates a channel through the "+" of "Canais de Voz".

Usage (from desktop/): .toolchain/venv/Scripts/python.exe tests/e2e/run_web_auth_e2e.py --exe out/build/triscord-web.exe
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, TOOLCHAIN, bundle_workers  # noqa: E402
from run_web_e2e import request  # noqa: E402
from run_web_call_e2e import account  # noqa: E402

SCRIPT = r"""
(() => {
  const log = window.__e2e = { steps: [] };
  const wait = (test, then, label, ms = 15000) => {
    const start = Date.now();
    const timer = setInterval(() => {
      let found; try { found = test(); } catch {}
      if (found) { clearInterval(timer); log.steps.push(label); then(found); }
      else if (Date.now() - start > ms) { clearInterval(timer); log.steps.push('TIMEOUT ' + label); }
    }, 200);
  };
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
  wait(() => button('Entrar com Google'), b => b.click(), 'clicked Entrar com Google');
  wait(() => document.querySelector('#tri-nick'), input => {
    log.suggested = input.value;
    type(input, 'Alice');
    input.form.requestSubmit();
  }, 'nick screen', 30000);
  wait(() => document.querySelector('.tri-rail__circle'), add => {
    add.click();
    wait(() => button('Criar o meu'), b => {
      b.click();
      wait(() => document.querySelector('#tri-server-name'), input => {
        log.prefilled = input.value;
        input.form.requestSubmit();
        wait(() => [...document.querySelectorAll('.tri-rail__button')].some(x => x.getAttribute('aria-label') === log.prefilled) && !document.querySelector('.tri-modal'), () => {
          document.querySelector('.tri-rail__circle').click();
          wait(() => button('Entrar em um servidor'), j => {
            j.click();
            wait(() => document.querySelector('#tri-invite'), invite => {
              type(invite, 'not an invite');
              invite.form.requestSubmit();
              wait(() => document.querySelector('.tri-modal__error'), e => {
                log.invalidError = e.textContent;
                type(invite, 'https://exemplo/convite/%INVITE%');
                invite.form.requestSubmit();
                wait(() => document.querySelector('.tri-server-header__name')?.textContent === 'Servidor do Bob' && !document.querySelector('.tri-modal'), () => {
                  log.joined = true;
                  [...document.querySelectorAll('.tri-rail__button')].find(x => x.getAttribute('aria-label') === log.prefilled).click();
                  wait(() => document.querySelector('.tri-server-header__name')?.textContent === log.prefilled && document.querySelector('[aria-label="Convidar pessoas"]'), () => {
                    document.querySelector('[aria-label="Convidar pessoas"]').click();
                    wait(() => document.querySelector('.tri-copy-input__input')?.value, code => {
                      log.inviteTitle = document.querySelector('.tri-dmodal__title')?.textContent;
                      log.inviteCode = code;
                      document.querySelector('.tri-copy-input__button').click();
                      wait(() => document.querySelector('.tri-copy-input__button')?.textContent === 'Copiado', () => {
                        log.copied = true;
                        dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
                        wait(() => !document.querySelector('.tri-dmodal') && document.querySelector('.tri-category__add'), add => {
                          add.click();
                          wait(() => document.querySelector('#tri-channel-name'), name => {
                            log.createSubtitle = document.querySelector('.tri-dmodal__subtitle')?.textContent;
                            log.createDisabledEmpty = button('Criar canal').disabled;
                            type(name, 'Sala do Modal');
                            name.form.requestSubmit();
                            wait(() => [...document.querySelectorAll('.tri-channel__name')].some(n => n.textContent === 'Sala do Modal') && !document.querySelector('.tri-dmodal'), () => {
                              log.channelCreated = true;
                            }, 'channel listed', 20000);
                          }, 'create channel modal');
                        }, 'invite modal closed');
                      }, 'invite copied');
                    }, 'invite code shown');
                  }, 'own server selected');
                }, 'joined Bob');
              }, 'invalid invite error');
            }, 'join page');
          }, 'modal reopened');
        }, 'server created');
      }, 'customize page');
    }, 'start page');
  }, 'signed in', 30000);
  return 'started';
})()
"""

PROBE = """JSON.stringify({
  ...(window.__e2e || {}),
  auth: window.__triscord.store.current.auth?.state,
  rail: [...document.querySelectorAll('.tri-rail__button')].map(b => b.getAttribute('aria-label')),
  header: document.querySelector('.tri-server-header__name')?.textContent,
  channels: [...document.querySelectorAll('.tri-channel__name')].map(n => n.textContent),
  account: document.querySelector('.tri-account__display')?.textContent,
  modalOpen: !!document.querySelector('.tri-modal'),
})"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-auth-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-auth-"))
    backend, passed, process = None, False, None
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        bob_session, _ = account(config, google, "auth-bob", "Bob")
        bob_server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor do Bob"}, bob_session)
        code = request(f"{config['hubUrl']}/servers/{bob_server['id']}/invites", "POST", {}, bob_session)["code"]
        print("  ok: Bob's server and a real invite on the local backend", flush=True)

        (work / "script.js").write_text(SCRIPT.replace("%INVITE%", code), encoding="utf-8")
        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        url_file = work / "oauth-url.txt"
        env = dict(os.environ)
        env["PATH"] = os.pathsep.join([str(TOOLCHAIN / "Qt" / "6.8.3" / "mingw_64" / "bin"), str(TOOLCHAIN / "Qt" / "Tools" / "mingw1310_64" / "bin"), env["PATH"]])
        env.update(TRISCORD_SETTINGS_PATH=str(work / "settings"), TRISCORD_AUTH_SERVER=config["authUrl"], TRISCORD_HUB_SERVER=config["hubUrl"],
                   TRISCORD_AUDIO_MODE="injected", TRISCORD_GOOGLE_AUTH_URL=config["googleAuthUrl"], TRISCORD_GOOGLE_TOKEN_URL=config["googleTokenUrl"],
                   TRISCORD_GOOGLE_CLIENT_SECRET="native-e2e-not-a-secret", TRISCORD_OPEN_URL_FILE=str(url_file),
                   TRISCORD_CLIPBOARD_FILE=str(work / "clipboard.txt"))
        log = (report / "client.log").open("w", encoding="utf-8")
        process = subprocess.Popen([str(Path(args.exe).resolve()), "--assets", args.assets, "--devtools", "--quit-after", "62",
                                    "--script", str(work / "script.js"), "--script-after", "1500",
                                    "--probe", str(work / "probe.js"), "--probe-after", "56000",
                                    "--capture", str(report / "after.png"), "--capture-after", "56000"], env=env, stdout=log, stderr=subprocess.STDOUT)
        # Play the browser: wait for the authorization URL, then follow fake Google to the client's loopback.
        deadline = time.monotonic() + 20
        while not (url_file.exists() and url_file.read_text(encoding="utf-8")) and time.monotonic() < deadline:
            time.sleep(0.2)
        if url_file.exists():
            with urllib.request.urlopen(url_file.read_text(encoding="utf-8") + "&e2e_user=web-auth-alice", timeout=15) as response:
                print("  loopback page:", "Login concluído" in response.read().decode("utf-8"), flush=True)
        process.wait(timeout=90)
        log.close()
        lines = [l[len("script: "):] for l in (report / "client.log").read_text(encoding="utf-8", errors="replace").splitlines() if l.startswith("script: ")]
        state = json.loads(json.loads(lines[-1])) if lines else {}
        print("  ui:", json.dumps(state, ensure_ascii=False), flush=True)
        copied = (work / "clipboard.txt").read_text(encoding="utf-8") if (work / "clipboard.txt").exists() else None
        redeemed = None
        if state.get("inviteCode"):
            try:
                redeemed = request(f"{config['hubUrl']}/invites/{state['inviteCode']}/accept", "POST", {}, bob_session).get("serverId")
            except Exception as error:
                print("  invite accept failed:", error, flush=True)
        bob_servers = [s["name"] for s in request(f"{config['hubUrl']}/servers", "GET", None, bob_session).get("servers", [])] if redeemed else []
        checks = {
            "login screen -> Google flow -> nick screen": "nick screen" in state.get("steps", []),
            "signed in after choosing the nick": state.get("auth") == "signedIn" and state.get("account") == "Alice",
            "server name prefilled 'Servidor de Alice'": state.get("prefilled") == "Servidor de Alice",
            "created server listed in the rail": "Servidor de Alice" in (state.get("rail") or []),
            "invalid invite shows Discord's message in the field": state.get("invalidError") == "Insira um link de convite ou um código de convite válido.",
            "joined Bob's server with the invite (opened, modal closed)": state.get("joined") is True,
            "invite modal titled 'Convidar amigos para Servidor de Alice'": state.get("inviteTitle") == "Convidar amigos para Servidor de Alice",
            "copied the code shown (to the test file, not the clipboard)": state.get("copied") is True and copied == state.get("inviteCode"),
            "the code shown is a real invite: Bob redeems it into Alice's server": "Servidor de Alice" in bob_servers,
            "create-channel modal: 'em Canais de Voz', 'Criar canal' disabled while empty": state.get("createSubtitle") == "em Canais de Voz" and state.get("createDisabledEmpty") is True,
            "channel created through the modal is listed": state.get("channelCreated") is True and "Sala do Modal" in (state.get("channels") or []),
        }
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        passed = all(checks.values())
    except Exception as error:
        print("FAIL:", error, flush=True)
    finally:
        if process and process.poll() is None:
            process.kill()
        if backend:
            backend.close()
        shutil.rmtree(work, ignore_errors=True)
    print(f"WEB AUTH E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
