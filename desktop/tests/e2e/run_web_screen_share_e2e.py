"""Screen share reaches a viewer: two local clients, local backend, the sharer's real screen at 1080p60 (19/10).

On 19/10 a viewer of a 0.9.36 share stayed on "Conectando à transmissão…": every packet arrived, yet the viewer kept
asking for keyframes and never showed a frame. This runs Alice sharing her real screen with HD + "Jogos" (1080p60)
to Bob in the same room and checks, as Bob would notice:
  - a screen stream from Alice appears for Bob and leaves "Conectando à transmissão…" (its first frame is decoded);
  - Bob's native video window keeps painting her frames;
  - how often Bob asked for a keyframe and why ("video: asked the sender for a keyframe: ...", logged since 19/10),
    and Alice's bitrate changes, are reported.
The captured frames only travel between the two local clients; the run's screenshots live in a temporary folder
that is deleted at the end. Local loopback has no packet loss, so this checks the stream path, not a bad network.

Usage (from desktop/): .toolchain/venv/Scripts/python.exe tests/e2e/run_web_screen_share_e2e.py --exe out/build-claude/triscord-web.exe
"""
import argparse
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers  # noqa: E402
from run_web_call_e2e import account, launch, profile  # noqa: E402
from run_web_e2e import request  # noqa: E402

ROOM = "Sala Tela E2E"
COMMON = r"""
const log = window.__e2e = window.__e2e || {}, s = () => window.__triscord.store.current, b = window.__triscord.bridge;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(test, label, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return; await sleep(80); } throw Error(label); }
const room = () => s().categories.flatMap(c => c.channels).find(c => c.name === %s);
""" % json.dumps(ROOM)
ALICE = COMMON + r"""
(async () => {
  await wait(() => s().auth?.state === 'signedIn', 'auth');
  b.send({ name: 'setSetting', key: 'shareHd', value: true });
  b.send({ name: 'setSetting', key: 'shareMode', value: 'game' });
  b.send({ name: 'createChannel', channelName: %s });
  await wait(() => room() && s().connectedChannelId === room().id, 'alice in the room');
  await wait(() => room().users.length >= 2, 'bob in the room', 20000);
  const list = await b.request({ name: 'listShareSources' });
  const screen = list.sources.find(x => x.kind === 'screen');
  if (!screen) throw Error('no screen source');
  b.send({ name: 'startScreenShare', generation: list.generation, index: screen.index });
  await wait(() => s().sharing === true, 'sharing');
  log.sharing = true; log.sharingAt = Date.now();
})().catch(e => log.error = e.message);
'alice started'
""" % json.dumps(ROOM)
BOB = COMMON + r"""
(async () => {
  await wait(() => s().auth?.state === 'signedIn' && room(), 'bob sees the room');
  b.send({ name: 'selectChannel', channelId: room().id });
  await wait(() => s().connectedChannelId === room().id, 'bob in the room');
  const screen = () => (s().streams || []).find(x => x.kind === 'screen');
  await wait(screen, 'screen stream appears', 30000);
  const appeared = Date.now(); log.appeared = true;
  await wait(() => screen() && !screen().loading, 'first screen frame (left "Conectando à transmissão…")', 30000);
  log.firstFrameMs = Date.now() - appeared;
})().catch(e => log.error = e.message);
'bob started'
"""
PROBE = r"""JSON.stringify((() => {
  const s = window.__triscord.store.current;
  return { e2e: window.__e2e || {}, streams: (s.streams || []).map(x => ({ id: x.id, kind: x.kind, loading: !!x.loading, title: x.title })),
           sharing: !!s.sharing, connected: !!s.connectedChannelId };
})())"""


def last_probe(text):
    lines = [line[len("script: "):] for line in text.splitlines() if line.startswith("script: ")]
    for line in reversed(lines):
        try:
            value = json.loads(json.loads(line))
            if isinstance(value, dict) and "streams" in value:
                return value
        except (ValueError, TypeError):
            continue
    return {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--report", default=str(DESKTOP / "out" / "web-screen-share-e2e-report"))
    args = parser.parse_args()
    report = Path(args.report)
    shutil.rmtree(report, ignore_errors=True)
    report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-screen-share-"))
    backend, passed, processes = None, False, []
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        alice_session, alice = account(config, google, "share-alice", "Alice")
        bob_session, bob = account(config, google, "share-bob", "Bob")
        alice["nick"], bob["nick"] = "Alice", "Bob"
        server = request(f"{config['hubUrl']}/servers", "POST", {"name": "Servidor de Alice"}, alice_session)
        code = request(f"{config['hubUrl']}/servers/{server['id']}/invites", "POST", {}, alice_session)["code"]
        request(f"{config['hubUrl']}/invites/{code}/accept", "POST", {}, bob_session)
        print("  ok: Alice and Bob on the local backend; Bob joined Alice's server", flush=True)
        for name, text in (("alice.js", ALICE), ("bob.js", BOB), ("probe.js", PROBE)):
            (work / name).write_text(text, encoding="utf-8")

        alice_log = (report / "alice.log").open("w", encoding="utf-8")
        bob_log = (report / "bob.log").open("w", encoding="utf-8")
        processes.append(launch(args.exe, args.assets, config, profile(work, "alice", alice_session, alice, server["id"]),
                                work / "alice.js", 2500, work / "probe.js", 50000, work / "alice.png", 58, alice_log))
        time.sleep(5)
        processes.append(launch(args.exe, args.assets, config, profile(work, "bob", bob_session, bob, server["id"]),
                                work / "bob.js", 2500, work / "probe.js", 45000, work / "bob.png", 52, bob_log))
        for process in processes:
            process.wait(timeout=90)
        alice_log.close(); bob_log.close()

        alice_text = (report / "alice.log").read_text(encoding="utf-8", errors="replace")
        bob_text = (report / "bob.log").read_text(encoding="utf-8", errors="replace")
        a, b = last_probe(alice_text), last_probe(bob_text)
        screen_ids = [x["id"] for x in b.get("streams", []) if x["kind"] == "screen"]
        painted = [int(m.group(2)) for m in re.finditer(r"overlay (\S+) painted=(\d+)", bob_text) if m.group(1) in screen_ids]
        keyframes = [line for line in bob_text.splitlines() if "asked the sender for a keyframe" in line]
        bitrates = [line for line in alice_text.splitlines() if line.startswith("screen: bitrate")]
        losses = [line for line in bob_text.splitlines() if line.startswith("video:") and "lost packets" in line]
        print("  alice:", json.dumps(a, ensure_ascii=False), flush=True)
        print("  bob:  ", json.dumps(b, ensure_ascii=False), flush=True)
        print("  bob's native window painted screen frames:", painted[-1] if painted else 0, flush=True)
        print("  bob asked for keyframes:", keyframes or "never", flush=True)
        print("  alice bitrate changes:", bitrates or "none", flush=True)
        print("  bob packet loss lines:", losses or "none", flush=True)
        checks = {
            "alice shares her screen": a.get("e2e", {}).get("sharing") is True and not a.get("e2e", {}).get("error"),
            "a screen stream from Alice appears for Bob": b.get("e2e", {}).get("appeared") is True,
            "Bob gets the first frame (leaves 'Conectando à transmissão…')": isinstance(b.get("e2e", {}).get("firstFrameMs"), int)
                and any(x["kind"] == "screen" and not x["loading"] for x in b.get("streams", [])),
            "Bob's native window keeps painting the screen": bool(painted) and painted[-1] > 30,
        }
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        if b.get("e2e", {}).get("firstFrameMs") is not None:
            print(f"  first frame {b['e2e']['firstFrameMs']} ms after the stream appeared", flush=True)
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
    print(f"WEB SCREEN SHARE E2E {'PASSED' if passed else 'FAILED'}; report in {report}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
