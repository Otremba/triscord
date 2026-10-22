import { useState } from 'react';
import type { Bridge } from '@/bridge';
import type { Session } from '@/protocol';
import { X, User, Volume2, Monitor, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';

type Page = 'account' | 'voice' | 'windows';

export function SettingsModal({ session, bridge, onClose }: { session: Session; bridge: Bridge; onClose: () => void }) {
    const [page, setPage] = useState<Page>('voice');
    const s = session.settings;

    const setSetting = (key: any, value: any) => {
        bridge.send({ name: 'setSetting', key, value });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="relative flex h-[85vh] w-[900px] max-w-[95vw] rounded-xl border border-ink-800 bg-ink-900 shadow-2xl overflow-hidden">
                {/* Close Button */}
                <button
                    type="button"
                    aria-label="Fechar"
                    onClick={onClose}
                    className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full text-ink-400 hover:bg-ink-800 hover:text-ink-100 transition-colors"
                >
                    <X size={20} />
                </button>

                {/* Sidebar Navigation */}
                <aside className="w-60 border-r border-ink-800 bg-ink-950/60 p-4 flex flex-col justify-between shrink-0">
                    <div>
                        <span className="block px-3 py-2 text-xs font-bold uppercase tracking-wider text-ink-500">Configurações de Usuário</span>
                        <nav className="mt-1 space-y-1">
                            <button
                                type="button"
                                onClick={() => setPage('account')}
                                className={cn(
                                    'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                    page === 'account' ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
                                )}
                            >
                                <User size={18} />
                                <span>Minha Conta</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setPage('voice')}
                                className={cn(
                                    'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                    page === 'voice' ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
                                )}
                            >
                                <Volume2 size={18} />
                                <span>Voz & Vídeo</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setPage('windows')}
                                className={cn(
                                    'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                    page === 'windows' ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
                                )}
                            >
                                <Monitor size={18} />
                                <span>Configurações do App</span>
                            </button>
                        </nav>
                    </div>

                    <div className="border-t border-ink-800 pt-3">
                        <button
                            type="button"
                            onClick={() => {
                                bridge.send({ name: 'signOut' });
                                onClose();
                            }}
                            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-critical hover:bg-critical/10 transition-colors"
                        >
                            <LogOut size={18} />
                            <span>Sair da Conta</span>
                        </button>
                    </div>
                </aside>

                {/* Content Panel */}
                <main className="flex-1 overflow-y-auto p-8">
                    {page === 'account' && (
                        <div className="space-y-6 max-w-xl">
                            <div>
                                <h2 className="text-xl font-bold text-ink-100">Minha Conta</h2>
                                <p className="text-xs text-ink-400 mt-1">Gerencie suas informações de perfil e autenticação.</p>
                            </div>

                            <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-4 space-y-4">
                                <div className="flex items-center gap-4">
                                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-ink-700 text-xl font-bold text-ink-100">
                                        {session.account.avatarUrl ? (
                                            <img src={session.account.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
                                        ) : (
                                            session.account.displayName.slice(0, 1).toUpperCase()
                                        )}
                                    </div>
                                    <div>
                                        <h3 className="font-semibold text-ink-100">{session.account.displayName}</h3>
                                        <p className="text-xs text-ink-400">@{session.account.username}</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {page === 'voice' && s && (
                        <div className="space-y-6 max-w-xl">
                            <div>
                                <h2 className="text-xl font-bold text-ink-100">Voz & Vídeo</h2>
                                <p className="text-xs text-ink-400 mt-1">Configure seus dispositivos de áudio, microfone e supressão de ruído.</p>
                            </div>

                            {/* Device Selectors */}
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-2">Dispositivo de Entrada</label>
                                    <select
                                        value={s.inputDevice}
                                        onChange={e => setSetting('inputDevice', e.target.value)}
                                        className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
                                    >
                                        {s.inputDevices.map(d => (
                                            <option key={d.id} value={d.id}>{d.name}</option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-2">Dispositivo de Saída</label>
                                    <select
                                        value={s.outputDevice}
                                        onChange={e => setSetting('outputDevice', e.target.value)}
                                        className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
                                    >
                                        {s.outputDevices.map(d => (
                                            <option key={d.id} value={d.id}>{d.name}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            {/* Volume Sliders */}
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <div className="flex justify-between text-xs text-ink-400 mb-1">
                                        <span>Volume do Microfone</span>
                                        <span>{s.inputVolume}%</span>
                                    </div>
                                    <input
                                        type="range"
                                        min={0}
                                        max={100}
                                        value={s.inputVolume}
                                        onChange={e => setSetting('inputVolume', +e.target.value)}
                                        className="w-full accent-brand-500"
                                    />
                                </div>

                                <div>
                                    <div className="flex justify-between text-xs text-ink-400 mb-1">
                                        <span>Volume de Saída</span>
                                        <span>{s.outputVolume}%</span>
                                    </div>
                                    <input
                                        type="range"
                                        min={0}
                                        max={200}
                                        value={s.outputVolume}
                                        onChange={e => setSetting('outputVolume', +e.target.value)}
                                        className="w-full accent-brand-500"
                                    />
                                </div>
                            </div>

                            <hr className="border-ink-800" />

                            {/* Toggles */}
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-sm font-medium text-ink-100 block">Supressão de Ruído (DeepFilterNet / RNNoise)</span>
                                        <span className="text-xs text-ink-400 block">Remove ruído de fundo como teclado e vento.</span>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={s.noiseSuppression}
                                        onClick={() => setSetting('noiseSuppression', !s.noiseSuppression)}
                                        className={cn(
                                            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none',
                                            s.noiseSuppression ? 'bg-brand-500' : 'bg-ink-700'
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out',
                                                s.noiseSuppression ? 'translate-x-5' : 'translate-x-0'
                                            )}
                                        />
                                    </button>
                                </div>

                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-sm font-medium text-ink-100 block">Controle Automático de Ganho</span>
                                        <span className="text-xs text-ink-400 block">Nivela sua voz automaticamente para seus amigos.</span>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={s.automaticGainControl ?? true}
                                        onClick={() => setSetting('automaticGainControl', !(s.automaticGainControl ?? true))}
                                        className={cn(
                                            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none',
                                            (s.automaticGainControl ?? true) ? 'bg-brand-500' : 'bg-ink-700'
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out',
                                                (s.automaticGainControl ?? true) ? 'translate-x-5' : 'translate-x-0'
                                            )}
                                        />
                                    </button>
                                </div>

                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-sm font-medium text-ink-100 block">Sons da Chamada</span>
                                        <span className="text-xs text-ink-400 block">Efeitos sonoros ao conectar, desconectar e mutar.</span>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={s.callSounds ?? true}
                                        onClick={() => setSetting('callSounds', !(s.callSounds ?? true))}
                                        className={cn(
                                            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none',
                                            (s.callSounds ?? true) ? 'bg-brand-500' : 'bg-ink-700'
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out',
                                                (s.callSounds ?? true) ? 'translate-x-5' : 'translate-x-0'
                                            )}
                                        />
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {page === 'windows' && s && (
                        <div className="space-y-6 max-w-xl">
                            <div>
                                <h2 className="text-xl font-bold text-ink-100">Configurações do App</h2>
                                <p className="text-xs text-ink-400 mt-1">Opções de integração com o sistema Windows.</p>
                            </div>

                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="text-sm font-medium text-ink-100 block">Minimizar para a Bandeja</span>
                                        <span className="text-xs text-ink-400 block">Fechar a janela mantém a chamada ativa em segundo plano.</span>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={s.closeToTray !== false}
                                        onClick={() => setSetting('closeToTray', !(s.closeToTray !== false))}
                                        className={cn(
                                            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none',
                                            s.closeToTray !== false ? 'bg-brand-500' : 'bg-ink-700'
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out',
                                                s.closeToTray !== false ? 'translate-x-5' : 'translate-x-0'
                                            )}
                                        />
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </main>
            </div>
        </div>
    );
}
