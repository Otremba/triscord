import { useEffect, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { AuthState } from '../protocol';
import { TriscordLogo } from './ui/TriscordLogo';
import { ShimmerButton } from './ui/ShimmerButton';

// User authentication and login screen.
export function LoginScreen({ auth, bridge }: { auth: AuthState; bridge: Bridge; googleLogin?: boolean }) {
  const [nick, setNick] = useState(auth.suggestedNick ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The suggestion arrives with the needsNick state, after this screen was first shown as "signing in".
  useEffect(() => { if (auth.suggestedNick && !nick) setNick(auth.suggestedNick); }, [auth.suggestedNick]);
  useEffect(() => { setError(null); }, [auth.state]);

  const field = (event: Event, name: string) =>
    ((event.currentTarget as HTMLFormElement).elements.namedItem(name) as HTMLInputElement | null)?.value ?? '';

  const submitNick = (event: Event) => {
    event.preventDefault();
    // Read the field itself: a submit right after a paste must not see a stale state value.
    const value = field(event, 'nick').trim();
    if (value.length < 2) { setError('Use pelo menos dois caracteres.'); return; }
    setSaving(true);
    setError(null);
    bridge.request({ name: 'setNick', nick: value }).catch((e: Error) => setError(e.message)).finally(() => setSaving(false));
  };

  const busy = saving || auth.state === 'signingIn';
  const shownError = error ?? auth.error ?? null;

  return (
    <div class="tri-login bg-space-950">
      <div class="tri-login__brand flex items-center gap-3">
        <TriscordLogo size={36} />
        <span class="font-semibold tracking-tight text-xl">Triscord</span>
      </div>
      <div class="tri-login__box tri-glass-panel" role="dialog" aria-label="Entrar">
        {auth.state === 'needsNick' ? (
          <form class="tri-login__form" onSubmit={submitNick} noValidate>
            <h1 class="tri-login__title">Como você quer ser chamado?</h1>
            <p class="tri-login__subtitle">É assim que seus amigos vão te ver no Triscord.</p>
            <label class="tri-login__label" for="tri-nick">Nome de exibição <span class="tri-required">*</span></label>
            <input
              id="tri-nick"
              name="nick"
              class={`tri-login__input ${error ? 'has-error' : ''}`}
              value={nick}
              maxLength={32}
              onInput={e => setNick((e.target as HTMLInputElement).value)}
              autoFocus
              aria-invalid={!!error}
            />
            {shownError && <p class="tri-login__error" role="alert">{shownError}</p>}
            <ShimmerButton class="w-full" type="submit" variant="cyan" disabled={saving}>Continuar</ShimmerButton>
          </form>
        ) : (
          <div class="tri-login__form">
            <h1 class="tri-login__title">Boas-vindas ao Triscord</h1>
            <p class="tri-login__subtitle">Entre com sua conta Google para continuar.</p>
            {shownError && <p class="tri-login__error" role="alert">{shownError}</p>}
            <button
              type="button"
              class="tri-login__google"
              disabled={busy}
              onClick={() => { setError(null); bridge.send({ name: 'signIn' }); }}
            >
              <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
              <span>{auth.state === 'signingIn' ? 'Continue no navegador…' : 'Entrar com Google'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
