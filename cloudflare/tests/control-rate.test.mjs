import assert from 'node:assert/strict';
import { consumeControlRate, controlRateLimitReason } from '../src/control_rate.js';

const packet = (event, payload = {}) => '42' + JSON.stringify([event, payload]);
const now = 2000;
const data = {};
// Four existing peers, voice and screen, each with SDP and a burst of ICE candidates.
for (let peer = 0; peer < 4; ++peer) {
  for (const type of ['voice', 'native-screen']) {
    assert(consumeControlRate(data, packet('webrtc-offer', { type, targetSocketId: String(peer) }), now));
    for (let candidate = 0; candidate < 12; ++candidate)
      assert(consumeControlRate(data, packet('webrtc-ice-candidate', { type, candidate: { candidate: 'test' } }), now));
  }
}
// UI commands keep the old limit even while WebRTC negotiates.
for (let n = 0; n < 40; ++n) assert(consumeControlRate(data, packet('user-state-change'), now));
assert.equal(consumeControlRate(data, packet('user-state-change'), now), false);
assert.equal(controlRateLimitReason(data), 'Control rate limit (commands 41/40)');
for (let n = data.rtcRateCount; n < 256; ++n) assert(consumeControlRate(data, packet('webrtc-answer'), now));
assert.equal(consumeControlRate(data, packet('webrtc-answer'), now), false);
assert.equal(controlRateLimitReason(data), 'Control rate limit (WebRTC 257/256)');
// State survives serialization; both budgets reset at the next one-second window.
const restored = JSON.parse(JSON.stringify(data));
assert.equal(consumeControlRate(restored, packet('webrtc-answer'), now + 999), false);
assert(consumeControlRate(restored, packet('webrtc-answer'), now + 1000));
assert(consumeControlRate(restored, packet('user-state-change'), now + 1000));
assert.equal(restored.rtcRateCount, 1);
assert.equal(restored.rateCount, 1);
for (const invalid of ['42[', '42["webrtc-offer",null]', '42["webrtc-offer",[]]', packet('unknown')]) {
  const exhausted = { rateTime: now, rateCount: 40 };
  assert.equal(consumeControlRate(exhausted, invalid, now), false);
  assert.equal(exhausted.rtcRateCount, undefined);
}

// WebRTC limit exhausted does NOT prevent regular commands if under 40
const rtcMaxed = { rateTime: now, rateCount: 5, rtcRateCount: 256 };
assert.equal(consumeControlRate(rtcMaxed, packet('webrtc-offer', {}), now), false);
assert.equal(consumeControlRate(rtcMaxed, packet('user-state-change'), now), true);
assert.equal(rtcMaxed.rateCount, 6);

// Non-42 packets (ping '2', pong '3', handshake '0') consume the standard rate limit
const nonRtc = { rateTime: now, rateCount: 39, rtcRateCount: 0 };
assert.equal(consumeControlRate(nonRtc, '2probe', now), true);
assert.equal(consumeControlRate(nonRtc, '2probe', now), false);
assert.equal(controlRateLimitReason(nonRtc), 'Control rate limit (commands 41/40)');

// Time going backwards or sub-second increments does NOT reset the counter
const midWindow = { rateTime: 5000, rateCount: 40, rtcRateCount: 256 };
assert.equal(consumeControlRate(midWindow, packet('user-state-change'), 4999), false);
assert.equal(consumeControlRate(midWindow, packet('user-state-change'), 5500), false);
assert.equal(consumeControlRate(midWindow, packet('user-state-change'), 6000), true);

console.log('PASS: call negotiation bursts, independent UI limit, bounded WebRTC limit, hibernation and reset');
