#pragma once
#include <QJsonArray>
#include <QString>
#include <vector>
#include <cstdio>
#include <rtc/configuration.hpp>
#include <rtc/peerconnection.hpp>

namespace triscord {

// One configured ICE server. STUN entries only need a url (e.g.
// "stun:stun.l.google.com:19302"); a TURN entry additionally carries
// username/credential so a relay can be configured without recompiling.
struct IceServerEntry {
    QString url;
    QString username;
    QString credential;
};

// Resolves the ICE server list to use for a WebRTC peer connection. Resolution
// order, first match wins:
//   1. The TRISCORD_ICE_SERVERS environment variable, a JSON array of objects
//      shaped like {"url": "...", "username": "...", "credential": "..."}
//      (username/credential optional). Intended for tests and advanced users;
//      malformed JSON or an array with no valid entries is ignored.
//   2. The "iceServers" value in the app's QSettings store (the same
//      persistence every other local preference uses, see main_window.cpp),
//      holding JSON in the same shape. Editable by hand without recompiling.
//   3. The session relays fetched from the signaling hub's GET /ice
//      (Cloudflare Realtime TURN, free tier, credentials minted per session
//      and valid for 600 s; see cloudflare/src/worker.js handleIce), put
//      ahead of the default STUN list while they are still fresh.
//   4. A built-in default: several free public STUN servers for redundancy.
//      The OpenRelay TURN relays used before were removed: on 15/10/2026 their
//      hostname resolved to 192.0.2.1 (TEST-NET-1, a sinkhole) through both
//      Google and Cloudflare DNS, so they could never relay anything.
std::vector<IceServerEntry> resolveIceServers();

// Parses the "iceServers" array returned by GET /ice (the RTCIceServer shape
// Cloudflare emits: {"urls": "..." | ["...", ...], "username", "credential"}).
// Every url becomes its own entry; urls that are not stun:/turn:/turns: are
// dropped. Exposed for tests.
std::vector<IceServerEntry> parseRtcIceServers(const QJsonArray& servers);

// Stores relays fetched from GET /ice for resolveIceServers() to use until
// `expiresAtMs` (QDateTime::currentMSecsSinceEpoch() scale). Thread-safe:
// peers are created on worker threads.
void setSessionIceServers(const std::vector<IceServerEntry>& entries, qint64 expiresAtMs);
void clearSessionIceServers();
// True while relays from GET /ice are stored and fresh.
bool hasSessionIceServers();
// TRISCORD_ICE_RELAY_ONLY=1: every call uses only TURN relays, also in injected test mode, as two homes behind
// CGNAT on different networks would (the "different networks" E2E, 18/10).
bool iceRelayOnly();
// Logs which path a connected peer uses ("ice: voice connected via relay/relay"); no addresses are printed.
inline void logSelectedPath(const char* kind, rtc::PeerConnection& pc) {
    rtc::Candidate local, remote;
    if (!pc.getSelectedCandidatePair(&local, &remote)) return;
    const auto name = [](const rtc::Candidate& c) {
        switch (c.type()) {
        case rtc::Candidate::Type::Host: return "host";
        case rtc::Candidate::Type::ServerReflexive: return "srflx";
        case rtc::Candidate::Type::PeerReflexive: return "prflx";
        case rtc::Candidate::Type::Relayed: return "relay";
        default: return "unknown";
        }
    };
    std::printf("ice: %s connected via %s/%s\n", kind, name(local), name(remote)); std::fflush(stdout);
}

// Converts resolved entries into libdatachannel's ICE server type, ready to
// append to an rtc::Configuration::iceServers list.
std::vector<rtc::IceServer> toRtcIceServers(const std::vector<IceServerEntry>& entries);

} // namespace triscord
