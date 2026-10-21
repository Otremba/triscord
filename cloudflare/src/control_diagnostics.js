// Only transport metadata, never bearer tokens, message bodies or profile values.
import { scrubLog } from './error_reports.js';
export function lastControlActivity(data, autoResponseTime = 0) {
  return Math.max(data.created || 0, data.lastActivity || 0, autoResponseTime || 0);
}
export function controlCloseReport(data, code, reason, now, autoResponseTime = 0) {
  return {
    component: 'control', diagnostic: 'control-close-v1', code,
    reason: scrubLog(String(reason || '')).replace(/[^\x20-\x7e]/g, '?').slice(0, 120),
    socketId: data.sid, serverId: data.identity?.serverId || 'private-group-v1',
    roomId: data.room || null, mediaTransport: data.mediaTransport || 'mesh',
    ready: !!data.ready, connectionAgeMs: Math.max(0, now - data.created),
    activityAgeMs: Math.max(0, now - lastControlActivity(data, autoResponseTime)),
    autoResponseAgeMs: autoResponseTime ? Math.max(0, now - autoResponseTime) : null,
    lastPingAgeMs: data.lastPingAt ? Math.max(0, now - data.lastPingAt) : null,
    commandsInWindow: data.rateCount || 0, webrtcInWindow: data.rtcRateCount || 0,
  };
}
export async function recordControlClose(env, data, code, reason, now = Date.now(), autoResponseTime = 0) {
  if (!env.DB || !data.identity?.accountId) return;
  // Independent quota: server diagnostics must not consume clients' six uploads/hour.
  try {
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM error_reports WHERE account_id=?1 AND reason='server' AND created_at>?2")
      .bind(data.identity.accountId, now - 3600000).first();
    if ((recent?.n || 0) >= 12) return;
    const text = JSON.stringify(controlCloseReport(data, code, reason, now, autoResponseTime), null, 2);
    await env.DB.prepare('INSERT INTO error_reports(id,account_id,nick,version,signals,reason,bytes,created_at,text) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)')
      .bind(crypto.randomUUID(), data.identity.accountId, data.identity.nick, 'server', 'control-close', 'server', text.length, now, text).run();
  } catch { console.warn('control: could not persist close diagnostic'); }
}
