// Room access is decided by the authenticated Durable Object, never by client-supplied room/identity claims.
const encode = value => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
export function mediaMode(users, requested, configured) {
  return users.length ? (users[0].data.mediaTransport || 'mesh')
    : configured && requested === 'livekit' ? 'livekit' : 'mesh';
}
async function signToken(env, claims) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LIVEKIT_API_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `${body}.${btoa(String.fromCharCode(...signature)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`;
}
export async function removeMediaParticipant(env, namespace, room, sid) {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return;
  const url = new URL(env.LIVEKIT_URL); url.protocol = 'https:'; url.pathname = '/twirp/livekit.RoomService/RemoveParticipant';
  const now = Math.floor(Date.now() / 1000);
  await Promise.all(['voice', 'screen', 'camera'].map(async kind => {
    const name = `${namespace}:${room}:${kind}`;
    const token = await signToken(env, { iss: env.LIVEKIT_API_KEY, nbf: now - 10, exp: now + 30, video: { roomAdmin: true, room: name } });
    try {
      const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: name, identity: `${sid}/${kind}` }), signal: AbortSignal.timeout(5000) });
      if (!response.ok && response.status !== 404) console.warn('media: participant cleanup failed', response.status);
    } catch { console.warn('media: participant cleanup unavailable'); }
  }));
}
export async function mediaCredentials(env, namespace, room, sid, name, now = Math.floor(Date.now() / 1000)) {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return null;
  const url = new URL(env.LIVEKIT_URL);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid media endpoint');
  const credentials = {};
  for (const kind of ['voice', 'screen', 'camera']) {
    const identity = `${sid}/${kind}`;
    const claims = { iss: env.LIVEKIT_API_KEY, sub: identity, name, nbf: now - 10, exp: now + 60,
      video: { roomJoin: true, room: `${namespace}:${room}:${kind}`, canPublish: true,
        canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false,
        canPublishSources: kind === 'voice' ? ['microphone'] : kind === 'screen' ? ['screen_share', 'screen_share_audio'] : ['camera'] } };
    credentials[kind] = { url: url.toString(), token: await signToken(env, claims) };
  }
  return credentials;
}
