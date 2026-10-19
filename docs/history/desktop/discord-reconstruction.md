# Discord reconstruction evidence ledger

Target selected by the user: Discord app-1.0.9261 on Windows. Goal remains active:
reconstruct the requested voice/chat/screenshare experience in independent C++,
using REA evidence and keeping a free alternative wherever hosting creates cost.

## Evidence collected on 2026-10-13

REA local checkout: C:/Users/camargo/Documents/GitHub/rea, version 6.4.0.
Built its runtime with npm ci / npm run build:cached. Its missing Windows addon
was obtained from the official npm package rea-agents@6.4.0, then verified by
REA's verify:windows-native:artifact. No Discord artifact was modified or executed.

| Artifact | REA evidence | SHA-256 |
| --- | --- | --- |
| resources/app.asar | ev_f4c7ab85f9bfd49c8c6de53a44a7e7f4008aca70996ca079d69b10f36710b40b | 535bcb3de917fa65289519e399ea82ab93d9e4df35f7b437ae8433e5ca9d39ca |
| modules/discord_voice-2/discord_voice | ev_5541ad0da5985c39f705bafc8d1117fd381f335245d30cbb30f3b0e2eb9f56a2 | c23628975926bdc86a842c2cc4e870912717331a60b55a2864daca24e34efa8b |

Full local Evidence is retained under desktop/out/discord-app-rea.json and
desktop/out/discord-voice-rea.json, outside version control. The app inventory
reports 5 relevant files, 2 parsed JavaScript files and no parse failures.
The voice inventory reports 480 relevant files, 406 parsed JavaScript files and
one parse failure. Voice graph coverage is explicitly incomplete. Neither
static result proves runtime behavior or absence of features.

Direct inert file inspection, separately from REA Evidence:
discord_voice/index.js SHA-256
1c12139ccbf818a992fb813b4954a68b1d64b4e96b0f6a97e12862ca5eef764a.
Lines 141-142 forward setLocalVolume(userId, volume) and
setLocalMute(userId, mute) to the native engine; nearby wrappers expose local pan,
screen sources and reconnection controls. The native algorithm and its effective
defaults remain unknown until native analysis or runtime verification.

## Applied behavior

The existing triscord menu already offered local volume and mute, but
VoiceDevices::playMixedFrame summed unmodified samples and ignored both stored
settings. The mixer now applies the selected 0-200% gain and local mute before
summing; the final aggregate still clips to [-1, 1]. Muted frames are consumed,
so unmuting does not replay queued old speech. Pan bookkeeping is removed when a peer is removed. Stereo PCM output is now implemented.

native-voice tests check the actual shared mixing helper against known PCM,
including mixed peers, zero gain, negative gain, mute and non-finite gain.
Existing encrypted Opus integration is checked separately; it does not prove
Discord transport equivalence or Internet connectivity through arbitrary NAT.

## Remaining requirements and proof needed

| Requirement | Current proof / remaining work |
| --- | --- |
| Faithful Discord call and stream UI | Native UI exists; compare each interaction against observed runtime behavior. Complete parity is unproven. |
| Voice pipeline, recovery, participant controls | Local integration exists; verify all exposed controls reach the actual playback/capture path. Stereo PCM and menu tests now pass locally; hardware listening and exact native gain law remain unverified. |
| Shared screen selection, focus, zoom, multiple streams | Implemented UI exists; capture/cost/quality parity still needs feature-specific traces and runtime checks. |
| PC audio without rebroadcasting call voices | WASAPI exclusion implemented and previously exercised; verify current build with a real remote friend and multiple output devices. |
| Webcam and retained background effects | Must inspect native/media boundaries and implement missing production functionality; not established by current Evidence. |
| Soundboard, bounded chat and own-message deletion | Existing tests establish triscord behavior; full Discord interaction parity unproven. |
| Push-to-talk and global shortcuts | Microphone-state and real Windows registration tests pass; physical key activation and game/elevation compatibility remain unverified. |
| Windows notifications | Event/name/focus/preference logic implemented and tested; actual OS presentation, rich actions and authenticated mention IDs remain unverified. |
| Automatic updater | Prior requested scope remains; a verified production implementation and update flow are still required. |
| Free deployment | P2P + current free control Worker retained. SFU/server egress introduces cost; never infer a free service from static Discord client code. |
| Native binary behavior | discord_voice.node and helpers identified but not decompiled in this step. No native algorithm fidelity claim yet. |

This ledger records progress, not completion. No proprietary Discord engine,
credential, hosted-service access or paid-feature entitlement is bundled.

## Stereo behavior and REA trace

REA trace_application_feature with a string seed "setLocalPan" returned no match
on the partial structural graph (ev_63bcbc155553d47cb75bc345de2c36e73022ba9c091a57114ae735ff1c2e3f94).
That does not establish absence: the identifier is a property, not a string literal.
A semantic property query found one seed in one module/function:
ev_d324268bbec097664b97d4ad337d666c9aa65dee1c4644a063b38ede3ff9be9d.
Its status is ambiguous, with zero traversed relations and 173 relevant unknowns.
Local results: desktop/out/discord-pan-trace.json and discord-pan-semantics.json.

Direct inert inspection of index.js line 147 confirms the wrapper signature
setLocalPan(userId, left, right). REA does not prove the native engine's curve.

Triscord now prefers a stereo output device format while retaining mono Opus on
the network. The participant context menu (cards and sidebar) adds an audio
position slider. Independent left/right PCM frames are mixed at the selected
per-user volume and mute, resampled independently, interleaved for the device,
and clipped. Center preserves the existing mono signal in both channels;
extreme positions silence the opposite channel. This is an explicit triscord
linear balance policy, not a claim that Discord uses the same curve.
A mono output falls back to unpanned mono, so a hard pan cannot silence its voice.
Surround output places left/right in the first two channels and mono in remaining
channels. Full surround speaker-position fidelity is not established.

Transport rebuilds clear old queued audio without discarding local per-peer
gain/mute/pan. Real peer departure and leaving the call discard those settings.
Closing a regular participant menu no longer accidentally compares an empty
selection to an unavailable moderation action.

Tests cover independent channels, centered and extreme positions, mute, clipping,
all four supported PCM sample formats, mono downmix, unequal channel rejection,
and sidebar context-menu adjustment retained on reopening. Existing voice/media
integration verifies transport and recovery separately. These checks do not
replace physical speaker/headphone listening or native Discord gain measurements.

## Local video disabling (0.9.3)

The Discord voice wrapper index.js line 148 exposes
setDisableLocalVideo(userId, disabled). REA semantic property analysis is retained
in desktop/out/discord-disable-video-rea.json (ev_8f8deffb777d721ac01a5c94250b48d275e08299dd533832fac3ed5ecb821b86; ambiguous, one property seed, zero traversed relations); it does not prove the native
engine's actual decoder or subscription policy.

Triscord's previous ScreenPane setter only stored a flag; rendering and decoding
did not consult it, and the participant menu did not expose it. The context menu
now offers "desligar vídeo para mim". Disabling clears cached frames and generation
mailboxes, releases the remote decoder, rejects future frames before decode, and
sends the existing room-scoped screen-watch control to the publisher. The publisher
skips that recipient when sending video. Call voice and screen audio are unchanged.
Enabling restores a new generation and requests a keyframe. The watch preference
is reannounced on media connection readiness and reset when leaving the room.
Old publishers can continue sending packets, but the updated receiver still skips
decoding; both updated executables are needed to avoid unnecessary video upload.

Tests cover membership validation, duplicate update suppression, rejecting late
UI frames, and video pause/resume with three actual encrypted media clients.
Voice, screen audio and a different stream continue during the pause. Both the
Node backend and the local Cloudflare Workers runtime passed this scenario.
This does not establish WAN/NAT behavior or measured CPU/network savings.
The sound playback test also now owns its callback context and buffer output
until the player is destroyed, fixing a discovered test-only lifetime failure.

## Independent screen-audio controls (0.9.4)

Discord's local voice wrapper forwards setLocalVolume and setLocalMute to a
connection instance (index.js lines 141-142). REA property analysis for
setLocalVolume is retained in desktop/out/discord-volume-rea.json:
ev_57e3979c735fb2122db77471610231c44f7825c35aaec2a21d04020b9afab172.
It finds one seed but remains ambiguous, with zero traversed relations and 173
relevant unknowns. This does not establish how Discord distinguishes voice and
Go Live connections, its gain law, or its persisted user preferences.

Triscord now implements independent local screen-audio volume (0-200%) and mute
through the existing ScreenAudio processing path. The participant context menu
has separate voice and screen controls. Screen gain/mute are applied to decoded
Opus before aggregate mixing, and consumed muted frames are not retained for
later replay. Current attenuation multiplies that local gain.

Stream settings survive jitter/transport rebuilds and toggling call audio;
real departure or leaving the room discards them. UI preferences now reset at
the same call boundaries as the media processors, fixing stale controls after
rejoining. Cross-call profile-persisted preferences remain unimplemented.

Tests feed actual Opus through ScreenAudio and check 4x energy at 200% gain,
zero energy when muted, retention after jitter reset and defaults after departure.
Three-client integration checks that stream mute leaves voice, video and another
screen's audio active, then verifies unmute/rejoin. UI tests check the controls,
retention on reopening the menu and defaults after rejoining a room. The local
Cloudflare Workers runtime also passed the three-client scenario.
No additional network service or paid media backend is introduced. Physical
speaker listening and full Discord gain/persistence equivalence remain unproven.

## Push-to-talk and global microphone shortcut (0.9.5)

Direct artifact observation: discord_voice/index.js line 175 forwards
setPTTActive(active, priority, muteOverride) to the native connection instance.
REA semantic property analysis is retained in desktop/out/discord-ptt-rea.json:
ev_a365cb07c0ce259c6fc61fc8cdc97b95456b076a948f27fbd678435a7e7400c7.
Its one matched property remains ambiguous, with no traversed relations and 173
relevant unknowns. Native priority/muteOverride semantics are not reconstructed.

The Windows client now offers "pressionar para falar" (off by default), a choice
of F6-F11 (default F8), and the optional Ctrl+Shift+M global microphone toggle.
Manual mute remains authoritative. In PTT mode the user enables the microphone,
then holds the selected key to transmit; release closes transmission. The actual
effective mute is sent to the room. Normal waiting for the PTT key no longer
produces the speaking-while-muted notice.

CallShortcuts owns Windows RegisterHotKey registrations only while audio is
active in the room. MOD_NOREPEAT prevents repeated toggles. The high bit of
GetAsyncKeyState checks the held key every 16 ms only during a press; that timer
stops on release/deactivation/reconfiguration. There is no keyboard polling in
idle state, global key hook, key history, or resource monitoring. Conflicts show
a simple actionable notice; PTT stays muted when registration fails.
Settings are local. Closing/leaving/disconnecting unregisters keys.

Authoritative API references:
https://learn.microsoft.com/en-in/windows/win32/api/winuser/nf-winuser-registerhotkey
https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate

The UI fixture verifies microphone state packets for hold/release, manual mute
override and switching back to continuous mode. A real Windows registration test
using F24 proves conflict detection, ownership and release (3 passed, 0 skipped).
It generates no physical keyboard input. Actual global activation, key release
timing and compatibility with games/elevated apps remain unverified. Arbitrary
custom chord binding and Discord priority semantics remain pending.

## Room microphone restriction (0.9.6)

Audit found that force-mute was only a transient isMuted update; participants
could immediately overwrite it with user-state-change. The control server now
owns isServerMuted independently of personal mute. Only the room owner can
toggle it; the owner menu can silence or release the microphone. Up to 200
profile IDs per room retain the restriction across same-profile rejoining.
The Worker stores it in the existing room record; the Node fallback retains it
only in its existing in-memory room lifetime.

Clients cannot set or clear the authoritative flag through normal user state.
Room join and member snapshots carry it. Native senders respect it independently
of manual mute/PTT; native receivers drop restricted voice before jitter/PCM
playout, clear queued voice and reset speaking activity. Releasing the restriction
keeps the participant manually muted until they choose to enable their mic.
Call audio, screen audio and screensharing are independent of this voice rule.

Tests verify overwrite attempts, non-owner release attempts and reconnecting the
same claimed profile on the Worker; Node tests verify overwrite/rejoin/release.
The three-client media fixture deliberately ignores the restriction at the
sender, keeps sending encrypted Opus, and checks that the receiver remains silent
while other voice, screen video and screen audio continue. Release/rejoin are
then exercised. UI tests verify that PTT/global mute cannot enable a restricted
mic and that owner release makes its button available again.

This is receiver-enforced P2P policy, not centralized media enforcement.
Every receiving app must be updated. Profiles remain client-claimed IDs, not
authenticated Discord accounts; changing claimed identity can evade profile
restrictions. Authenticated identity and complete permission parity remain pending.

Native REA analysis was attempted directly on discord_voice.node, retained at
desktop/out/discord-native-rea.json. It reports provider_unavailable: Ghidra/Java
are absent from the configured environment, Hopper is unsupported on Windows,
and IDA is not configured. No native behavior was reconstructed by that attempt.
A verified portable Ghidra/JDK toolchain is being prepared separately; downloads
and readiness do not count as native analysis completion.

Portable native-analysis runtime prepared locally:
Ghidra 12.1.4 archive SHA-256
ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db;
Temurin JDK 21.0.12.1+1 archive SHA-256
f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e.
Official release assets and checksums were recorded in
desktop/out/rea-native-runtime-plan.json and checked before extraction.
The tools live only under .toolchain/rea-runtime, outside the distributed app.
desktop/tools/analyze_native.ps1 binds this runtime for one CLI invocation and
restores the caller's environment afterwards. No REA setup/global agent or
system runtime configuration was modified. The Discord target is read as an
immutable analysis input; it is not launched as an executable.

First configured native import attempt terminated with provider_timeout at
330,000 ms (list_documents). The CLI exited and no Java process remained.
That terminal result is retained in desktop/out/discord-native-ghidra.json;
it supplies no completed native analysis evidence. The same complete target
is now retried with REA_GHIDRA_STARTUP_TIMEOUT_MS=1800000, after changing that
observed prerequisite. The development wrapper also binds/restores this timeout.
Its result is being retained in desktop/out/discord-native-ghidra-long.json.
Completion remains unproven until that process returns usable Evidence.

A silenced participant who inherits room ownership can explicitly release their
own restriction through their avatar/menu; the microphone stays manually muted.
This avoids trapping the next owner when the previous owner leaves.

## Sharing resolution and frame pacing (0.9.7)

The Discord wrapper exposes setDesktopSourceWithOptions(options) at index.js
line 166. REA property analysis is retained in
desktop/out/discord-source-options-rea.json. It remains a static ambiguous
boundary; the actual native option schema and adaptation policy are unproven.

The source picker now offers 480p/720p/1080p and 15/30/60 fps, saved locally.
720p30 remains the default 2.5 Mbps preset. The selected dimensions/fps/bitrate
reach capture, GPU conversion, hardware encoder and outgoing SDP video metadata.
Invalid configurations are rejected before disturbing a current stream.
Legacy calls without a preset retain their caller-selected constructor config.

Audit also found a hard-coded 66 ms focused render throttle (about 15 fps)
and a 1280x720 focused image cap. Focused rendering now follows negotiated fps
and retains the negotiated raster up to the existing 1920x1080 codec limit.
Secondary thumbnails retain the 200 ms / 320x180 path. The local capture preview
remains deliberately limited to 640x360; it is not evidence of outgoing quality.
Multiple stage focus, larger rasters and adaptive upload allocation still need
further implementation/verification.

Presets are bounded: 480p uses 0.8/1.2/2 Mbps, 720p 1.5/2.5/4 Mbps, and 1080p
3/5/8 Mbps for 15/30/60 fps. Every P2P viewer still adds outgoing media traffic.
Higher settings increase network, decoding and GUI work; no cost/subscription
check or paid media service is introduced.

All preset combinations pass codec/pacing checks and the UI exposes the choices.
A development-only fullhd60 GPU test actually encoded 30 frames, decoded 29,
verified colors/timestamps/forced IDR and late receiver recovery at 1920x1080
with a 60 fps media type on this PC. It does not establish real-time WGC delivery,
whole-client performance, Internet throughput or universal GPU capability.
The existing encrypted media integration is exercised separately.

## Completed native inventory and retained query session

The complete discord_voice.node overview succeeded with Ghidra 12.1.4:
ev_cd674dc4a72cb21ccd7c4459b66a080e9dac7c61ba1a29c7b0e1780a50345b21.
Target SHA-256 d85ef7059a7dd28732f23d157a8fdf965f8c6e394decd2a5293fbe62e3d4a0bc,
PE x86-64, immutable ephemeral import. Ghidra reports 11 segments, 34,241
procedures and 17,582 strings. CLI duration was 804,087 ms. These counts
establish completed inventory, not reconstruction of media algorithms.

Full local Evidence: desktop/out/discord-native-ghidra-long.json.
A separate development-only native_analysis_session.mjs now uses the installed
MCP client SDK (v2.3.1) to retain one REA target for read-only queries. It discovers
the actual 172-tool catalog, admits only read-only analysis/query tools, and
receives file-backed requests in a new session directory. It changes no agent
configuration and ships no SDK/JDK/Ghidra runtime in the client. The current
session is under desktop/out/native-session-20261013; readiness/status files
are not proof of a live process and must be revalidated through its tool handle.
Queued searches target setLocalVolume, setDesktopSourceWithOptions and setPTTActive.
Only returned query Evidence can establish their native addresses and references.

## Desktop notifications and native-session SDK repair (0.9.8)

The first persistent native query helper used the v1-style callTool parameter
position. The installed MCP client SDK v2.3.1 accepts options in the second
argument, so all three requests timed out at its default 60 seconds. Their
error records are preserved in desktop/out/native-session-20261013.
That session was closed through the SDK, its exec handle reached terminal
state and no Java process remained. The helper was corrected against the local
type declaration. A new session lives under desktop/out/native-session-20261013-r2
and is performing the same complete-target read-only searches with the intended
timeout. No timed-out response is treated as native evidence.

REA statically analyzed the selected Discord notifications module:
ev_ba2a6ddd48e34162128418caae5df9bf3071fc86d9cfdf55c156661af90e1c70,
99 relevant files, 94 parsed JavaScript files, no parse failures.
Full result: desktop/out/discord-notifications-rea.json.
Direct artifact inspection shows that index.js selects notifications_win on
Windows; notifications_win.js constructs electron.Notification with toast XML
(line 186). Static observations do not establish visible runtime behavior.

Triscord now routes background room entries and messages mentioning the local
name through a native Qt system-tray notification. The tray object is created
lazily on the first accepted notification. No browser, push service, image
download, timer polling or notification-history store is introduced.
The audio/settings dialog includes a saved Windows-notifications toggle.
Clicking the tray/message requests reopening the main window.

Name matching escapes regex metacharacters and uses Unicode-aware word boundaries;
it follows the legacy Triscord plain-name heuristic, not Discord's authenticated
mention IDs. Own messages, empty names and foreground events are suppressed.
Independent entry/mention rate guards bound bursts to one per type per 3 seconds.
History replay does not trigger notifications because only live message events
invoke the notifier.

Tests cover accents, escaped names, substring rejection, focus, own messages,
rate limiting and disabled preferences without generating OS notifications.
Actual Windows presentation/Focus Assist behavior remains unverified. Qt documents
that message visibility depends on system configuration/preferences:
https://doc.qt.io/qt-6.8/qsystemtrayicon.html
Rich toast actions/avatar images and authenticated mention IDs remain pending.

## Native audio dispatch and a decompiler control-flow gap

The retained REA session `desktop/out/native-session-20261013-r2` returned
native string locations, registration instructions and focused decompilations
for the unchanged `discord_voice.node` target identified above. These are
static observations, not proof of runtime equivalence with Triscord.

- `setLocalVolume` at `0x180ec8992` references the registration procedure
  `0x1800184b0`. Its descriptor associates callback `0x18004e390` with
  dispatch function `0x18002a610`. The dispatch calls the exported
  `discord::voice::Connection::SetUserPlayoutVolume` at `0x1801866c0`.
  REA evidence: `ev_67c71104fcef4c34aa19f3f8b4a0d714e488a8512859b011f4e592abe3024636`.
- The callback validates a numeric second argument representable as a float.
  It does not establish the UI slider range or a perceptual volume curve.
  Evidence: `ev_b4ca44522be6e0188ae739f1193da4d88b069f69cf30178cc1c62a38f0ceeaa9`.
- `SetUserPlayoutVolume` copies the user identifier and float into a task.
  The task's user lookup occurs at `0x1801909f0`. Its REA pseudocode
  incorrectly ends the successful lookup at the cookie-check call
  `0x180d120b0`; emitted instructions omit `0x180190a3c..0x180190a52`.
  Do not infer that the volume setter is inert from that pseudocode.
- Read-only GNU objdump from the existing MinGW toolchain confirms that
  cookie check has a successful `RET` at `0x180d120c4`, and that the omitted
  task tail jumps to `0x180163f30` with the user object and float gain.
  Raw bounded output is retained as `volume-task-gap-objdump.txt` and
  `cookie-check-objdump.txt` in the session directory. This corroboration
  does not modify the target or Ghidra database and is separate from REA Evidence.
- REA analysis of `0x180163f30` then shows storage of the user volume,
  multiplication by two other gain fields, bounding of the effective gain
  to 0..10 and dispatch to an audio interface. The roles of the other
  fields and downstream limiter are unknown. This does not justify changing
  Triscord's current 0..200% UI or claiming matching loudness.
  Evidence: `ev_343811a1a943b047b729feeff0af63240f3178d7b5caffc1f3388c9aace4c311`.
- `setPTTActive` at `0x180ec59b4` associates callback `0x180050d70` and
  dispatch `0x18002be60` with exported `SetPTTActive` at `0x180189c30`.
  The shipped JavaScript names its arguments active, priority and muteOverride.
  Native dispatch independently writes the priority flag and passes active
  plus muteOverride to `0x180176fc0`.
  Evidence: `ev_e6e91e8cceb4684f9978983e688975948be9f62101a8ccb2296c9ad54f467e31`.
- The PTT state routine uses distinct active/override sentinels and records
  a release timestamp using a counter/frequency conversion to nanoseconds.
  This establishes a timestamp-based state, not its downstream release policy.
  Evidence: `ev_08820fd73f92da338a25c26905c47690a885508107ebea885719d878680f022a`.
- `pttReleaseDelay` at `0x180eade61` is read as an option in
  `0x180006d70`; the current evidence does not establish the time unit,
  default, accepted user-facing range or consumer. Trace those before
  implementing a release delay in Triscord.
  Evidence: `ev_6693327336ac5d83c3ea0e15b0dd357d3fff5eabe046592ce4debc7009503e38`.

Full function results are the session's response-11 through response-36 JSON
files. Registration analysis exceeded the MCP inline result limit, while the
bounded instruction query succeeded. Retained resource-constraint responses
are not treated as negative findings. The native session remains open for
the next consumer queries; validate its live handle before using it.

No runtime media change or new client release is claimed for this investigation.
Next native steps: locate the PTT activation-state consumer and release-delay
unit/default, establish the gain fields and audio interface semantics, then
compare those observations with the existing Triscord implementation.

Follow-up: the PE export table locates `GetPTTActivationState` at
`0x180189c60`; its decorated signature explicitly accepts a
`std::chrono::duration<int64, ratio<1,1000>>`, i.e. milliseconds.
REA evidence `ev_896e93b84eb565720cda0277b9dd587e7fc66bafee0ee31c0057ad0be41cd7e8`
links it to `0x180177120`. The latter compares the current nanosecond counter
with the recorded release timestamp plus the passed delay multiplied by
1,000,000; zero delay returns inactive on release. Active/override sentinels
are handled separately. Evidence:
`ev_dede1b33327a15fce36bc52cd981bbe965af230962d6af226712b151817f6f29`.
The decompiler's inferred Boolean type obscures the override's third state;
do not collapse that internal enum solely from the printed return type.
The default delay and actual configuration-to-consumer mapping remain unknown.
Triscord currently closes PTT immediately on observed key release, so adjustable
release delay is now a concrete behavioral gap with native evidence. Implement
it without allowing a delayed close to override manual mute, room restrictions,
disconnect, or changed shortcut ownership. This investigation does not establish
Discord keyboard-hook behavior or support for arbitrary game shortcuts.

## Triscord PTT release-delay implementation (0.9.9)

The native timing evidence above now informs a separately written Triscord
implementation. Audio settings persist an optional 0..2000 ms release delay,
defaulting to 0 to retain the previous Triscord behavior. This range/default
is a Triscord product choice, not a recovered Discord configuration default.
`CallShortcuts` owns physical key state separately from the effective talking
gate. Observed release stops Win32 key polling and schedules one precise
single-shot close; a new press cancels that close without a spurious mute event.
Repeated release events do not extend the deadline. Deactivation, reconfiguration
and destruction cancel both timers and close the gate immediately.

The microphone policy still evaluates manual and server mute ahead of the
talking gate. A timer closing the gate cannot unmute either restriction.
Development tests exercise the real shortcut gate/event loop with explicit
key-state inputs, including repress, delayed release, zero delay, leaving/rejoining,
reconfiguration and disabled PTT. The room UI fixture exercises saved settings
and verifies manual mute during a release tail through signaling events.
This does not replace physical-key/game testing or establish Discord's priority
speaker/muteOverride equivalence; those native states remain separate pending work.

## Camera enumeration and native capture foundation

REA returned `getVideoInputDevices` at `0x180eb8201` and its registration
reference at `0x180013f07`. Registration associates callback `0x180008c20`,
which calls exported `Discord::GetVideoInputDevices` at `0x180098740`.
The exported signature returns a vector of `VideoInputDeviceDescription` through
a callback; its implementation includes queued/deferred task paths. This is
static API/task evidence, not measured runtime scheduling or device behavior.
Evidence: `ev_02531b2833990e3a3aa60a99670915dc5fd094f56108d26db059d4bee359b144`
and `ev_c8232b4d47aaba7afd3678dbd0f193391e503fadbb9cdd4206a84d727b835b49`.

REA's selection callback `0x180008670` invokes `Discord::SetVideoInputDevice`
with either an index or an identifier string. It explicitly rejects the wrong
argument kind. Evidence:
`ev_d4131403ff2fec76064d48e65c6ba7fdd5cc7b21936097d0ee60fb70e4cf49cb`.
These observations establish camera device selection as a missing Triscord
capability. They do not establish Discord format defaults, mirroring, background
segmentation, camera permissions or simultaneous stream transport semantics.

An independently implemented `CameraCapture` now uses the existing Qt Multimedia
runtime, `QCamera`, `QMediaCaptureSession` and `QVideoSink`. It selects a supplied
device ID exactly, handles removal and startup errors, and creates the capture
objects only on start. A missing selected ID does not silently choose another
camera. The camera callback retains only the latest native `QVideoFrame` under
a mutex; it never maps pixels or queues a history of images. Generation changes
discard frames from stopped/replaced sources. The delivery timer runs only while
capturing; stop clears both delivery and startup timers and releases the session.
The native format preference near 720p/30 is a Triscord choice, not a recovered
Discord default, and camera-driver output is not guaranteed to match it exactly.

This library currently connects only to separate development tests/probes.
It is not linked into the distributed client. No new client release or working
camera transmission is claimed. The webcam must remain a separate media source
so it can eventually coexist with screen sharing. Next integration work needs
worker-owned asynchronous device enumeration/capture, independent camera signaling
and P2P transport, participant rendering, and background effects. Synchronous Qt
device enumeration must not be called from the interactive UI path.

The first camera CTest run hit its 15-second observation timeout. A later explicit
test run passed all three cases (five QtTest results including init/cleanup) in
142 ms. The reason for the initial delay is unproven; do not describe it as a
fixed driver defect. The hardware probe subsequently reported zero connected
cameras, so physical frame delivery/removal/permission behavior is unverified.
The desktop executable remains 0.9.9 with SHA-256
`5686eac3d1116704cfba4d504a5c90acc8c70a6933ec771241e916c2a4b1abda`.

Qt API references:
https://doc.qt.io/qt-6.8/qcamera.html,
https://doc.qt.io/qt-6.8/qvideosink.html,
https://doc.qt.io/qt-6.8/qmediacapturesession.html.

Subsequent execution evidence narrows the timeout issue: a full CTest run with
implicit QtTest output also timed out existing UI/voice tests and produced no
QtTest text for tests that eventually returned success. That run was interrupted;
it does not establish assertion coverage. The same UI executable with explicit
file logging passed eight QtTest results in 6.233 seconds. Changing only the
generated camera CTest command to an explicit QtTest file logger made it pass
in 0.19 seconds. The exact underlying Windows console/handle behavior remains
unknown, but this comparison supports changing the development runner rather
than changing camera/media logic or relaxing assertion timeouts.

CMake now supplies a separate explicit text report for each QtTest suite under
`desktop/out/build/qt-test-results`; the development test script prints assertion
failure reports before returning failure. The final build succeeded and all nine
native CTest suites passed in 11.44 seconds, including the camera suite in 0.23
seconds. These reports provide actual QtTest assertions as well as exit status.
The final integration result is retained separately in
`desktop/out/camera-foundation-tests-final.log`.

## External encoder recovery and integration follow-up

The subsequent media integration run timed out after joining three local clients.
Repeating it with file-backed stdout/stderr did not resolve the timeout, so output
redirection is not treated as a screen-transport fix. The integration helper now
retains those streams through timeout handling to give useful failure evidence.
Temporary development-only stage prints made a later run pass; that observation
alone was not treated as a fix and the prints were removed.

Source inspection found a concrete external-encoder gap: native capture answered
peer-ready, RTCP keyframe and resumed-viewer requests through `encoder_`, but the
injected/external source path owned no `encoder_` and discarded those requests.
`ScreenCall` now routes them through `requestLocalKeyframe`; an active external
source emits `keyframeRequested` through `ScreenService` to its encoder owner.
Remote PLI callbacks validate the current peer session before requesting a frame.
The existing native capture path still uses its own encoder directly.

The screen-room development tool connects this signal to its actual software
encoder and removes the manual 100 ms keyframe workaround after viewer resume.
A unit check covers known viewers, outsider rejection, an inactive source and
stop. The uninstrumented full development suite then passed all nine native
groups and local signaling/voice/screen integration, including pause/resume,
rejoin, independent stream audio and room-mute enforcement. Its output is in
`desktop/out/camera-keyframe-tests.log`; the final rebuild after adding the
session guard is verified separately in `camera-keyframe-tests-final.log`.
The omission is established independently from the intermittent timeout's full
cause; this does not prove every prior hang had that cause.

This recovery route is also required when connecting the separately owned
webcam encoder. Camera transmission, hardware capture and background effects
remain incomplete; no new camera UI or release is claimed here.

## Asynchronous camera service and cancellation

The callback/deferred paths in the previously retained native
`Discord::GetVideoInputDevices` analysis inform the next independently written
Triscord boundary. `CameraService` is a UI-facing facade; its thread and
`CameraWorker` are created only on the first device request or start. Device
enumeration, `CameraCapture` creation and capture shutdown run on that worker.
No native reimport or new Discord runtime observation is claimed for this step.

Device queries carry a request number so only the newest result reaches the
consumer. Capture commands carry a separate generation shared through an atomic
desired-generation value. A canceled start is skipped before opening the source;
the capture component checks cancellation again after device enumeration and
before starting the camera. Stop immediately invalidates UI frame delivery,
then schedules native cleanup. Old status/error replies cannot reactivate a
newer selection or show a canceled-start error.

The camera callback buffer and the worker-to-UI buffer each retain at most one
native frame. Only one UI notification is pending; a pending old notification
can deliver the newest valid selection instead of accumulating frame history.
The direct capture callback owns only its shared buffer. Worker-to-UI callbacks
are receiver-scoped; final service destruction stops/joins the worker before
destroying the facade. Destruction still waits for the provider to return;
physical driver stalls and close latency remain unverified, not guaranteed away.

The development camera probe now uses the asynchronous service too. Its latest
run reported zero available cameras and skipped physical capture. All six camera
test cases passed (eight QtTest results including init/cleanup) in 288 ms:
latest-frame retention, source replacement, one pending notification, lazy worker
startup, canceled starts, newest device result, UI callback affinity, shutdown
dropping queued replies and missing-device behavior. The final CTest camera group
passed in 0.41 seconds. Build evidence is in `desktop/out/camera-service-build.log`;
the assertion report is `desktop/out/build/qt-test-results/native-camera.txt`.

The library remains development-only and is not connected to camera encoding,
P2P publication, participant rendering or background effects yet. Those are the
next required steps; this facade alone is not a working call webcam. The desktop
client remains the previously shipped 0.9.9 executable.

## Native camera encoding stage

`CameraEncoder` independently adapts Qt native frames to the existing Media
Foundation H.264 pipeline. This implements the next required media boundary;
no new Discord decompilation or physical camera observation is claimed here.
It must be created, used and destroyed on an MTA media thread. The first codec
test attempted construction on QApplication's GUI thread and threw an unhandled
exception; the corrected test uses an actual MTA worker and reports exceptions
back to QtTest. Codec COM requirements were preserved rather than relaxed for UI
construction. Camera capture and encoding are not connected yet, and the actual
capture-provider apartment behavior remains to be verified during integration.

Matching NV12 dimensions, full viewport, top-down layout, BT.709 limited range
and no frame rotation use a direct plane-packing path. It validates both strides
and plane lengths before reading. Software encoding uses the packed bytes;
device-aware hardware encoding uses a fresh immutable NV12 texture. Other SDR
inputs use Qt image conversion, orientation correction and the existing D3D11
video processor for aspect-preserving scaling and color conversion. Hardware
encoding retains immutable output textures; software RGB input uses a bounded
staging/readback resource. Busy encoder input is rejected before pixel conversion.
No extra capture timer, transport, recording or frame-history queue is introduced.

Selfie mirroring remains a local presentation choice instead of reversing remote
pixels. Frame rotation is applied to the encoded image. These are Triscord choices,
not recovered Discord defaults. Qt documents that frame-level transformations
do not affect `toImage`; native timestamps are in microseconds, whereas this codec
interface explicitly accepts Media Foundation's 100 ns units. A future capture
bridge must normalize that clock rather than passing timestamps unchanged:
https://doc.qt.io/qt-6.8/qvideoframe.html#toImage,
https://doc.qt.io/qt-6.8/qvideoframe.html#startTime.

The encoder currently rejects PQ/HLG HDR instead of silently applying an SDR
matrix without tone mapping. SDR inputs are limited to 4096x2160 before conversion;
output follows the existing validated VideoConfig. HDR/tone mapping and direct
Qt GPU-surface interoperability remain pending. The RGB path still performs a
Qt image conversion and upload; it is not proven zero-copy or a resource benchmark.

All nine camera test cases passed (eleven QtTest results including setup/cleanup),
covering native padded-stride roundtrip, decoded pixels/dimensions/timestamps,
forced IDR, truncated planes, invalid timestamps, rotation, local mirror policy,
HDR rejection and the prior lifecycle/cancellation checks. Assertion output is
`desktop/out/build/qt-test-results/native-camera.txt`.

The separate synthetic encoding probe initially failed hardware completion: its
30 submitted inputs produced 29 decoded outputs because the live codec retained
a tail frame. The probe now maintains continuous input with at most one tail
frame and still validates at least the first 30 decoded outputs. No codec timeout
or pixel assertion was relaxed. Final observed results on this PC:

- RGB/rotation hardware: 31 submitted, 30 decoded, 15 late-decoder frames.
- RGB/rotation software: 30 submitted, 30 decoded, 15 late-decoder frames.
- Direct NV12 hardware: 31 submitted, 30 decoded, 15 late-decoder frames.

All three verified image content, output dimensions, timestamps and recovery;
RGB runs also verified rotation and portrait letterboxing. Evidence is retained
in `camera-encoder-hardware-final.log`, `camera-encoder-software-final.log` and
`camera-encoder-native-hardware.log` under desktop/out. These are synthetic-frame
GPU/codec checks, not physical camera capture, realtime load measurements or WAN
transport proof. Camera encoding still needs to be connected to capture, separate
P2P camera signaling, participant presentation and background effects. No new
distributed camera feature or executable release is claimed.

## Independent camera and screen media roles (0.9.10)

The coordinator now distinguishes camera from screen media. Camera uses
`native-camera`, `isCameraOn` and `camera-watch`; screen retains its original
signaling type, sharing flag and viewer event. Each coordinator owns its own
peer sessions, generations, decoder state and watch preferences. `External`
source mode accepts producer-owned encoded video while retaining production
STUN/ICE configuration; `Injected` remains the isolated local-test mode.
No new native Discord behavior is claimed beyond the existing observations of
separate input-camera and desktop-source APIs. Independent P2P connections are
Triscord's free infrastructure choice, not a recovered Discord implementation.

Camera peers negotiate only video with the camera MID. They do not construct
the screen-audio RTP track, and their coordinator rejects stream-audio sends.
The Node fallback and Cloudflare control Worker relay camera viewer events only
within the current room. The Worker accepts the separate camera signaling type;
its existing camera state field is used without changing storage schema or
introducing SFU/media traffic, subscriptions or additional hosted resources.

The first synthetic dual-source integration failed when one camera stopped:
the remote-sharing state update rebuilt a duplex peer on only one side, losing
the other publisher's video. That underlying coordinator bug also applied to
screen media. Stopping remote publication now drops its decoder/frame generation
but retains the peer if our own publication is still active. Starting a remote
source still rebuilds for fresh session/configuration negotiation.

The uninstrumented two-client integration exchanged screen and camera H.264
simultaneously, verified distinct image content for the two roles, then stopped
one camera and verified continued delivery of both screens and the other camera.
The complete development suite passed nine native CTest groups in 12.76 seconds,
local voice with 2/3/10 clients, three-client screen/voice/audio recovery,
moderation enforcement and the new dual-video scenario. Output is retained in
`desktop/out/dual-video-final-tests.log`. Qt checks additionally verify independent
state/watch events and a camera SDP without an audio section. Local Miniflare
control tests passed in `cloudflare/out/camera-control-tests.log`.

The existing Worker was deployed successfully with version ID
`34b75e32-34e8-46db-beef-a9a01c554080`. Endpoint and Free deployment configuration
are unchanged. Deployment success does not establish live camera-media behavior;
the full camera transport test used the local Node signaling fixture.

The final 0.9.10 package starts and excludes development commands/tools. Its
Desktop copy matches SHA-256
`7b18abcb6650d92e350a122b08944db4f018566d681b1f59a86f97f38866567b`.
The distributed client receives the coordinator fix; the camera foundations and
encoding probes remain development-only. Capture-to-encoder binding, clock
normalization, call-camera controls, participant rendering, background effects
and physical/WAN camera testing remain required. This is not a completed webcam
feature or a completed Discord reconstruction.

## Camera publisher pipeline and frontend evidence (2026-10-14)

`CameraPublisher` now binds asynchronous native capture to `CameraEncoder` and
the independent camera transport. Capture retains the latest frame, posts at most
one encoder notification, and rejects obsolete source generations. Encoding and
network delivery share a worker thread; timestamps use that worker's monotonic
clock in 100 ns units. The GUI does not carry encoded video. Local previews and
remote participant images use a generation-aware coalescing mailbox. Preview and
remote card rendering are limited to five updates per second; this does not set
the transmitted camera frame rate. Stop joins capture before destroying the
publisher worker. Mirroring is applied only to the local preview.

The dual-video development test now feeds raw generated `QVideoFrame` images
through the publisher, rather than feeding pre-encoded camera packets through
`ScreenService`. It verifies decoded pixels for each media role and continued
screen/other-camera delivery after stopping one publisher. A final check also
requires local previews and verifies they stop with their camera. The full suite
passed nine CTest suites and the existing signaling, chat, voice, reconnection,
screen/audio, moderation and feature-policy integrations in
`desktop/out/camera-publisher-tests.log`. The final preview assertions passed in
`desktop/out/camera-publisher-final-integration.log` after rebuilding. An initial
standalone invocation lacked the Qt runtime PATH and exited before the test;
rerunning with the build toolchain PATH passed without changing assertions.

This pipeline is an independent implementation, not a recovered Discord encoder
implementation. Camera controls, participant rendering, effects and physical/WAN
validation remain pending. The Desktop executable remains 0.9.10; no user-visible
webcam release is claimed at this stage.

For frontend reconstruction, REA analyzed the installed desktop-core `core.asar`
without executing Discord. The retained evidence is
`desktop/out/discord-core-ui-rea.json`, evidence ID
`ev_ca811d190d41a8e23e31ebf3b1a6246f5a52ab844a7824fb2a5f1090b8a3b72c`.
The archive SHA-256 is
`396088f647b3084fc3b6efedd7c5e50eb4d7b9575b817e9b689ff739a54e0c04`.
REA parsed two JavaScript files from three relevant files without parse failures
or integrity contradictions. These static bundle relationships do not establish
the call UI's runtime layout.

Read-only inspection of the local Chromium cache recovered a Brotli-compressed
external CSS payload. Its compressed SHA-256 is
`f147b8fb80e2cf2c9d81d27c1407f05490a0cba13e490ae3f358e1f78e8b2c54`;
the decoded 777301-byte stylesheet SHA-256 is
`cc0b5768c69332c1964fb2bf82329dad403ab63d5059cf33b99c86475912ea22`.
Both provenance and the recovered stylesheet are retained under
`desktop/out/discord-ui-cache`. It contains theme tokens and font declarations,
but the targeted call-tile/control selectors were not recovered. Cache-entry URL
mapping is also unresolved. No layout measurements or reconstructed call UI are
claimed from this base stylesheet. Discord assets are not packaged in triscord.

## Recovered call styles and native camera controls (0.9.11)

The earlier CSS coverage gap was resolved by reading Chromium blockfile entry
records and their body stream addresses. `tools/recover_discord_styles.cjs` only
exports bodies whose cache keys end in a public `discord.com/assets/*.css` URL.
It does not export response headers or private application responses and never
writes to Discord's cache. The binary layout follows Chromium's
[address definition](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/disk_cache/blockfile/addr.h),
[entry format](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/disk_cache/blockfile/disk_format.h)
and [block header](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/disk_cache/blockfile/disk_format_base.h).
The manifest records body hashes, sizes, decompression and entry offsets. This
is read-only supplementary artifact recovery alongside the REA core analysis.
It is not runtime inspection or recovered React component logic.

The recovery produced 682 CSS bodies and zero body recovery errors, retained in
`desktop/out/discord-styles-recovered-20261014`. Scanning entry blocks rather than
the live index can include stale records; the live cache is not an atomic snapshot.
Key-to-body mappings are now recovered, but CSS rules alone cannot establish
which variant Discord selected for a particular call or viewport.

Observed rules relevant to the native call cards:

- `613085.9c29529a66c3ebd1.css`, SHA-256
  `a748edc911ac745c3992b3645a472d8abe9d406bafd3b6d7023940cdf838bd7b`:
  `.tile__90dc5` uses a relative container, hidden overflow and a shared radius.
- `655282.7b25cb505483f3c7.css`, SHA-256
  `af24b2ad42907c149c6fb9403651ddebf8c4645786e7c256a02d0d15cf6b8a0f`:
  `.content__2f4f7` centers media in a clipped absolute-fill container;
  `.overlayContainer__2f4f7` has a 12px margin; `.overlayBottom__2f4f7` places
  overlays at the bottom; title text elides; the border covers the card.
- `245851.67dd5621b4da0e9a.css`, SHA-256
  `13cb15da67b5e4299de53da3f81f0fba9a545c87b6e6260b765dbf5215b3fabe`:
  `.tile__2aff1` declares 16:9, an 8px radius and an 8px inter-tile margin.

Qt cards now use these observed structural choices: centered aspect-preserving
video, clipped rounded cards and an elided bottom name overlay. Applying 16:9
to the main participant grid is a reconstruction choice, not proof that every
Discord grid variant uses that aspect ratio. AMOLED colors, lowercase labels,
white speaking borders and omitted transitions follow the user's explicit
preferences. Original styles, images and fonts are not bundled.

The footer camera toggle starts/stops the independent publisher; settings expose
asynchronous device enumeration and selection. Device changes restart capture;
failures reset the toggle and show a short actionable message. Room changes,
leave and disconnect stop capture and clear camera session state. Card images
only attach to known room participants, retain the latest image and are cleared
when that participant leaves. Camera preview rendering remains capped at 5 fps.

Nine CTest suites and all existing local media/signaling integrations passed in
`desktop/out/camera-ui-tests.log`. UI coverage verifies the camera control becomes
available only after joining and that card images reject unknown participants,
render, disappear on removal and do not survive leave/rejoin. Rendered UI and
settings were visually inspected. The camera-card image is a synthetic gray
fixture, not evidence of physical capture. Physical/WAN validation, background
effects, camera focus/fullscreen and broader frontend reconstruction remain open.

The release package passes startup, development-command exclusion and runtime-only
dependency checks in `desktop/out/camera-ui-package.log`. The first portable
verification missed the newly launched child in its immediate process snapshot;
the exact expected executable was subsequently observed running. The external
verifier now polls for up to five seconds while preserving the exact parent and
executable-path checks. Both launches and runtime hash/cache reuse checks pass in
`desktop/out/camera-ui-portable-tests.log`. No client diagnostics were added.
Version 0.9.11 was copied to `C:/Users/camargo/Desktop/triscord.exe`; its SHA-256
matches the built portable file:
`0c8ce50943b7653a7ac1dff0f9510d4b91c87e4337298c110ba000f24bb3ecf7`.

## Recovered participant selection/fullscreen behavior (0.9.12)

The read-only cache recovery tool can now select public call-related JavaScript
bodies for inert analysis. Initial class-name matching recovered only three CSS
mapping chunks; following their numeric Webpack module consumers recovered nine
assets, including the web bootstrap and eight smaller call-related chunks. REA
analyzed the eight smaller chunks in
`desktop/out/discord-call-components-rea.json`, evidence ID
`ev_325575d4541fa048fc7069631590d18401899da18007c22fa8b31df6ab366273`.
Its report contains 163 recovered modules, eight parsed files, 87248 visited AST
nodes and no parse failures. Bundle bootstrap code was not executed. Public URLs,
source entry offsets, sizes and body hashes remain in the recovery manifest.

Two relevant retained bodies are `11c4f14f11748a08.js`, SHA-256
`c86acc3015f8cf9d14cb65696e5d6f516a1bb62b016aa97b141848bba3afd159`,
and `2bd6e4e05647f388.js`, SHA-256
`9a45b0c594c7deae1ea59db003d678ccb11dd80700ab605dd513a3cc03248422`.
The former consumes style module 584841 and exposes tile props including selected,
focused, onClick, onDoubleClick and a contain-fit default. The latter forwards
participant selection and fullscreen actions separately: its grid passes the
selection callback as onClick and the fullscreen callback as onDoubleClick.
`handleSelectParticipant` selects the participant or clears it when it is already
selected, while in an active video call. `handleFullscreenParticipant` coordinates
selection and fullscreen toggling. `handleFullScreen` remembers the prior layout;
leaving fullscreen restores that layout. These are observations of inert shipped
frontend code, not proof of a currently selected runtime variant. The profile
cache can contain historical web bundles independently of the installed desktop
core version; exact runtime/version association remains unverified.

Native participant cards now toggle camera focus on click and open fullscreen on
double click. The full-screen view reuses the existing native video stage's wheel
zoom/pan/reset controls. Escape returns to the preceding inline layout; double
clicking the unzoomed full-screen image returns to the grid. Removing the selected
camera closes its view and clears image/zoom state. Card hit testing retains the
clicked participant across the layout change caused by the first click. Focused
card height is capped at 240px inside the existing compact call area; this is a
native layout adaptation, not a recovered Discord numeric constraint.

`CameraPublisher::setFocus` selects the full-size remote render path, or a 1280x720
local preview at up to 30 fps. Other remote cards remain 320x180 at up to five
render updates per second; card image updates are also throttled at the widget.
The full-screen view retains a single current image. No additional encoder,
capture session, packet history, server stream or monitoring loop is created.
This reduces render/conversion work, not the camera P2P network bitrate or the
decoder's coded resolution.

The focus integration exposed a prior bug: `ScreenCall::leave` cleared its focus
selection, so a later join could render every camera at full resolution. The
camera worker now reapplies its grid/selected focus on every room-ready event.
The two-client camera/screen test asserts default remote images are 320x180,
then selects one remote and one local preview and requires 1280x720 output. It
still checks role pixels and continued independent streams after stopping one
camera. The full nine-suite and integration run passed in
`desktop/out/camera-focus-final-tests.log`. UI tests additionally cover selection
toggle, fullscreen, zoom reset, Escape, frame-source isolation and removed-camera
cleanup. Physical/WAN capture, background effects and further frontend components
remain incomplete; this is not a completed Discord reconstruction.

Final UI checks additionally select/fullscreen the second participant after the
first click rearranges the grid, and pass in
`desktop/out/camera-focus-ui-final-tests.log`. The focused-layout image was
visually inspected using a synthetic color fixture. Stricter role-specific media
checks reject full-size remote delivery on the unfocused client and full-size
local preview on the client focusing a remote participant; they pass in
`desktop/out/camera-focus-media-final-tests.log`.

The portable check exposed the actual cause of the earlier initial-launch
observation failure: this packaged Windows host redirects LocalAppData, and a
path resolved before extraction can differ from its final existing-file path.
The client was present with the launcher's exact parent PID, but the verifier's
frozen pre-extraction canonical path rejected it. `verify_portable.py` now retains
the logical expected path and resolves it while the child exists, preserving
exact executable and parent checks. This corrects the earlier timing hypothesis;
no client startup workaround or monitoring was added. Package/startup and final
portable runtime hash/reuse checks pass in `camera-focus-package.log` and
`camera-focus-portable-final-tests.log` respectively under `desktop/out`.

The 0.9.12 executable was copied to `C:/Users/camargo/Desktop/triscord.exe` and
matches the portable build SHA-256:
`3212cebb13288da66826d9c90fd12a8b1ee4e35e208d84dcab6c6c8c8a77ab41`.

## Background segmentation evidence and native mask foundation

The installed voice module contains `selfie_segmentation_landscape.tflite` and
`selfie_segmentation.tflite`. Independently downloading both from the public
[Google MediaPipe model links](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/models.md)
produced byte-identical SHA-256 hashes:

- Landscape: `a77d03f4659b9f6b6c1f5106947bf40e99d7655094b6527f214ea7d451106edd`.
- General: `9ee168ec7c8f2a16c56fe8e1cfbc514974cbbb7e434051b455635f1bd1462f5c`.

The retained read-only native REA session was revalidated live before querying.
String evidence `response-47-effects.json` has ID
`ev_e0fffb3250a3b017b052b0c1b4dec5b487013684ba947d5e398f52ab126ef275`.
It recovered embedded blur/replacement graphs with a flow limiter, segmentation,
two bilateral mask filters, a previous-mask loop and temporal smoothing. Blur uses
a mask overlay; replacement uses a light-wrap calculator configured with a
confidence threshold. The blur graph begins at `0x180d9fc40`; xrefs at
`0x1801f1e70` and `0x1801f1e77` are retained in `response-49-effects-xrefs.json`, ID
`ev_5ed9a4e2a2b20dbf552c573f21fdf45f8c3fa7ad4fff49c3e3a263d749387481`.
The containing function `FUN_1801f1c80` was analyzed in
`response-50-effects-constructor.json`, ID
`ev_b285bc5a6d302555ab6ce2be899d6a96be31a3b33bc654e41f3cbddcc67360f8`.
Its decompilation shows a default smoothing ratio of float32 0.95 and default blur
iterations of five, with optional overrides. These are derived static observations;
the original Discord executable was not run and runtime option selection remains
unverified. Complete records remain under `desktop/out/native-session-20261013-r2`.

`export_selfie_model.py` exports only the pinned public landscape model. It rejects
unknown source hashes/operators/options and preserves float16-to-float32 weights,
convolution layouts, resize coordinates and the MediaPipe transpose-convolution
with bias. The custom operator was checked against the
[public kernel](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/util/tflite/operations/transpose_conv_bias.cc);
its raw options in this model specify SAME padding and strides 2x2. The exported
246-node ONNX file is 441922 bytes, hash
`fc319dd58d764b242e8c13e53ac8be3e210769b0a02f458bff6e55540358e1e3`.
Input is float32 NHWC 1x144x256x3; output is 1x144x256x1. Schema/shape checks passed.
Google's [input graph](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/selfie_segmentation/selfie_segmentation_cpu.pbtxt)
specifies RGB float range 0..1 and resizing without retaining aspect ratio.

The external `verify_selfie_model.py` compares three synthetic inputs with an
independent NumPy evaluator. Final mask error was below 9e-8, and 136 operator
outputs were checked with identical runtime upstream values, with maximum local
error below 4.6e-5. Comparing every independently propagated intermediate using
the same tight tolerance initially failed; the final report retains that drift
separately (up to 0.01154 for the zero input) rather than hiding it or weakening
the local-operator gate. This is evidence of the tested mathematical contracts,
not TensorFlow Lite execution equivalence or real-person segmentation accuracy.
Synthetic scenes produced near-background masks; real foreground/boundary cases
are still required. Results are in `desktop/out/camera-model-reference.json` and
`camera-model-reference-final.log`.

On this PC, ONNX Runtime 1.31.0 CPU inference with one thread, five warmups and
twenty timed runs per case measured medians of 1.92..2.14 ms and p95 up to 2.47 ms.
These are external development measurements in an unisolated environment, not
total effect latency or measurements from the distributed client. Testing-only
packages were installed under `.toolchain/camera-effects/python`; Python and model
testing libraries are not shipped. Converted model files also remain development
artifacts. Choosing the landscape variant is a performance decision based on its
smaller input, not proof that Discord always selects it.

`CameraMaskSmoother` implements the uncertainty-weighted temporal algorithm from
the public [MediaPipe smoother](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/calculators/image/segmentation_smoothing_calculator.cc)
with the recovered default ratio. It retains one previous model-resolution mask,
rejects invalid sizes/probabilities before changing state, resets on dimensions
changing and releases its buffer on reset. It has no thread, timer or resource
monitor. A first test incorrectly expected perfect 0/1 endpoints; MediaPipe's
polynomial has a small endpoint residual. Reference-valued assertions now check
that behavior instead of altering the algorithm. All 13 camera QtTest results
passed in `desktop/out/camera-mask-final-tests.log` and the Qt test report.
The Apache-2.0 license is preserved with media notices for future redistribution.

This component is not invoked by the camera publisher yet. Native inference
loading, spatial filtering/composition, the effects selector/frontend and tests
with people/camera hardware/WAN remain incomplete. The Desktop executable stays
at 0.9.12; no operational background-effect release is claimed here.

## Native inference and GPU composition foundation

`CameraSegmenter` now loads the CPU ONNX Runtime through its public C ABI, using
absolute paths and the pinned exported model digest. RAII releases values,
sessions, options, memory information, environment and module on failure/close.
Input/output tensor buffers are allocated once and reused. Input images are
converted to RGB, stretched using bilinear pixel-center sampling and normalized
to float 0..1. Oversized/empty images and invalid output probabilities are rejected.
The runtime uses sequential execution with one intra/inter-op thread, spinning
disabled and telemetry explicitly disabled. No resource monitoring/profiling loop
is added. The object is intended for the existing media worker, created only
while an effect is active; it is not constructed by the client yet.

The SDK C headers are fetched by content-pinned SHA-256 from ONNX Runtime v1.31.0,
with TLS verification, and remain private to the effects library. The
[public API](https://github.com/microsoft/onnxruntime/blob/v1.31.0/include/onnxruntime/core/session/onnxruntime_c_api.h)
supports caller-owned tensor buffers and the loader's resource-release contracts.
The MIT license is included among media notices. The tested DLL came from the
development-only ONNX Runtime wheel. Its dependencies include Microsoft's Visual
C++ runtime; packaging those prerequisites is still required before distributing
effects. No Python runtime or wheel contents were added to the client package.

The standalone `triscord-camera-effects-smoke` generated three RGB fixtures:
256x144 (model size), 391x211 (1176-byte padded rows) and 1x1. It rejects empty
and oversize images, then continues successfully using the same session.
`verify_native_segmenter.py` independently performs resizing/normalization and
compares ONNX masks against the C++ outputs. All three cases had zero maximum
absolute error. This includes a nonzero mask maximum of 0.219505 for the
model-size fixture, but is not real-person accuracy evidence. Results are in
`desktop/out/camera-native-inference-r2/comparison.json` and
`desktop/out/camera-native-comparison.log`. Twenty externally timed runs after
five warmups measured medians of 2.52..2.72 ms for C++ preprocessing/inference
on these fixtures. Composition and complete effect latency are not included.

`CameraGpuComposite` implements the alpha blend primitive needed by the recovered
mask-overlay pipeline: foreground and alternative background are sampled with
a clamped bilinear sampler, mixed by the normalized mask and rendered opaque.
It requires single-mip, single-sample surfaces from the same device, produces
output at the foreground's dimensions, unbinds sampled inputs and returns a fresh
BGRA surface. Output is never recycled while downstream encoding may retain it.
The replacement image is currently sampled by normalized coordinates; aspect-fit
policy, confidence-threshold mapping and the recovered spatial/blur stages are
not implemented by this primitive. No complete LightWrap equivalence is claimed.

The WARP GPU test checks 0/1/0.25 alpha pixels, verifies an earlier output remains
unchanged after a subsequent blend and rejects missing/wrong-format surfaces.
All 14 camera QtTest results passed, and all nine native CTest suites passed in
`desktop/out/native-effects-final-tests.log`. Native image comparisons and GPU
readback are development-only tools/tests. Hardware GPU performance, people,
physical cameras, integrated encoding and WAN effects remain unverified.

Effects components are organized in a separate native library; the camera target
uses its temporal smoother through that dependency. Neither segmentation nor GPU
composition is connected to `CameraPublisher` yet, and the effects selector is
not exposed. The Desktop executable remains 0.9.12. Spatial filtering/blur,
publication integration, frontend reconstruction and runtime packaging remain
the next required steps toward operational background effects.

The final strict-warning build is recorded in `native-effects-clean-build.log`.
After the typed dynamic-entrypoint conversion change, all three native fixtures
were regenerated and again matched the reference with zero maximum mask error
in `camera-native-comparison-final.log` and
`camera-native-inference-r3/comparison.json`, under `desktop/out`. The native
camera suite also passes with the new library's normal warning settings. No
effects runtime was copied into the Desktop package during this stage.

## Recovered masked blur kernel and GPU mask processing

Further inspection located the actual effect shaders in the separate installed
`mediapipe.dll`, rather than `discord_voice.node`. REA artifact inspection is
retained in `desktop/out/discord-mediapipe-artifact-rea.json`, evidence ID
`ev_43cdb7b9f7eeca885803a2b8e9a0e2c2f946a819c3e5c7f19c4f271b6b250dea`.
The DLL SHA-256 is
`f034ba689f0847105190e57da6e8f8f48318914f0f2af1ab2301fb2a0ebdff68`.
Read-only string recovery produced shader fragments and byte offsets under
`desktop/out/mediapipe-shaders-20261014`, preserving the original file unchanged.
Those ignored evidence files are not distributed with triscord.

Fragment 10, starting at file offset 6996672, contains a directional Gaussian
kernel with center weight and three paired positive/negative offsets. Neighbor
samples are mixed toward the center color using the neighbor's segmentation
mask before being weighted. This protects the foreground from spreading into
the blurred background. `CameraGpuComposite::blurPass` ports that mathematical
kernel into HLSL with explicit horizontal/vertical pixel directions and fresh
immutable output. It does not yet reconstruct the calculator's complete
iteration/downsampling schedule; the recovered default of five iterations alone
does not establish that schedule.

Fragment 11 at offset 6999488 contains replacement confidence gating: mask
weight below the threshold becomes zero, otherwise the original mask weight is
used. `blend` now supports that rule. Node-module REA xrefs lead to
`FUN_1801f2040`; its optional confidence field defaults to zero, and its smoothing
field defaults to 0.95. The decompilation is retained in
`native-session-20261014-effects-r1/response-04-replacement-constructor.json`, ID
`ev_18aea000c8954bac96762a015eb95f2f4ed07b276f74f01fb1d91e2d8b24e826`.
This is static evidence, not a runtime option trace.

GPU spatial filtering follows the recovered 10/3 spatial sigma stages and 0.3
color sigma, with the public MediaPipe subsampling and Gaussian equations. The
scalar R32 mask representation is an implementation choice; RGB-mask equivalence
is not assumed. Initial CPU comparisons failed by around 0.0006 with hardware
bilinear sampling; assuming a particular fixed-point rounding rule did not fix
the discrepancy. Direct3D permits limited subtexel precision, as described in its
[sampling specification](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm).
The scalar mask path now performs explicit float bilinear interpolation via
texture loads. The original test tolerance was preserved and passes against the
independent reference; the color blur continues to use linear texture sampling.

Temporal smoothing also has a GPU pass with the same uncertainty polynomial and
0.95 default. A missing previous mask produces a fresh copy of the current mask;
the caller retains at most one previous output. Common shader/view/draw handling
is shared by the four passes and sampled resources are unbound after each draw.
No additional capture, encoder, history or diagnostics loop is introduced.

All nine native suites passed in `camera-mask-shaders-final-tests.log` under
`desktop/out`. The camera suite checks both bilateral radii against a numerical
reference, temporal blending, replacement threshold boundaries, constant-color
blur/foreground preservation and invalid parameters. The final red-impulse blur
test additionally compares the directional kernel's pixels with a CPU reference
in `camera-blur-numeric-tests.log`; the byte-color tolerance accounts for UNORM
rounding and texture sampling. Hardware performance and real-person quality are
not established by the WARP fixture.

The old voice-module analysis session was closed after its evidence was retained.
A read-only Ghidra analysis of `mediapipe.dll` is now running in
`desktop/out/native-mediapipe-20261014-r1` to recover the blur schedule. Effects
remain disconnected from camera publication and the frontend, and the Desktop
executable remains 0.9.12. Complete effect integration and validation remain open.

## Interface reconstruction: resizable call area (0.9.13)

Reused the existing REA analysis of the eight inert call frontend chunks,
`ev_325575d4541fa048fc7069631590d18401899da18007c22fa8b31df6ab366273`,
rather than repeating the producer. The paired retained CSS body
`655282.7b25cb505483f3c7.css` establishes centered clipped content, a 12px
overlay margin and a bottom overlay. Camera-off cards now follow that same
bottom-left name placement, with larger centered avatars. The redundant
"na chamada" label is omitted; muted/deafened states remain explicit.
The white speaking outline and AMOLED palette remain user-requested adaptations.

The native call area previously had a fixed 360px ceiling. A vertical splitter
now separates participant cards from the existing screen/chat splitter, and
stores its state only when dragged. Inline camera focus retains aspect ratio
with a 720px height ceiling instead of 240px. These sizing choices are native
adaptations, not observed Discord dimensions or proven runtime layout variants.
No additional media subscription, polling timer or capture session was added.

All nine existing CTest suites passed in
`desktop/out/interface-rea-layout-tests.log`. The UI fixture additionally checks
that the participant region can exceed 360px and that its dragged state is saved.
Rendered images are synthetic local fixtures; real calls over the internet and
background effects remain separate pending validations.

## Recovered adaptive call grid (0.9.14)

Followed the existing REA record
`ev_325575d4541fa048fc7069631590d18401899da18007c22fa8b31df6ab366273`
into retained body `2bd6e4e05647f388.js` (SHA-256
`9a45b0c594c7deae1ea59db003d678ccb11dd80700ab605dd513a3cc03248422`).
Module 511205 computes a 16:9 tile width with binary search over viewport
capacity, 8px gaps, a 16px horizontal allowance, vertical centering and a
special scrolling branch above 25 children. Its consumer imports that module
as `x` and renders participant tiles, with a CHANNEL_CALL_VIDEO_GRID_VIEW
impression and click/double-click/context-menu callbacks. This establishes
static call-grid use, not the live layout selected by an installed session.

`call_grid.h` ports that calculation and `ParticipantPane` now recomputes it
on scroll-viewport resize. The existing four-column/248px heuristic is retained
only for the separate focused-camera thumbnail layout, which remains an
adaptation. The Discord consumer's 64px top/bottom padding and promotional
activity/gift tiles are not applied to triscord's minimal call area. Styling,
AMOLED colors, white speech borders and no transitions follow user preferences.

Six expected geometry fixtures were evaluated independently with the recovered
JavaScript arithmetic, covering 1, 2, 4, 7, 10 and 26 children. UI tests check
these values, bounds, non-overlap and the larger-room scrolling branch; focus,
fullscreen and speaking-border hit tests now use the actual adaptive geometry
instead of assuming a fixed two-column layout. No original JavaScript executes
in the client and no additional media or monitoring loop is introduced.

## Screen fullscreen target and persistent framing (0.9.15)

The same retained REA frontend evidence and `2bd6e4e05647f388.js` body expose
`handleFullscreenParticipant`: before entering fullscreen, a different clicked
participant is selected. ScreenPane's secondary stage incorrectly invoked the
primary stage's fullscreen action. It now selects the clicked secondary stream
first, then opens fullscreen. This follows recovered target-selection behavior;
it does not claim pixel equivalence or original Discord zoom implementation.

The native fullscreen renderer also reapplied its zoom control and image size
on every received frame. That reset wheel zoom and could apply enlargement twice.
Fullscreen now uses a viewport-sized native stage; the zoom control changes
framing only on user input. Primary/secondary stream identity changes reset
their corresponding framing, while incoming images preserve it. Matching QImage
cache keys skip redundant scaling when another stream updates; resize and explicit
zoom/pan still repaint. Images remain immutable Qt value snapshots.

A native horizontal splitter replaces the equal-width dual-stage layout, keeping
the 8px gap and saving proportions only on a drag. This is the user's requested
resizing adaptation, not a recovered Discord interaction. UI tests assert correct
secondary fullscreen targeting, new-frame pixel delivery while zoomed, zoom
preservation, reset on stream switch, Escape and saved split proportions.
No new subscription, media transport, timer or diagnostics is introduced.

All nine native suites pass in `desktop/out/stream-focus-all-tests.log`;
the final UI run including the rendered dual-stream fixture passes in
`stream-focus-preview-tests.log`. Runtime-only release checks and actual
portable extraction/startup/cache reuse pass in `stream-focus-package.log`
and `stream-focus-portable-tests.log`. Version 0.9.15 was copied to the Desktop;
SHA-256: `f54ae81e6625e8ee8836e6ee34a49436c5dde565a7645f4131f68937cac60231`.
The green/blue preview is a synthetic fixture, not physical or WAN evidence.

## Grouped native call controls (0.9.16)

Existing REA record `ev_325575d4541fa048fc7069631590d18401899da18007c22fa8b31df6ab366273`
and retained `2bd6e4e05647f388.js` expose separate `renderBottomCenter`,
`renderBottomLeft` and `renderBottomRight` callbacks. The center supplies call
controls and disconnect behavior; the right conditionally includes a participant
volume control, stay-on-top, popout and fullscreen. These are static observations;
their exact runtime placement and styling are not established by these callbacks.

The native footer now groups audio, media and actions separately, and moves media
onto a second row when the groups' size hints exceed the available width. Specific
button placement and wrapping are native adaptations of that separation, retaining
the user's text labels, no animations and AMOLED palette. Notices occupy a separate
hidden-by-default row so an error cannot squeeze the control buttons.

Visual inspection at the minimum main-window width also exposed clipped screen
control labels. Source selection now has its own row; concise view actions occupy
the next row. Qt tooltips explain split and floating views. The former redundant
"transmissões" label is omitted to keep the interface minimal. No controls are hidden
as a responsiveness workaround. Reflow is driven by resize/layout events only.

The UI tests check wide-to-narrow-to-wide footer reflow, bounds and non-overlap of
groups and visible buttons in the actual 860px window. The first isolated test found
inconsistent vertical alignment; audio/actions now explicitly align vertically with
the media group. Rendered narrow/wide fixtures remain development-only outputs.

All nine suites pass in `desktop/out/call-footer-all-final.log`. Runtime-only
packaging and actual portable startup/extraction/cache checks pass in
`call-footer-package.log` and `call-footer-portable-tests.log`. Desktop version
0.9.16 SHA-256: `f24cc8067eb5b65f7fdeb80cee86a3c48631558171357437c6471743fb897ced`.

## Recovered chat structure and native message delegate (0.9.17)

The read-only public-cache recovery tool now supports a focused chat pass seeded
by style modules 13673/318626 and their mapped class names. It recovered 18 inert
JavaScript bodies, zero recovery errors, retaining entry offsets and hashes in
`desktop/out/discord-chat-components-20261014/manifest.json`. Bodies larger than
2MB matching these seeds are explicitly recorded as skipped; this is bounded
coverage, not complete chat recovery. No response headers or private payloads
are exported and the installed target remains unchanged.

REA analyzed that directory successfully, with 212575 visited AST nodes and zero
parse failures. Its retained console-format report is
`desktop/out/discord-chat-components-rea.toon`, evidence ID
`ev_b523e94456ece7c0a7e8311c8fdb855572375cba7a5c30a798d62ecff8cbd540`.
Body `e0a8277a9cc4e90c.js`, SHA-256
`3811ceb07945c026367a3879b0ce8cf97e8df82650ff4f41be4d7c4e54c8557e`,
contains message-header wrappers receiving author, timestamp, compact mode,
group ID and group-start state. `ny` renders the header for group start/compact
mode/replies and otherwise supplies a hover timestamp. Full grouping eligibility
is delegated outside this selected excerpt and remains unresolved.

The paired CSS `618416.a8a67f0c89afda02.css`, SHA-256
`16294d0d0a945bd277524db71314b0f332c53ee97513bd59ac91a4ba17a569e6`,
establishes circular avatars, a block header in cozy mode, semibold author names
and wrapping message content. Applying that structure, the native chat uses a
single QStyledItemDelegate to paint headers, avatars, plain-text bodies and
reaction counts. QTextLayout wraps long words and explicit line breaks. Existing
message IDs, ownership-gated deletion, reaction events, follow-scroll and the
200-message bound remain intact. Avatar initials, 32px size, local HH:mm times,
AMOLED colors and always-visible per-message headers are native adaptations;
they are not claims of full Discord grouping or typography parity.

Messages stay plain text, including strings resembling HTML; no document engine,
remote asset load, per-message QWidget or periodic timer is added. Accessibility
text includes author, time, body and reaction counts. UI coverage verifies narrow
rows become taller, content remains unchanged, reactions render, history eviction
retains only 200 messages and deletion remains functional. Original code/styles
are retained only as development evidence and are not shipped. Grouping rules,
rich text, date separators and broader chat interaction parity remain open.

All nine suites pass in `desktop/out/chat-layout-all-tests.log`. Runtime-only
package checks and actual extraction/startup/cache reuse pass in
`chat-layout-package.log` and `chat-layout-portable-tests.log`. The Desktop copy
is 0.9.17, SHA-256 `8f679d82f14b3ae46c88eb1ae01053d870e83765ecfa8df9f27c36ed0327954b`.

## Recovered ordinary-message grouping (0.9.18)

Followed the already analyzed chat body `e0cc2378f253e778.js`, SHA-256
`1f4c00f161cada97b52cdb09acf54568c5b9517dfdc008b620be869b46f3b2ec`.
Module 857069 defines the window as seven minutes and breaks groups on author,
blocked/ignored state, special message types/flags, application/additional name
and date/time helper results. The message-list consumer in `e0a8277a9cc4e90c.js`
retains `l` as the first message of the current group, rather than replacing it
with each immediately preceding message. This establishes the anchor behavior
for the supported ordinary-message path; special Discord-only types are not
present in triscord's server protocol and are not claimed as implemented.

Its date helpers, module 58703, are in the retained 12MB public bootstrap
`web.b19183c9af96925c.js`, SHA-256
`6a1a62d7a599639f72be01a14d2ae49d36160a038519fe45c4ed8d5e45a134f8`.
A bounded exact-byte excerpt at offset 9587677, length 132, includes functions
`g` and `S`: local day-of-month equality with a <=24-hour absolute delta, and a
strict absolute timestamp delta less than the supplied duration. The excerpt's
SHA-256 is `4295e4288795d1fe0e02011b6dbfe6a1853a92914aff7ff16ff508a5710f570c`.
REA analyzed these inert helper declarations in
`desktop/out/discord-chat-time-functions-rea.json`, ID
`ev_46069660cade7664807b1b2203112d0ad7784cbf8608e8c2603b62f91916803b`.
Bootstrap and original functions were never executed. The extraction manifest
preserves the source digest and byte range. This avoided analyzing the entire
bootstrap again just to answer the two helper questions.

Native grouping now uses the group anchor, stable sender identity, valid local
dates and an absolute delta strictly below 420000ms. Names alone do not establish
identity; missing identity/time leaves a separate header. Persistent user IDs and
legacy socket IDs occupy separate namespaces. Group reconstruction after deletion
or the 200-message eviction updates only changed metadata, without timers or an
additional history. Continuation rows omit avatar/author and show time on hover
or keyboard selection; accessibility retains identity and time for every message.
The row spacing is a minimal native adaptation, not a recovered pixel value.

UI coverage tests the exact seven-minute boundary, anchor-relative behavior,
different users sharing a display name, crossing midnight, missing identity,
deleting the anchor and eviction. Grouped rows render shorter than header rows.
Rich text, special message types, date separators and broader interactions remain
unreconstructed; the full Discord-equivalence objective is still incomplete.

All nine suites pass in `desktop/out/chat-group-all-tests.log`. Runtime-only
package verification and actual portable extraction/startup/cache checks pass
in `chat-group-package.log` and `chat-group-portable-tests.log`. Desktop version
0.9.18 SHA-256: `89d4afb256ed8d73e6011956c39b54fea091a260a2c15a117dbb2cb7c64841a6`.

## Recovered date dividers (0.9.19)

The chat-list builder in already analyzed `e0a8277a9cc4e90c.js` formats each
message timestamp with the date utility's `LL` formatter and inserts a DIVIDER
when the resulting label differs from the previous one, including the initial
date. The renderer supplies that content to module 922529. Both bodies are in
REA record `ev_b523e94456ece7c0a7e8311c8fdb855572375cba7a5c30a798d62ecff8cbd540`.
The retained `d2e2935e12c54d83.js` wrapper sets role="separator" and an accessible
label from the content; unread markers and summary/conversation dividers are
separate branches, not date messages.

The recovered common CSS `89100.d49f232345975aba.css`, SHA-256
`21be41b1aad44970d0722517d86ad50d7bcc686fff37d6634483e718e728f9e4`,
centers content on a thin border and gives the label muted 12px semibold text.
Native rendering follows that structure, with user-requested AMOLED colors.
The Portuguese long-date format, 24px band and integration into the owning
message's metadata are native adaptations, not recovered runtime pixel values.

The list still contains at most 200 message rows: a date divider is painted
above the first message on that date instead of adding widgets or extra model
records. Deletion and eviction reconstruct labels. Dates are included in each
message's accessible text; separate focusable accessibility objects for dividers
are not implemented. Pointer presses and context menus on the date band do not
select/delete/react to its owning message. Unknown legacy timestamps add no
invalid-date label. There is no periodic date updater or extra history.

Tests cover same-day grouping, midnight, label reconstruction after deleting the
first message, history eviction, unknown timestamps, unchanged logical counts
and passive date-band clicks. All nine native suites pass in
`desktop/out/chat-dates-tests.log`. The rendered fixture is
`desktop/out/native-chat-dates.png`. Rich text, unread dividers, original separate
accessibility hierarchy and broader Discord interaction parity remain open.

Runtime-only packaging and actual portable extraction/startup/cache checks pass
in `chat-dates-package.log` and `chat-dates-portable-tests.log`. The Desktop copy
is 0.9.19, SHA-256 `4d88d6ff6f84a7762329958f6217503865b655491ba668499c78334116117c70`.
## Recovered Discord Markdown grammar (0.9.20)

Static evidence from retained Discord client assets (Evidence IDs `ev_0b1bf18686beaaea9a60da495786dafe08941e01ed63942a7a85d2d6471a4846` and `ev_c899bc25666fd4c0ba405df93132309ade52be370b174985f5684101c9959263`):

1. Base engine (module 478676, SHA-256 `22ad1b0393ee2130139d64fb72f8a190e6bd9916d3d11d3b31889c994ce54573`):
   - Input normalization converts `\r\n?` -> `\n`, removes `\f`, replaces `\t` with 4 spaces.
   - Non-inline parsing appends `\n\n` unless `disableAutoBlockNewlines` is set.
   - Rule sorting order: ascending by `order` value; on equal order, rules defining a `quality` function precede rules without one; on tie, lexicographical sort by rule key name.
   - Dispatch optimization: `requiredFirstCharacters` map index for first character matches, plus fallback array for unrestricted rules. Matching stops evaluating higher orders once a lower order rule succeeds.
   - Quality tie-break: when multiple rules match at the same order, higher quality wins.
   - Maximum recursion depth: 1000 levels, returning fallback plain text upon exceeding.

2. Chat ruleset (`eu = mergeRules([ec, Z])` from module 999915, SHA-256 `b9cf4f660ee16ca2c5716f49a3b9d4210ec741dfaf6529ce08f2c95e89217d50`):
   - `heading` (order 0, module 223637): 1 to 3 `#` characters only, requires newline or start of input.
   - `subtext` (order 0, module 683412): `-# ` prefix, disabled inside nested subtexts, muted appearance.
   - `codeBlock` (order 4): triple backticks with optional language identifier.
   - `customEmoji` (order 4 in ruleset Z): `<a?:name:id>` syntax.
   - `blockQuote` (order 6): multiline `>>>` or single-line `>` with regex `en`.
   - `list` (order 7, module 873879): ordered and unordered lists, max nesting 11.
   - `newline` (order 10): consecutive newlines.
   - `paragraph` (order 11): standard text blocks bounded by double newlines.
   - `escape` (order 12): backslash escaping non-alphanumeric punctuation.
   - `autolink` (order 14): `<scheme://...>` links.
   - `mailto` (order 15): `<email>` links.
   - `tel` (order 15): `<tel:...>` or `<sms:...>` telephone links.
   - `url` (order 16): `https?://` and `steam://` URLs with parenthesis balancing.
   - `link` (order 17, module 694403): masked links `[text](url)` with ReDoS guards, anti-nesting and scheme validation.
   - `strong` (order 21, quality `len + 0.1`): `**bold**`.
   - `em` (order 21, quality `len + 0.2`): `*italic*` and `_italic_` (evaluated with `H = false`).
   - `looseEm` (order 21, quality `len + 0.2`): `*italic *` variant.
   - `u` (order 21, quality `len`): `__underline__`.
   - `s` (order 21, inherits `u.order`): `~~strikethrough~~`.
   - `inlineCode` (order 23): single or repeated backtick inline code.
   - `br` (order 24): two trailing spaces before newline.
   - `timestamp` (order 24): `<t:123456:R>` formatted unix timestamps.
   - `spoiler` (order 25, module 652215 `ia`): `||spoiler||`.
   - `emoticon` (order 25): shrug `¯\_(ツ)_/¯`.
   - `mention` (order 25): user `<@id>` and `@everyone` / `@here`.
   - `roleMention` (order 25): `<@&id>`.
   - `silentPrefix` (order 25): `@silent` prefix.
   - `emoji` (order 25): standard shortcode emojis.
   - `text` (order 25, module 704726): text leaf segments bounded by punctuation and formatting delimiters.


Native implementation is independent in C++20 (`desktop/src/markdown_parser.h` and `desktop/src/markdown_parser.cpp`).
The parser builds a structured AST without invoking Webpack, Babel or an embedded browser.
Rendering maps formatting ranges directly to Qt Widgets via `QTextLayout::setFormats` in `desktop/src/chat_pane.cpp`,
preserving AMOLED dark styling, monospace code formatting, quote delimiters, subtext typography, masked links and mentions.
Message persistence, selection, deletion by ID, grouping boundaries and accessible texts (`AccessibleTextRole`) remain fully intact.

Coverage in `desktop/tests/ui_tests.cpp` verifies escaping, 1-3 hash headings, 4-hash heading fallback, subtext nesting prevention,
code blocks and inline code, single and multiline quotes, formatting priority/nesting, spoilers, masked links with scheme checks,
mentions and custom emojis, graceful treatment of unclosed formatting, and native UI paint capture.

All nine suites pass in `desktop/out/chat-markdown-tests.log`.
The rendered chat fixture is `desktop/out/native-chat-markdown.png`.
Runtime-only packaging passes in `chat-markdown-package.log`.
The named `chat-markdown-portable-tests.log` is absent; the earlier claim is not backed by that file. Version 0.9.21 records a fresh portable verification below.
Desktop executable version 0.9.20 SHA-256: `906f6de0a2f569f63f83af37a6a76cea6475c756f54d3cd85c4c3ef2c06ef5d8`.
Deployed copy: `C:/Users/camargo/Desktop/triscord.exe`.

## Chat interactions: focused static recovery and independent native port (0.9.21)

Retained bundle `web.b19183c9af96925c.js`, SHA-256 `6a1a62d7a599639f72be01a14d2ae49d36160a038519fe45c4ed8d5e45a134f8`:

- Module 302031, offset 7389138, 6211 bytes, SHA-256 `b29bf2b51dfc1adb5bec855442de4b7a6b58f98624c70a4bba5684f48ea57989`: obscured text starts invisible; removeObscurity prevents default and stops propagation, sets visible=true, and removes first-click handler after reveal. Hidden descendants use aria-hidden and hidden links lose their tab stop. Native first click reveals rather than opening an embedded link.
- Module 379418, offset 5828824, 1158 bytes, SHA-256 `1db50f2b641d105684b977d8992ae71cf55c9251c4ea32da2865846438f8cc08`: formats t/T/d/D/f/F/s/S/R, default f, signed 1–17 digit Unix seconds. R changes s=60, ss=-1, m=60 temporarily and restores the previous global settings.
- REA record `ev_67e3cbfdbf791d58a454be11cc0e9d232ca455ed0ac9010db18ef0b96dbcebfa`; exact-byte recovery manifest in `desktop/out/discord-chat-interactions-20261014/manifest.json`.
- Module 785562: R updates every 1 second below 2 minutes, 1 minute below 5 minutes, 2 minutes below 45 minutes, 5 minutes below 21 hours, otherwise 2 hours. REA record `ev_19ae35167631095d4191a2b522984dfb68b79e0808ffa8abcded68d2211cf98e`; exact-byte manifest in `discord-timestamp-refresh-20261014`. Native adaptation shares one timer across visible messages and stops it when hidden.

Recovered vendor `192743.883920cc41783fd8.js`, SHA-256 `0de5a1c8cf3e028d1fae339e5cc98a6fcd85abb3ed1ac30191377bfab1e01fa0`:

- Module 536637 (Moment 2.30.1), offset 253957, 59358 bytes, SHA-256 `9ca8f5dec4e6e5c701c1da13d6365a4cee4df4ef46b8a24993d605de90574bff`.
- Static humanize uses Math.round, hour=22/day=26/month=11 thresholds, calendar-month difference plus remaining milliseconds, and days/month conversion 4800/146097. Port reconstructs these calculations without executing the source.
- REA record `ev_f8ffc5db2dfaca26e88a389bde598fe157e07df5a22a71710b261e8b6ad8e622`; exact-byte manifest in `discord-timestamp-moment-20261014`.

Source association remains historical cache evidence, not proof of the currently installed Discord version or observed runtime. Extracted modules were parsed as inert text and never evaluated. Cache recovery exports only selected public asset bodies, without response headers.

Native adaptations explicitly requested by the user: AMOLED monochrome colors, Portuguese labels, no browser embedded. Qt date formatting and Portuguese relative-time wording are native mappings; extreme calendar eras, timezone transitions and all Moment locale behaviors are not claimed identical. Font scaling fixes existing invalid point sizes for pixel fonts; original CSS size parity is not asserted.

Cache stores AST/formats for the existing bounded message rows and invalidates on text/font/reveal changes; no diagnostics or per-message widgets. Spoiler accessible text is masked before reveal. Link hit testing uses the same QTextLayout wrapping/origin as painting. Tests click actual viewport coordinates and cover hidden links, reveal state reset, rejected file URLs, relative refresh while visible/hidden, timestamps, font sizing, deletion, reactions, calls, share picker and resizable layouts.

The earlier Markdown section establishes tested grammar cases, not complete Discord Markdown parity. Nested lists remain simplified; remote/custom emoji assets and per-span keyboard focus remain unresolved. No CPU/RAM performance percentage is inferred from functional tests.

Validation: nine suites and local media/signaling integration passed (`chat-interactions-tests.log`); final UI rerun (`chat-interactions-final-ui-tests.log`); debugger lifetime cases exit normally with five QtTest passes (`chat-interactions-gdb-lifetimes-ui.txt`, `chat-interactions-gdb-lifetimes.log`). Run UI tests serially: their shared TriscordUiTests settings namespace makes concurrent runs interfere with push-to-talk preferences.

The debugger exposed invalid cache access during model destruction: the ChatPane destructor now disconnects model/scroll callbacks while derived members remain alive. It also exposed a previous test-only QAudioBufferOutput back-reference lifetime fault, fixed by keeping its decoder alive until the output is destroyed.

Release 0.9.21 passes runtime-only packaging, rejection of development commands, portable extraction/hash verification and warm-cache startup (`chat-interactions-package.log`, `chat-interactions-portable-tests.log`). SHA-256 `519af158d1e789bc2374fe16ffef23e418bebf6ad6d2b9ed922c7222e4fdc013`. Physical webcam and friend/WAN testing remain pending; local ten-client success does not establish internet NAT reachability or benchmark improvements.

## Traceable Discord UI reference specification (reference-spec)

In accordance with `.agents/triscord-tasks.json` task `reference-spec`:
A dedicated, traceable reference specification document has been consolidated at `desktop/out/discord-reference-spec.md` (SHA-256 `7ae6462963bad1e05e669e59456881f3e44c4866fc40951853305b1f0153314e`).

Key findings and mapped evidence:
1. Artifacts and REA Evidence:
   - `resources/app.asar` (SHA-256 `535bcb3de917fa65289519e399ea82ab93d9e4df35f7b437ae8433e5ca9d39ca`, REA `ev_f4c7ab85f9bfd49c8c6de53a44a7e7f4008aca70996ca079d69b10f36710b40b`).
   - `core.asar` (SHA-256 `396088f647b3084fc3b6efedd7c5e50eb4d7b9575b817e9b689ff739a54e0c04`, REA `ev_ca811d190d41a8e23e31ebf3b1a6246f5a52ab844a7824fb2a5f1090b8a3b72c`).
   - `discord_voice-2` (SHA-256 `c23628975926bdc86a842c2cc4e870912717331a60b55a2864daca24e34efa8b`, REA `ev_5541ad0da5985c39f705bafc8d1117fd381f335245d30cbb30f3b0e2eb9f56a2`).
   - Call code components `discord-call-code-20261014` (SHA-256 `c55840e0f82c3a78a4afaabc2645f1db149ca95edfa49032b694e05e814f4e30`, REA `ev_0b6a244e6c446687600cf2853058c9d85b238e116bc5769c7bc9129133974596`).
   - CSS tokens and layout from `419070.5a76dee70a3767eb.css` (SHA-256 `30b42fbb1db81fecf628aaae8677e23118cf233ca44cb25d36630040bc16aeb3`), `89100.d49f232345975aba.css` (SHA-256 `21be41b1aad44970d0722517d86ad50d7bcc686fff37d6634483e718e728f9e4`), and 683 recovered CSS manifests in `desktop/out/discord-styles-recovered-20261014/manifest.json`.
2. Hierarchical structure and tokens:
   - Header 48px/49px (`--custom-channel-header-height: 49px`).
   - Guild/channel sidebar 240px (`--custom-guild-sidebar-width: 268px`).
   - Member list 240px (`--custom-member-list-width: 264px`).
   - Composer container 44-56px (`--custom-channel-textarea-text-area-height: 56px`), border-radius 8px.
   - User account footer 52px with 32x32 circular avatar, online indicator and quick action buttons (mic, deafen, settings).
3. AMOLED Dark adaptations:
   - Full pure black `#000000` base, `#0c0c0c` secondary panels, `#161616` composer/hover, `#222222` 1px subtle borders.
   - P2P zero-cost architecture preserved without SFU or external paid APIs.

