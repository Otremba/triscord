import type { Bridge } from '../bridge';
import type { Command, Session } from '../protocol';
import { fixtureSession } from '../fixtures';
import { vi } from 'vitest';

export interface MockBridge extends Bridge {
    sent: Command[];
    requested: any[];
    callbacks: Array<(msg: any) => void>;
    emit(msg: any): void;
}

export function createMockBridge(requestHandler?: (cmd: any) => Promise<any>): MockBridge {
    const sent: Command[] = [];
    const requested: any[] = [];
    const callbacks: Array<(msg: any) => void> = [];

    return {
        sent,
        requested,
        callbacks,
        send: vi.fn((cmd: Command) => {
            sent.push(cmd);
            return 'mock-req-id';
        }),
        request: vi.fn(async (cmd: any) => {
            requested.push(cmd);
            if (requestHandler) return requestHandler(cmd);
            return null;
        }),
        onMessage: vi.fn((cb: (msg: any) => void) => {
            callbacks.push(cb);
            return () => {
                const idx = callbacks.indexOf(cb);
                if (idx >= 0) callbacks.splice(idx, 1);
            };
        }),
        emit(msg: any) {
            for (const cb of callbacks) cb(msg);
        },
    };
}

export function getFixture(name: string = 'call'): Session {
    return JSON.parse(JSON.stringify(fixtureSession(name)));
}
