"""Two local clients communicating through production TURN relays (18/10).

Two real clients on this computer, each with its own profile, forced to reach each other ONLY through the Cloudflare
TURN relays (TRISCORD_ICE_RELAY_ONLY=1, production relay credentials from GET /ice).
This exercises the relay path; it does not validate two physical networks or real microphones.
Local backend (real auth + hub Workers). Bob is a nick-only account (no Google) with a GIF avatar; he joins Alice's
server with an invite. Both talk with the test's synthetic quiet voice (-40 dBFS, through RNNoise, AGC and Opus).

Checked on both sides, as a person would notice:
  - every voice and video connection is relay/relay (logged by the client, no addresses);
  - each one hears the other (received level logged) loud enough: the AGC lifts the quiet talker;
  - the green "speaking" ring lights up for the other person;
  - Bob's camera reaches Alice;
  - Bob's GIF avatar shows without clicking him: still in the list, animated on the call card, and in the chat;
  - the user menu's "Volume do usuário" slider changes Bob's volume for Alice.

Usage (from desktop/): .toolchain/venv/Scripts/python.exe tests/e2e/run_web_wan_e2e.py --exe out/build-claude/triscord-web.exe --ice ice.json
  --ice: a file with the body of GET /ice from the production hub (short-lived TURN credentials, never printed).
"""
import argparse
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import Backend, DESKTOP, bundle_workers  # noqa: E402
from run_web_call_e2e import account, launch, profile  # noqa: E402
from run_web_e2e import request  # noqa: E402

COMMON = r"""
const log = window.__e2e = { steps: [] }, s = () => window.__triscord.store.current, b = window.__triscord.bridge;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = (test, label, ms = 30000) => new Promise((resolve, reject) => {
  const start = Date.now();
  const timer = setInterval(() => { let v; try { v = test(); } catch {}
    if (v) { clearInterval(timer); log.steps.push(label); resolve(v); }
    else if (Date.now() - start > ms) { clearInterval(timer); log.steps.push('TIMEOUT ' + label); reject(new Error(label)); } }, 150);
});
const channel = () => s().categories?.flatMap(c => c.channels).find(c => c.name === 'Outra rede');
const users = () => channel()?.users ?? [];
const other = name => users().find(u => u.name === name);
"""

ALICE = r"""(() => {COMMON
(async () => {
  await wait(() => s().auth?.state === 'signedIn', 'auth');
  b.send({ name: 'createChannel', channelName: 'Outra rede' });
  await wait(() => channel(), 'channel');
  b.send({ name: 'selectChannel', channelId: channel().id });
  await wait(() => s().connectedChannelId === channel().id, 'joined');
  b.send({ name: 'setMuted', muted: false });
  await wait(() => other('Bob'), 'Bob in the room', 60000);
  // Avatar without clicking: still frame in the list, GIF for the call card.
  const bob = other('Bob');
  await wait(() => s().avatars?.[bob.accountId]?.animated, 'Bob avatar prefetched', 30000);
  log.avatar = (bob.avatarUrl || other('Bob').avatarUrl || '').startsWith('data:image/png') || (s().avatars[bob.accountId].still || '').startsWith('data:image/png');
  log.avatarGif = s().avatars[bob.accountId].animated.startsWith('data:image/gif');
  // The call card shows the animated avatar while Bob has no camera.
  await wait(() => ((document.querySelector('.tri-call-card[aria-label="Bob"] img') || {}).src || '').startsWith('data:image/gif'), 'GIF on the call card', 20000);
  log.callGif = true;
  await wait(() => other('Bob')?.speaking, 'Bob speaking (green)', 60000); log.bobSpeaking = true;
  await wait(() => (s().streams || []).some(x => x.kind === 'camera'), 'Bob camera', 60000); log.camera = true;
  // Chat from Bob, with his avatar.
  document.querySelector('[aria-label="Mostrar chat"]')?.click();
  const message = () => [...document.querySelectorAll('.tri-message')].find(m => m.textContent.includes('oi, sou o Bob de outra rede'));
  await wait(() => message()?.querySelector('.tri-message__avatar-still'), 'Bob chat message with avatar', 30000); log.chatAvatar = true;
  // Volume do usuário from the user menu.
  const row = document.querySelector('.tri-voice-user[aria-label="Ver perfil de Bob"]');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 300 }));
  const slider = await wait(() => document.querySelector('[role="menu"] input[aria-label="Volume do usuário"]'), 'menu slider');
  slider.value = '150'; slider.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(() => other('Bob').volume === 150, 'volume applied'); log.volume = true;
  dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  log.done = true;
})().catch(e => log.error = e.message);
return 'wan alice started'; })()"""

BOB = r"""(() => {COMMON
(async () => {
  await wait(() => s().auth?.state === 'signedIn', 'auth');
  await wait(() => channel(), 'channel', 60000);
  b.send({ name: 'selectChannel', channelId: channel().id });
  await wait(() => s().connectedChannelId === channel().id, 'joined');
  b.send({ name: 'setMuted', muted: false });
  await wait(() => other('Alice')?.speaking, 'Alice speaking (green)', 60000); log.aliceSpeaking = true;
  await sleep(4000);   // Alice checks the animated avatar on the call card first
  b.send({ name: 'setCamera', on: true });
  await wait(() => s().camera, 'camera on', 30000);
  b.send({ name: 'sendChatMessage', text: 'oi, sou o Bob de outra rede' });
  log.done = true;
})().catch(e => log.error = e.message);
return 'wan bob started'; })()"""

PROBE = "JSON.stringify(window.__e2e || {})"


def gif(size, colors):
    data = io.BytesIO()
    frames = [Image.new("RGB", size, c) for c in colors]
    frames[0].save(data, format="GIF", save_all=True, append_images=frames[1:], duration=200, loop=0)
    return data.getvalue()


def upload(config, token, kind, data):
    req = urllib.request.Request(config["authUrl"] + "/profile/" + kind, data=data, method="PUT",
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "image/gif"})
    with urllib.request.urlopen(req, timeout=15) as response:
        assert response.status == 200


def last_state(path):
    state = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("script: "):
            try:
                value = json.loads(line[8:]); value = json.loads(value) if isinstance(value, str) else value
                if isinstance(value, dict): state = value
            except ValueError:
                pass
    return state


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    parser.add_argument("--ice", required=True)
    args = parser.parse_args()
    ice = json.loads(Path(args.ice).read_text(encoding="utf-8")).get("iceServers", [])
    entries = []
    for server in ice:
        urls = server["urls"] if isinstance(server["urls"], list) else [server["urls"]]
        for url in urls:
            if url.startswith("turn"):
                entries.append({"url": url, "username": server.get("username", ""), "credential": server.get("credential", "")})
    if not entries:
        print("FAIL: no TURN relay in the --ice file"); return 1
    report = DESKTOP / "out" / "web-wan-e2e-report"
    shutil.rmtree(report, ignore_errors=True); report.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix="triscord-wan-"))
    backend, processes, logs, passed = None, [], [], False
    os.environ.update(TRISCORD_ICE_RELAY_ONLY="1", TRISCORD_ICE_SERVERS=json.dumps(entries), TRISCORD_SYNTHETIC_VOICE="1")
    try:
        backend = Backend(*bundle_workers(DESKTOP / "out" / "wan-e2e-backend"), report / "backend.log")
        config = backend.config
        google = config["googleAuthUrl"].rsplit("/", 1)[0]
        alice_token, alice = account(config, google, "wan-alice", "Alice")
        alice["nick"] = "Alice"
        login = request(config["authUrl"] + "/auth/nick", "POST", {"nick": "Bob"})   # nick-only account, as the friend
        bob_token, bob = login["session"], login["account"]
        upload(config, alice_token, "avatar", gif((128, 128), ["#8a5ae6", "#2d7d46"]))
        upload(config, bob_token, "avatar", gif((128, 128), ["#e6b75a", "#365e80"]))
        server = request(config["hubUrl"] + "/servers", "POST", {"name": "Servidor da Alice"}, alice_token)
        code = request(f"{config['hubUrl']}/servers/{server['id']}/invites", "POST", {}, alice_token)["code"]
        request(config["hubUrl"] + "/invites/" + code + "/accept", "POST", {}, bob_token)
        print(f"  ok: local backend; Bob is a nick account ({bob['id'][:2]}…); {len(entries)} production TURN relays", flush=True)
        for name, script in (("alice", ALICE), ("bob", BOB)):
            (work / f"{name}.js").write_text(script.replace("COMMON", COMMON), encoding="utf-8")
        (work / "probe.js").write_text(PROBE, encoding="utf-8")
        for name, token, acct, delay in (("alice", alice_token, alice, 0), ("bob", bob_token, bob, 6)):
            time.sleep(delay)
            log = (report / f"{name}.log").open("w", encoding="utf-8"); logs.append(log)
            processes.append(launch(args.exe, args.assets, config, profile(work, name, token, acct, server["id"]), work / f"{name}.js", 2500,
                                    work / "probe.js", 85000 if name == "alice" else 79000, report / f"{name}.png", 95 if name == "alice" else 89, log))
        for process in processes:
            process.wait(timeout=140)
        for log in logs:
            log.close()
        texts = {name: (report / f"{name}.log").read_text(encoding="utf-8", errors="replace") for name in ("alice", "bob")}
        states = {name: last_state(report / f"{name}.log") for name in ("alice", "bob")}
        print("  alice:", json.dumps(states["alice"], ensure_ascii=False), flush=True)
        print("  bob:", json.dumps(states["bob"], ensure_ascii=False), flush=True)
        paths = {name: re.findall(r"ice: (\w+) connected via (\w+)/(\w+)", text) for name, text in texts.items()}
        heard = {name: [float(v) for v in re.findall(r"voice: heard peer at (-?[\d.]+) dBFS", text)] for name, text in texts.items()}
        print("  paths:", paths, "heard (dBFS):", {k: v[-1:] for k, v in heard.items()}, flush=True)
        a, bb = states["alice"], states["bob"]
        checks = {
            "every connection used the relay (voice and video, both sides)": all(
                paths[n] and all(l == "relay" and r == "relay" for _, l, r in paths[n]) for n in paths)
                and any(k == "voice" for k, _, _ in paths["alice"]) and any(k == "video" for k, _, _ in paths["alice"]),
            "Alice hears Bob loud enough (AGC on a -40 dBFS talker)": bool(heard["alice"]) and heard["alice"][-1] > -30,
            "Bob hears Alice loud enough": bool(heard["bob"]) and heard["bob"][-1] > -30,
            "green ring lights for Bob on Alice's side": a.get("bobSpeaking") is True,
            "green ring lights for Alice on Bob's side": bb.get("aliceSpeaking") is True,
            "Bob's camera reaches Alice through the relay": a.get("camera") is True,
            "Bob's avatar without clicking (still + GIF)": a.get("avatar") is True and a.get("avatarGif") is True,
            "Bob's GIF animates on the call card": a.get("callGif") is True,
            "Bob's chat message shows his avatar": a.get("chatAvatar") is True,
            "'Volume do usuário' from the menu": a.get("volume") is True,
            "both scripts finished without errors": a.get("done") is True and bb.get("done") is True and not a.get("error") and not bb.get("error"),
        }
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        passed = all(checks.values())
    finally:
        for process in processes:
            if process.poll() is None: process.kill()
        for log in logs:
            if not log.closed: log.close()
        if backend: backend.close()
        shutil.rmtree(work, ignore_errors=True)
    print(f"WEB WAN E2E {'PASSED' if passed else 'FAILED'}; report in {report}", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
