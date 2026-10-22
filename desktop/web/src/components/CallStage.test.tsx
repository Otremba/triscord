import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CallStage } from './call/CallStage';
import { createMockBridge } from '../test/test-utils';
import { fixtureSession } from '../fixtures';
import type { VideoStream, VoiceUser } from '../protocol';

const baseSession = {
    ...fixtureSession('call'),
    sharing: false,
};

describe('CallStage Dynamic Grouping', () => {
    it('divides the stage among all voice participants when no streams are present', () => {
        const bridge = createMockBridge();
        const users: VoiceUser[] = [
            { id: 'u1', name: 'camargo', self: true, muted: false, deafened: false, speaking: false },
            { id: 'u2', name: 'Virtu', self: false, muted: false, deafened: false, speaking: false },
            { id: 'u3', name: 'Otremba', self: false, muted: false, deafened: false, speaking: false },
        ];

        render(
            <CallStage
                session={baseSession}
                bridge={bridge}
                videoStreams={[]}
                callParticipants={users}
            />
        );

        // All 3 participants appear in the stage
        expect(screen.getByText('camargo')).toBeInTheDocument();
        expect(screen.getByText('Virtu')).toBeInTheDocument();
        expect(screen.getByText('Otremba')).toBeInTheDocument();
    });

    it('groups multiple participants/streams on stage when clicked instead of single tile', () => {
        const bridge = createMockBridge();
        const users: VoiceUser[] = [
            { id: 'u1', name: 'camargo', self: true, muted: false, deafened: false, speaking: false },
            { id: 'u2', name: 'Virtu', self: false, muted: false, deafened: false, speaking: false },
            { id: 'u3', name: 'Otremba', self: false, muted: false, deafened: false, speaking: false },
        ];

        render(
            <CallStage
                session={baseSession}
                bridge={bridge}
                videoStreams={[]}
                callParticipants={users}
            />
        );

        // Click Virtu -> Virtu focused
        fireEvent.click(screen.getByText('Virtu'));

        // Now Otremba is in the strip. Clicking Otremba in strip groups Otremba with Virtu!
        const otrembaStrip = screen.getByText('Otremba');
        fireEvent.click(otrembaStrip);

        // Both Virtu and Otremba are now on stage and camargo remains in strip
        expect(screen.getByText('Virtu')).toBeInTheDocument();
        expect(screen.getByText('Otremba')).toBeInTheDocument();
        expect(screen.getByText('camargo')).toBeInTheDocument();
    });

    it('groups stream and participant together when strip participant is clicked', () => {
        const bridge = createMockBridge();
        const streams: VideoStream[] = [
            {
                id: 'stream-1',
                ownerId: 'u2',
                kind: 'screen',
                title: 'Tela de Virtu',
                width: 1920,
                height: 1080,
                path: 'native-overlay',
            },
        ];
        const users: VoiceUser[] = [
            { id: 'u1', name: 'camargo', self: true, muted: false, deafened: false, speaking: false },
            { id: 'u2', name: 'Virtu', self: false, muted: false, deafened: false, speaking: false },
        ];

        render(
            <CallStage
                session={baseSession}
                bridge={bridge}
                videoStreams={streams}
                callParticipants={users}
            />
        );

        // Initially stream is on stage, Virtu & camargo are in strip
        expect(screen.getByText('Tela de Virtu')).toBeInTheDocument();

        // Click camargo in strip -> camargo groups with the stream on stage!
        const camargoCard = screen.getByText('camargo');
        fireEvent.click(camargoCard);

        // Both are present
        expect(screen.getByText('Tela de Virtu')).toBeInTheDocument();
        expect(screen.getByText('camargo')).toBeInTheDocument();
    });
});
