import { useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import '../styles/friends-view.css';

type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

export function FriendsView({ session, bridge }: { session: Session; bridge: Bridge }) {
  const [tab, setTab] = useState<Tab>('online');
  const [search, setSearch] = useState('');

  // Collect friends from session or participants
  const account = session.account;

  return (
    <div class="tri-friends-page">
      <header class="tri-friends-header">
        <div class="tri-friends-header__left">
          <Icon name="Friends" size={24} className="tri-friends-header__icon" />
          <h1 class="tri-friends-header__title">Amigos</h1>
          <span class="tri-friends-header__divider" role="separator" />
          <nav class="tri-friends-header__tabs" aria-label="Abas de amigos">
            <button class={`tri-friends-tab ${tab === 'online' ? 'is-active' : ''}`} onClick={() => setTab('online')}>
              Disponível
            </button>
            <button class={`tri-friends-tab ${tab === 'all' ? 'is-active' : ''}`} onClick={() => setTab('all')}>
              Todos
            </button>
            <button class={`tri-friends-tab ${tab === 'pending' ? 'is-active' : ''}`} onClick={() => setTab('pending')}>
              Pendente
            </button>
            <button class={`tri-friends-tab ${tab === 'blocked' ? 'is-active' : ''}`} onClick={() => setTab('blocked')}>
              Bloqueado
            </button>
            <button class={`tri-friends-tab tri-friends-tab--add ${tab === 'add' ? 'is-active' : ''}`} onClick={() => setTab('add')}>
              Adicionar amigo
            </button>
          </nav>
        </div>
        <div class="tri-friends-header__toolbar">
          <Tooltip text="Nova conversa em grupo" position="bottom">
            <button class="tri-icon-button" aria-label="Nova conversa em grupo" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Conversas em grupo em desenvolvimento.' }))}>
              <Icon name="Chat" size={24} />
            </button>
          </Tooltip>
          <span class="tri-friends-header__divider" role="separator" />
          <Tooltip text="Caixa de entrada" position="bottom">
            <button class="tri-icon-button" aria-label="Caixa de entrada" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Caixa de entrada em desenvolvimento.' }))}>
              <Icon name="Bell" size={20} />
            </button>
          </Tooltip>
        </div>
      </header>

      <div class="tri-friends-body">
        <section class="tri-friends-main">
          {tab === 'add' ? (
            <div class="tri-friends-add">
              <h2 class="tri-friends-add__title">ADICIONAR AMIGO</h2>
              <p class="tri-friends-add__subtitle">Você pode adicionar amigos usando o nome de usuário do Discord.</p>
              <form class="tri-friends-add__form" onSubmit={e => { e.preventDefault(); dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Solicitação de amizade enviada!' })); }}>
                <div class="tri-friends-add__input-box">
                  <input type="text" placeholder="Você pode adicionar amigos com o nome de usuário" aria-label="Nome de usuário do amigo" />
                  <button type="submit" class="tri-friends-add__submit">Enviar pedido de amizade</button>
                </div>
              </form>
            </div>
          ) : (
            <div class="tri-friends-list-container">
              <div class="tri-friends-search">
                <input type="text" placeholder="Buscar" value={search} onInput={e => setSearch((e.target as HTMLInputElement).value)} aria-label="Buscar amigos" />
                <Icon name="MagnifyingGlass" size={16} className="tri-friends-search__icon" />
              </div>
              <div class="tri-friends-empty">
                <div class="tri-friends-empty__wumpus">
                  <Icon name="Friends" size={80} />
                </div>
                <p class="tri-friends-empty__text">Nenhum amigo está disponível no momento. Wumpus está esperando amigos!</p>
              </div>
            </div>
          )}
        </section>

        <aside class="tri-friends-activity" aria-label="Ativo agora">
          <h2 class="tri-friends-activity__title">Ativo agora</h2>
          <div class="tri-friends-activity__card">
            <h3 class="tri-friends-activity__card-title">No momento, está tudo quieto...</h3>
            <p class="tri-friends-activity__card-text">Quando seus amigos tiverem uma atividade ativa (como jogar um jogo ou ouvir música), nós vamos mostrá-los aqui!</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
