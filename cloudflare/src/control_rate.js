const RTC_EVENTS = new Set(['webrtc-offer', 'webrtc-answer', 'webrtc-ice-candidate']);

// Joining an existing call negotiates voice, screens and cameras with multiple peers at once.
// ICE bursts must not consume the small UI/control budget and force an endless reconnect loop.
// Keep both budgets finite, independent, and in the serialized socket attachment for hibernation.
export function consumeControlRate(data, message, now) {
  if (now - (data.rateTime || 0) >= 1000) {
    data.rateTime = now;
    data.rateCount = 0;
    data.rtcRateCount = 0;
  }
  let rtc = false;
  if (message.startsWith('42[')) {
    try {
      const args = JSON.parse(message.slice(2));
      rtc = Array.isArray(args) && args.length === 2 && RTC_EVENTS.has(args[0])
        && args[1] !== null && typeof args[1] === 'object' && !Array.isArray(args[1]);
    } catch { /* Malformed messages still consume the ordinary budget. */ }
  }
  const counter = rtc ? 'rtcRateCount' : 'rateCount';
  data[counter] = (data[counter] || 0) + 1;
  return data[counter] <= (rtc ? 256 : 40);
}
