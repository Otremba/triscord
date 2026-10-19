"""End-to-end test of the new client's user settings, driven by clicks in the web UI (local backend only).

Alice is signed in (auth Worker, fake Google). Through the UI she opens "Configurações de usuário" (gear of the
account panel) and:
  1. on "Voz e vídeo": sees "Alta qualidade" (DeepFilterNet) chosen by default, picks "Padrão" (RNNoise), turns
     "Supressão de ruído" off (the choice of suppressor hides) and moves "Volume do Alto-falante" and "Volume dos efeitos
     sonoros" (the core stores them);
  2. on "Aparência": picks "Claro"; the page switches to the light tokens;
  3. on "Conta": "Editar" the user name to "Alice Nova" (auth Worker /nick) and sees it in the account panel;
  4. "Sair" -> confirmation -> "Sair": back to the login screen.
A second launch with the same settings file checks that the choices persisted (QSettings).

Usage (from desktop/): ../.toolchain/venv/Scripts/python.exe tests/e2e/run_web_settings_e2e.py --exe out/build/triscord-web.exe
"""
import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers  # noqa: E402
from run_web_e2e import request  # noqa: E402
from run_web_call_e2e import account, launch, profile  # noqa: E402

SCRIPT = r"""(() => {
  const log = window.__e2e = { steps: [] };
  const wait = (test, then, label, ms = 15000) => {
    const start = Date.now();
    const timer = setInterval(() => {
      let found; try { found = test(); } catch {}
      if (found) { clearInterval(timer); log.steps.push(label); then(found); }
      else if (Date.now() - start > ms) { clearInterval(timer); log.steps.push('TIMEOUT ' + label); }
    }, 200);
  };
  const s = () => window.__triscord.store.current.settings;
  const nav = label => [...document.querySelectorAll('.tri-settings__item')].find(b => b.textContent.trim() === label);
  wait(() => document.querySelector('[aria-label="Configurações de usuário"]'), gear => {
    gear.click();
    wait(() => document.querySelector('.tri-settings [role="switch"]') && document.querySelector('input[name="noiseSuppressionMode"]'), () => {
      const sw = document.querySelector('.tri-settings [role="switch"]');
      log.titles = document.querySelector('.tri-settings__title').textContent;
      const modes = () => [...document.querySelectorAll('input[name="noiseSuppressionMode"]')];
      log.modes = modes().map(i => ({ value: i.value, checked: i.checked, disabled: i.disabled, title: i.closest('label').querySelector('.tri-radio__title').textContent }));
      log.modeBefore = s().noiseSuppressionMode;
      log.strengthBefore = s().noiseSuppressionStrength;
      Promise.all([-1, 101, 12.5, '50', true].map(async value => {
        try { await window.__triscord.bridge.request({name: 'setSetting', key: 'noiseSuppressionStrength', value}); return false; }
        catch { return true; }
      })).then(results => { log.invalidStrengthRejected = results.every(Boolean); });
      const strength = () => document.querySelector('.tri-slider[aria-label="Intensidade da supressão de ruído"]');
      strength().value = '35'; strength().dispatchEvent(new Event('input', { bubbles: true }));
      wait(() => s().noiseSuppressionStrength === 35, () => {
      log.strengthHigh = s().noiseSuppressionStrength;
      modes().find(i => i.value === 'standard').click();
      wait(() => s().noiseSuppressionMode === 'standard' && modes().find(i => i.value === 'standard').checked, () => {
      strength().value = '65'; strength().dispatchEvent(new Event('input', { bubbles: true }));
      wait(() => s().noiseSuppressionStrength === 65, () => {
      sw.click();
      document.querySelector('[role="switch"][aria-label="Sons da chamada"]').click();
      const slider = document.querySelector('.tri-slider[aria-label="Volume do Alto-falante"]');
      slider.value = '150'; slider.dispatchEvent(new Event('input', { bubbles: true }));
      const sfx = document.querySelector('.tri-slider[aria-label="Volume dos efeitos sonoros"]');
      sfx.value = '40'; sfx.dispatchEvent(new Event('input', { bubbles: true }));
      wait(() => s().noiseSuppression === false && s().outputVolume === 150 && s().soundboardVolume === 40 && s().callSounds === false, () => {
        nav('Aparência').click();
        wait(() => document.querySelector('.tri-theme[aria-label="Claro"]'), claro => {
          claro.click();
          wait(() => document.documentElement.dataset.theme === 'light', () => {
            log.light = getComputedStyle(document.querySelector('.tri-settings')).backgroundColor;
            nav('Conta').click();
            wait(() => [...document.querySelectorAll('.tri-settings button')].find(b => b.textContent === 'Editar'), edit => {
              edit.click();
              wait(() => document.querySelector('#tri-settings-nick'), input => {
                input.value = 'Alice Nova';
                input.form.requestSubmit();
                wait(() => document.querySelector('.tri-account__display')?.textContent === 'Alice Nova' && !document.querySelector('#tri-settings-nick'), () => {
                  nav('Sair').click();
                  wait(() => [...document.querySelectorAll('.tri-dmodal button')].find(b => b.textContent === 'Sair'), out => {
                    log.signOutSubtitle = document.querySelector('.tri-dmodal .tri-dmodal__subtitle')?.textContent;
                    out.click();
                    wait(() => document.querySelector('.tri-login'), () => { log.signedOut = true; }, 'login screen');
                  }, 'sign-out modal');
                }, 'name changed');
              }, 'name modal');
            }, 'account page');
          }, 'light theme');
        }, 'appearance page');
      }, 'voice settings stored');
      wait(() => !document.querySelector('input[name="noiseSuppressionMode"]') && !strength(), () => { log.modesHiddenWhenOff = true; }, 'suppressor choice hidden when off');
      }, 'standard strength stored');
      }, 'standard suppressor stored');
      }, 'high quality strength stored');
    }, 'settings open');
  }, 'app ready', 30000);
  return 'started';
})()"""
PROBE = """JSON.stringify({ ...(window.__e2e || {}), auth: window.__triscord.store.current.auth?.state,
  theme: document.documentElement.dataset.theme, settings: window.__triscord.store.current.settings })"""
RELAUNCH_PROBE = """JSON.stringify({ settings: window.__triscord.store.current.settings, theme: document.documentElement.dataset.theme })"""


def last_probe(path):
    lines = [line[len("script: "):] for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.startswith("script: ")]
    return json.loads(json.loads(lines[-1])) if lines else {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-settings-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-web-settings-"))
    backend, passed = None, False
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        session, alice = account(config, google, "settings-alice", "Alice")
        alice["nick"] = "Alice"
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de Alice"}, session)
        settings = profile(work, "alice", session, alice, server["id"])
        (work / "script.js").write_text(SCRIPT, encoding="utf-8")
        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        with (report / "first.log").open("w", encoding="utf-8") as log:
            launch(args.exe, args.assets, config, settings, work / "script.js", 2500, work / "probe.js", 16000, report / "first.png", 20, log).wait(timeout=60)
        first = last_probe(report / "first.log")
        print("  first: ", json.dumps(first, ensure_ascii=False), flush=True)
        # Relaunch with the same settings (signed out now): the stored choices come back from QSettings.
        (work / "probe2.js").write_text(RELAUNCH_PROBE, encoding="utf-8")
        (work / "noop.js").write_text("'noop'", encoding="utf-8")
        with (report / "second.log").open("w", encoding="utf-8") as log:
            launch(args.exe, args.assets, config, settings, work / "noop.js", 1000, work / "probe2.js", 4000, report / "second.png", 7, log).wait(timeout=30)
        second = last_probe(report / "second.log")
        print("  second:", json.dumps(second, ensure_ascii=False), flush=True)
        s1, s2 = first.get("settings") or {}, second.get("settings") or {}
        checks = {
            "core rejects out of range, fractional and nonnumeric strengths": first.get("invalidStrengthRejected") is True,
            "suppression strength adjustable in both modes, saved across restart":
                first.get("strengthBefore") == 100 and first.get("strengthHigh") == 35
                and s1.get("noiseSuppressionStrength") == 65 and s2.get("noiseSuppressionStrength") == 65,
            "call sound switch stored and kept off": s1.get("callSounds") is False and s2.get("callSounds") is False,
            "settings open on 'Voz e vídeo'": first.get("titles") == "Voz e vídeo",
            "noise suppression off and speaker volume 150 stored by the core": s1.get("noiseSuppression") is False and s1.get("outputVolume") == 150,
            "'Claro' switches the page to the light tokens": first.get("theme") == "light" and str(first.get("light", "")).startswith("oklab(0.988"),   # --background-base-low of light (#fbfbfb)
            "user name changed through Conta > Editar": "name changed" in (first.get("steps") or []),
            "'Sair' asks first and signs out": first.get("signOutSubtitle") == "Você tem certeza de que deseja sair?" and first.get("signedOut") is True and first.get("auth") == "signedOut",
            "choices persist after a restart": s2.get("noiseSuppression") is False and s2.get("outputVolume") == 150 and s2.get("theme") == "light" and second.get("theme") == "light",
            "'Volume dos efeitos sonoros' stored and kept (40)": s1.get("soundboardVolume") == 40 and s2.get("soundboardVolume") == 40,
            "'Alta qualidade' (DeepFilterNet) is the default and available":
                first.get("modeBefore") == "high" and [m.get("title") for m in first.get("modes") or []] == ["Alta qualidade", "Padrão"]
                and (first.get("modes") or [{}])[0].get("checked") is True and (first.get("modes") or [{}])[0].get("disabled") is False,
            "'Padrão' stored by the core, kept after a restart, choice hidden when suppression is off":
                s1.get("noiseSuppressionMode") == "standard" and s2.get("noiseSuppressionMode") == "standard" and first.get("modesHiddenWhenOff") is True,
        }
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        passed = all(checks.values())
    except Exception as error:
        print("FAIL:", error, flush=True)
    finally:
        if backend:
            backend.close()
        shutil.rmtree(work, ignore_errors=True)
    print(f"WEB SETTINGS E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
