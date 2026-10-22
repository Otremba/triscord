import { describe, it, expect, vi } from 'vitest';
import { SessionStore } from './store';
import { getFixture } from './test/test-utils';
import { PROTOCOL_VERSION } from './protocol';

describe('SessionStore & State Resilience Fuzzing', () => {
    it('requests snapshot when receiving a message with invalid protocol version', () => {
        const onRequestSnapshot = vi.fn();
        const store = new SessionStore(onRequestSnapshot);

        const session = getFixture('call');
        store.receive({ v: PROTOCOL_VERSION + 1, type: 'snapshot', session, revision: 1 } as any);

        expect(onRequestSnapshot).toHaveBeenCalled();
        expect(store.current).toBeNull();
    });

    it('receives snapshot, sets current session and notifies subscribers', () => {
        const onRequestSnapshot = vi.fn();
        const store = new SessionStore(onRequestSnapshot);

        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        const session = getFixture('call');
        store.receive({ v: PROTOCOL_VERSION, type: 'snapshot', session, revision: 1 });

        expect(store.current).toEqual(session);
        expect(listener).toHaveBeenCalledWith(session);

        unsubscribe();
    });

    it('applies delta patches when baseRevision matches', () => {
        const onRequestSnapshot = vi.fn();
        const store = new SessionStore(onRequestSnapshot);
        const session = getFixture('call');

        store.receive({ v: PROTOCOL_VERSION, type: 'snapshot', session, revision: 1 });

        // Apply delta
        store.receive({
            v: PROTOCOL_VERSION,
            type: 'delta',
            baseRevision: 1,
            revision: 2,
            patch: {
                muted: true,
                connectedChannelId: 'geral-2',
            },
        });

        const current = store.current!;
        expect(current.muted).toBe(true);
        expect(current.connectedChannelId).toBe('geral-2');
        expect(current.account.displayName).toBe(session.account.displayName);
        expect(onRequestSnapshot).not.toHaveBeenCalled();
    });

    it('detects revision gap and requests fresh snapshot', () => {
        const onRequestSnapshot = vi.fn();
        const store = new SessionStore(onRequestSnapshot);
        const session = getFixture('call');

        store.receive({ v: PROTOCOL_VERSION, type: 'snapshot', session, revision: 1 });

        // Apply delta with wrong base revision (gap)
        store.receive({
            v: PROTOCOL_VERSION,
            type: 'delta',
            baseRevision: 999,
            revision: 1000,
            patch: { muted: true },
        });

        expect(onRequestSnapshot).toHaveBeenCalled();
        // Session should remain at revision 1 without partial corrupt patch
        expect(store.current?.muted).toBe(session.muted);
    });

    it('routes event messages to onEvent listeners', () => {
        const store = new SessionStore(() => {});
        const eventListener = vi.fn();
        const unsubscribe = store.onEvent(eventListener);

        const mockEvent = {
            v: PROTOCOL_VERSION,
            type: 'event' as const,
            name: 'callActivity' as const,
        };
        store.receive(mockEvent);

        expect(eventListener).toHaveBeenCalledWith(mockEvent);
        unsubscribe();
    });

    it('fuzzing: handles malformed, partial, and extreme snapshots gracefully without crashing', () => {
        const store = new SessionStore(() => {});

        // 1. Snapshot with empty object
        expect(() => {
            store.receive({ v: PROTOCOL_VERSION, type: 'snapshot', session: {} as any, revision: 1 });
        }).not.toThrow();

        // 2. Snapshot with extreme text and unicode
        const longText = 'A'.repeat(50000);
        const extremeUnicode = '🚀🎉🔥'.repeat(1000) + '\u0000\uFFFF';

        expect(() => {
            store.receive({
                v: PROTOCOL_VERSION,
                type: 'delta',
                baseRevision: 1,
                revision: 2,
                patch: {
                    account: {
                        id: 'fuzz-1',
                        displayName: longText,
                        username: extremeUnicode,
                        status: 'invisible',
                    },
                },
            });
        }).not.toThrow();

        expect(store.current?.account?.displayName).toBe(longText);

        // 3. Stress test: 500 users in channel
        const hugeUsersList = Array.from({ length: 500 }, (_, i) => ({
            id: `user-${i}`,
            name: `User ${i}`,
            muted: i % 2 === 0,
            deafened: i % 4 === 0,
            speaking: i % 5 === 0,
        }));

        expect(() => {
            store.receive({
                v: PROTOCOL_VERSION,
                type: 'delta',
                baseRevision: 2,
                revision: 3,
                patch: {
                    categories: [
                        {
                            id: 'c1',
                            name: 'Mega Room',
                            channels: [
                                {
                                    id: 'ch1',
                                    name: 'Geral',
                                    kind: 'voice',
                                    users: hugeUsersList,
                                },
                            ],
                        },
                    ],
                },
            });
        }).not.toThrow();

        expect(store.current?.categories[0].channels[0].users.length).toBe(500);
    });
});
