"""Error reports reach the hub (20/10): the app sends a failed session's log by itself, the user can send one by hand,
and turning the reports off stops them.

  - run 1: the previous run's log is Diego's 19/10 failure (decoder + capture + "start failed"); the one-time notice
    shows, "Entendi" closes it for good, the automatic report arrives with those signals, and "Enviar log" sends the
    running session's log too;
  - run 2: same failed previous log, reports turned off in the settings: nothing is sent.
The local backend's admin API (ADMIN_KEY, cloudflare/src/error_reports.js) is what checks what arrived.

Usage (from desktop/): .toolchain/venv/Scripts/python.exe tests/e2e/run_web_error_reports_e2e.py --exe out/build-claude/triscord-web.exe
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers  # noqa: E402
from run_web_call_e2e import account, launch, profile  # noqa: E402
from run_web_e2e import request  # noqa: E402

SECRET = "f" * 64
FAILED_LOG = (
    "19:42:40.151 Triscord 0.9.37, 2026-10-19T19:42:40\n"
    f"19:42:41.467 signed in {SECRET} alice@example.com\n"
    "19:43:08.103 video: asked the sender for a keyframe: decoder: COM video initialization HRESULT=2147549446 x1\n"
    "19:43:18.116 video: asked the sender for a keyframe: decoder: COM video initialization HRESULT=2147549446 x38\n"
    "19:43:28.214 video: asked the sender for a keyframe: decoder: COM video initialization HRESULT=2147549446 x38\n"
    "19:50:09.414 capture: thumbnail 0 failed: Windows capture failed (0x80010106)\n"
    "19:53:19.124 warning: screen: start failed: Windows capture failed (0x80010106)\n")
RUN1 = r"""
const log = window.__e2e = window.__e2e || {}, s = () => window.__triscord.store.current, b = window.__triscord.bridge;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(test, label, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return; await sleep(80); } throw Error(label); }
(async () => {
  await wait(() => s().auth?.state === 'signedIn' && s().settings, 'signed in');
  log.available = !!s().settings.errorReportsAvailable; log.enabled = s().settings.errorReports !== false;
  await wait(() => document.querySelector('.tri-error-reports-notice'), 'notice shown');
  log.notice = true;
  [...document.querySelectorAll('.tri-dmodal button')].find(x => x.textContent.trim() === 'Entendi').click();
  await wait(() => s().settings.errorReportsNotice === false, 'notice marked seen');
  await wait(() => !document.querySelector('.tri-error-reports-notice'), 'notice closed');
  log.noticeSeen = true;
  await b.request({ name: 'sendErrorReport' });
  log.manual = 'ok';
})().catch(e => log.error = e.message);
'run 1 started'
"""
RUN2 = r"""
const log = window.__e2e = window.__e2e || {}, s = () => window.__triscord.store.current;
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  while (!(s().auth?.state === 'signedIn' && s().settings)) await sleep(80);
  log.enabled = s().settings.errorReports !== false; log.notice = !!document.querySelector('.tri-error-reports-notice');
})();
'run 2 started'
"""
PROBE = "JSON.stringify({ e2e: window.__e2e || {}, notice: !!window.__triscord.store.current.settings?.errorReportsNotice })"


def last_probe(text):
    for line in reversed([l[len("script: "):] for l in text.splitlines() if l.startswith("script: ")]):
        try:
            value = json.loads(json.loads(line))
            if isinstance(value, dict) and "e2e" in value:
                return value
        except (ValueError, TypeError):
            continue
    return {}


def admin(config, path):
    req = urllib.request.Request(config["hubUrl"] + path, headers={"Authorization": "Bearer " + config["adminKey"]})
    with urllib.request.urlopen(req, timeout=10) as response:
        return response.read().decode("utf-8")


def run(exe, assets, config, settings, logs, script, name, report, quit_after=14):
    for file, text in (("triscord.previous.log", FAILED_LOG), ("triscord.log", "10:00:00.000 Triscord 0.9.38, now\n10:00:01.000 ui -> core: requestSnapshot\n")):
        (logs / file).write_text(text, encoding="utf-8")
    os.environ.update(TRISCORD_REPORT_LOG_DIR=str(logs), TRISCORD_REPORT_DELAY_MS="1500")
    out = (report / f"{name}.log").open("w", encoding="utf-8")
    process = launch(exe, assets, config, settings, script, 2500, report / "probe.js", (quit_after - 2) * 1000,
                     report / f"{name}.png", quit_after, out)
    process.wait(timeout=60)
    out.close()
    return (report / f"{name}.log").read_text(encoding="utf-8", errors="replace")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-error-reports-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-error-reports-"))
    backend, passed = None, False
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        session, alice = account(config, google, "reports-alice", "Alice")
        alice["nick"] = "Alice"
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de Alice"}, session)
        settings = profile(work, "alice", session, alice, server["id"])
        logs = work / "logs"
        logs.mkdir()
        (work / "run1.js").write_text(RUN1, encoding="utf-8")
        (work / "run2.js").write_text(RUN2, encoding="utf-8")
        (report / "probe.js").write_text(PROBE, encoding="utf-8")

        text1 = run(args.exe, args.assets, config, settings, logs, work / "run1.js", "run1", report)
        probe1 = last_probe(text1)
        reports1 = json.loads(admin(config, "/admin/api/reports"))["reports"]
        auto = [r for r in reports1 if r["reason"] == "auto"]
        manual = [r for r in reports1 if r["reason"] == "manual"]
        auto_text = admin(config, f"/admin/api/reports/{auto[0]['id']}") if auto else ""
        print("  run 1 probe:", json.dumps(probe1, ensure_ascii=False), flush=True)
        print("  run 1 reports:", json.dumps(reports1, ensure_ascii=False), flush=True)
        print("  run 1 app lines:", [l for l in text1.splitlines() if l.startswith("reports:")], flush=True)

        ini = settings / "Triscord" / "TriscordNativePreview.ini"
        ini.write_text(ini.read_text(encoding="utf-8").replace("[General]", "[General]\nerrorReports=false", 1), encoding="utf-8")
        text2 = run(args.exe, args.assets, config, settings, logs, work / "run2.js", "run2", report, quit_after=10)
        probe2 = last_probe(text2)
        reports2 = json.loads(admin(config, "/admin/api/reports"))["reports"]
        print("  run 2 probe:", json.dumps(probe2, ensure_ascii=False), flush=True)

        e1 = probe1.get("e2e", {})
        checks = {
            "reports are available and on by default": e1.get("available") is True and e1.get("enabled") is True,
            "the one-time notice shows and 'Entendi' marks it seen": e1.get("notice") is True and e1.get("noticeSeen") is True and probe1.get("notice") is False,
            "the failed session's log arrives by itself, with its signals": len(auto) == 1
                and auto[0]["signals"] == ["screen-start", "decoder", "capture", "keyframe-storm"] and auto[0]["nick"] == "Alice",
            "the report holds the failure, not the token or the e-mail": "COM video initialization" in auto_text
                and SECRET not in auto_text and "alice@example.com" not in auto_text,
            "'Enviar log' sends the running session's log": e1.get("manual") == "ok" and len(manual) == 1,
            "the app logs what it sent": any(l.startswith("reports: automatic report sent") for l in text1.splitlines()),
            "turned off: nothing is sent and no notice shows": probe2.get("e2e", {}).get("enabled") is False
                and probe2.get("e2e", {}).get("notice") is False and len(reports2) == len(reports1),
            "no script errors": not e1.get("error"),
        }
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        if e1.get("error"):
            print("  run 1 error:", e1["error"], flush=True)
        passed = all(checks.values())
    except Exception as error:
        print("FAIL:", error, flush=True)
    finally:
        if backend:
            backend.close()
        shutil.rmtree(work, ignore_errors=True)
    print(f"WEB ERROR REPORTS E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
