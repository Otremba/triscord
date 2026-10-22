import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsModal } from './SettingsModal';
import { CreateChannelModal } from './modals/CreateChannelModal';
import { CreateServerModal } from './modals/CreateServerModal';
import { ShareScreenModal } from './modals/ShareScreenModal';
import { QuickSwitcher } from './QuickSwitcher';
import { createMockBridge, getFixture } from '../test/test-utils';

describe('Modals & Dialogs Components', () => {
    it('SettingsModal switches tabs and updates settings', () => {
        const bridge = createMockBridge();
        const session = getFixture('call');
        const onClose = vi.fn();

        render(<SettingsModal session={session} bridge={bridge} onClose={onClose} />);

        // Switch to Voz & Vídeo tab
        const voiceTab = screen.getByRole('button', { name: /voz & vídeo/i });
        fireEvent.click(voiceTab);

        expect(screen.getByText(/dispositivo de entrada/i)).toBeInTheDocument();
        expect(screen.getByText(/dispositivo de saída/i)).toBeInTheDocument();

        // Close button
        const closeBtn = screen.getByRole('button', { name: /fechar/i });
        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalled();
    });

    it('CreateChannelModal creates voice and text channels', () => {
        const bridge = createMockBridge();
        const onClose = vi.fn();

        render(<CreateChannelModal categoryName="Canais de Voz" bridge={bridge} onClose={onClose} />);

        const input = screen.getByPlaceholderText(/geral/i);
        fireEvent.change(input, { target: { value: 'jogos-geral' } });

        const submitBtn = screen.getByRole('button', { name: /criar canal/i });
        fireEvent.click(submitBtn);

        expect(bridge.send).toHaveBeenCalledWith({
            name: 'createChannel',
            channelName: 'jogos-geral',
        });
        expect(onClose).toHaveBeenCalled();
    });

    it('CreateServerModal handles creation and invite entry', async () => {
        const bridge = createMockBridge();
        const onClose = vi.fn();

        render(<CreateServerModal bridge={bridge} onClose={onClose} />);

        // Server creation
        const input = screen.getByPlaceholderText(/meu servidor incrível/i);
        fireEvent.change(input, { target: { value: 'Clube dos Cria' } });

        const submitBtn = screen.getByRole('button', { name: /^criar$/i });
        fireEvent.click(submitBtn);

        await waitFor(() => {
            expect(bridge.send).toHaveBeenCalledWith({
                name: 'createServer',
                serverName: 'Clube dos Cria',
            });
            expect(onClose).toHaveBeenCalled();
        });
    });

    it('QuickSwitcher filters channels and navigates with keyboard', () => {
        const bridge = createMockBridge();
        const session = getFixture('call');
        const onClose = vi.fn();

        render(<QuickSwitcher session={session} bridge={bridge} onClose={onClose} />);

        const searchInput = screen.getByPlaceholderText(/digite para buscar/i);
        fireEvent.change(searchInput, { target: { value: 'geral' } });

        expect(screen.getByText('#Geral')).toBeInTheDocument();

        // Escape closes
        fireEvent.keyDown(searchInput, { key: 'Escape' });
        expect(onClose).toHaveBeenCalled();
    });

    it('ShareScreenModal lists sources and starts share with real generation and index', async () => {
        const bridge = createMockBridge(async (cmd) => {
            if (cmd.name === 'listShareSources') {
                return {
                    generation: 'gen-uuid-1234',
                    sources: [
                        { index: 0, kind: 'screen', name: 'Tela 1' },
                        { index: 1, kind: 'window', name: 'Visual Studio Code' },
                    ],
                };
            }
            return null;
        });
        const onClose = vi.fn();

        render(<ShareScreenModal bridge={bridge} onClose={onClose} />);

        await waitFor(() => {
            expect(screen.getByText('Tela 1')).toBeInTheDocument();
        });

        // Click share
        const shareBtn = screen.getByRole('button', { name: /^compartilhar$/i });
        fireEvent.click(shareBtn);

        expect(bridge.send).toHaveBeenCalledWith({
            name: 'startScreenShare',
            generation: 'gen-uuid-1234',
            index: 0,
            resolution: '1080p',
            fps: 60,
        });
        expect(onClose).toHaveBeenCalled();
    });
});
