// Relay check (dev tool, never shipped): two in-process peers forced to TURN only (TransportPolicy::Relay), with the
// servers that GET /ice returned, converted by the same parseRtcIceServers/toRtcIceServers the calls use. Proves the
// relays carry data when no direct path is allowed, the case of two homes behind CGNAT (18/10).
// Usage: triscord-turn-probe <file with the GET /ice JSON body>. Prints the outcome only, never the credentials.
#include "ice_config.h"
#include <rtc/rtc.hpp>
#include <QCoreApplication>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <atomic>
#include <chrono>
#include <iostream>
#include <thread>

using namespace triscord;

int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    if (argc != 2) return 2;
    QFile file(QString::fromLocal8Bit(argv[1]));
    if (!file.open(QIODevice::ReadOnly)) return 3;
    const auto entries = parseRtcIceServers(QJsonDocument::fromJson(file.readAll()).object().value("iceServers").toArray());
    int turn = 0;
    for (const auto& e : entries) if (e.url.startsWith("turn")) ++turn;
    rtc::Configuration config;
    config.iceServers = toRtcIceServers(entries);
    config.iceTransportPolicy = rtc::TransportPolicy::Relay;
    std::cout << "servers " << entries.size() << " (turn " << turn << ")" << std::endl;

    rtc::PeerConnection a(config), b(config);
    std::atomic<int> relayCandidates{0};
    a.onLocalDescription([&](rtc::Description d) { b.setRemoteDescription(d); });
    b.onLocalDescription([&](rtc::Description d) { a.setRemoteDescription(d); });
    a.onLocalCandidate([&](rtc::Candidate c) { if (c.type() == rtc::Candidate::Type::Relayed) ++relayCandidates; b.addRemoteCandidate(c); });
    b.onLocalCandidate([&](rtc::Candidate c) { if (c.type() == rtc::Candidate::Type::Relayed) ++relayCandidates; a.addRemoteCandidate(c); });
    std::atomic<bool> received{false};
    std::shared_ptr<rtc::DataChannel> incoming;   // kept alive: a dropped channel delivers nothing
    b.onDataChannel([&](std::shared_ptr<rtc::DataChannel> channel) {
        incoming = channel;
        channel->onMessage([&](rtc::message_variant m) { if (std::holds_alternative<std::string>(m) && std::get<std::string>(m) == "ola pelo relay") received = true; });
    });
    auto channel = a.createDataChannel("probe");
    channel->onOpen([channel] { channel->send(std::string("ola pelo relay")); });
    const auto start = std::chrono::steady_clock::now();
    while (!received && std::chrono::steady_clock::now() - start < std::chrono::seconds(20))
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
    rtc::Candidate local, remote;
    const bool pair = a.getSelectedCandidatePair(&local, &remote);
    std::cout << "relay candidates " << relayCandidates << ", message " << (received ? "received" : "NOT received")
              << " in " << ms << " ms, selected " << (pair ? (local.type() == rtc::Candidate::Type::Relayed ? "relay" : "non-relay") : "none") << std::endl;
    a.close(); b.close();
    return received && relayCandidates > 0 ? 0 : 1;
}
