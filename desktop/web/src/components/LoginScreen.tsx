import { useEffect, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { AuthState } from '../protocol';
import glyph from '../assets/triscord-glyph.png';
import { TriscordLogo } from './ui/TriscordLogo';
import { ShimmerButton } from './ui/ShimmerButton';

// Login, observed in Discord (LOGIN.md, discord-login.png, 1280x900) and its auth box module __921c5
// recovered with REA: 480px box (784px only with the QR column, which triscord has no use for), 32px
// padding (--custom-auth-box-auth-box-padding), radius 8, high elevation shadow; semibold 24px title
// "Boas-vindas de volta!" and subtitle "Estamos muito animados em te ver novamente!"; 12px bold uppercase labels,
// 40px fields, a 38px brand button and the small link line under it; the wordmark at the top left of the page.
// The login page uses its own fixed palette (measured: card #242429, title #f2f2f2, subtitle #bababc,
// field #202024 / border #37373d / focus #4d96ee, button #5865f2 414x38) because no user theme applies yet.
// triscord signs in with a nick (no account elsewhere needed; a new nick creates the account and the password is
// optional, settable later in Configurações → Conta) or with Google. Discord's e-mail field becomes "Nome de usuário";
// "Esqueceu sua senha?" has no function (there is no e-mail to recover with), and the QR column is left out.
// The nick step after Google is triscord's own (Discord has no equivalent screen); it reuses the same box and field.
export function LoginScreen({ auth, bridge, googleLogin = true }: { auth: AuthState; bridge: Bridge; googleLogin?: boolean }) {
  const [nick, setNick] = useState(auth.suggestedNick ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
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
  const submitLogin = (event: Event) => {
    event.preventDefault();
    const value = field(event, 'nick').trim(), password = field(event, 'password');
    if (value.length < 2) { setError('Digite um nome de usuário com pelo menos dois caracteres.'); return; }
    if (password && password.length < 6) { setError('A senha precisa ter pelo menos 6 caracteres.'); return; }
    setSaving(true);
    setError(null);
    bridge.request({ name: 'signInNick', nick: value, ...(password ? { password } : {}) })
      .catch((e: Error) => setError(e.message)).finally(() => setSaving(false));
  };
  const busy = saving || auth.state === 'signingIn';
  const shownError = error ?? auth.error ?? null;
  return (
    <div class="tri-login bg-space-950">
      <div class="tri-login__brand flex items-center gap-3"><TriscordLogo size={36} /><span class="font-semibold tracking-tight text-xl">Triscord</span></div>
      <div class="tri-login__box tri-glass-panel" role="dialog" aria-label="Entrar">
        {auth.state === 'needsNick' ? (
          <form class="tri-login__form" onSubmit={submitNick} noValidate>
            <h1 class="tri-login__title">Como você quer ser chamado?</h1>
            <p class="tri-login__subtitle">É assim que seus amigos vão te ver no Triscord.</p>
            <label class="tri-login__label" for="tri-nick">Nome de exibição <span class="tri-required">*</span></label>
            <input id="tri-nick" name="nick" class={`tri-login__input ${error ? 'has-error' : ''}`} value={nick} maxLength={32}
              onInput={e => setNick((e.target as HTMLInputElement).value)} autoFocus aria-invalid={!!error} />
            {shownError && <p class="tri-login__error" role="alert">{shownError}</p>}
            <ShimmerButton class="w-full" type="submit" variant="cyan" disabled={saving}>Continuar</ShimmerButton>
          </form>
        ) : (
          <form class="tri-login__form" onSubmit={submitLogin} noValidate>
            <h1 class="tri-login__title">Boas-vindas de volta!</h1>
            <p class="tri-login__subtitle">Estamos muito animados em te ver novamente!</p>
            <label class="tri-login__label" for="tri-login-nick">Nome de usuário <span class="tri-required">*</span></label>
            <input id="tri-login-nick" name="nick" class={`tri-login__input ${shownError ? 'has-error' : ''}`} maxLength={32}
              autoComplete="username" autoFocus spellcheck={false} disabled={busy} aria-invalid={!!shownError} />
            <label class="tri-login__label" for="tri-login-password">Senha</label>
            <div class="tri-login__password">
              <input id="tri-login-password" name="password" type={showPassword ? 'text' : 'password'} class="tri-login__input"
                maxLength={128} autoComplete="current-password" disabled={busy} />
              <button type="button" class="tri-login__reveal" onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={showPassword}>{showPassword ? 'Ocultar' : 'Mostrar'}</button>
            </div>
            <p class="tri-login__hint">Primeira vez? Escolha um nome e entre. A senha é opcional e pode ser criada depois em Configurações.</p>
            {shownError && <p class="tri-login__error" role="alert">{shownError}</p>}
            <ShimmerButton class="w-full" type="submit" variant="aurora" disabled={busy}>{saving ? <span class="tri-login__dots" aria-label="Entrando" /> : 'Entrar'}</ShimmerButton>
            {googleLogin && <><div class="tri-login__divider"><span>ou</span></div>
            <button type="button" class="tri-login__google" disabled={busy} onClick={() => { setError(null); bridge.send({ name: 'signIn' }); }}>
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
              {auth.state === 'signingIn' ? 'Continue no navegador…' : 'Entrar com Google'}
            </button></>}
          </form>
        )}
      </div>
    </div>
  );
}
