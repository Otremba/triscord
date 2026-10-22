import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VideoTile } from './VideoTile';
import { createMockBridge } from '../test/test-utils';
import type { VideoStream } from '../protocol';

describe('VideoTile Component', () => {
    it('renders video surface and reports geometry and role', () => {
        const bridge = createMockBridge();
        const stream: VideoStream = {
            id: 'stream-1',
            title: 'Tela do Matheus',
            kind: 'screen',
            width: 1920,
            height: 1080,
            path: 'native-overlay',
        };

        render(<VideoTile stream={stream} bridge={bridge} />);

        // Should report role grid
        expect(bridge.send).toHaveBeenCalledWith({
            name: 'videoRole',
            streamId: 'stream-1',
            role: 'grid',
        });

        expect(screen.getByText('Tela do Matheus')).toBeInTheDocument();
        expect(screen.getByText('AO VIVO')).toBeInTheDocument();
    });

    it('displays unhide button when hidden and requests unhide on click', () => {
        const bridge = createMockBridge();
        const stream: VideoStream = {
            id: 'stream-2',
            title: 'Câmera',
            kind: 'camera',
            hidden: true,
            width: 1280,
            height: 720,
            path: 'native-overlay',
        };

        render(<VideoTile stream={stream} bridge={bridge} />);

        const unhideBtn = screen.getByRole('button', { name: /vídeo oculto/i });
        expect(unhideBtn).toBeInTheDocument();

        fireEvent.click(unhideBtn);

        expect(bridge.request).toHaveBeenCalledWith({
            name: 'setStreamHidden',
            streamId: 'stream-2',
            hidden: false,
        });
    });

    it('displays connecting state when stream is loading', () => {
        const bridge = createMockBridge();
        const stream: VideoStream = {
            id: 'stream-3',
            title: 'Carregando...',
            loading: true,
            width: 1920,
            height: 1080,
            path: 'native-overlay',
        };

        render(<VideoTile stream={stream} bridge={bridge} />);

        expect(screen.getByText(/conectando à transmissão/i)).toBeInTheDocument();
    });
});
