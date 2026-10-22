import { useState, useEffect } from 'react';
import type { Bridge } from '@/bridge';
import type { ShareSource } from '@/protocol';
import { X, Monitor, AppWindow, ScreenShare, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ShareScreenModal({ bridge, onClose }: { bridge: Bridge; onClose: () => void }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [generation, setGeneration] = useState<string>('');
    const [sources, setSources] = useState<ShareSource[]>([]);
    const [tab, setTab] = useState<'screen' | 'window'>('screen');
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
    const [resolution, setResolution] = useState<'720p' | '1080p' | '1440p'>('1080p');
    const [fps, setFps] = useState<30 | 60>(60);

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
        bridge.send({
            name: 'startScreenShare',
            generation,
            index: selectedIndex,
            resolution,
            fps,
        });
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
                        <div className="grid grid-cols-2 gap-3 max-h-52 overflow-y-auto pr-1">
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
                                            className={`flex flex-col items-center justify-center gap-2 rounded-lg border p-3.5 text-center transition-all ${
                                                isSelected
                                                    ? 'border-brand-500 bg-brand-500/15 text-brand-300 ring-1 ring-brand-500'
                                                    : 'border-ink-750 bg-ink-950 text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                                            }`}
                                        >
                                            {source.kind === 'screen' ? (
                                                <Monitor size={32} className={isSelected ? 'text-brand-400' : 'text-ink-400'} />
                                            ) : (
                                                <AppWindow size={32} className={isSelected ? 'text-brand-400' : 'text-ink-400'} />
                                            )}
                                            <span className="text-xs font-medium truncate w-full max-w-[180px]">
                                                {source.name}
                                            </span>
                                        </button>
                                    );
                                })
                            )}
                        </div>

                        {/* Quality Options: Resolution & FPS */}
                        <div className="grid grid-cols-2 gap-3 pt-3 border-t border-ink-800">
                            <div>
                                <label className="block text-[11px] font-bold text-ink-400 mb-1.5 uppercase tracking-wider">
                                    Resolução
                                </label>
                                <div className="grid grid-cols-3 gap-1 bg-ink-950 p-1 rounded-lg border border-ink-800">
                                    {(['720p', '1080p', '1440p'] as const).map(res => (
                                        <button
                                            key={res}
                                            type="button"
                                            onClick={() => setResolution(res)}
                                            className={`py-1 text-xs font-semibold rounded transition-colors flex items-center justify-center gap-1 ${
                                                resolution === res
                                                    ? 'bg-brand-500 text-white shadow-sm'
                                                    : 'text-ink-400 hover:text-ink-200'
                                            }`}
                                        >
                                            {res === '1440p' && <Sparkles size={11} className={resolution === res ? 'text-yellow-300' : 'text-brand-400'} />}
                                            <span>{res}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div>
                                <label className="block text-[11px] font-bold text-ink-400 mb-1.5 uppercase tracking-wider">
                                    Taxa de Quadros
                                </label>
                                <div className="grid grid-cols-2 gap-1 bg-ink-950 p-1 rounded-lg border border-ink-800">
                                    {([30, 60] as const).map(f => (
                                        <button
                                            key={f}
                                            type="button"
                                            onClick={() => setFps(f)}
                                            className={`py-1 text-xs font-semibold rounded transition-colors ${
                                                fps === f
                                                    ? 'bg-brand-500 text-white shadow-sm'
                                                    : 'text-ink-400 hover:text-ink-200'
                                            }`}
                                        >
                                            {f} FPS
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Footer buttons */}
                        <div className="flex items-center justify-between pt-3 border-t border-ink-800">
                            <span className="text-xs text-ink-400">
                                {resolution} @ {fps} FPS • GPU Hardware Encoder
                            </span>
                            <div className="flex items-center gap-2">
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
                    </div>
                )}
            </div>
        </div>
    );
}
