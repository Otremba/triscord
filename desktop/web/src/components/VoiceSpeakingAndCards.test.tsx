import { describe, it, expect, vi } from 'vitest';
import { render, screen, renderHook, act, fireEvent } from '@testing-library/react';
import { useSpeakingHold } from '../hooks/useSpeakingHold';
import { ParticipantCard } from './call/ParticipantCard';
import { OwnStreamTile } from './call/OwnStreamTile';
import type { VoiceUser } from '../protocol';

describe('Voice Speaking Indicator & ParticipantCard', () => {
    it('useSpeakingHold activates immediately and holds speaking state for 400ms', () => {
        vi.useFakeTimers();

        const { result, rerender } = renderHook(({ active }) => useSpeakingHold(active, 400), {
            initialProps: { active: false },
        });

        expect(result.current).toBe(false);

        // Speaking starts
        rerender({ active: true });
        expect(result.current).toBe(true);

        // Speaking stops -> should still be held
        rerender({ active: false });
        expect(result.current).toBe(true);

        // Advance 250ms (still within 400ms hold)
        act(() => {
            vi.advanceTimersByTime(250);
        });
        expect(result.current).toBe(true);

        // Advance past 400ms
        act(() => {
            vi.advanceTimersByTime(160);
        });
        expect(result.current).toBe(false);

        vi.useRealTimers();
    });

    it('ParticipantCard renders stage layout with green ring when speaking', () => {
        const user: VoiceUser = {
            id: 'u1',
            name: 'Otremba',
            self: false,
            muted: false,
            deafened: false,
            speaking: true,
        };

        const { container, rerender } = render(<ParticipantCard user={user} isSpeaking={true} />);

        expect(screen.getByText('Otremba')).toBeInTheDocument();
        // Check for green speaking border class/style
        const card = container.firstChild as HTMLElement;
        expect(card.className).toContain('border-[#23a55a]');

        // When not speaking
        rerender(<ParticipantCard user={user} isSpeaking={false} />);
        // useSpeakingHold holds for 400ms, then drops
    });

    it('ParticipantCard never displays green speaking ring when user is muted or deafened even if isSpeaking is true', () => {
        const mutedUser: VoiceUser = {
            id: 'u1',
            name: 'camargo',
            self: true,
            muted: true,
            deafened: false,
            speaking: true,
        };

        const { container } = render(<ParticipantCard user={mutedUser} isSpeaking={true} />);

        // Must NOT have green border or ring
        const card = container.firstChild as HTMLElement;
        expect(card.className).not.toContain('border-[#23a55a]');
        expect(card.className).not.toContain('ring-[#23a55a]');
    });

    it('ParticipantCard triggers onKick when moderation button is clicked', () => {
        const user: VoiceUser = {
            id: 'u2',
            name: 'Infrator',
            self: false,
            muted: true,
            deafened: false,
            speaking: false,
        };

        const onKick = vi.fn();
        render(<ParticipantCard user={user} isSpeaking={false} onKick={onKick} />);

        const kickBtn = screen.getByRole('button', { name: /remover da chamada/i });
        fireEvent.click(kickBtn);

        expect(onKick).toHaveBeenCalledTimes(1);
    });

    it('ParticipantCard displays AO VIVO badge when user is live streaming', () => {
        const user: VoiceUser = {
            id: 'u3',
            name: 'Streamer',
            self: true,
            muted: false,
            deafened: false,
            speaking: false,
            live: true,
        };

        render(<ParticipantCard user={user} isSpeaking={false} />);
        expect(screen.getByText('AO VIVO')).toBeInTheDocument();
    });

    it('OwnStreamTile displays stream title, quality info, timer and stop button', () => {
        const bridge = { send: vi.fn(), request: vi.fn(), on: vi.fn(), off: vi.fn() };
        const session: any = {
            sharing: true,
            sharingName: 'Valorant - Partida Ranqueada',
            settings: {
                shareHd: true,
                shareAudio: true,
            },
        };

        render(<OwnStreamTile session={session} bridge={bridge as any} />);

        expect(screen.getByText('Valorant - Partida Ranqueada')).toBeInTheDocument();
        expect(screen.getByText('1080p 60 FPS')).toBeInTheDocument();
        expect(screen.getByText('8.0 Mbps')).toBeInTheDocument();
        expect(screen.getByText(/Você está transmitindo sua tela/i)).toBeInTheDocument();

        const stopBtn = screen.getByRole('button', { name: /Parar Transmissão/i });
        fireEvent.click(stopBtn);
        expect(bridge.send).toHaveBeenCalledWith({ name: 'stopScreenShare' });
    });
});

