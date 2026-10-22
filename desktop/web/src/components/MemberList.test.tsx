import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemberList } from './MemberList';
import { createMockBridge, getFixture } from '../test/test-utils';

describe('MemberList Component', () => {
    it('renders server members grouped into Disponíveis with correct roles and avatars', () => {
        const bridge = createMockBridge();
        const session = getFixture('call');
        session.selectedServerId = 'srv-1';
        session.servers = [{ id: 'srv-1', name: 'camargo community', owned: true }];

        render(<MemberList session={session} bridge={bridge} />);

        expect(screen.getByText(/disponíveis/i)).toBeInTheDocument();
        expect(screen.getByText('camargo')).toBeInTheDocument();
        expect(screen.getByText('Dono')).toBeInTheDocument();
    });

    it('emits tri-open-profile when own member row is clicked', () => {
        const bridge = createMockBridge();
        const session = getFixture('call');
        session.selectedServerId = 'srv-1';
        session.servers = [{ id: 'srv-1', name: 'camargo community', owned: false }];

        let profileOpened = false;
        const listener = () => { profileOpened = true; };
        window.addEventListener('tri-open-profile', listener);

        render(<MemberList session={session} bridge={bridge} />);

        const ownButton = screen.getByRole('button', { name: /perfil de camargo/i });
        fireEvent.click(ownButton);

        expect(profileOpened).toBe(true);

        window.removeEventListener('tri-open-profile', listener);
    });
});
