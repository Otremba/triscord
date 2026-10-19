"""Share picker thumbnails must show the screens, not black (18/10: Tela 1 and Tela 2 were black on the user's PC).

One signed-in client on the local backend asks for the share sources (as "Compartilhar tela" does) and measures every
thumbnail it receives: its brightest pixel and how many distinct colours it has. A monitor thumbnail that is entirely
black fails. Captures stay in memory; only the numbers are printed. Run with TRISCORD_CAPTURE_BACKEND=gdi to check the
GDI fallback too.

Usage (from desktop/): .toolchain/venv/Scripts/python.exe tests/e2e/run_web_share_thumbnails_e2e.py --exe out/build-claude/triscord-web.exe
"""
import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers  # noqa: E402
from run_web_call_e2e import account, launch, profile  # noqa: E402
from run_web_e2e import request  # noqa: E402

SCRIPT = r"""(() => {
window.__shareAudio = %SHAREAUDIO%;
const log = window.__e2e = { thumbs: {} }, s = () => window.__triscord.store.current, b = window.__triscord.bridge;
const measure = url => new Promise(resolve => { const img = new Image(); img.onload = () => {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data; let max = 0; const colours = new Set();
  for (let i = 0; i < d.length; i += 4) { max = Math.max(max, d[i], d[i + 1], d[i + 2]); if (colours.size < 64) colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); }
  resolve({ w: img.width, h: img.height, max, colours: colours.size }); }; img.onerror = () => resolve({ error: true }); img.src = url; });
window.__triscord.store.onEvent(async e => { if (e.name === 'shareThumbnail') log.thumbs[e.index] = await measure(e.image); });
(async () => {
  const wait = (t, ms = 20000) => new Promise((ok, no) => { const st = Date.now(); const id = setInterval(() => { if (t()) { clearInterval(id); ok(); } else if (Date.now() - st > ms) { clearInterval(id); no(new Error('timeout')); } }, 100); });
  await wait(() => s().auth?.state === 'signedIn');
  // In a call, as the picker is used ("Compartilhar tela" is in the call controls).
  b.send({ name: 'createChannel', channelName: 'Miniaturas' });
  await wait(() => s().categories?.flatMap(c => c.channels).some(c => c.name === 'Miniaturas'));
  const ch = s().categories.flatMap(c => c.channels).find(c => c.name === 'Miniaturas');
  b.send({ name: 'selectChannel', channelId: ch.id });
  await wait(() => s().connectedChannelId === ch.id);
  await new Promise(r => setTimeout(r, 2000));
  // As a user who already shared once: share the first screen, stop, then open the picker again.
  if (new URLSearchParams(location.search).get('shareAudio') === '1' || window.__shareAudio) b.send({ name: 'setSetting', key: 'shareAudio', value: true });
  const first = await b.request({ name: 'listShareSources' });
  await new Promise(r => setTimeout(r, 2500));
  b.send({ name: 'startScreenShare', generation: first.generation, index: 0 });
  await wait(() => s().sharing || (s().streams || []).some(x => x.kind === 'screen'), 15000).catch(() => {});
  log.shared = !!(s().sharing || (s().streams || []).some(x => x.kind === 'screen'));
  await new Promise(r => setTimeout(r, 3000));
  b.send({ name: 'stopScreenShare' });
  await new Promise(r => setTimeout(r, 1500));
  for (const k of Object.keys(log.thumbs)) delete log.thumbs[k];
  const list = await b.request({ name: 'listShareSources' });
  log.sources = list.sources.map(x => ({ index: x.index, kind: x.kind }));
  await new Promise(r => setTimeout(r, 6000));
  // What the user sees: open the real picker (Compartilhar tela > Tela Inteira) several times and count the monitors
  // whose thumbnail is drawn. The race between the list reply and the first thumbnails left them black.
  log.picker = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    document.querySelector('button.tri-call-button[aria-label="Compartilhar tela"]').click();
    await wait(() => [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Tela Inteira'));
    [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Tela Inteira').click();
    await new Promise(r => setTimeout(r, 2500));
    const cards = [...document.querySelectorAll('.tri-share-source')].filter(c => /Tela \d/.test(c.textContent));
    const drawn = await Promise.all(cards.map(c => { const img = c.querySelector('.tri-share-source__thumb img'); return img ? measure(img.src) : { missing: true }; }));
    const t0 = performance.now();
    log.picker.push({ monitors: cards.length, drawn: drawn.filter(d => !d.missing && d.max > 40).length,
      cards: document.querySelectorAll('.tri-share-source').length, open: !!document.querySelector('.tri-share-picker, [aria-label*="Compartilhar"][role="dialog"]'),
      tab: [...document.querySelectorAll('button[aria-selected="true"], button.is-selected')].map(x => x.textContent.trim()).join('|'),
      placeholders: document.querySelectorAll('.tri-share-source__missing').length });
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(() => !document.querySelector('.tri-share-source'), 5000).catch(() => {});   // fully closed before reopening
    await new Promise(r => setTimeout(r, 400));
  }
  log.done = true;
})().catch(e => log.error = e.message);
return 'thumbnails started'; })()"""

PROBE = "JSON.stringify(window.__e2e || {})"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--real-devices", action="store_true", help="real microphone/speaker/camera, as a user's session")
    parser.add_argument("--share-audio", action="store_true", help="share the system audio too (\"Compartilhar áudio\")")
    args = parser.parse_args()
    report = DESKTOP / "out" / "web-share-thumbnails-e2e-report"
    shutil.rmtree(report, ignore_errors=True); report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-thumbs-"))
    backend, process, passed = None, None, False
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "thumbs-e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        token, acct = account(config, google, "thumbs-alice", "Alice"); acct["nick"] = "Alice"
        server = request(config["hubUrl"] + "/servers", "POST", {"name": "Miniaturas"}, token)
        (work / "script.js").write_text(SCRIPT.replace("%SHAREAUDIO%", "true" if args.share_audio else "false"), encoding="utf-8"); (work / "probe.js").write_text(PROBE, encoding="utf-8")
        log = (report / "client.log").open("w", encoding="utf-8")
        settings = profile(work, "alice", token, acct, server["id"])
        if args.real_devices:
            import os, subprocess
            from run_e2e import TOOLCHAIN
            env = dict(os.environ); env["PATH"] = os.pathsep.join([str(TOOLCHAIN / "Qt" / "6.8.3" / "mingw_64" / "bin"), str(TOOLCHAIN / "Qt" / "Tools" / "mingw1310_64" / "bin"), env["PATH"]])
            env.update(TRISCORD_SETTINGS_PATH=str(settings), TRISCORD_AUTH_SERVER=config["authUrl"], TRISCORD_HUB_SERVER=config["hubUrl"])
            env.pop("TRISCORD_AUDIO_MODE", None); env.pop("TRISCORD_VIDEO_SOURCE", None)
            process = subprocess.Popen([str(Path(args.exe).resolve()), "--assets", args.assets, "--devtools", "--quit-after", "80",
                                        "--script", str(work / "script.js"), "--script-after", "2500", "--probe", str(work / "probe.js"),
                                        "--probe-after", "75000"], env=env, stdout=log, stderr=subprocess.STDOUT)
        else:
            process = launch(args.exe, args.assets, config, settings, work / "script.js", 2500, work / "probe.js", 75000, report / "client.png", 80, log)
        process.wait(timeout=120); log.close()
        state = {}
        for line in (report / "client.log").read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("script: "):
                try: v = json.loads(line[8:]); v = json.loads(v) if isinstance(v, str) else v; state = v if isinstance(v, dict) else state
                except ValueError: pass
        capture_lines = [l for l in (report / "client.log").read_text(encoding="utf-8", errors="replace").splitlines() if l.startswith("capture:")]
        print("  shared first:", state.get("shared"), " picker:", state.get("picker"), flush=True)
        print("  sources:", state.get("sources"), "\n  thumbnails:", json.dumps(state.get("thumbs")), "\n  capture log:", capture_lines[:4], flush=True)
        monitors = [s["index"] for s in state.get("sources", []) if s["kind"] == "screen"]
        thumbs = state.get("thumbs", {})
        checks = {
            "every monitor got a thumbnail": bool(monitors) and all(str(i) in thumbs for i in monitors),
            "no monitor thumbnail is black": bool(monitors) and all(thumbs.get(str(i), {}).get("max", 0) > 40 and thumbs.get(str(i), {}).get("colours", 0) > 4 for i in monitors),
            "the picker shows every monitor's thumbnail, every time": bool(state.get("picker")) and all(x["monitors"] > 0 and x["drawn"] == x["monitors"] for x in state["picker"]),
            "no script error": state.get("done") is True and not state.get("error"),
        }
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        passed = all(checks.values())
    finally:
        if process and process.poll() is None: process.kill()
        if backend: backend.close()
        shutil.rmtree(work, ignore_errors=True)
    print(f"WEB SHARE THUMBNAILS E2E {'PASSED' if passed else 'FAILED'}; report in {report}", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
