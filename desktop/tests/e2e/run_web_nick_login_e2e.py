"""End-to-end test of signing in with only a nick (no Google account), driven by the web UI.

Fresh, signed-out profile; local backend (real auth + hub Workers). The page script types a new nick with no
password and presses "Entrar" (the account is created), opens Configurações > Conta > "Criar senha" and sets one,
signs out, then signs in again on the login screen: Bob's nick (a Google account without a password) is refused as
taken, the account's own nick without/with a wrong password shows the right errors, and nick + password signs in to
the same account. The hub sees the nick account like any other (it creates a server).

Usage (from desktop/): .toolchain/venv/Scripts/python.exe tests/e2e/run_web_nick_login_e2e.py --exe out/build-claude/triscord-web.exe
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, TOOLCHAIN, bundle_workers  # noqa: E402
from run_web_call_e2e import account  # noqa: E402

SCRIPT = r"""
(async () => {
  const log = window.__e2e = { steps: [] };
  const until = (test, label, ms = 15000) => new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      let found; try { found = test(); } catch {}
      if (found) { clearInterval(timer); log.steps.push(label); resolve(found); }
      else if (Date.now() - start > ms) { clearInterval(timer); log.steps.push('TIMEOUT ' + label); reject(new Error(label)); }
    }, 150);
  });
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
  const error = () => document.querySelector('.tri-login__error')?.textContent;
  const login = async (nick, password) => {
    const field = await until(() => document.querySelector('#tri-login-nick:not([disabled])'), 'login form ' + nick);
    type(field, nick); type(document.querySelector('#tri-login-password'), password);
    const before = error();
    field.form.requestSubmit();
    return until(() => window.__triscord.store.current.auth?.state === 'signedIn' ? 'signedIn' : (error() && error() !== before ? error() : null), 'answer ' + nick);
  };
  try {
    log.screen = { google: !!button('Entrar com Google'), hint: document.querySelector('.tri-login__hint')?.textContent };
    log.created = await login('Carol', '');
    await until(() => document.querySelector('.tri-account__display')?.textContent === 'Carol', 'signed in as Carol');
    dispatchEvent(new Event('tri-open-settings'));
    (await until(() => [...document.querySelectorAll('.tri-settings__item')].find(b => b.textContent.includes('Conta')), 'settings')).click();
    const create = await until(() => [...document.querySelectorAll('.tri-settings__row-button')].find(b => b.textContent === 'Criar senha'), 'Criar senha shown', 20000);
    create.click();
    const fresh = await until(() => document.querySelector('#tri-password-new'), 'password modal');
    log.hasCurrentField = !!document.querySelector('#tri-password-current');
    type(fresh, 'senha123'); type(document.querySelector('#tri-password-confirm'), 'senha124');
    fresh.form.requestSubmit();
    log.mismatch = (await until(() => document.querySelector('.tri-dmodal__error'), 'mismatch error')).textContent;
    type(document.querySelector('#tri-password-confirm'), 'senha123');
    fresh.form.requestSubmit();
    await until(() => !document.querySelector('#tri-password-new') && [...document.querySelectorAll('.tri-settings__row-button')].some(b => b.textContent === 'Alterar senha'), 'password saved', 20000);
    log.profileHasPassword = window.__triscord.store.current.profile?.hasPassword;
    (await until(() => document.querySelector('.tri-settings__item.is-danger'), 'Sair item')).click();
    (await until(() => [...document.querySelectorAll('.tri-dmodal button')].find(b => b.textContent.trim() === 'Sair'), 'Sair confirm')).click();
    await until(() => window.__triscord.store.current.auth?.state === 'signedOut', 'signed out');
    log.bobTaken = await login('bob', '');
    log.noPassword = await login('carol', '');
    log.wrongPassword = await login('CAROL', 'errada1');
    log.shortPassword = await login('Carol', '123');
    log.again = await login('carol', 'senha123');
    await until(() => document.querySelector('.tri-account__display')?.textContent === 'Carol', 'signed in again as Carol');
    log.done = true;
  } catch (e) { log.failure = String(e && e.message || e); }
})();
'started'
"""

PROBE = """JSON.stringify({
  ...(window.__e2e || {}),
  auth: window.__triscord.store.current.auth?.state,
  account: document.querySelector('.tri-account__display')?.textContent,
  accountId: window.__triscord.store.current.account?.id,
})"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-nick-login-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-nick-"))
    backend, passed, process = None, False, None
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        account(config, google, "nick-bob", "Bob")   # a Google account named Bob, without a password
        (work / "script.js").write_text(SCRIPT, encoding="utf-8")
        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        env = dict(os.environ)
        env["PATH"] = os.pathsep.join([str(TOOLCHAIN / "Qt" / "6.8.3" / "mingw_64" / "bin"), str(TOOLCHAIN / "Qt" / "Tools" / "mingw1310_64" / "bin"), env["PATH"]])
        env.update(TRISCORD_SETTINGS_PATH=str(work / "settings"), TRISCORD_AUTH_SERVER=config["authUrl"], TRISCORD_HUB_SERVER=config["hubUrl"],
                   TRISCORD_AUDIO_MODE="injected", TRISCORD_SKIP_UPDATE="1")
        env.pop("TRISCORD_GOOGLE_CLIENT_SECRET", None)
        log = (report / "client.log").open("w", encoding="utf-8")
        process = subprocess.Popen([str(Path(args.exe).resolve()), "--assets", args.assets, "--devtools", "--quit-after", "50",
                                    "--script", str(work / "script.js"), "--script-after", "1500",
                                    "--probe", str(work / "probe.js"), "--probe-after", "44000",
                                    "--capture", str(report / "after.png"), "--capture-after", "44000"], env=env, stdout=log, stderr=subprocess.STDOUT)
        process.wait(timeout=90)
        log.close()
        lines = [l[len("script: "):] for l in (report / "client.log").read_text(encoding="utf-8", errors="replace").splitlines() if l.startswith("script: ")]
        state = json.loads(json.loads(lines[-1])) if lines else {}
        print("  ui:", json.dumps(state, ensure_ascii=False), flush=True)
        checks = {
            "login screen offers nick + password and Google": (state.get("screen") or {}).get("google") is True and "opcional" in ((state.get("screen") or {}).get("hint") or ""),
            "a new nick with no password signs in (account created)": state.get("created") == "signedIn",
            "nick account id from the auth Worker": str(state.get("accountId", "")).startswith("n_"),
            "no current-password field before a password exists": state.get("hasCurrentField") is False,
            "mismatched confirmation refused": state.get("mismatch") == "As senhas não coincidem.",
            "password saved (Minha conta shows 'Alterar senha')": state.get("profileHasPassword") is True,
            "Google account's nick without password is taken": state.get("bobTaken") == "Esse nome já está em uso. Escolha outro.",
            "own nick without password asks for it": state.get("noPassword") == "Essa conta tem senha. Digite a senha para entrar.",
            "wrong password refused": state.get("wrongPassword") == "Nome de usuário ou senha incorretos.",
            "short password refused before sending": state.get("shortPassword") == "A senha precisa ter pelo menos 6 caracteres.",
            "nick + password signs in again (case-insensitive)": state.get("again") == "signedIn" and state.get("done") is True,
            "same account after signing in again": state.get("account") == "Carol" and state.get("auth") == "signedIn",
            "no failure in the page script": not state.get("failure"),
            "login capture saved": (report / "after.png").is_file(),
        }
        for name, ok in checks.items():
            print(("PASS: " if ok else "FAIL: ") + name, flush=True)
        passed = all(checks.values())
        (report / "result.json").write_text(json.dumps({"passed": passed, "checks": checks, "state": state}, indent=2, ensure_ascii=False), encoding="utf-8")
        print("WEB NICK LOGIN E2E " + ("PASSED" if passed else "FAILED") + f"; report in {report}", flush=True)
        return 0 if passed else 1
    finally:
        if process and process.poll() is None:
            process.kill()
        if backend:
            backend.close()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
