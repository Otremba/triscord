import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AccountPanel } from './AccountPanel';
import { ControlsBar } from './call/ControlsBar';
import { createMockBridge, getFixture } from '../test/test-utils';
import { soundEngine } from '../sound-engine';

describe('AccountPanel & ControlsBar Components', () => {
    beforeEach(() => {
        vi.spyOn(soundEngine, 'play').mockImplementation(() => {});
    });

    it('AccountPanel displays user info and triggers mute/deafen with sound effects', () => {
        const bridge = createMockBridge();
        const session = getFixture('call');
        session.muted = false;
        session.deafened = false;

        render(<AccountPanel session={session} bridge={bridge} />);

        expect(screen.getAllByText('camargo').length).toBeGreaterThanOrEqual(1);

        // Mute toggle
        const muteBtn = screen.getByRole('button', { name: /silenciar/i });
        fireEvent.click(muteBtn);
        expect(soundEngine.play).toHaveBeenCalledWith('mute');
        expect(bridge.send).toHaveBeenCalledWith({ name: 'setMuted', muted: true });

        // Deafen toggle
        const deafenBtn = screen.getByRole('button', { name: /desativar áudio/i });
        fireEvent.click(deafenBtn);
        expect(soundEngine.play).toHaveBeenCalledWith('deafen');
        expect(bridge.send).toHaveBeenCalledWith({ name: 'setDeafened', deafened: true });

        // Settings
        const settingsListener = vi.fn();
        window.addEventListener('tri-open-settings', settingsListener);
        const settingsBtn = screen.getByRole('button', { name: /configurações/i });
        fireEvent.click(settingsBtn);
        expect(settingsListener).toHaveBeenCalled();
        expect(bridge.send).toHaveBeenCalledWith({ name: 'openSettings' });
        window.removeEventListener('tri-open-settings', settingsListener);
    });

    it('AccountPanel opens UserProfilePopout when clicking user profile and handles edit profile', () => {
        const bridge = createMockBridge();
        const session = getFixture('call');
        render(<AccountPanel session={session} bridge={bridge} />);

        // Popout is initially not rendered
        expect(screen.queryByText(/editar perfil/i)).not.toBeInTheDocument();

        // Click user profile button
        const profileBtn = screen.getByRole('button', { name: /meu perfil/i });
        fireEvent.click(profileBtn);

        // Popout is now visible with profile info
        expect(screen.getByText(/editar perfil/i)).toBeInTheDocument();

        // Clicking "Editar Perfil" triggers openSettings on 'account' page
        const settingsListener = vi.fn();
        window.addEventListener('tri-open-settings', settingsListener);
        const editBtn = screen.getByRole('button', { name: /editar perfil/i });
        fireEvent.click(editBtn);

        expect(settingsListener).toHaveBeenCalled();
        window.removeEventListener('tri-open-settings', settingsListener);
    });

    it('ControlsBar toggles camera, sharing, and leaveVoice with sound effects', () => {
        const bridge = createMockBridge();
        const session = getFixture('call');
        session.camera = false;
        session.sharing = false;

        render(<ControlsBar session={session} bridge={bridge} />);

        // Camera toggle
        const cameraBtn = screen.getByRole('button', { name: /ativar câmera/i });
        fireEvent.click(cameraBtn);
        expect(soundEngine.play).toHaveBeenCalledWith('cameraOn');
        expect(bridge.send).toHaveBeenCalledWith({ name: 'setCamera', on: true });

        // Screen share toggle opens shareScreen modal
        const modalListener = vi.fn();
        window.addEventListener('tri-open-modal', modalListener);
        const shareBtn = screen.getByRole('button', { name: /compartilhar tela/i });
        fireEvent.click(shareBtn);
        expect(modalListener).toHaveBeenCalled();
        window.removeEventListener('tri-open-modal', modalListener);

        // Leave call
        const leaveBtn = screen.getByRole('button', { name: /desconectar da chamada/i });
        fireEvent.click(leaveBtn);
        expect(soundEngine.play).toHaveBeenCalledWith('leave');
        expect(bridge.send).toHaveBeenCalledWith({ name: 'leaveVoice' });
    });
});
