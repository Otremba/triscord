import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';
import { createMockBridge } from '../test/test-utils';
import type { ChatMessage } from '../protocol';

describe('ChatPanel Component', () => {
    const mockMessages: ChatMessage[] = [
        {
            id: 'm1',
            authorId: 'u1',
            authorName: 'Camargo',
            text: 'Olá mundo!',
            timestamp: Date.now() - 60000,
            own: false,
            reactions: [],
        },
        {
            id: 'm2',
            authorId: 'u2',
            authorName: 'Amigo',
            text: 'Bora jogar?',
            timestamp: Date.now() - 30000,
            own: true,
            reactions: [],
        },
    ];

    it('renders message history correctly', () => {
        const bridge = createMockBridge();
        render(<ChatPanel channelName="Geral" messages={mockMessages} bridge={bridge} />);

        expect(screen.getByText('Olá mundo!')).toBeInTheDocument();
        expect(screen.getByText('Bora jogar?')).toBeInTheDocument();
        expect(screen.getByText('Camargo')).toBeInTheDocument();
    });

    it('sends message on Enter key and clears input', () => {
        const bridge = createMockBridge();
        render(<ChatPanel channelName="Geral" messages={mockMessages} bridge={bridge} />);

        const textarea = screen.getByPlaceholderText(/mensagem em #geral/i) as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: 'Mensagem de teste' } });

        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

        expect(bridge.send).toHaveBeenCalledWith({
            name: 'sendChatMessage',
            text: 'Mensagem de teste',
        });
        expect(textarea.value).toBe('');
    });

    it('does not send message on Shift+Enter (allows newline)', () => {
        const bridge = createMockBridge();
        render(<ChatPanel channelName="Geral" messages={mockMessages} bridge={bridge} />);

        const textarea = screen.getByPlaceholderText(/mensagem em #geral/i) as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: 'Primeira linha' } });

        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

        expect(bridge.send).not.toHaveBeenCalled();
        expect(textarea.value).toBe('Primeira linha');
    });

    it('ignores empty or whitespace-only messages', () => {
        const bridge = createMockBridge();
        render(<ChatPanel channelName="Geral" messages={mockMessages} bridge={bridge} />);

        const textarea = screen.getByPlaceholderText(/mensagem em #geral/i) as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: '   ' } });

        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

        expect(bridge.send).not.toHaveBeenCalled();
    });
});
