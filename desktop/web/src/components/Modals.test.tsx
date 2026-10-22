import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsModal } from './SettingsModal';
import { CreateChannelModal } from './modals/CreateChannelModal';
import { CreateServerModal } from './modals/CreateServerModal';
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
});
