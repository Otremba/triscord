import { useState } from 'react';
import type { Bridge } from '@/bridge';
import { X, Hash, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function CreateChannelModal({ categoryName, bridge, onClose }: { categoryName?: string; bridge: Bridge; onClose: () => void }) {
    const isTextCategory = categoryName?.toLowerCase().includes('texto') ?? false;
    const [name, setName] = useState('');
    const [kind, setKind] = useState<'text' | 'voice'>(isTextCategory ? 'text' : 'voice');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        bridge.send({ name: 'createChannel', channelName: trimmed, kind });
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-xl border border-ink-800 bg-ink-900 p-6 shadow-2xl">
                <div className="flex items-center justify-between pb-4 border-b border-ink-800">
                    <h2 className="text-lg font-bold text-ink-100">Criar Canal</h2>
                    <button type="button" aria-label="Fechar" onClick={onClose} className="text-ink-400 hover:text-ink-100">
                        <X size={20} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-2">Tipo de Canal</label>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => setKind('voice')}
                                className={`flex items-center gap-2.5 rounded-lg border p-3 text-left transition-colors ${kind === 'voice' ? 'border-brand-500 bg-brand-500/10 text-brand-400' : 'border-ink-700 bg-ink-950 text-ink-300 hover:bg-ink-800'}`}
                            >
                                <Volume2 size={20} />
                                <div>
                                    <div className="text-sm font-semibold text-ink-100">Voz</div>
                                    <div className="text-xs text-ink-400">Conversas por voz e tela</div>
                                </div>
                            </button>

                            <button
                                type="button"
                                onClick={() => setKind('text')}
                                className={`flex items-center gap-2.5 rounded-lg border p-3 text-left transition-colors ${kind === 'text' ? 'border-brand-500 bg-brand-500/10 text-brand-400' : 'border-ink-700 bg-ink-950 text-ink-300 hover:bg-ink-800'}`}
                            >
                                <Hash size={20} />
                                <div>
                                    <div className="text-sm font-semibold text-ink-100">Texto</div>
                                    <div className="text-xs text-ink-400">Mensagens e links</div>
                                </div>
                            </button>
                        </div>
                    </div>

                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">Nome do Canal</label>
                        <input
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder={kind === 'voice' ? 'Geral' : 'bate-papo'}
                            autoFocus
                            className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
                        />
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
                        <Button type="submit" variant="default" disabled={!name.trim()}>Criar Canal</Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
