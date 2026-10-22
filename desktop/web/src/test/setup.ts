import '@testing-library/jest-dom/vitest';

// Mock Web Audio API for happy-dom
if (typeof window !== 'undefined') {
    class MockAudioContext {
        state = 'running';
        createGain() {
            return {
                connect: () => {},
                disconnect: () => {},
                gain: { value: 1, setValueAtTime: () => {} },
            };
        }
        createBufferSource() {
            return {
                connect: () => {},
                disconnect: () => {},
                buffer: null,
                start: () => {},
                stop: () => {},
            };
        }
        decodeAudioData(_buffer: ArrayBuffer) {
            return Promise.resolve({ duration: 1 } as AudioBuffer);
        }
        resume() {
            return Promise.resolve();
        }
        suspend() {
            return Promise.resolve();
        }
        close() {
            return Promise.resolve();
        }
    }
    (window as any).AudioContext = MockAudioContext;
    (window as any).webkitAudioContext = MockAudioContext;

    // Mock ResizeObserver
    class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    }
    (window as any).ResizeObserver = MockResizeObserver;
}
