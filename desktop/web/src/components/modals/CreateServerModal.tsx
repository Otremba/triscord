import { useState } from 'react';
import type { Bridge } from '@/bridge';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function CreateServerModal({ bridge, onClose }: { bridge: Bridge; onClose: () => void }) {
    const [name, setName] = useState('');
    const [invite, setInvite] = useState('');
    const [tab, setTab] = useState<'create' | 'join'>('create');

    const handleCreate = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        bridge.send({ name: 'createServer', serverName: trimmed });
        onClose();
    };

    const handleJoin = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = invite.trim();
        if (!trimmed) return;
        bridge.send({ name: 'acceptInvite', invite: trimmed });
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-xl border border-ink-800 bg-ink-900 p-6 shadow-2xl">
                <div className="flex items-center justify-between pb-4 border-b border-ink-800">
                    <div className="flex gap-4">
                        <button
                            type="button"
                            onClick={() => setTab('create')}
                            className={`text-base font-bold transition-colors ${tab === 'create' ? 'text-ink-100' : 'text-ink-500 hover:text-ink-300'}`}
                        >
                            Criar Servidor
                        </button>
                        <button
                            type="button"
                            onClick={() => setTab('join')}
                            className={`text-base font-bold transition-colors ${tab === 'join' ? 'text-ink-100' : 'text-ink-500 hover:text-ink-300'}`}
                        >
                            Entrar com Convite
                        </button>
                    </div>
                    <button type="button" aria-label="Fechar" onClick={onClose} className="text-ink-400 hover:text-ink-100">
                        <X size={20} />
                    </button>
                </div>

                {tab === 'create' ? (
                    <form onSubmit={handleCreate} className="mt-4 space-y-4">
                        <p className="text-xs text-ink-400">Um servidor é o espaço onde você e seus amigos conversam por voz, vídeo e texto.</p>
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">Nome do Servidor</label>
                            <input
                                type="text"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                placeholder="Meu servidor incrível"
                                autoFocus
                                className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
                            />
                        </div>

                        <div className="flex justify-end gap-2 pt-2">
                            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
                            <Button type="submit" variant="default" disabled={!name.trim()}>Criar</Button>
                        </div>
                    </form>
                ) : (
                    <form onSubmit={handleJoin} className="mt-4 space-y-4">
                        <p className="text-xs text-ink-400">Insira um código de convite para se juntar a um servidor existente.</p>
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">Código do Convite</label>
                            <input
                                type="text"
                                value={invite}
                                onChange={e => setInvite(e.target.value)}
                                placeholder="Ex: a1b2c3d4"
                                autoFocus
                                className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
                            />
                        </div>

                        <div className="flex justify-end gap-2 pt-2">
                            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
                            <Button type="submit" variant="default" disabled={!invite.trim()}>Entrar</Button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
