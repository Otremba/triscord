import { useState } from 'react';
import type { Bridge } from '../bridge';
import type { AuthState } from '../protocol';
import { Button } from './ui/button';

export function LoginScreen({ auth, bridge, onSuccess }: { auth?: AuthState; bridge: Bridge; onSuccess?: () => void }) {
    const [nick, setNick] = useState(auth?.suggestedNick ?? '');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isNeedsNick = auth?.state === 'needsNick';

    const handleNickSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = nick.trim();
        if (trimmed.length < 2) {
            setError('Use pelo menos dois caracteres.');
            return;
        }

        setLoading(true);
        setError(null);
        try {
            await bridge.request({ name: 'setNick', nick: trimmed });
            onSuccess?.();
        } catch (err: any) {
            setError(err.message ?? 'Falha ao salvar apelido.');
        } finally {
            setLoading(false);
        }
    };

    const handleGoogleSignIn = () => {
        setError(null);
        bridge.send({ name: 'signIn' });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950 p-4 select-none">
            <div className="w-full max-w-sm rounded-xl border border-ink-800 bg-ink-900 p-8 shadow-2xl">
                <div className="text-center mb-6">
                    <h1 className="text-2xl font-bold tracking-tight text-ink-100">
                        {isNeedsNick ? 'Como quer ser chamado?' : 'Boas-vindas ao Triscord'}
                    </h1>
                    <p className="mt-1.5 text-xs text-ink-400">
                        {isNeedsNick
                            ? 'Escolha o nome com o qual seus amigos verão você.'
                            : 'Um espaço leve e privado para conversar e jogar.'}
                    </p>
                </div>

                {isNeedsNick ? (
                    <form onSubmit={handleNickSubmit} className="space-y-4">
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">
                                Nome de exibição
                            </label>
                            <input
                                type="text"
                                value={nick}
                                onChange={e => setNick(e.target.value)}
                                autoFocus
                                maxLength={32}
                                className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
                                placeholder="Seu apelido"
                            />
                        </div>

                        {error && <p className="text-xs text-critical">{error}</p>}

                        <Button type="submit" variant="default" className="w-full" disabled={loading || !nick.trim()}>
                            {loading ? 'Salvando...' : 'Continuar'}
                        </Button>
                    </form>
                ) : (
                    <div className="space-y-4">
                        <button
                            type="button"
                            onClick={handleGoogleSignIn}
                            disabled={auth?.state === 'signingIn'}
                            className="flex w-full items-center justify-center gap-3 rounded-lg border border-ink-700 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 shadow-sm transition-all hover:bg-gray-100 disabled:opacity-50"
                        >
                            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                            </svg>
                            <span>{auth?.state === 'signingIn' ? 'Conectando ao navegador...' : 'Entrar com Google'}</span>
                        </button>

                        {error && <p className="text-xs text-center text-critical">{error}</p>}
                    </div>
                )}
            </div>
        </div>
    );
}