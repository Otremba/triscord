import { useState } from 'react';
import type { Bridge } from '@/bridge';
import type { Session } from '@/protocol';
import { X, User, Volume2, Monitor, LogOut, Camera, Upload, Trash2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

type Page = 'account' | 'voice' | 'windows';

export function SettingsModal({ session, bridge, initialPage = 'voice', onClose }: { session: Session; bridge: Bridge; initialPage?: Page; onClose: () => void }) {
    const [page, setPage] = useState<Page>(initialPage);
    const s = session.settings;

    // Profile Edit State
    const [displayName, setDisplayName] = useState(session.profile?.display_name || session.account.displayName);
    const [customStatus, setCustomStatus] = useState(session.account.customStatus || '');
    const [pronouns, setPronouns] = useState(session.profile?.pronouns || '');
    const [bio, setBio] = useState(session.profile?.bio || '');
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'uploading'>('idle');
    const [uploadError, setUploadError] = useState<string | null>(null);

    const setSetting = (key: any, value: any) => {
        bridge.send({ name: 'setSetting', key, value });
    };

    const handleMediaUpload = async (file: File, kind: 'avatar' | 'banner') => {
        setUploadError(null);
        const limit = kind === 'avatar' ? 524288 : 1048576;
        if (file.size > limit) {
            setUploadError(`${kind === 'avatar' ? 'Avatar' : 'Banner'} deve ter no máximo ${kind === 'avatar' ? '512 KB' : '1 MB'}.`);
            return;
        }
        setSaveStatus('uploading');
        try {
            const buffer = await file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            const size = bytes.length;
            const res: any = await bridge.send({ name: 'beginProfileMedia', kind, size });
            const uploadId = res?.uploadId;
            if (!uploadId) throw new Error('Falha ao iniciar envio');

            const CHUNK_SIZE = 16384;
            for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
                const chunk = bytes.slice(offset, Math.min(offset + CHUNK_SIZE, size));
                let binary = '';
                for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
                const data = btoa(binary);
                await bridge.send({ name: 'appendProfileMedia', uploadId, offset, data });
            }
            await bridge.send({ name: 'finishProfileMedia', uploadId });
            setSaveStatus('saved');
            setTimeout(() => setSaveStatus('idle'), 2500);
        } catch (err: any) {
            setUploadError('Erro ao enviar imagem.');
            setSaveStatus('idle');
        }
    };

    const handleSaveProfile = async () => {
        setSaveStatus('saving');
        setUploadError(null);
        try {
            await bridge.send({
                name: 'saveOwnProfile',
                fields: {
                    display_name: displayName.trim() || null,
                    pronouns: pronouns.trim() || null,
                    bio: bio.trim() || null,
                    note: null,
                    banner_color: null,
                    profile_theme_start: null,
                    profile_theme_end: null,
                },
            });
            if (customStatus.trim() !== (session.account.customStatus || '')) {
                bridge.send({ name: 'setCustomStatus', text: customStatus.trim() });
            }
            setSaveStatus('saved');
            setTimeout(() => setSaveStatus('idle'), 2500);
        } catch {
            setSaveStatus('idle');
        }
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
                                <h2 className="text-xl font-bold text-ink-100">Meu Perfil</h2>
                                <p className="text-xs text-ink-400 mt-1">Personalize seu avatar, banner, apelido e biografia.</p>
                            </div>

                            {/* Banner & Avatar preview */}
                            <div className="rounded-xl border border-ink-800 bg-ink-950/60 overflow-hidden">
                                <div
                                    className="h-28 w-full bg-gradient-to-r from-brand-600 via-indigo-600 to-purple-600 relative group"
                                    style={session.profile?.bannerDataUrl ? { backgroundImage: `url(${session.profile.bannerDataUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
                                >
                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                        <label className="cursor-pointer flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ink-900/90 hover:bg-ink-800 text-xs font-semibold text-ink-100 transition-colors">
                                            <Upload size={14} />
                                            <span>Mudar Banner</span>
                                            <input
                                                type="file"
                                                accept="image/png,image/jpeg,image/gif"
                                                className="hidden"
                                                onChange={e => {
                                                    const f = e.target.files?.[0];
                                                    if (f) handleMediaUpload(f, 'banner');
                                                }}
                                            />
                                        </label>
                                        {session.profile?.hasBanner && (
                                            <button
                                                type="button"
                                                onClick={() => bridge.send({ name: 'removeProfileMedia', kind: 'banner' })}
                                                className="p-1.5 rounded-lg bg-critical/80 hover:bg-critical text-white transition-colors"
                                                title="Remover banner"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        )}
                                    </div>
                                </div>

                                <div className="px-5 pb-5 -mt-10 flex items-end justify-between">
                                    <div className="relative group">
                                        <div className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-ink-900 bg-ink-800 text-2xl font-bold text-ink-100 shadow-md overflow-hidden">
                                            {session.account.avatarUrl ? (
                                                <img src={session.account.avatarUrl} alt="" className="h-full w-full object-cover" />
                                            ) : (
                                                session.account.displayName.slice(0, 1).toUpperCase()
                                            )}
                                        </div>
                                        <label className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer text-white">
                                            <Camera size={20} />
                                            <input
                                                type="file"
                                                accept="image/png,image/jpeg,image/gif"
                                                className="hidden"
                                                onChange={e => {
                                                    const f = e.target.files?.[0];
                                                    if (f) handleMediaUpload(f, 'avatar');
                                                }}
                                            />
                                        </label>
                                    </div>

                                    {session.profile?.hasAvatar && (
                                        <button
                                            type="button"
                                            onClick={() => bridge.send({ name: 'removeProfileMedia', kind: 'avatar' })}
                                            className="text-xs text-critical hover:underline"
                                        >
                                            Remover avatar
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Form fields */}
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">Nome de Exibição / Apelido</label>
                                    <input
                                        type="text"
                                        value={displayName}
                                        onChange={e => setDisplayName(e.target.value)}
                                        placeholder={session.account.username}
                                        className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">Status Personalizado</label>
                                    <input
                                        type="text"
                                        value={customStatus}
                                        onChange={e => setCustomStatus(e.target.value)}
                                        placeholder="Ex: Jogando Valorant"
                                        className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">Pronomes</label>
                                    <input
                                        type="text"
                                        value={pronouns}
                                        onChange={e => setPronouns(e.target.value)}
                                        placeholder="ele/dele, ela/dela, etc."
                                        className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">Sobre Mim / Biografia</label>
                                    <textarea
                                        rows={3}
                                        value={bio}
                                        onChange={e => setBio(e.target.value)}
                                        placeholder="Conte um pouco sobre você..."
                                        className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none resize-none"
                                    />
                                </div>

                                {uploadError && (
                                    <p className="text-xs text-critical">{uploadError}</p>
                                )}

                                <div className="flex items-center justify-between pt-2">
                                    <span className="text-xs text-ink-400">
                                        {saveStatus === 'saved' ? '✓ Alterações salvas com sucesso!' : saveStatus === 'uploading' ? 'Enviando imagem...' : ''}
                                    </span>
                                    <button
                                        type="button"
                                        disabled={saveStatus === 'saving' || saveStatus === 'uploading'}
                                        onClick={handleSaveProfile}
                                        className="rounded-lg bg-brand-500 hover:bg-brand-600 px-4 py-2 text-xs font-bold text-white transition-colors disabled:opacity-50"
                                    >
                                        {saveStatus === 'saving' ? 'Salvando...' : 'Salvar Alterações'}
                                    </button>
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
                                        <span className="text-sm font-medium text-ink-100 block">Supressão de Ruído</span>
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

                                {s.noiseSuppression && (
                                    <div className="p-3 bg-ink-950/60 rounded-lg border border-ink-800 space-y-3">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-medium text-ink-300">Modo de Supressão</span>
                                            <div className="flex gap-1 bg-ink-900 p-0.5 rounded border border-ink-800">
                                                <button
                                                    type="button"
                                                    onClick={() => setSetting('noiseSuppressionMode', 'standard')}
                                                    className={`px-2 py-1 text-xs rounded transition-colors ${
                                                        s.noiseSuppressionMode === 'standard' ? 'bg-brand-500 text-white font-semibold' : 'text-ink-400 hover:text-ink-200'
                                                    }`}
                                                >
                                                    Padrão (WebRTC)
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setSetting('noiseSuppressionMode', 'high')}
                                                    className={`px-2 py-1 text-xs rounded transition-colors flex items-center gap-1 ${
                                                        s.noiseSuppressionMode === 'high' ? 'bg-brand-500 text-white font-semibold' : 'text-ink-400 hover:text-ink-200'
                                                    }`}
                                                >
                                                    <Sparkles size={11} className={s.noiseSuppressionMode === 'high' ? 'text-yellow-300' : 'text-brand-400'} />
                                                    <span>Avançado (RNNoise)</span>
                                                </button>
                                            </div>
                                        </div>

                                        <div>
                                            <div className="flex justify-between text-xs text-ink-400 mb-1">
                                                <span>Intensidade da Supressão</span>
                                                <span>{s.noiseSuppressionStrength ?? 100}%</span>
                                            </div>
                                            <input
                                                type="range"
                                                min={0}
                                                max={100}
                                                value={s.noiseSuppressionStrength ?? 100}
                                                onChange={e => setSetting('noiseSuppressionStrength', +e.target.value)}
                                                className="w-full accent-brand-500"
                                            />
                                        </div>
                                    </div>
                                )}

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
