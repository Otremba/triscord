import { useState, useEffect } from 'react';
import type { Bridge } from '@/bridge';
import type { ShareSource } from '@/protocol';
import { X, Monitor, AppWindow, ScreenShare, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ShareScreenModal({ bridge, onClose }: { bridge: Bridge; onClose: () => void }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [generation, setGeneration] = useState<string>('');
    const [sources, setSources] = useState<ShareSource[]>([]);
    const [tab, setTab] = useState<'screen' | 'window'>('screen');
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

    useEffect(() => {
        let mounted = true;
        bridge.request<{ generation: string; sources: ShareSource[] }>({ name: 'listShareSources' })
            .then(res => {
                if (!mounted) return;
                setGeneration(res.generation);
                setSources(res.sources || []);
                const firstScreen = res.sources.find(s => s.kind === 'screen') || res.sources[0];
                if (firstScreen) {
                    setSelectedIndex(firstScreen.index);
                    setTab(firstScreen.kind);
                }
                setLoading(false);
            })
            .catch(err => {
                if (!mounted) return;
                setError(err instanceof Error ? err.message : 'Não foi possível listar as janelas.');
                setLoading(false);
            });

        return () => {
            mounted = false;
        };
    }, [bridge]);

    const handleShare = () => {
        if (selectedIndex === null || !generation) return;
        bridge.send({ name: 'startScreenShare', generation, index: selectedIndex });
        onClose();
    };

    const filteredSources = sources.filter(s => s.kind === tab);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="w-full max-w-lg rounded-xl border border-ink-800 bg-ink-900 p-6 shadow-2xl">
                <div className="flex items-center justify-between pb-4 border-b border-ink-800">
                    <div className="flex items-center gap-2 text-ink-100">
                        <ScreenShare size={20} className="text-brand-400" />
                        <h2 className="text-lg font-bold">Compartilhar Tela</h2>
                    </div>
                    <button type="button" aria-label="Fechar" onClick={onClose} className="text-ink-400 hover:text-ink-100">
                        <X size={20} />
                    </button>
                </div>

                {loading ? (
                    <div className="flex flex-col items-center justify-center py-12 text-ink-400 gap-3">
                        <Loader2 className="animate-spin text-brand-400" size={32} />
                        <span className="text-sm">Buscando telas e janelas disponíveis...</span>
                    </div>
                ) : error ? (
                    <div className="py-8 text-center text-critical text-sm">
                        {error}
                    </div>
                ) : (
                    <div className="mt-4 space-y-4">
                        {/* Tabs */}
                        <div className="flex gap-2 border-b border-ink-800 pb-2">
                            <button
                                type="button"
                                onClick={() => {
                                    setTab('screen');
                                    const first = sources.find(s => s.kind === 'screen');
                                    if (first) setSelectedIndex(first.index);
                                }}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                                    tab === 'screen'
                                        ? 'bg-ink-800 text-ink-100'
                                        : 'text-ink-400 hover:text-ink-200'
                                }`}
                            >
                                <Monitor size={16} />
                                Telas ({sources.filter(s => s.kind === 'screen').length})
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setTab('window');
                                    const first = sources.find(s => s.kind === 'window');
                                    if (first) setSelectedIndex(first.index);
                                }}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                                    tab === 'window'
                                        ? 'bg-ink-800 text-ink-100'
                                        : 'text-ink-400 hover:text-ink-200'
                                }`}
                            >
                                <AppWindow size={16} />
                                Janelas ({sources.filter(s => s.kind === 'window').length})
                            </button>
                        </div>

                        {/* Sources list/grid */}
                        <div className="grid grid-cols-2 gap-3 max-h-60 overflow-y-auto pr-1">
                            {filteredSources.length === 0 ? (
                                <div className="col-span-2 py-8 text-center text-sm text-ink-500">
                                    Nenhuma {tab === 'screen' ? 'tela' : 'janela'} encontrada.
                                </div>
                            ) : (
                                filteredSources.map(source => {
                                    const isSelected = selectedIndex === source.index;
                                    return (
                                        <button
                                            key={source.index}
                                            type="button"
                                            onClick={() => setSelectedIndex(source.index)}
                                            className={`flex flex-col items-center justify-center gap-2.5 rounded-lg border p-4 text-center transition-all ${
                                                isSelected
                                                    ? 'border-brand-500 bg-brand-500/15 text-brand-300 ring-1 ring-brand-500'
                                                    : 'border-ink-750 bg-ink-950 text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                                            }`}
                                        >
                                            {source.kind === 'screen' ? (
                                                <Monitor size={36} className={isSelected ? 'text-brand-400' : 'text-ink-400'} />
                                            ) : (
                                                <AppWindow size={36} className={isSelected ? 'text-brand-400' : 'text-ink-400'} />
                                            )}
                                            <span className="text-xs font-medium truncate w-full max-w-[180px]">
                                                {source.name}
                                            </span>
                                        </button>
                                    );
                                })
                            )}
                        </div>

                        {/* Footer buttons */}
                        <div className="flex items-center justify-end gap-3 pt-4 border-t border-ink-800">
                            <Button type="button" variant="ghost" onClick={onClose}>
                                Cancelar
                            </Button>
                            <Button
                                type="button"
                                variant="default"
                                disabled={selectedIndex === null}
                                onClick={handleShare}
                            >
                                Compartilhar
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
