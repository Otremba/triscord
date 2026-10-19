# Triscord Native — engineering preview

Windows x64 client in C++20 / Qt Widgets. No Electron, WebView, or Node runtime
is needed to run the desktop executable. The client supports both the existing Node server and the private Cloudflare Worker.

## Native interface (0.9.12)

The call footer now includes a camera toggle; camera selection is available in
settings. Camera images appear inside participant cards while screen sharing
remains independent. Cards retain only the latest delivered image and render at
most five updates per second in the grid. Click a camera to focus it; click again
or press Escape to return to the grid. Double-click opens fullscreen, with wheel
zoom, drag to pan, an adjust button and Escape to close. Only the selected camera
receives full-size render delivery; other cards stay reduced. This controls render
cost, not P2P network bitrate. Synthetic camera/screen integration is verified;
physical cameras and calls over the internet still require validation. Background
effects are not implemented yet.

Background-effect development now includes an export of the pinned public
MediaPipe landscape model, independent numerical model tests and a native temporal
mask smoother. These are not connected to the distributed client's camera yet.
Native C++ inference and GPU alpha composition are now implemented and validated
as separate components. The inference smoke tool checks model-size, padded-stride
resize and single-pixel inputs against an independent preprocessing reference.
The GPU test checks soft alpha mixing and immutable output surfaces. Spatial
filtering and a mask-aware Gaussian blur pass are implemented. Full blur-pass
scheduling, camera publication integration and effects controls are pending.
The model tools run externally under `desktop/tools`; Python/ONNX Runtime testing
dependencies live only in the ignored `.toolchain/camera-effects/python` directory.
Inference timing is measured by the external verifier, not by the application.

Stopping a remote video publisher now keeps the duplex peer when the local
participant is still publishing. This avoids rebuilding only one end of an
active media connection. Camera and screen coordinators have independent state,
signaling sessions and viewing controls; camera peers negotiate video only.
Synthetic two-client integration verifies both sources simultaneously and that
stopping one camera preserves both screens and the other camera. Physical webcam
capture/publication over the internet still needs physical and WAN validation.

Audio settings offer a saved push-to-talk release delay from 0 to 2000 ms.
The default is 0 (immediate release), preserving previous behavior; Discord's
default was not established by the native analysis. Pressing again cancels a
pending release. Leaving the call or changing shortcuts closes the gate and
cancels its timer. Manual mute and room restrictions continue to take priority.
Only one single-shot timer runs during the release tail; keyboard-release polling
runs only while the physical key is held. No idle monitoring was added.

Webcam capture is being implemented separately from screen sharing. The current
`triscord_camera` library is development-only until independent camera transport,
participant rendering and background effects are connected. It is not linked into
the distributed client. `CameraService` now performs device queries and capture
on a lazily created media worker, drops canceled selections and queues at most
one preview notification. After a development build, `triscord-camera-smoke` lists
the number of cameras; `--capture` explicitly requests a short capture check and
does not record images. This PC had no camera attached, so physical capture has
not been verified. Native QtTest text reports are in `desktop/out/build/qt-test-results`.

`CameraEncoder` now accepts native Qt frames on an MTA media thread and produces
the existing H.264 packet type. Compatible BT.709 limited-range NV12 avoids RGB
conversion; other SDR formats use GPU conversion/scaling. RGB conversion still
uses a Qt image and upload, so it is not an end-to-end zero-copy camera path.
`triscord-camera-encode-smoke --hardware-only` validates synthetic RGB/orientation
frames; adding `--nv12` validates direct native NV12 upload. `--software-only`
validates software encoding with GPU conversion/readback. These tools remain
separate from the client. Physical capture, camera publication and background
effects are still pending integration.

On first launch, a native welcome dialog requires a name and saves it locally.
Later launches connect automatically; clicking a room joins the call. The footer
Disconnect button leaves the call while keeping the room directory connected.
Interface labels, displayed room names and participant names use lowercase;
chat message bodies and stored names are preserved as entered. The audio control
says silenciar chamada.
The client always uses an AMOLED palette: pure black backgrounds, neutral gray
controls and light text, including menus, tooltips and native Qt dialogs. The
monochrome application icon is embedded in both the client and portable launcher.
The empty chat and message field have no instructional text. Routine connection
status is hidden; actionable notices appear temporarily for ten seconds.

Room sidebar, central conversation/shared video, participant sidebar with cached
avatars and call controls in the footer. Settings and source selection are native
dialogs. Inactive video does not reserve empty panels; hidden/minimized images
skip UI scaling. Presence updates reuse items. No decorative animations or web
renderer were introduced. A separate Qt Test fixture covers real local signaling,
presence reuse, reactions, video visibility and closing a connected window.
Functional tests do not establish whole-client CPU/RAM or latency improvements.

## Implemented

- Speaking indication: white participant-card outline, computed from existing
  local/decoded PCM on the media thread, with transitions only sent to the UI.
- One-shot Windows Graphics Capture source thumbnails, grouped into entire
  screens and application windows. No continuous capture after closing the picker.
- Optional PC audio during screen sharing: WASAPI process loopback excludes the
  entire triscord process tree; no endpoint-loopback fallback that could include
  call voices. Requires Windows build 20348 or later (including Windows 11).
  Audio uses a separate encrypted Opus track on the screen connection, 48 kHz
  mono at 64 kbps. It captures all other applications, even when sharing a window.
  Capture is off by default, starts only with consent and stops with the share.
  Playback follows the chosen audio output and the call-silence control.

Development validation: `triscord-system-audio-smoke --capture` with a separate
`--tone` process tests external audio inclusion and own-process exclusion.
No captured audio files or resource-monitoring history are written. Room tests
exercise video, call voice and screen audio concurrently with rejoin and stop.

- Screen sharing uses direct peer-to-peer connections only. No Realtime credentials or relay transport are included. The encoder runs once; network output scales with the number of viewers.

- Native room directory, participant list and plain-text chat using the existing
  Engine.IO v4 / Socket.IO JSON event protocol over WebSocket.
- Handshake, heartbeat, bounded input, reconnect backoff, explicit disconnect,
  and rejection of offline events (no stale signaling queue).
- Local settings in a separate `TriscordNativePreview` namespace.
- Experimental native voice between native clients: Opus at 48 kHz/32 kbps,
  20 ms frames, ICE/DTLS-SRTP transport, microphone/speaker via Qt Multimedia,
  mute/deafen, bounded jitter/playback queues and connection recovery.
  Microphone starts muted; device PCM rates of 8–192 kHz are converted to/from
  the 48 kHz voice clock, including 44.1 kHz devices and stereo downmixing.
  Opus is encoded once per microphone frame and sent to each remote participant.
- A dedicated media thread owns audio devices, codecs, jitter buffers and peers.
  The UI thread owns signaling and receives only device/state updates; production
  does not forward raw PCM into the UI. Pending received audio is bounded before
  dispatch, not just after it reaches the jitter buffer.
- Persisted microphone/output selection, Windows default-device mode, debounced
  device-change notifications and actionable device errors without leaving chat.
  Explicit unavailable selections are preserved instead of opening another mic.
- SpeexDSP 1.2.1 provides streaming resampling, optional noise suppression
  (default on). Experimental echo reduction is disabled in the distributed client.
  Effects run only
  on captured microphone frames, on the media thread. Playback reference is
  the clipped mix submitted to the output device. Noise suppression preferences persist.
- Room-integrated screen/window sharing via Windows Graphics Capture, D3D11
  scaling/conversion, hardware Media Foundation H.264 and a separate WebRTC
  connection per remote participant. Voice and screen signaling are isolated by
  media type and session generations. The default share is 720p30 at 2.5 Mbps;
  one hardware encoder feeds all viewers. System audio is not included yet.
- Source selection, local preview, received stream selection, secondary thumbnails,
  fullscreen and zoom. Focused frames render at up to 15 fps/1280×720 and secondary
  frames at up to 5 fps/320×180. This limits CPU presentation work; network receive
  bitrate and full-size decoding are not yet reduced for secondary streams.
- Private Cloudflare control plane with SQLite Durable Objects and hibernating
  WebSockets, bounded text history and group invitation authentication. Local
  protocol/media tests passed; the Worker is deployed on Workers Free and public
  authentication/chat/heartbeat plus synthetic C++ media exchange passed. Two-PC
  NAT/quality acceptance remains pending. See [deployment](../../../cloudflare/DEPLOYMENT.md).
  Saved invitations use Windows DPAPI, never plaintext settings.
- Shared upload-budget policy with audio headroom, focus priority and secondary
  viewer limits, tested independently. **Not yet applied to a media transport.**
- Native chat reactions and owner controls for kick and mute. Room lock/limit
  controls were removed from the client; server capacity restrictions remain.
- No diagnostics tab, resource indicators, periodic resource monitoring, or
  development CLI in the distributed client. Hardware probes, PNG rendering
  and integration checks exist only in a separate development executable.

## Not implemented yet

Accepted physical echo cancellation across different devices/clocks, camera and
background effects, system audio capture, soundboard,
speaking indicator, global shortcuts, individual volume/mute, microphone
self-test, notifications, profile controls, installer and automatic updates.
Adaptive upload policy, TURN connectivity and real internet acceptance also remain
pending. Native chat reactions (right-click), room creation/leave and owner lock/limit/
kick/mute controls are implemented.
The UI identifies this clearly and joins rooms with the microphone muted.
This preview is **not a replacement** for the current Triscord.

## Video codec implementation

`triscord_video` provides Media Foundation H.264 encoding and NV12 decoding.
It selects a compatible hardware encoder first, with a software compatibility
path. Hardware transforms use their asynchronous need-input/have-output events;
application input is limited to four outstanding frames and polling returns at
most four outputs. Busy input is rejected instead of queued. Dimensions, frame
rates, bitrates, sample allocations and timestamps are bounded/validated.
Baseline profile, low-latency requests, a two-second GOP and explicit IDR requests
prepare live delivery. Each IDR includes Annex B SPS/PPS for a new receiver.
Decoder output is cropped from its padded stride/height into packed NV12.

The hardware path also accepts immutable NV12 textures from a matching D3D11
device through a DXGI device manager. `triscord_screen` connects WGC to a D3D11
video processor for BGRA-to-NV12 conversion, aspect-preserving scaling/letterbox
and hardware H.264 encoding. It validates the selected source on every tick,
pauses capture while minimized and rejects closed/hidden/lost sources. Busy
encoders skip conversion; capture timestamps are normalized per stream.
The only sender readback is the bounded local preview, at most 640×360. Full-size
capture/conversion images remain on the GPU. WGC leases cover the queued copy
through preview readback; fresh immutable NV12 textures are retained by MF.

This pipeline currently requires compatible GPU conversion and hardware encoding;
the standalone software codec is not yet a screen-pipeline fallback. Textures
are freshly allocated rather than unsafely recycled while MF owns them. A safe
tracked pool remains an optimization task. The room coordinator and received-video presentation are active in 0.6.0.
Real hardware capture/transport fixtures and synthetic room integration are
separate checks; the complete client on two different PCs still needs acceptance.
No whole-client performance reduction or WAN latency has been established.

Reference contracts: [H.264 encoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder),
[H.264 decoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-decoder),
[asynchronous MFTs](https://learn.microsoft.com/en-us/windows/win32/medfound/asynchronous-mfts),
[D3D11 video processing](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11videocontext-videoprocessorblt).

## Screen WebRTC transport

`triscord_video_transport` adds a separate native H.264 send/receive connection
through libdatachannel's ICE/DTLS-SRTP, with 90 kHz RTP timestamps, Annex B
fragmentation and RTCP sender/receiver reports. PLI/FIR requests ask the shared
encoder for a new IDR; request delivery is coalesced and limited to once per
250 ms. A bounded 256-packet NACK responder cache is installed; generation of
NACK requests and acceptance under impaired networks remain future work.

The receiver assembles one access unit, limited to 2 MiB, 2,048 packets, 1,500
bytes per RTP packet and 200 ms assembly age. It validates RTP headers,
extensions/padding, single NAL, STAP-A and FU-A. It accepts duplicates/reordering
within that unit and sequence/timestamp wrap. Incomplete/malformed/excessive
frames are discarded; recovery requires SPS/PPS + IDR. Timestamp progression is
unwrapped into a per-decoder timeline, rejecting late/duplicate frames.
The cross-thread delivery queue has at most two frames and one pending Qt
notification. Overflow clears dependent frames and requests recovery instead of
decoding a damaged prediction chain. Decoder reset is emitted once per recovery
cycle; retries request IDR without repeatedly recreating the decoder. A sender
with more than 256 KiB buffered skips input and waits for a fresh IDR.

`ScreenCall` owns room membership, typed SDP/ICE, codec configuration and UUID
session generations on a dedicated media thread. Sharing is explicit; leaving,
disconnecting or losing the source stops capture. Decoded UI delivery retains
only the latest image per stream and coalesces Qt notifications. A three-client
integration test requires decoded pixels and voice in all directions, then
rejoin with a new socket and stopping one share. It passes against Node and
Miniflare; media stays local in those tests.
WAN/NAT/TURN, congestion adaptation and system audio/synchronization remain pending.

## Product scope

See [FEATURE_SCOPE.md](FEATURE_SCOPE.md) for the agreed feature set. Recording,
chat images, light theme, decorative animations, web client and integrated
diagnostics are excluded. The shared backend accepts text-only chat and keeps
its health endpoint without serving the renderer. Features marked for retention
are requirements for migration, not a claim that this preview implements them.

## Build and test locally

For the published preview, see [testing with a friend](TESTAR_COM_AMIGO.md).
The group-specific 0.6.2 package is a single `triscord.exe`, with automatic server
and invitation configuration. It prepares runtime DLLs once and reuses them;
see [single-file packaging](../../../desktop/packaging/README.md). Anyone with that executable
can join the group. Generic source/CI builds do not embed the invitation.

Python 3, Git and Node.js are needed for setup/tests. From the repository root:

```powershell
./desktop/scripts/setup.ps1
./desktop/scripts/build.ps1 -DevTools
npm ci --omit=dev
./desktop/scripts/test.ps1
./desktop/scripts/build.ps1 -Package
./desktop/dist/triscord-native.exe
```

Setup downloads pinned Qt 6.8.3 / MinGW 13.1 and Python build tools into the
ignored `.toolchain` directory. It does not change the system PATH or require
administrator privileges. The scripts restore the calling process PATH.
The native voice build uses pinned libdatachannel 0.24.6, Opus 1.5.2 and
MbedTLS 3.6.5 sources fetched by CMake. These libraries are compiled with the
same toolchain as the client. Qt Multimedia supplies native audio devices.
The transport handles ICE, DTLS and SRTP; SpeexDSP, built from pinned revision
1b28a0f61bc31162979e1f26f3981fc3637095c8, supplies the separate DSP pipeline.
Its bundled FFT notices are retained, and diagnostic dump options are disabled.
Echo reduction remains experimental: real device delay and independent clocks
can prevent effective cancellation. Prefer headphones during initial tests.
Reference: https://www.speex.org/docs/manual/speex-manual/node7.html

For a manually configured Qt / MSVC installation:

```powershell
cmake -S desktop -B desktop/out/msvc -G Ninja -DCMAKE_BUILD_TYPE=Release -DTRISCORD_BUILD_DEV_TOOLS=ON -DCMAKE_PREFIX_PATH=C:/Qt/6.8.3/msvc2022_64
cmake --build desktop/out/msvc
ctest --test-dir desktop/out/msvc --output-on-failure
```

The integration test starts and stops its own local server on an ephemeral
port. It never connects to Render, Metered or any cloud account. Synthetic
voice tests connect 2, 3 and 10 clients and require decoded audio from every
other participant. They validate signaling and encrypted media delivery, not
microphone quality, real-world latency, NAT traversal or performance on ten PCs.
The three-client scenario also disconnects and rejoins a participant with a new
session, then requires audio in all directions again.
Actual calls may use the server's configured STUN/TURN endpoints; TURN capacity
and billing depend on that provider. See [Cloudflare setup](../../../cloudflare/README.md) for the private Worker. It currently
provides STUN only; restrictive networks can require a separately configured TURN relay.

## Development tools (not distributed)

`TRISCORD_BUILD_DEV_TOOLS` defaults to `OFF`. Build with `-DevTools` to enable
`triscord-dev-tools.exe`, `triscord-voice-smoke.exe`, `triscord-audio-smoke.exe`,
`triscord-voice-bench.exe`, `triscord-capture-smoke.exe` and
`triscord-video-smoke.exe`, `triscord-screen-smoke.exe`,
`triscord-video-transport-smoke.exe`, `triscord-screen-transport-smoke.exe` and
`triscord-screen-room-smoke.exe`; Qt Test is requested
only when `BUILD_TESTING=ON`.
Release packaging uses a separate `desktop/out/release` build with both flags
explicitly disabled, rebuilds the generated package directory, and installs
only `triscord-native.exe` with its runtime dependencies and license metadata.
Neither the tests nor the development executable are installed or packaged.

`triscord-video-smoke --software-only` runs through CTest when development tools
are enabled. The default manual run also requires a working hardware encoder
and D3D11 NV12 surface input. It validates changing luminance/chroma, timestamps,
Annex B, forced IDR, a late decoder joining at that IDR, padded dimensions,
invalid input rejection and resource release/recreation. No images/video files
are captured, saved or uploaded. Windows editions without Media Foundation
may need the Media Feature Pack; hardware runs are not CI acceptance criteria.

`triscord-screen-smoke` manually validates the actual capture-to-encoder path
on a worker thread, using only its own controlled window. It requires a local
interactive Windows session, compatible GPU video processor and hardware H.264
encoder. Large colored windows are scaled, encoded and decoded; BT.709 pixel
values, resize/letterbox, timestamp order, forced IDR, a late receiver,
minimize/restore, stream restart and source closure are checked. It does not
capture monitors or other apps, save video, upload media or monitor resources.

CTest also runs `native-video-rtp` (assembly limits, loss, incomplete fragments,
malformed input, extensions/padding, duplicates, reordering and wrap) and
`native-video-transport` (two local peers, software H.264 both ways, decoded
changing block patterns spanning FU-A packets, remote PLI and decoder rejoin).
`triscord-screen-transport-smoke` requires interactive graphics/hardware and
manually verifies its own colored window through WGC, GPU conversion/hardware
encoding, real ICE/DTLS-SRTP transport and pixel-checked decoding, including
resize and remote PLI/decoder recovery. SDP/ICE exchange is local/in-process;
these tests do not validate the room server, WAN traversal or two physical PCs.
The client has no resource-monitoring timer; heartbeat and reconnect timers
remain necessary for network operation. Future adaptive media measurements
must remain transient, without resource histories or user diagnostic panels.

```powershell
# With the Qt/MinGW bin directories on PATH (same as the build/test scripts):
./desktop/out/build/triscord-dev-tools.exe --smoke-report desktop/out/startup.json
./desktop/out/build/triscord-dev-tools.exe --smoke-report desktop/out/capture.json --probe-capture
./desktop/out/build/triscord-dev-tools.exe --preview-image desktop/out/preview.png
python desktop/tests/integration_smoke.py --exe desktop/out/build/triscord-dev-tools.exe --voice-exe desktop/out/build/triscord-voice-smoke.exe
# Optional local hardware check: mic stays muted, speakers output silence.
./desktop/out/build/triscord-audio-smoke.exe
# Synthetic DSP plus Opus timing only, never a whole-client CPU/RAM benchmark:
./desktop/out/build/triscord-voice-bench.exe
# The packaged client rejects all of the above development switches:
python desktop/tests/verify_client.py --exe desktop/dist/triscord-native.exe --package
```

`triscord-capture-smoke.exe` is a separate optional hardware tool. It captures
only its own controlled window and validates real frames, GPU-scaled colors,
resize, minimize/resume, stop/restart and source closure. No images are written
or uploaded. Run it on an interactive Windows desktop with Qt/MinGW on PATH:

```powershell
./desktop/out/build/triscord-capture-smoke.exe
```

The CTest capture suite checks preview bounds and the latest-frame mailbox,
including concurrent production and stale-source rejection, without a GPU.
Development tools use their own settings namespace, `TriscordNativeDevTools`.
The integration test starts only a local server; TURN HTTP calls are disabled.
Use external profilers to benchmark the actual client and the whole process
set under matched voice/video workloads, rather than shipping profilers in it.

`--preview-image` renders only the app widget, not the desktop. Startup metrics
are for a hidden window, **not a video-call or idle-visible-window benchmark**.
`hardwareEncoderVerified: false` remains false until a real encoding pipeline
is tested. Successful GPU creation is not proof of hardware encoding.

Desktop Duplication currently probes the first output of the default adapter;
multi-GPU laptops, remote sessions and locked desktops may require a different
adapter/output or report an explicit failure. Final source selection/capture
uses Windows Graphics Capture in the native client's separate capture component.
The hardware check has passed for the controlled test window on the local PC;
multi-GPU configurations, physical monitor capture, HDR, protected content and
remote/locked desktops still need acceptance. This stage captures SDR BGRA;
HDR tone mapping and device-loss recovery require later work. WGC requires
Windows 10 1903 or newer and compatible graphics/capture permissions.
API references:
https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture
and https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow

## Next milestones

1. Harden voice: speech and hotplug checks on physical devices, different networks,
   evaluate noise suppression and align/accept echo cancellation on actual devices.
2. Add WASAPI loopback and accept real screen sharing on two physical PCs;
   hardware capture/encoding and room video transport are implemented.
3. Integrate the aggregate quality policy; compare voice-only and screen/game
   workloads against Electron on the same hardware and network.
4. Port remaining features without losing current user data. Keep legacy client
   and release workflow until functional/performance acceptance passes.
5. Accept the deployed Free Workers control plane with two PCs on different networks.
   No automatic plan upgrades or paid relay activation; verify NAT requirements.

Work is isolated on `rewrite/native-desktop`; this preview does not change
the legacy default executable, production server, or existing release channel.

## Soundboard migration and layout (0.9.8)

The native soundboard includes the 32 active MP3 clips recovered from the legacy
Electron IndexedDB profile (2,634,070 bytes). Each bundled filename is the SHA-256
of the original bytes. The development exporter clones IndexedDB before reading;
it does not modify the legacy profile. The catalog lives in
shared/soundboard_catalog.json and the clips in desktop/assets/soundboard.

The footer button "sons" opens a searchable native grid with a saved volume
slider and local stop button. Clicking a clip sends only its ID; the server
validates membership and the catalog and broadcasts to that room, including the
sender. A one-second per-user interval prevents rapid replay. Everyone needs
the updated executable to hear these bundled sounds.

QMediaPlayer and QAudioOutput are created only on first playback. Only the chosen
clip is verified by hash and extracted to the local cache without ID3 metadata
(cover images caused a Qt/FFmpeg playback regression). The compressed audio frames
are preserved and opened by the existing
Qt Multimedia backend. Playback replaces the previous sound, ends after at most
10.5 seconds and stops on leave, disconnect or silencing the call. It follows the
selected output device. No audio is uploaded to the Worker or streamed between
peers for soundboard playback. Adding/removing sounds is not part of this migration.

Own screen sharing now uses the same large stage, source selector, zoom and
fullscreen controls as remote video. Drag the vertical column dividers to resize
rooms and participants; drag the horizontal video/chat divider to change the
stage height. Sizes are saved locally. Secondary stream thumbnails still use a
compact strip; select one to make it the main stage.

Right-click your own chat message and choose "excluir mensagem". The server checks
the current room and sender profile, removes the history entry and broadcasts its
removal. The existing client-provided profile identity is not an authenticated
individual account. Cross-profile deletion is rejected for connected profiles.

Qt UI tests verify all 32 embedded hashes and decode the clips through the playback
backend without audible output; control tests cover room-scoped sound events,
rate limiting, message author checks and deletion from persistent history.

Voice playback in 0.9.8 prefers stereo output and offers a per-participant
left/right position slider in the participant menu. Network voice remains mono.
Local volume/mute/pan survive transport rebuilds and are discarded when a peer
leaves. Stereo PCM and menu checks are included in development tests.
See desktop/discord-reconstruction.md for REA provenance and fidelity limitations.

In 0.9.8 the participant menu's local video toggle actually suspends remote
decoding and requests the publisher to stop sending video to that viewer.
Screen audio and voice stay active. Reactivating requests a fresh keyframe.

In 0.9.8 participant menus include independent screen-audio volume (0-200%)
and mute. These affect the decoded screen audio while voice/video continue.
Controls retain their state during media transport rebuilds and reset on
participant departure or leaving/rejoining a room, matching the media state.

In 0.9.8 audio settings include push-to-talk (default off; F8 by default,
selectable F6-F11) and a global microphone shortcut (Ctrl+Shift+M). First enable
the microphone, then hold the PTT key. Manual mute wins over PTT.
Registrations are active only during a call; conflicts display an actionable
notice. Keys are checked only while the PTT key is held. Game compatibility
still needs manual verification.

In 0.9.8 the room owner can silence or release a participant's microphone.
Room restrictions override manual unmute/PTT and persist for the same claimed
profile. Updated P2P receivers also reject voice from a restricted participant.
All receivers should use the updated client; identities are still client claimed.

In 0.9.8 the source picker selects 480p/720p/1080p and 15/30/60 fps. The default
remains 720p30; higher settings use more upload per viewer and more local work.
Focused remote rendering follows negotiated fps/raster instead of the former
15 fps/720p cap. Secondary thumbnails stay reduced. Native hardware encoding
at 1080p60 was verified on this PC; WAN and real-time capture rates remain
unverified. The local preview is still reduced independently of outgoing media.

In 0.9.8 background room entries and name mentions request a Windows notification.
The setting can be disabled, own/foreground messages are suppressed, and bursts
are limited. Notification display depends on Windows settings/Focus Assist.
No browser or push service is needed. Visual OS delivery still needs verification.
