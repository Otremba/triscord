# Native media through the VPS

The control Worker keeps accounts, server membership, room admission, moderation
and chat. LiveKit on the Lura VPS forwards encoded media. The native client still
captures and encodes H.264 with Media Foundation, processes microphone audio and
plays Opus through its existing per-user mixer. It uploads each track once.

`media-bridge` is a separate, device-free Go executable using the official LiveKit
Go SDK and Pion. Anonymous process pipes carry encoded packets and commands;
tokens never appear in command-line arguments or local files. A small Qt adapter
owns the process on each native media thread. Voice, screen and camera use
separate LiveKit rooms with the same authenticated control-room namespace.

## Admission and transition

The presence of `triscord-media.exe` advertises capability on `join-room`. A room
with existing callers retains its transport. An empty room selects LiveKit when
the first authenticated caller supports it and the Worker has its configuration.
Older clients cannot join an active SFU call; they must update. This prevents
silently connecting participants to different media transports in the same call.

The Worker signs role-specific JWTs only after room admission checks. They permit
joining one exact server/room/media namespace, publishing its allowed sources and
subscribing. They do not permit data publishing or room administration. Admission
tokens last 60 seconds; the SDK refreshes connected sessions, while a terminal
transport failure requests fresh credentials over the authenticated control socket.
Each join has a unique media identity so delayed cleanup cannot remove a newer
connection. Leaving/kicking also requests removal through the private server API.

The Worker requires `LIVEKIT_URL` and secret bindings `LIVEKIT_API_KEY` /
`LIVEKIT_API_SECRET`. The signing secret stays on the VPS and in Worker secrets.
Never put it in client configuration, build arguments, Git or log output.

## Build and validation

Install Go 1.27.3 under `.toolchain/go` or configure `TRISCORD_GO_EXECUTABLE`.
CMake builds the adapter with pinned modules and `CGO_ENABLED=0`, without a console
window. `portable-web.ps1` includes it and collects notices for linked modules.
`-BuildDirectory` can reuse an existing build. Packaging still requires
`-SkipRuntimeVerification` while the user's runtime/E2E restriction applies.

Headless checks:

```powershell
node --test cloudflare/tests/media-tokens.test.mjs cloudflare/tests/control-rate.test.mjs
cd desktop/media-bridge
go test -p 2 ./...
go vet -p 2 ./...
```

Packet tests cover fragmented/reordered H.264, RTP timestamps, keyframe detection,
pipe serialization and bounded output queues. They do not connect to a media
room or access devices. Native core unit tests also remain applicable.

Queues are bounded by bytes and packets. Loss or replacement of a track resets
video recovery; RTP timestamps retain the encoder's actual capture cadence.
Reconnects reset audio jitter/decoder state. Disabling a remote stream unsubscribes
its video track at the SFU, retaining audio playback. Existing volume, mute, pan and noise suppression controls
continue through the native playback/capture code.

## Current deployment limits

The VPS endpoint uses free IP-based sslip.io DNS and trusted HTTPS. Media supports
direct UDP, ICE/TCP and embedded TURN/UDP. TURN/TLS is not configured yet, so
networks that block these paths may fail. A private domain and TURN/TLS are useful
follow-up improvements. Server HTTPS checks do not prove successful media flow.
Real calls, capture, playback and performance remain unverified under the user's
explicit prohibition on runtime and end-to-end tests.
