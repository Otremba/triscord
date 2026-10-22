import { useState, useEffect, useMemo } from 'react';
import type { Bridge } from '@/bridge';
import type { Session, VideoStream, VoiceUser } from '@/protocol';
import { VideoTile } from '@/components/VideoTile';
import { OwnStreamTile } from '@/components/call/OwnStreamTile';
import { ParticipantCard } from '@/components/call/ParticipantCard';
import { cn } from '@/lib/utils';

interface CallStageProps {
    session: Session;
    bridge: Bridge;
    videoStreams: VideoStream[];
    callParticipants: VoiceUser[];
}

export function CallStage({
    session,
    bridge,
    videoStreams,
    callParticipants,
}: CallStageProps) {
    // Array of focused keys that divide the large stage together
    const [focusedKeys, setFocusedKeys] = useState<string[]>([]);

    // Native window video click listener from Rust
    useEffect(() => {
        return bridge.onMessage((msg: any) => {
            if (msg?.type === 'event' && msg?.name === 'videoClick' && msg?.streamId) {
                toggleFocus(msg.streamId);
            }
        });
    }, [bridge]);

    const toggleFocus = (key: string) => {
        setFocusedKeys(prev => {
            const defaultStageKeys = streamItems.length > 0
                ? streamItems.map(s => s.key)
                : [];

            if (prev.includes(key)) {
                return prev.filter(k => k !== key);
            } else if (prev.length === 0 && !defaultStageKeys.includes(key)) {
                return [...defaultStageKeys, key];
            } else {
                return [...prev, key];
            }
        });
    };

    // Clean up stale focused keys if streams or participants depart
    useEffect(() => {
        const validKeys = new Set<string>();
        if (session.sharing) validKeys.add('own-stream');
        for (const s of videoStreams) validKeys.add(s.id);
        for (const u of callParticipants) validKeys.add(u.id);

        setFocusedKeys(prev => {
            const filtered = prev.filter(k => validKeys.has(k));
            return filtered.length === prev.length ? prev : filtered;
        });
    }, [session.sharing, videoStreams, callParticipants]);

    // All available stream items
    const streamItems = useMemo(() => {
        const items: Array<{ key: string; type: 'stream' | 'own-stream'; stream?: VideoStream }> = [];
        if (session.sharing) {
            items.push({ key: 'own-stream', type: 'own-stream' });
        }
        for (const s of videoStreams) {
            items.push({ key: s.id, type: 'stream', stream: s });
        }
        return items;
    }, [session.sharing, videoStreams]);

    // Determine which items go to the large stage
    const { stageItems, stripItems } = useMemo(() => {
        if (focusedKeys.length > 0) {
            // User explicitly grouped specific items on the large stage
            const stageStreams = streamItems.filter(s => focusedKeys.includes(s.key));
            const stageUsers = callParticipants.filter(u => focusedKeys.includes(u.id));

            const stripStreams = streamItems.filter(s => !focusedKeys.includes(s.key));
            const stripUsers = callParticipants.filter(u => !focusedKeys.includes(u.id));

            return {
                stageItems: { streams: stageStreams, users: stageUsers },
                stripItems: { streams: stripStreams, users: stripUsers },
            };
        }

        // Automatic mode (no manual selection)
        if (streamItems.length > 0) {
            // When there are active screen/video streams, they all share the large stage
            return {
                stageItems: { streams: streamItems, users: [] },
                stripItems: { streams: [], users: callParticipants },
            };
        }

        // When only voice participants are in the call, they all share the large stage
        return {
            stageItems: { streams: [], users: callParticipants },
            stripItems: { streams: [], users: [] },
        };
    }, [focusedKeys, streamItems, callParticipants]);

    const totalStageCount = stageItems.streams.length + stageItems.users.length;
    const hasStrip = stripItems.streams.length > 0 || stripItems.users.length > 0;

    // Trigger video surface recalculation on stage composition change
    useEffect(() => {
        dispatchEvent(new Event('tri-layout-changed'));
    }, [totalStageCount, hasStrip]);

    // Grid columns layout calculation to divide the large stage harmoniously
    const getGridClass = (count: number) => {
        if (count <= 1) return 'grid-cols-1 max-w-5xl';
        if (count === 2) return 'grid-cols-1 md:grid-cols-2 max-w-6xl';
        if (count === 3) return 'grid-cols-1 md:grid-cols-3 max-w-7xl';
        if (count === 4) return 'grid-cols-1 sm:grid-cols-2 max-w-6xl';
        if (count <= 6) return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 max-w-7xl';
        return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 max-w-7xl';
    };

    return (
        <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-hidden p-4">
            {/* The Large Stage: tiles group and divide the available space */}
            <div className="flex flex-1 min-h-0 w-full items-center justify-center overflow-y-auto">
                <div className={cn(
                    'grid gap-4 w-full h-full content-center items-center justify-center justify-items-center mx-auto transition-all duration-200',
                    getGridClass(totalStageCount)
                )}>
                    {/* Streams on Stage */}
                    {stageItems.streams.map(item => {
                        const isFocused = focusedKeys.includes(item.key);
                        if (item.type === 'own-stream') {
                            return (
                                <OwnStreamTile
                                    key="own-stream"
                                    session={session}
                                    bridge={bridge}
                                    isFocused={isFocused}
                                    onClick={() => toggleFocus('own-stream')}
                                />
                            );
                        }
                        if (item.stream) {
                            return (
                                <VideoTile
                                    key={item.stream.id}
                                    stream={item.stream}
                                    bridge={bridge}
                                    isFocused={isFocused}
                                    onClick={() => toggleFocus(item.key)}
                                />
                            );
                        }
                        return null;
                    })}

                    {/* Users on Stage */}
                    {stageItems.users.map(user => {
                        const canSpeak = !user.muted && !user.serverMuted && !user.deafened;
                        return (
                            <ParticipantCard
                                key={user.id}
                                user={user}
                                isSpeaking={canSpeak && Boolean(user.speaking)}
                                variant="stage"
                                isFocused={focusedKeys.includes(user.id)}
                                onClick={() => toggleFocus(user.id)}
                                onKick={!user.self ? () => bridge.send({ name: 'disconnectParticipant', socketId: user.id }) : undefined}
                            />
                        );
                    })}
                </div>
            </div>

            {/* Bottom Strip: other participants/streams waiting to be focused */}
            {hasStrip && (
                <div className="flex flex-wrap items-center justify-center gap-3 pt-3 border-t border-ink-800/60 mt-auto shrink-0 max-h-36 overflow-y-auto">
                    {/* Secondary Streams in strip */}
                    {stripItems.streams.map(item => {
                        if (item.type === 'own-stream') {
                            return (
                                <div key="strip-own-stream" className="w-48 sm:w-56 cursor-pointer" onClick={() => toggleFocus('own-stream')}>
                                    <div className="flex items-center gap-2 p-2 rounded-lg bg-ink-900 border border-brand-500/40 hover:border-brand-400 text-xs text-brand-300 font-medium">
                                        <span className="h-2 w-2 rounded-full bg-positive animate-pulse" />
                                        <span className="truncate">Sua Tela (Clique para ampliar)</span>
                                    </div>
                                </div>
                            );
                        }
                        if (item.stream) {
                            return (
                                <div key={`strip-${item.stream.id}`} className="w-48 sm:w-56 cursor-pointer" onClick={() => toggleFocus(item.key)}>
                                    <div className="flex items-center gap-2 p-2 rounded-lg bg-ink-900 border border-ink-700 hover:border-brand-400 text-xs text-ink-200">
                                        <span className="truncate">{item.stream.title} (Clique para ampliar)</span>
                                    </div>
                                </div>
                            );
                        }
                        return null;
                    })}

                    {/* Secondary Participants in strip */}
                    {stripItems.users.map(user => {
                        const canSpeak = !user.muted && !user.serverMuted && !user.deafened;
                        return (
                            <div key={user.id} className="w-48 sm:w-56">
                                <ParticipantCard
                                    user={user}
                                    isSpeaking={canSpeak && Boolean(user.speaking)}
                                    variant="compact"
                                    isFocused={false}
                                    onClick={() => toggleFocus(user.id)}
                                    onKick={!user.self ? () => bridge.send({ name: 'disconnectParticipant', socketId: user.id }) : undefined}
                                />
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
