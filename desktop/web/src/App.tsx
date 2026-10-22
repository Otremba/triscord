import { useEffect, useState, useRef } from 'react';
import { useSession, type SessionStore } from './store';
import { soundEngine } from './sound-engine';
import { TitleBar } from './components/TitleBar';
import { ServerRail } from './components/ServerRail';
import { ChannelSidebar } from './components/ChannelSidebar';
import { AccountPanel } from './components/AccountPanel';
import { ChatPanel } from './components/ChatPanel';
import { VideoTile } from './components/VideoTile';
import { LoginScreen } from './components/LoginScreen';
import { FriendsView } from './components/FriendsView';
import { QuickSwitcher } from './components/QuickSwitcher';
import { SettingsModal } from './components/SettingsModal';
import { CreateChannelModal } from './components/modals/CreateChannelModal';
import { CreateServerModal } from './components/modals/CreateServerModal';
import { ShareScreenModal } from './components/modals/ShareScreenModal';
import { ControlsBar } from './components/call/ControlsBar';
import { ParticipantCard } from './components/call/ParticipantCard';
import { OwnStreamTile } from './components/call/OwnStreamTile';
import type { Bridge } from './bridge';
import type { Session, VoiceUser, Channel } from './protocol';
import { EVENTS } from './events';
import { MessageSquare, Volume2, Hash } from 'lucide-react';
import { Tooltip } from './components/ui/tooltip';

export function App({ store, bridge }: { store: SessionStore; bridge: Bridge }) {
    const session: Session | null = useSession(store);

    const [showChat, setShowChat] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsPage, setSettingsPage] = useState<'account' | 'voice' | 'windows'>('voice');
    const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
    const [channelModal, setChannelModal] = useState<{ categoryName?: string } | null>(null);
    const [serverModalOpen, setServerModalOpen] = useState(false);
    const [shareModalOpen, setShareModalOpen] = useState(false);

    // Event listeners
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setQuickSwitcherOpen(prev => !prev);
            }
        };
        const openSwitcher = () => setQuickSwitcherOpen(prev => !prev);
        const openSettings = (e?: Event) => {
            const detail = (e as CustomEvent)?.detail;
            if (detail?.page) {
                setSettingsPage(detail.page);
            } else {
                setSettingsPage('voice');
            }
            setSettingsOpen(true);
        };
        const openModalHandler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.kind === 'createChannel') {
                setChannelModal({ categoryName: detail.categoryName });
            } else if (detail?.kind === 'shareScreen') {
                setShareModalOpen(true);
            } else if (detail?.kind === 'createServer') {
                setServerModalOpen(true);
            }
        };

        window.addEventListener('keydown', onKey);
        window.addEventListener(EVENTS.openQuickSwitcher, openSwitcher);
        window.addEventListener(EVENTS.openSettings, openSettings);
        window.addEventListener(EVENTS.openModal, openModalHandler);

        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener(EVENTS.openQuickSwitcher, openSwitcher);
            window.removeEventListener(EVENTS.openSettings, openSettings);
            window.removeEventListener(EVENTS.openModal, openModalHandler);
        };
    }, []);

    // Synchronize sound settings with SoundEngine
    useEffect(() => {
        if (session?.settings) {
            soundEngine.setEnabled(session.settings.callSounds ?? true);
            soundEngine.setVolume(session.settings.soundboardVolume ?? 70);
        }
    }, [session?.settings?.callSounds, session?.settings?.soundboardVolume]);

    // Play join / leave sound cues when connecting/disconnecting from a voice channel
    const prevConnectedRef = useRef<string | null | undefined>(undefined);
    useEffect(() => {
        if (prevConnectedRef.current !== undefined) {
            if (!prevConnectedRef.current && session?.connectedChannelId) {
                soundEngine.play('join');
            } else if (prevConnectedRef.current && !session?.connectedChannelId) {
                soundEngine.play('leave');
            }
        }
        prevConnectedRef.current = session?.connectedChannelId;
    }, [session?.connectedChannelId]);

    // Play userJoin / userLeave sound cues when other participants join or leave the active call
    const prevParticipantsRef = useRef<string[]>([]);
    useEffect(() => {
        if (!session?.connectedChannelId) {
            prevParticipantsRef.current = [];
            return;
        }
        const currentIds = (session.callChannel?.users ?? []).map(u => u.id);
        if (prevParticipantsRef.current.length > 0) {
            const joined = currentIds.filter(id => !prevParticipantsRef.current.includes(id));
            const left = prevParticipantsRef.current.filter(id => !currentIds.includes(id));
            if (joined.length > 0) soundEngine.play('userJoin');
            else if (left.length > 0) soundEngine.play('userLeave');
        }
        prevParticipantsRef.current = currentIds;
    }, [session?.callChannel?.users, session?.connectedChannelId]);

    if (!session || (session.auth && session.auth.state !== 'signedIn')) {
        return <LoginScreen auth={session?.auth} bridge={bridge} />;
    }

    const isHome = !session.selectedServerId || session.selectedServerId === '@me';
    const selectedServer = session.servers.find(s => s.id === session.selectedServerId);

    const allChannels: Channel[] = session.categories.flatMap(c => c.channels);
    const selectedChannel = allChannels.find(c => c.id === session.selectedChannelId) ?? allChannels[0];

    const inCall = !!session.connectedChannelId;
    const callChannel = session.callChannel ?? allChannels.find(c => c.id === session.connectedChannelId);
    const callParticipants = callChannel?.users ?? [];
    const videoStreams = session.streams ?? [];

    return (
        <div className="flex h-screen w-screen flex-col bg-ink-950 text-ink-100 overflow-hidden select-none font-sans">
            <TitleBar server={selectedServer} bridge={bridge} />

            <div className="flex flex-1 min-h-0 min-w-0">
                {/* Left: Server Rail */}
                <ServerRail
                    servers={session.servers}
                    selectedId={session.selectedServerId ?? '@me'}
                    bridge={bridge}
                />

                {/* Second column: Channel Sidebar + Account Panel */}
                <div className="flex w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
                    <ChannelSidebar session={session} bridge={bridge} />
                    <AccountPanel session={session} bridge={bridge} />
                </div>

                {/* Main View Area */}
                <main className="flex flex-1 min-w-0 flex-col bg-ink-950">
                    {isHome ? (
                        <FriendsView session={session} bridge={bridge} />
                    ) : (
                        <div className="flex flex-1 min-h-0 flex-col">
                            {/* Channel Header */}
                            <header className="flex h-12 shrink-0 items-center justify-between border-b border-ink-800 bg-ink-900/60 px-4">
                                <div className="flex items-center gap-2 min-w-0">
                                    {selectedChannel?.kind === 'voice' ? (
                                        <Volume2 size={18} className="text-ink-400 shrink-0" />
                                    ) : (
                                        <Hash size={18} className="text-ink-400 shrink-0" />
                                    )}
                                    <span className="font-semibold text-sm text-ink-100 truncate">
                                        {selectedChannel?.name ?? 'Geral'}
                                    </span>
                                </div>

                                <div className="flex items-center gap-2">
                                    {selectedChannel?.kind === 'voice' && inCall && (
                                        <Tooltip label={showChat ? 'Ocultar chat' : 'Mostrar chat'}>
                                            <button
                                                type="button"
                                                onClick={() => setShowChat(prev => !prev)}
                                                className={`flex h-8 w-8 items-center justify-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100 transition-colors ${showChat ? 'bg-ink-800 text-ink-100' : ''}`}
                                            >
                                                <MessageSquare size={18} />
                                            </button>
                                        </Tooltip>
                                    )}
                                </div>
                            </header>

                            {/* Content Body: Chat or Call View */}
                            <div className="flex flex-1 min-h-0">
                                {selectedChannel?.kind === 'voice' && inCall ? (
                                    <div className="flex flex-1 min-h-0 flex-col">
                                        {/* Call Stage */}
                                        <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto p-4">
                                            {(videoStreams.length > 0 || session.sharing) ? (
                                                <div className="flex flex-1 min-h-0 flex-col gap-4">
                                                    {/* Video & Screen Streams Grid */}
                                                    <div className={`grid gap-4 auto-rows-fr ${
                                                        (videoStreams.length + (session.sharing ? 1 : 0)) === 1
                                                            ? 'grid-cols-1 max-w-4xl mx-auto w-full'
                                                            : 'grid-cols-1 md:grid-cols-2'
                                                    }`}>
                                                        {session.sharing && (
                                                            <OwnStreamTile session={session} bridge={bridge} />
                                                        )}
                                                        {videoStreams.map(stream => (
                                                            <VideoTile key={stream.id} stream={stream} bridge={bridge} />
                                                        ))}
                                                    </div>

                                                    {/* Voice Participants Strip */}
                                                    <div className="flex flex-wrap items-center justify-center gap-3 pt-3 border-t border-ink-800/60 mt-auto">
                                                        {callParticipants.map((user: VoiceUser) => (
                                                            <div key={user.id} className="w-48 sm:w-56">
                                                                <ParticipantCard
                                                                    user={user}
                                                                    isSpeaking={user.speaking}
                                                                    variant="compact"
                                                                    onKick={!user.self ? () => bridge.send({ name: 'disconnectParticipant', socketId: user.id }) : undefined}
                                                                />
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="grid flex-1 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 auto-rows-max">
                                                    {callParticipants.map((user: VoiceUser) => (
                                                        <ParticipantCard
                                                            key={user.id}
                                                            user={user}
                                                            isSpeaking={user.speaking}
                                                            onKick={!user.self ? () => bridge.send({ name: 'disconnectParticipant', socketId: user.id }) : undefined}
                                                        />
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Bottom Controls Bar */}
                                        <ControlsBar session={session} bridge={bridge} />
                                    </div>
                                ) : (
                                    <ChatPanel
                                        channelName={selectedChannel?.name ?? 'conversa'}
                                        messages={session.chat ?? []}
                                        bridge={bridge}
                                    />
                                )}

                                {/* Side Chat when in Voice Call */}
                                {selectedChannel?.kind === 'voice' && inCall && showChat && (
                                    <aside className="w-80 border-l border-ink-800 flex flex-col bg-ink-900/40">
                                        <ChatPanel
                                            channelName={selectedChannel?.name ?? 'conversa'}
                                            messages={session.chat ?? []}
                                            bridge={bridge}
                                        />
                                    </aside>
                                )}
                            </div>
                        </div>
                    )}
                </main>
            </div>

            {/* Modals & Dialogs */}
            {settingsOpen && (
                <SettingsModal
                    session={session}
                    bridge={bridge}
                    initialPage={settingsPage}
                    onClose={() => setSettingsOpen(false)}
                />
            )}

            {channelModal && (
                <CreateChannelModal
                    categoryName={channelModal.categoryName}
                    bridge={bridge}
                    onClose={() => setChannelModal(null)}
                />
            )}

            {serverModalOpen && (
                <CreateServerModal
                    bridge={bridge}
                    onClose={() => setServerModalOpen(false)}
                />
            )}

            {shareModalOpen && (
                <ShareScreenModal
                    bridge={bridge}
                    onClose={() => setShareModalOpen(false)}
                />
            )}

            {quickSwitcherOpen && (
                <QuickSwitcher
                    session={session}
                    bridge={bridge}
                />
            )}
        </div>
    );
}