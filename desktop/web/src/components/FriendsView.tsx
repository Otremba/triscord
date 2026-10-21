import { useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { BentoGrid, BentoCard } from './ui/BentoGrid';
import { ShimmerButton } from './ui/ShimmerButton';
import { TriscordLogo } from './ui/TriscordLogo';
import { soundEngine } from '../sound-engine';
import '../styles/friends-view.css';

type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

export function FriendsView({ session, bridge }: { session: Session; bridge: Bridge }) {
  const [tab, setTab] = useState<Tab>('online');
  const [search, setSearch] = useState('');
  const account = session.account;
  const servers = session.servers.filter(s => s.id && s.id !== '@me');

  return (
    <div class="tri-friends-page bg-space-950 text-slate-100 flex flex-col h-full overflow-hidden">
      <header class="tri-friends-header tri-glass-panel border-b border-white/[0.08] px-6 py-3 flex items-center justify-between">
        <div class="tri-friends-header__left flex items-center gap-4">
          <div class="flex items-center gap-2">
            <TriscordLogo size={24} />
            <h1 class="tri-friends-header__title text-base font-bold tracking-tight text-white">Amigos</h1>
          </div>
          <span class="tri-friends-header__divider h-5 w-[1px] bg-white/10" role="separator" />
          <nav class="tri-friends-header__tabs flex items-center gap-1.5" aria-label="Abas de amigos">
            <button
              class={`tri-friends-tab ${tab === 'online' ? 'is-active' : ''}`}
              onClick={() => { soundEngine.play('channelSwitch'); setTab('online'); }}
            >
              Disponível
            </button>
            <button
              class={`tri-friends-tab ${tab === 'all' ? 'is-active' : ''}`}
              onClick={() => { soundEngine.play('channelSwitch'); setTab('all'); }}
            >
              Todos
            </button>
            <button
              class={`tri-friends-tab ${tab === 'pending' ? 'is-active' : ''}`}
              onClick={() => { soundEngine.play('channelSwitch'); setTab('pending'); }}
            >
              Pendente
            </button>
            <button
              class={`tri-friends-tab ${tab === 'blocked' ? 'is-active' : ''}`}
              onClick={() => { soundEngine.play('channelSwitch'); setTab('blocked'); }}
            >
              Bloqueado
            </button>
            <button
              class={`tri-friends-tab tri-friends-tab--add ${tab === 'add' ? 'is-active' : ''}`}
              onClick={() => { soundEngine.play('channelSwitch'); setTab('add'); }}
            >
              Adicionar amigo
            </button>
          </nav>
        </div>
        <div class="tri-friends-header__toolbar flex items-center gap-2">
          <Tooltip text="Nova conversa em grupo" position="bottom">
            <button
              class="tri-icon-button p-2 rounded-xl hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
              aria-label="Nova conversa em grupo"
              onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Conversas em grupo em desenvolvimento.' }))}
            >
              <Icon name="Chat" size={24} />
            </button>
          </Tooltip>
          <span class="tri-friends-header__divider h-4 w-[1px] bg-white/10" role="separator" />
          <Tooltip text="Caixa de entrada" position="bottom">
            <button
              class="tri-icon-button p-2 rounded-xl hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
              aria-label="Caixa de entrada"
              onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Caixa de entrada em desenvolvimento.' }))}
            >
              <Icon name="Bell" size={20} />
            </button>
          </Tooltip>
        </div>
      </header>

      <div class="tri-friends-body flex-1 overflow-y-auto p-6">
        {tab === 'add' ? (
          <div class="tri-friends-add max-w-xl mx-auto mt-8 p-8 rounded-3xl bg-space-850/80 border border-white/10 shadow-glass backdrop-blur-2xl">
            <h2 class="tri-friends-add__title text-xl font-bold text-white tracking-tight">ADICIONAR AMIGO</h2>
            <p class="tri-friends-add__subtitle text-sm text-slate-400 mt-1 mb-6">Você pode adicionar amigos usando o nome de usuário do Discord ou Triscord.</p>
            <form
              class="tri-friends-add__form flex flex-col gap-4"
              onSubmit={e => {
                e.preventDefault();
                dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Solicitação de amizade enviada!' }));
              }}
            >
              <div class="tri-friends-add__input-box flex gap-3">
                <input
                  type="text"
                  placeholder="Você pode adicionar amigos com o nome de usuário"
                  aria-label="Nome de usuário do amigo"
                  class="flex-1 px-4 py-3 rounded-xl bg-space-950/80 border border-white/10 text-white placeholder-slate-500 focus:outline-none focus:border-neon-cyan/50 text-sm"
                />
                <ShimmerButton type="submit" variant="cyan" className="tri-friends-add__submit">
                  Enviar pedido de amizade
                </ShimmerButton>
              </div>
            </form>
          </div>
        ) : (
          <div class="tri-friends-list-container max-w-6xl mx-auto space-y-6">
            <div class="flex items-center justify-between">
              <div>
                <h2 class="text-2xl font-extrabold text-white tracking-tight">Aurora Social Lounge</h2>
                <p class="text-sm text-slate-400">Espaço interativo em tempo real para conectar, jogar e conversar.</p>
              </div>
              <div class="tri-friends-search relative w-64">
                <input
                  type="text"
                  placeholder="Buscar"
                  value={search}
                  onInput={e => setSearch((e.target as HTMLInputElement).value)}
                  aria-label="Buscar amigos"
                  class="w-full pl-9 pr-4 py-2 rounded-xl bg-space-850/80 border border-white/10 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-neon-cyan/50"
                />
                <Icon name="MagnifyingGlass" size={16} className="tri-friends-search__icon absolute left-3 top-3 text-slate-500" />
              </div>
            </div>

            {/* Bento Grid Lounge Section */}
            <BentoGrid>
              {/* Card 1: Perfil do Usuário */}
              <BentoCard
                title={account.displayName}
                description={account.customStatus || `@${account.username}`}
                badge="Seu Status"
                badgeVariant="cyan"
                header={
                  <div class="flex items-center gap-4">
                    <span class="tri-avatar tri-avatar--48 rounded-2xl overflow-hidden border border-white/20 shadow-glow-cyan">
                      {account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : <span class="tri-avatar__letter text-lg font-bold">{account.displayName.slice(0, 1).toUpperCase()}</span>}
                    </span>
                    <div>
                      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-neon-emerald/15 text-neon-emerald border border-neon-emerald/30">
                        <span class="w-1.5 h-1.5 rounded-full bg-neon-emerald animate-pulse" />
                        Disponível
                      </span>
                    </div>
                  </div>
                }
              >
                <div class="mt-4 pt-4 border-t border-white/10 flex gap-2">
                  <button
                    class="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold text-white transition-all"
                    onClick={() => dispatchEvent(new Event('tri-open-profile'))}
                  >
                    Editar Perfil
                  </button>
                  <button
                    class="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-semibold text-slate-300 transition-all"
                    onClick={() => dispatchEvent(new Event('tri-open-settings'))}
                  >
                    Configurações
                  </button>
                </div>
              </BentoCard>

              {/* Card 2: Espaços de Voz Ativos */}
              <BentoCard
                title="Canais de Voz & Mídia"
                description={`${servers.length} servidores conectados na sua rede.`}
                badge="Voz Ativa"
                badgeVariant="emerald"
                header={
                  <div class="p-3 rounded-2xl bg-neon-emerald/10 border border-neon-emerald/20 text-neon-emerald w-fit">
                    <Icon name="VoiceSpeaker" size={24} />
                  </div>
                }
              >
                <div class="mt-4 pt-4 border-t border-white/10">
                  <p class="text-xs text-slate-400 mb-3">Qualidade de estúdio com 48kHz, cancelamento de ruído DSP e vídeo em 1080p60.</p>
                  <ShimmerButton
                    variant="aurora"
                    className="w-full text-xs py-2"
                    onClick={() => {
                      const firstServer = servers[0];
                      if (firstServer) bridge.send({ name: 'selectServer', serverId: firstServer.id });
                    }}
                  >
                    Entrar em um Servidor
                  </ShimmerButton>
                </div>
              </BentoCard>

              {/* Card 3: Atividade e Amigos */}
              <BentoCard
                title="Atividades Recentes"
                description="Sem atividades em andamento no momento."
                badge="Comunidade"
                badgeVariant="violet"
                header={
                  <div class="p-3 rounded-2xl bg-neon-violet/10 border border-neon-violet/20 text-purple-300 w-fit">
                    <Icon name="Compass" size={24} />
                  </div>
                }
              >
                <div class="mt-4 pt-4 border-t border-white/10">
                  <p class="text-xs text-slate-400">
                    Quando seus amigos estiverem jogando ou compartilhando tela, os destaques aparecerão aqui no Lounge.
                  </p>
                </div>
              </BentoCard>
            </BentoGrid>

            {/* Empty illustration container for friends list status */}
            <div class="tri-friends-empty mt-8 p-10 rounded-3xl bg-space-900/40 border border-white/5 text-center flex flex-col items-center justify-center gap-3">
              <div class="tri-friends-empty__illustration">
                <svg width="180" height="110" viewBox="0 0 180 110" fill="none" aria-hidden="true">
                  <circle cx="90" cy="50" r="36" fill="var(--background-base-lowest, #1e1f22)" />
                  <path d="M90 35a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM74 68c0-8.8 7.2-16 16-16s16 7.2 16 16v4H74v-4Z" fill="var(--channels-default, #80848e)" opacity="0.35" />
                  <circle cx="125" cy="35" r="3" fill="var(--brand-500, #5865f2)" opacity="0.5" />
                </svg>
              </div>
              <p class="tri-friends-empty__text text-sm text-slate-400">Nenhum amigo está disponível no momento. Wumpus está esperando amigos!</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
