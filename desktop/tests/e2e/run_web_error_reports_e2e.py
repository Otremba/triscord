"""Error reports reach the hub (20/10): the app sends its log by itself on an interval, each line once, the user can
send one by hand, and turning the reports off stops them.

  - run 1: the previous run's log is Diego's 19/10 failure (decoder + capture + "start failed") and the running log
    has a dropped-connection loop; both arrive by themselves, with their signals; lines added to the running log later
    arrive in the next report (every 2 s here, 30 minutes outside tests) with the log's first lines and nothing sent
    before; nothing new means no report; "Enviar log" sends the whole running log;
  - run 2: the previous log is run 1's running log, all sent already: only the new running log goes out;
  - run 3: reports turned off in the settings: nothing is sent.
The local backend's admin API (ADMIN_KEY, cloudflare/src/error_reports.js) is what checks what arrived.

Usage (from desktop/): .toolchain/venv/Scripts/python.exe tests/e2e/run_web_error_reports_e2e.py --exe out/build-claude/triscord-web.exe
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import time
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
    + "".join(f"10:00:{n:02}.000 ui -> core: requestSnapshot\n" for n in range(2, 12))   # past the 12 first lines
    + "10:05:00.000 signaling: heartbeat timeout\n10:06:00.000 signaling: heartbeat timeout\n10:07:00.000 signaling: heartbeat timeout\n")
APPENDED = "10:10:00.000 ui -> core: selectChannel\n10:10:01.000 ice: voice connected via relay/relay\n"
HEALTHY_LOG = "11:00:00.000 Triscord 0.9.38, 2026-10-20T11:00:00\n11:00:01.000 signed in\n"
RUN1 = r"""
const log = window.__e2e = window.__e2e || {}, s = () => window.__triscord.store.current, b = window.__triscord.bridge;
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  while (!(s().auth?.state === 'signedIn' && s().settings)) await sleep(80);
  log.available = !!s().settings.errorReportsAvailable; log.enabled = s().settings.errorReports !== false;
  await sleep(8000);   // the automatic sends run first
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


def run(exe, assets, config, settings, logs, previous, running, script, name, report, quit_after, during=None):
    (logs / "triscord.previous.log").write_text(previous, encoding="utf-8")
    (logs / "triscord.log").write_text(running, encoding="utf-8")
    os.environ.update(TRISCORD_REPORT_LOG_DIR=str(logs), TRISCORD_REPORT_DELAY_MS="1500", TRISCORD_REPORT_INTERVAL_MS="2000")
    out = (report / f"{name}.log").open("w", encoding="utf-8")
    process = launch(exe, assets, config, settings, script, 2500, report / "probe.js", (quit_after - 2) * 1000,
                     report / f"{name}.png", quit_after, out)
    if during:
        time.sleep(7)
        during()
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

        def append():
            with (logs / "triscord.log").open("a", encoding="utf-8") as log:
                log.write(APPENDED)

        text1, lines1 = run(args.exe, args.assets, config, settings, logs, FAILED_LOG, RUNNING_LOG, work / "run1.js", "run1", report, 16, append)
        probe1 = last_probe(text1).get("e2e", {})
        reports = json.loads(admin(config, "/admin/api/reports"))["reports"]
        periodic = sorted((r for r in reports if r["reason"] == "periodic"), key=lambda r: r["createdAt"])
        manual = [r for r in reports if r["reason"] == "manual"]
        previous_text = admin(config, f"/admin/api/reports/{periodic[0]['id']}") if periodic else ""
        later_text = admin(config, f"/admin/api/reports/{periodic[2]['id']}") if len(periodic) > 2 else ""
        print("  run 1 probe:", json.dumps(probe1, ensure_ascii=False), flush=True)
        print("  run 1 reports:", json.dumps([[r["reason"], r["signals"]] for r in reports]), flush=True)
        print("  run 1 later report:", repr(later_text), flush=True)

        _, lines2 = run(args.exe, args.assets, config, settings, logs, RUNNING_LOG + APPENDED, HEALTHY_LOG, work / "idle.js", "run2", report, 9)
        middle = json.loads(admin(config, "/admin/api/reports"))["reports"]

        ini = settings / "Triscord" / "TriscordNativePreview.ini"
        ini.write_text(ini.read_text(encoding="utf-8").replace("[General]", "[General]\nerrorReports=false", 1), encoding="utf-8")
        _, lines3 = run(args.exe, args.assets, config, settings, logs, FAILED_LOG.replace("19:42:40.151", "19:42:40.152"),
                        RUNNING_LOG.replace("10:00:00.000", "10:00:00.001"), work / "idle.js", "run3", report, 9)
        after = json.loads(admin(config, "/admin/api/reports"))["reports"]

        checks = {
            "reports are available and on by default": probe1.get("available") is True and probe1.get("enabled") is True,
            "no notice is shown": probe1.get("notice") is False,
            "the previous session's log arrives by itself, with its signals": len(periodic) >= 1
                and periodic[0]["signals"] == ["screen-start", "decoder", "capture", "keyframe-storm"] and periodic[0]["nick"] == "Alice",
            "the running log arrives by itself, with its signals": len(periodic) >= 2 and periodic[1]["signals"] == ["signaling"],
            "later lines arrive in the next report, with the first lines and nothing sent before": len(periodic) == 3
                and periodic[2]["signals"] == ["none"] and later_text.startswith("10:00:00.000 Triscord 0.9.38") and "[…]" in later_text
                and "relay/relay" in later_text and "heartbeat timeout" not in later_text,
            "nothing new, no report (checked every 2 s)": sum(l.startswith("reports: periodic") for l in lines1) == 3,
            "the report holds the failure, not the token or the e-mail": "COM video initialization" in previous_text
                and SECRET not in previous_text and "alice@example.com" not in previous_text,
            "'Enviar log' sends the running session's log": probe1.get("manual") == "ok" and len(manual) == 1,
            "next start: only the new log goes out, the previous one was all sent": lines2 == ["reports: periodic report sent (none)"],
            "turned off: nothing is sent": not lines3 and len(after) == len(middle),
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
