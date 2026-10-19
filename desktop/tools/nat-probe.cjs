// Probes the NAT of the current network with two public STUN servers from ONE UDP socket (RFC 5389 binding
// requests). Same mapped port for both servers = endpoint-independent mapping (direct peer-to-peer works);
// different ports = symmetric NAT (direct connections between peers behind such NATs usually fail without TURN).
// Sends two small UDP packets to Google's public STUN servers; nothing else leaves the machine.
const dgram = require("dgram");
const dns = require("dns").promises;
const crypto = require("crypto");

const SERVERS = [["stun.l.google.com", 19302], ["stun1.l.google.com", 19302], ["stun2.l.google.com", 19302]];

function request() {
  const id = crypto.randomBytes(12);
  const message = Buffer.alloc(20);
  message.writeUInt16BE(0x0001, 0); message.writeUInt16BE(0, 2); message.writeUInt32BE(0x2112a442, 4); id.copy(message, 8);
  return { id, message };
}

function parse(buffer, id) {
  if (buffer.length < 20 || buffer.readUInt16BE(0) !== 0x0101 || !buffer.subarray(8, 20).equals(id)) return null;
  let offset = 20;
  while (offset + 4 <= buffer.length) {
    const type = buffer.readUInt16BE(offset), length = buffer.readUInt16BE(offset + 2), value = buffer.subarray(offset + 4, offset + 4 + length);
    if (type === 0x0020 && value[1] === 0x01) { // XOR-MAPPED-ADDRESS, IPv4
      const port = value.readUInt16BE(2) ^ 0x2112;
      const address = [0, 1, 2, 3].map((i) => value[4 + i] ^ [0x21, 0x12, 0xa4, 0x42][i]).join(".");
      return { address, port };
    }
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

(async () => {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, resolve));
  const results = [];
  const pending = new Map();
  socket.on("message", (buffer, remote) => {
    for (const [key, entry] of pending) {
      const mapped = parse(buffer, entry.id);
      if (mapped) { results.push({ server: entry.name, ...mapped }); pending.delete(key); entry.done(); }
    }
  });
  for (const [host, port] of SERVERS) {
    let address;
    try { address = (await dns.lookup(host, { family: 4 })).address; } catch { results.push({ server: host, error: "dns" }); continue; }
    const { id, message } = request();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(host); results.push({ server: host, error: "timeout" }); resolve(); }, 3000);
      pending.set(host, { id, name: host, done: () => { clearTimeout(timer); resolve(); } });
      socket.send(message, port, address);
    });
  }
  socket.close();
  console.log("local port:", socket.address ? "(closed)" : "");
  for (const r of results) console.log(r.error ? `${r.server}: ${r.error}` : `${r.server}: mapped ${r.port}`);
  const ok = results.filter((r) => !r.error);
  if (ok.length < 2) { console.log("RESULT: inconclusive (fewer than two STUN answers; UDP may be blocked)"); return; }
  const ports = new Set(ok.map((r) => r.port));
  console.log(ports.size === 1
    ? "RESULT: endpoint-independent mapping (same mapped port for every server): direct peer-to-peer is expected to work from this network"
    : "RESULT: address/port-dependent mapping (symmetric NAT): direct peer-to-peer may fail against other restrictive NATs without TURN");
})();
