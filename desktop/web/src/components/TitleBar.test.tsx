import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TitleBar } from './TitleBar';
import { createMockBridge } from '../test/test-utils';

describe('TitleBar Component', () => {
    it('renders server name or default Triscord', () => {
        const bridge = createMockBridge();
        const { rerender } = render(<TitleBar bridge={bridge} />);
        expect(screen.getByText('Triscord')).toBeInTheDocument();

        rerender(<TitleBar server={{ id: 's1', name: 'Sala dos Amigos', owned: true }} bridge={bridge} />);
        expect(screen.getByText('Sala dos Amigos')).toBeInTheDocument();
    });

    it('triggers minimize, maximize and close actions', () => {
        const bridge = createMockBridge();
        render(<TitleBar bridge={bridge} />);

        const minBtn = screen.getByRole('button', { name: /minimizar/i });
        const maxBtn = screen.getByRole('button', { name: /maximizar/i });
        const closeBtn = screen.getByRole('button', { name: /fechar/i });

        fireEvent.click(minBtn);
        expect(bridge.send).toHaveBeenCalledWith({ name: 'window', action: 'minimize' });

        fireEvent.click(maxBtn);
        expect(bridge.send).toHaveBeenCalledWith({ name: 'window', action: 'maximize' });

        fireEvent.click(closeBtn);
        expect(bridge.send).toHaveBeenCalledWith({ name: 'window', action: 'close' });
    });

    it('triggers window maximize on double click of header background', () => {
        const bridge = createMockBridge();
        const { container } = render(<TitleBar bridge={bridge} />);
        const header = container.querySelector('header');
        expect(header).toBeInTheDocument();

        fireEvent.doubleClick(header!);
        expect(bridge.send).toHaveBeenCalledWith({ name: 'window', action: 'maximize' });
    });
});
