import { useState } from 'react';
import type { Bridge } from '@/bridge';
import type { Session } from '@/protocol';
import { Users, Search } from 'lucide-react';

type Tab = 'available' | 'all' | 'pending' | 'blocked' | 'add';

export function FriendsView({ session: _session, bridge: _bridge }: { session: Session; bridge: Bridge }) {
    const [tab, setTab] = useState<Tab>('available');
    const [search, setSearch] = useState('');
    const [addUsername, setAddUsername] = useState('');
    const [addStatus, setAddStatus] = useState<string | null>(null);

    const handleAddFriend = (e: React.FormEvent) => {
        e.preventDefault();
        if (!addUsername.trim()) return;
        setAddStatus(`Pedido enviado para ${addUsername.trim()}!`);
        setAddUsername('');
        setTimeout(() => setAddStatus(null), 4000);
    };

    return (
        <div className="flex flex-1 flex-col overflow-hidden bg-ink-950">
            {/* Header Tabs */}
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900/60 px-4">
                <div className="flex items-center gap-2 border-r border-ink-800 pr-4 text-ink-300">
                    <Users size={20} />
                    <span className="font-semibold text-sm text-ink-100">Amigos</span>
                </div>

                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => setTab('available')}
                        className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${tab === 'available' ? 'bg-ink-750 text-ink-100' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-200'}`}
                    >
                        Disponível
                    </button>
                    <button
                        type="button"
                        onClick={() => setTab('all')}
                        className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${tab === 'all' ? 'bg-ink-750 text-ink-100' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-200'}`}
                    >
                        Todos
                    </button>
                    <button
                        type="button"
                        onClick={() => setTab('pending')}
                        className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${tab === 'pending' ? 'bg-ink-750 text-ink-100' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-200'}`}
                    >
                        Pendente
                    </button>
                    <button
                        type="button"
                        onClick={() => setTab('blocked')}
                        className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${tab === 'blocked' ? 'bg-ink-750 text-ink-100' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-200'}`}
                    >
                        Bloqueado
                    </button>
                    <button
                        type="button"
                        onClick={() => setTab('add')}
                        className={`rounded-md px-2.5 py-1 text-sm font-semibold transition-colors ${tab === 'add' ? 'bg-positive/20 text-positive' : 'bg-positive text-ink-950 hover:bg-positive/90'}`}
                    >
                        Adicionar amigo
                    </button>
                </div>
            </header>

            {/* Main Content */}
            <div className="flex flex-1 min-h-0">
                <div className="flex flex-1 flex-col p-6 overflow-y-auto">
                    {tab === 'add' ? (
                        <div className="max-w-xl">
                            <h2 className="text-base font-semibold text-ink-100">ADICIONAR AMIGO</h2>
                            <p className="mt-1 text-xs text-ink-400">Você pode adicionar amigos usando o nome de usuário deles.</p>
                            <form onSubmit={handleAddFriend} className="mt-4 flex gap-2">
                                <input
                                    type="text"
                                    value={addUsername}
                                    onChange={e => setAddUsername(e.target.value)}
                                    placeholder="Ex: usuário#0000 ou nome"
                                    className="flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none"
                                />
                                <button
                                    type="submit"
                                    disabled={!addUsername.trim()}
                                    className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-brand-400 disabled:opacity-40"
                                >
                                    Enviar pedido
                                </button>
                            </form>
                            {addStatus && <p className="mt-3 text-xs text-positive">{addStatus}</p>}
                        </div>
                    ) : (
                        <div className="flex flex-1 flex-col">
                            {/* Search */}
                            <div className="relative mb-6 max-w-md">
                                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500" />
                                <input
                                    type="text"
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    placeholder="Buscar amigos..."
                                    className="w-full rounded-md border border-ink-800 bg-ink-900 py-1.5 pl-9 pr-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-ink-700 focus:outline-none"
                                />
                            </div>

                            {/* Empty state */}
                            <div className="flex flex-1 flex-col items-center justify-center text-center">
                                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-ink-900 text-ink-600 mb-4">
                                    <Users size={32} />
                                </div>
                                <h3 className="text-base font-medium text-ink-200">Nenhum amigo por aqui</h3>
                                <p className="mt-1 text-xs text-ink-500 max-w-xs">
                                    {tab === 'available'
                                        ? 'Nenhum amigo está disponível no momento. Wumpus está aguardando!'
                                        : 'Adicione seus amigos usando o nome de usuário para começar a conversar.'}
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {/* Right rail: Active now */}
                <aside className="w-80 border-l border-ink-800 bg-ink-900/40 p-4 hidden lg:block overflow-y-auto">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-ink-400 mb-3">Ativo agora</h3>
                    <div className="rounded-lg border border-dashed border-ink-800 p-4 text-center">
                        <p className="text-xs text-ink-500">Por enquanto, está tudo calmo...</p>
                        <p className="mt-1 text-xs text-ink-600">Quando seus amigos estiverem jogando ou em chamadas, você verá aqui!</p>
                    </div>
                </aside>
            </div>
        </div>
    );
}
