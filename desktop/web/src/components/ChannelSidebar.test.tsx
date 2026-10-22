import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChannelSidebar } from './ChannelSidebar';
import { createMockBridge, getFixture } from '../test/test-utils';

describe('ChannelSidebar Component Hierarchy and Behavior', () => {
    it('nests channel users strictly under their specific channel, not under subsequent channels', () => {
        const bridge = createMockBridge();
        const session = getFixture('call');
        
        session.selectedServerId = 's1';
        session.servers = [{ id: 's1', name: 'camargo community', owned: true }];
        session.connectedChannelId = 'c1';
        session.categories = [
            {
                id: 'cat-1',
                name: 'Canais de Voz',
                channels: [
                    {
                        id: 'c1',
                        name: 'Geral',
                        kind: 'voice',
                        users: [
                            {
                                id: 'u1',
                                name: 'camargo',
                                muted: true,
                                deafened: false,
                                speaking: false,
                            },
                        ],
                    },
                    {
                        id: 'c2',
                        name: 'Jogos',
                        kind: 'voice',
                        users: [],
                    },
                ],
            },
        ];

        render(<ChannelSidebar session={session} bridge={bridge} />);

        const geralChannel = screen.getByText('Geral');
        const jogosChannel = screen.getByText('Jogos');
        const camargoUser = screen.getByText('camargo');

        expect(geralChannel).toBeInTheDocument();
        expect(jogosChannel).toBeInTheDocument();
        expect(camargoUser).toBeInTheDocument();

        // Verify DOM order: "Geral" must appear before "camargo", which MUST appear before "Jogos"
        // (Previously, all users were flattened after Jogos at the bottom of the category!)
        const positionGeral = geralChannel.compareDocumentPosition(camargoUser);
        const positionJogos = camargoUser.compareDocumentPosition(jogosChannel);

        // Node.DOCUMENT_POSITION_FOLLOWING is 4
        expect(positionGeral & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(positionJogos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('triggers joinVoice when voice channel is clicked and openTextRoom for text channel', () => {
        const bridge = createMockBridge();
        const session = getFixture('empty');
        session.selectedServerId = 's1';
        session.servers = [{ id: 's1', name: 'Test Server', owned: true }];
        session.categories = [
            {
                id: 'cat-1',
                name: 'Geral',
                channels: [
                    { id: 'v1', name: 'Voz 1', kind: 'voice', users: [] },
                    { id: 't1', name: 'chat-geral', kind: 'text', users: [] },
                ],
            },
        ];

        render(<ChannelSidebar session={session} bridge={bridge} />);

        fireEvent.click(screen.getByText('Voz 1'));
        expect(bridge.send).toHaveBeenCalledWith({ name: 'selectChannel', channelId: 'v1' });
        expect(bridge.send).toHaveBeenCalledWith({ name: 'joinVoice', channelId: 'v1' });

        fireEvent.click(screen.getByText('chat-geral'));
        expect(bridge.send).toHaveBeenCalledWith({ name: 'selectChannel', channelId: 't1' });
        expect(bridge.send).toHaveBeenCalledWith({ name: 'openTextRoom', channelId: 't1' });
    });
});
