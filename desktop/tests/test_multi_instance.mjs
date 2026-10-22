// Multi-instance integration test for Triscord Voice and Screen Sharing.
// Simulates two concurrent clients (Alice & Bob) joining a voice channel,
// authenticating against the Auth worker, connecting to the Control Hub,
// and validating LiveKit SFU credential minting, participant discovery, and signaling.

import assert from 'node:assert/strict';

const AUTH_URL = process.env.TRISCORD_AUTH_URL || 'https://triscord-auth.triscord-cloudflare-control.workers.dev';
const HUB_URL = process.env.TRISCORD_HUB_URL || 'https://triscord-control.triscord-cloudflare-control.workers.dev';
const TEST_ROOM = process.env.TRISCORD_TEST_ROOM || 'geral';

const INVITE_CODE = 'tuYhYjOl4FY8IWKNJ68Y4a-Tb5Uzu6nq';

async function createTestAccount(prefix) {
    const nick = `${prefix}_${Date.now().toString(36).slice(-5)}`;
    const res = await fetch(`${AUTH_URL}/auth/nick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick }),
    });
    if (!res.ok) {
        throw new Error(`Falha ao criar conta para ${nick}: HTTP ${res.status}`);
    }
    const data = await res.json();
    return { nick, session: data.session, accountId: data.account?.id };
}

class SimulatedClient {
    constructor(name) {
        this.name = name;
        this.account = null;
        this.ws = null;
        this.sid = null;
        this.roomData = null;
        this.events = [];
        this.listeners = new Map();
    }

    async authenticate() {
        this.account = await createTestAccount(this.name);
        return this.account;
    }

    async connect() {
        if (!this.account) {
            await this.authenticate();
        }

        const url = new URL(HUB_URL);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = '/socket.io/';
        url.searchParams.set('EIO', '4');
        url.searchParams.set('transport', 'websocket');
        url.searchParams.set('sessionToken', this.account.session);

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url.toString());
            this.ws = ws;

            const timer = setTimeout(() => {
                reject(new Error(`[${this.name}] Timeout conectando ao hub`));
            }, 10000);

            ws.onerror = (err) => {
                clearTimeout(timer);
                reject(err);
            };

            ws.onclose = (event) => {
                if (!this.sid) {
                    clearTimeout(timer);
                    reject(new Error(`[${this.name}] WebSocket fechado antes de conectar (Code: ${event.code}, Motivo: ${event.reason})`));
                }
            };

            ws.onmessage = (event) => {
                const data = String(event.data);
                if (data.startsWith('0')) {
                    // Open frame -> respond with 40 and invite code
                    ws.send(`40${JSON.stringify({ invite: INVITE_CODE })}`);
                } else if (data.startsWith('40')) {
                    // Connected
                    const parsed = JSON.parse(data.slice(2));
                    this.sid = parsed.sid;
                    clearTimeout(timer);
                    resolve();
                } else if (data.startsWith('2')) {
                    // Ping -> Pong
                    ws.send('3');
                } else if (data.startsWith('42[')) {
                    try {
                        const [eventName, payload] = JSON.parse(data.slice(2));
                        this.events.push({ eventName, payload });
                        const callback = this.listeners.get(eventName);
                        if (callback) callback(payload);
                    } catch (e) {
                        console.error(`[${this.name}] Erro ao parsear pacote:`, data, e);
                    }
                }
            };
        });
    }

    waitForEvent(eventName, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            // Check if already in history
            const existing = this.events.find(e => e.eventName === eventName);
            if (existing) {
                // remove to not re-trigger
                const idx = this.events.indexOf(existing);
                this.events.splice(idx, 1);
                return resolve(existing.payload);
            }

            const timer = setTimeout(() => {
                this.listeners.delete(eventName);
                reject(new Error(`[${this.name}] Timeout aguardando evento: ${eventName}`));
            }, timeoutMs);

            this.listeners.set(eventName, (payload) => {
                clearTimeout(timer);
                this.listeners.delete(eventName);
                resolve(payload);
            });
        });
    }

    send(name, payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error(`[${this.name}] WebSocket não está aberto`);
        }
        this.ws.send(`42${JSON.stringify([name, payload])}`);
    }

    async joinVoice(roomId, roomName = 'Geral') {
        this.send('join-room', {
            roomId,
            roomName,
            mediaTransport: 'livekit',
            sessionToken: this.account.session,
            userData: {
                username: this.account.nick,
                sessionToken: this.account.session,
                isMuted: false,
                isDeafened: false,
                status: 'Test Client'
            }
        });
        const roomJoined = await this.waitForEvent('room-joined');
        this.roomData = roomJoined;
        return roomJoined;
    }

    async leave() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.send('leave-room', {});
            } catch {}
            this.ws.close();
        }
    }
}

async function runTest() {
    console.log('--- Iniciando Teste Multi-Instância Triscord (Voz & Tela) ---');
    console.log(`Hub: ${HUB_URL}`);
    console.log(`Auth: ${AUTH_URL}`);

    const alice = new SimulatedClient('Alice');
    const bob = new SimulatedClient('Bob');

    try {
        console.log('1. Autenticando e conectando Instância 1 (Alice)...');
        await alice.connect();
        console.log(`   Alice conectada como "${alice.account.nick}" (Socket: ${alice.sid})`);

        console.log('2. Autenticando e conectando Instância 2 (Bob)...');
        await bob.connect();
        console.log(`   Bob conectado como "${bob.account.nick}" (Socket: ${bob.sid})`);

        console.log(`3. Alice entrando no canal de voz "${TEST_ROOM}"...`);
        const aliceRoom = await alice.joinVoice(TEST_ROOM);
        assert.equal(aliceRoom.roomId, TEST_ROOM, 'RoomId deve bater');
        assert.equal(aliceRoom.mediaTransport, 'livekit', 'Transporte deve ser LiveKit SFU');
        assert(aliceRoom.media, 'Credenciais de mídia devem existir');
        assert(aliceRoom.media.voice?.url, 'URL LiveKit de voz deve existir');
        assert(aliceRoom.media.voice?.token, 'Token JWT de voz deve existir');
        assert(aliceRoom.media.screen?.token, 'Token JWT de tela deve existir');
        console.log(`   Alice admitida no LiveKit SFU: ${aliceRoom.media.voice.url}`);

        console.log(`4. Bob entrando no mesmo canal de voz "${TEST_ROOM}"...`);
        const bobJoinedPromise = alice.waitForEvent('user-joined');
        const bobRoom = await bob.joinVoice(TEST_ROOM);
        assert.equal(bobRoom.roomId, TEST_ROOM);
        assert.equal(bobRoom.mediaTransport, 'livekit', 'Bob também deve usar LiveKit SFU');
        assert(bobRoom.media.voice?.token, 'Bob deve receber token LiveKit');

        console.log('5. Verificando descoberta mútua em tempo real...');
        const userJoinedAlice = await bobJoinedPromise;
        assert.equal(userJoinedAlice.userData.username, bob.account.nick, 'Alice deve detectar a entrada de Bob');
        console.log(`   Confirmado: Alice recebeu notificação de entrada de ${userJoinedAlice.userData.username}!`);

        // Test LiveKit WSS connection directly to VPS
        console.log('6. Validando handshake WebSocket com a VPS LiveKit (SFU)...');
        const lkUrl = new URL(aliceRoom.media.voice.url);
        lkUrl.protocol = 'wss:';
        lkUrl.pathname = '/rtc';
        lkUrl.searchParams.set('access_token', aliceRoom.media.voice.token);
        lkUrl.searchParams.set('protocol', '15');

        await new Promise((resolve, reject) => {
            const lkWs = new WebSocket(lkUrl.toString());
            const timer = setTimeout(() => {
                lkWs.close();
                reject(new Error('Timeout conectando ao LiveKit WSS'));
            }, 8000);

            lkWs.onopen = () => {
                console.log('   Conexão direta estabelecida com o SFU LiveKit na VPS (217.9.14.79)!');
                clearTimeout(timer);
                lkWs.close();
                resolve();
            };

            lkWs.onerror = (err) => {
                clearTimeout(timer);
                reject(new Error(`Erro ao conectar ao LiveKit SFU: ${err.message || 'Falha de rede'}`));
            };
        });

        console.log('7. Testando atualização de estado de voz (Mute / Microfone)...');
        const statePromise = bob.waitForEvent('user-state-updated');
        alice.send('user-state-change', { isMuted: true, isDeafened: false, isSpeaking: false });
        const updatedState = await statePromise;
        assert.equal(updatedState.socketId, alice.sid, 'Socket ID deve corresponder a Alice');
        assert.equal(updatedState.state.isMuted, true, 'Alice deve figurar como mutada');
        console.log('   Confirmado: Bob recebeu estado mutado de Alice!');

        console.log('8. Testando admissão para Compartilhamento de Tela...');
        const screenPromise = alice.waitForEvent('media-credentials');
        alice.send('media-refresh', { kind: 'screen', roomId: TEST_ROOM });
        const screenCreds = await screenPromise;
        assert.equal(screenCreds.kind, 'screen');
        assert(screenCreds.credentials?.token, 'Token de tela deve ser renovado');
        console.log('   Confirmado: Token de compartilhamento de tela emitido pela VPS!');

        console.log('9. Desconectando participantes de forma limpa...');
        const leavePromise = alice.waitForEvent('user-left');
        await bob.leave();
        const leftUser = await leavePromise;
        assert.equal(leftUser.username, bob.account.nick);
        console.log(`   Confirmado: Alice recebeu saída de ${leftUser.username}!`);

        await alice.leave();
        console.log('\n--- TODOS OS 9 PASSOS DO TESTE MULTI-INSTÂNCIA PASSARAM COM SUCESSO! ---');
    } catch (err) {
        console.error('\nFALHA NO TESTE MULTI-INSTÂNCIA:', err);
        await alice.leave();
        await bob.leave();
        process.exit(1);
    }
}

runTest();
