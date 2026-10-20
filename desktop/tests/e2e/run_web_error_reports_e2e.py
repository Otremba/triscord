"""Error reports reach the hub (20/10): the app sends logs with signs of a bug by itself, each problem once, the user
can send one by hand, and turning the reports off stops them.

  - run 1: the previous run's log is Diego's 19/10 failure (decoder + capture + "start failed") and the running log
    has a dropped-connection loop; both arrive by themselves, the running one only once although it is checked every
    2 s (30 minutes outside tests), and "Enviar log" sends the running log too;
  - run 2: the previous log is run 1's running log, already reported: nothing new goes out;
  - run 3: a new failure, reports turned off in the settings: nothing is sent.
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
RUNNING_LOG = (
    "10:00:00.000 Triscord 0.9.38, 2026-10-20T10:00:00\n"
    "10:00:01.000 signed in\n"
    "10:05:00.000 signaling: heartbeat timeout\n10:06:00.000 signaling: heartbeat timeout\n10:07:00.000 signaling: heartbeat timeout\n")
HEALTHY_LOG = "11:00:00.000 Triscord 0.9.38, 2026-10-20T11:00:00\n11:00:01.000 signed in\n"
RUN1 = r"""
const log = window.__e2e = window.__e2e || {}, s = () => window.__triscord.store.current, b = window.__triscord.bridge;
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  while (!(s().auth?.state === 'signedIn' && s().settings)) await sleep(80);
  log.available = !!s().settings.errorReportsAvailable; log.enabled = s().settings.errorReports !== false;
  await sleep(6000);   // the automatic checks run first
  log.notice = !!document.querySelector('.tri-dmodal');
  await b.request({ name: 'sendErrorReport' });
  log.manual = 'ok';
})().catch(e => log.error = e.message);
'run 1 started'
"""
PROBE = "JSON.stringify({ e2e: window.__e2e || {} })"


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


def run(exe, assets, config, settings, logs, previous, running, script, name, report, quit_after):
    (logs / "triscord.previous.log").write_text(previous, encoding="utf-8")
    (logs / "triscord.log").write_text(running, encoding="utf-8")
    os.environ.update(TRISCORD_REPORT_LOG_DIR=str(logs), TRISCORD_REPORT_DELAY_MS="1500", TRISCORD_REPORT_INTERVAL_MS="2000")
    out = (report / f"{name}.log").open("w", encoding="utf-8")
    process = launch(exe, assets, config, settings, script, 2500, report / "probe.js", (quit_after - 2) * 1000,
                     report / f"{name}.png", quit_after, out)
    process.wait(timeout=60)
    out.close()
    text = (report / f"{name}.log").read_text(encoding="utf-8", errors="replace")
    lines = [l for l in text.splitlines() if l.startswith("reports:")]
    print(f"  {name} app lines:", lines, flush=True)
    return text, lines


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
        (work / "idle.js").write_text("'idle'", encoding="utf-8")
        (report / "probe.js").write_text(PROBE, encoding="utf-8")

        text1, lines1 = run(args.exe, args.assets, config, settings, logs, FAILED_LOG, RUNNING_LOG, work / "run1.js", "run1", report, 14)
        probe1 = last_probe(text1).get("e2e", {})
        reports = json.loads(admin(config, "/admin/api/reports"))["reports"]
        auto = sorted((r for r in reports if r["reason"] == "auto"), key=lambda r: r["createdAt"])
        manual = [r for r in reports if r["reason"] == "manual"]
        previous_text = admin(config, f"/admin/api/reports/{auto[0]['id']}") if auto else ""
        print("  run 1 probe:", json.dumps(probe1, ensure_ascii=False), flush=True)
        print("  run 1 reports:", json.dumps([[r["reason"], r["signals"]] for r in reports]), flush=True)

        _, lines2 = run(args.exe, args.assets, config, settings, logs, RUNNING_LOG, HEALTHY_LOG, work / "idle.js", "run2", report, 9)

        ini = settings / "Triscord" / "TriscordNativePreview.ini"
        ini.write_text(ini.read_text(encoding="utf-8").replace("[General]", "[General]\nerrorReports=false", 1), encoding="utf-8")
        _, lines3 = run(args.exe, args.assets, config, settings, logs, FAILED_LOG.replace("19:42:40.151", "19:42:40.152"),
                        RUNNING_LOG.replace("10:00:00.000", "10:00:00.001"), work / "idle.js", "run3", report, 9)
        after = json.loads(admin(config, "/admin/api/reports"))["reports"]

        checks = {
            "reports are available and on by default": probe1.get("available") is True and probe1.get("enabled") is True,
            "no notice is shown": probe1.get("notice") is False,
            "the previous session's failure arrives by itself, with its signals": len(auto) >= 1
                and auto[0]["signals"] == ["screen-start", "decoder", "capture", "keyframe-storm"] and auto[0]["nick"] == "Alice",
            "the running log's problem arrives once, though checked every 2 s": len(auto) == 2 and auto[1]["signals"] == ["signaling"]
                and sum(l.startswith("reports: automatic") for l in lines1) == 2,
            "the report holds the failure, not the token or the e-mail": "COM video initialization" in previous_text
                and SECRET not in previous_text and "alice@example.com" not in previous_text,
            "'Enviar log' sends the running session's log": probe1.get("manual") == "ok" and len(manual) == 1,
            "a problem already reported is not sent again at the next start": not lines2,
            "turned off: nothing is sent": not lines3 and len(after) == len(reports),
            "no script errors": not probe1.get("error"),
        }
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        if probe1.get("error"):
            print("  run 1 error:", probe1["error"], flush=True)
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
