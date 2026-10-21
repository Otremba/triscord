# Third-party components in the native preview

Qt 6.8.3 Core, GUI, Widgets, Network, WebSockets and Multimedia are dynamically
linked from the unmodified official Qt distribution. Qt Test is used only by
the test executable. Qt includes additional third-party components with their
own licenses. The preview retains available SDK notices, Qt SBOM metadata and
MinGW runtime licenses. The binary-only Qt SDK may omit license texts; this
engineering preview must not be externally distributed until the release
packaging includes those texts and the matching third-party source notices.

Qt open-source license information and matching source archives:

- https://doc.qt.io/qt-6/licensing.html
- https://download.qt.io/archive/qt/6.8/6.8.3/single/
- https://www.gnu.org/licenses/lgpl-3.0.html
- https://www.gnu.org/licenses/gpl-3.0.html

Users may replace the dynamically linked Qt libraries with ABI-compatible
modified builds. No Qt libraries are statically linked into this application.
Before distributing a release, retain all license texts and corresponding
third-party notices for the exact packaged modules and runtime binaries.

The portable build also uses the MinGW GCC runtime under GPL with the GCC
Runtime Library Exception:

- https://gcc.gnu.org/onlinedocs/libstdc++/manual/license.html
- https://www.gnu.org/licenses/gcc-exception-3.1.html

Windows system APIs and libraries are provided by the user's operating system.
No libwebrtc runtime is shipped. The optional `triscord-media.exe` adapter uses
LiveKit server-sdk-go v2.19.0 (Apache 2.0) and Pion WebRTC v4.2.19 (MIT) to
transport already encoded H.264/Opus. Its module versions and checksums are in
`desktop/media-bridge/go.mod` and `go.sum`; dependency notices ship under
`media-licenses/LiveKit`. Go's runtime is BSD licensed. This adapter never
opens microphones, speakers, cameras or screen capture devices.

Native voice statically links the following source-built libraries. The package
includes their upstream license texts under `media-licenses`:

- libdatachannel 0.24.6, MPL 2.0:
  https://github.com/paullouisageneau/libdatachannel/tree/6b1e2e620f1e37f0eafeee702eaea0043cb305fd
- Opus 1.5.2, BSD-style license and additional upstream patent notices:
  https://github.com/xiph/opus/tree/ddbe48383984d56acd9e1ab6a090c54ca6b735a6
- MbedTLS 3.6.5, upstream Apache 2.0 / GPL 2.0-or-later licensing:
  https://github.com/Mbed-TLS/mbedtls/tree/e185d7fd85499c8ce5ca2a54f5cf8fe7dbe3f8df
- SpeexDSP 1.2.1, BSD-style license, including its bundled FFT notices:
  https://github.com/xiph/speexdsp/tree/1b28a0f61bc31162979e1f26f3981fc3637095c8
- libdatachannel's pinned submodules: libjuice (MPL 2.0), libSRTP and
  usrsctp (BSD-style), plog and nlohmann/json (MIT). Exact revisions are
  recorded in the libdatachannel source revision linked above.

The libraries are built from unmodified sources, with the project's MbedTLS
configuration enabling DTLS-SRTP and disabling TLS debug instrumentation.
When distributing the executable, preserve license notices and provide access
to the corresponding MPL-covered source files, including any modifications.

Noise suppression ("Supressão de ruído") uses two neural models:

- RNNoise v0.1.1, BSD 3-clause, statically linked (`media-licenses/RNNoise-license.txt`):
  https://github.com/xiph/rnnoise
- DeepFilterNet 3 ("Alta qualidade"), MIT or Apache 2.0, shipped as
  `deepfilter/df.dll` (libDF's C API, built from unmodified sources with
  `scripts/build-deepfilter.ps1`) and its model `DeepFilterNet3_onnx.tar.gz`:
  https://github.com/Rikorose/DeepFilterNet/tree/d375b2d
  The DLL statically links 99 Rust crates (tract, ndarray and others) under
  MIT, Apache 2.0, BSD, Zlib, Unicode-DFS or CC0 licenses; each crate's
  license text and the full list are in `media-licenses/DeepFilterNet`.
