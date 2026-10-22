import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginScreen } from './LoginScreen';
import { createMockBridge } from '../test/test-utils';

describe('LoginScreen Component', () => {
    it('renders google sign-in button when signed out', () => {
        const bridge = createMockBridge();
        render(<LoginScreen auth={{ state: 'signedOut' }} bridge={bridge} />);

        const googleBtn = screen.getByRole('button', { name: /entrar com google/i });
        expect(googleBtn).toBeInTheDocument();
        expect(googleBtn).not.toBeDisabled();
    });

    it('sends signIn command when google button is clicked', () => {
        const bridge = createMockBridge();
        render(<LoginScreen auth={{ state: 'signedOut' }} bridge={bridge} />);

        const googleBtn = screen.getByRole('button', { name: /entrar com google/i });
        fireEvent.click(googleBtn);

        expect(bridge.send).toHaveBeenCalledWith({ name: 'signIn' });
    });

    it('disables google button while signing in', () => {
        const bridge = createMockBridge();
        render(<LoginScreen auth={{ state: 'signingIn' }} bridge={bridge} />);

        const googleBtn = screen.getByRole('button', { name: /conectando ao navegador/i });
        expect(googleBtn).toBeInTheDocument();
        expect(googleBtn).toBeDisabled();
    });

    it('shows display name prompt when state is needsNick', async () => {
        const bridge = createMockBridge(async cmd => {
            if (cmd.name === 'setNick') return { ok: true };
            return null;
        });
        const onSuccess = vi.fn();
        render(<LoginScreen auth={{ state: 'needsNick', suggestedNick: 'Otremba' }} bridge={bridge} onSuccess={onSuccess} />);

        expect(screen.getByText(/como quer ser chamado\?/i)).toBeInTheDocument();
        const input = screen.getByPlaceholderText(/seu apelido/i) as HTMLInputElement;
        expect(input.value).toBe('Otremba');

        const submitBtn = screen.getByRole('button', { name: /continuar/i });
        fireEvent.click(submitBtn);

        await waitFor(() => {
            expect(bridge.request).toHaveBeenCalledWith({ name: 'setNick', nick: 'Otremba' });
            expect(onSuccess).toHaveBeenCalled();
        });
    });

    it('validates min length on nickname submission', async () => {
        const bridge = createMockBridge();
        render(<LoginScreen auth={{ state: 'needsNick', suggestedNick: 'a' }} bridge={bridge} />);

        const input = screen.getByPlaceholderText(/seu apelido/i);
        fireEvent.change(input, { target: { value: 'a' } });

        const submitBtn = screen.getByRole('button', { name: /continuar/i });
        fireEvent.click(submitBtn);

        expect(await screen.findByText(/use pelo menos dois caracteres/i)).toBeInTheDocument();
        expect(bridge.request).not.toHaveBeenCalled();
    });
});
