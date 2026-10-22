import { useEffect, useState, useRef } from 'react';
import { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { emit } from '../events';

export function QuickSwitcher({ bridge, session }: { bridge: Bridge; session: Session | null }) {
    const [query, setQuery] = useState('');
    const [filteredServers, setFilteredServers] = useState<Array<{ id: string; name: string }>>([]);
    const [filteredChannels, setFilteredChannels] = useState<Array<{ id: string; name: string; serverId: string; serverName: string }>>([]);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!session) return;

        // Initial filter - show all servers and channels from selected server
        const serverOptions = session.servers.map(s => ({ id: s.id, name: s.name }));
        setFilteredServers(serverOptions);

        const channelOptions = session.categories
            .flatMap(category =>
                category.channels.map(channel => ({
                    id: channel.id,
                    name: `#${channel.name}`,
                    serverId: category.id, // Using category ID as serverId for grouping
                    serverName: category.name
                }))
            )
            .filter(channel => channel.serverId === session.selectedServerId); // Only show channels from selected server initially
        setFilteredChannels(channelOptions);

        // Focus input when opened
        inputRef.current?.focus();

        // Handle escape to close
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                emit('tri-open-quick-switcher', {}); // Toggle off
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [session, bridge]);

    useEffect(() => {
        if (!session || !query) {
            // Reset filters when query is empty
            if (session) {
                const serverOptions = session.servers.map(s => ({ id: s.id, name: s.name }));
                setFilteredServers(serverOptions);

                const channelOptions = session.categories
                    .flatMap(category =>
                        category.channels.map(channel => ({
                            id: channel.id,
                            name: `#${channel.name}`,
                            serverId: category.id,
                            serverName: category.name
                        }))
                    )
                    .filter(channel => channel.serverId === session.selectedServerId);
                setFilteredChannels(channelOptions);
            }
            return;
        }

        const searchTerm = query.toLowerCase();

        // Filter servers
        const serverMatches = session.servers
            .filter(server =>
                server.name.toLowerCase().includes(searchTerm) ||
                server.id.toLowerCase().includes(searchTerm)
            )
            .map(s => ({ id: s.id, name: s.name }));
        setFilteredServers(serverMatches);

        // Filter channels
        const channelMatches = session.categories
            .flatMap(category =>
                category.channels.map(channel => ({
                    id: channel.id,
                    name: `#${channel.name}`,
                    serverId: category.id,
                    serverName: category.name
                }))
            )
            .filter(channel =>
                channel.name.toLowerCase().includes(searchTerm) ||
                channel.serverName.toLowerCase().includes(searchTerm) ||
                channel.serverId.toLowerCase().includes(searchTerm)
            );
        setFilteredChannels(channelMatches);
    }, [session, query]);

    const handleServerSelect = (serverId: string) => {
        bridge.send({ name: 'selectServer', serverId });
        emit('tri-open-quick-switcher', {}); // Close quick switcher
    };

    const handleChannelSelect = (channelId: string, serverId: string) => {
        bridge.send({ name: 'selectServer', serverId });
        bridge.send({ name: 'selectChannel', channelId });
        emit('tri-open-quick-switcher', {}); // Close quick switcher
    };

    if (!session) {
        return null;
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 backdrop-blur-sm">
            <div className="bg-ink-900 rounded-lg p-6 w-80 max-h-[80vh] overflow-hidden space-y-4">
                <div className="flex items-center space-x-3 pb-3 border-b border-ink-800">
                    <h3 className="text-lg font-semibold text-ink-50">Alternar rapidamente</h3>
                    <button
                        className="ml-auto p-1 rounded hover:bg-ink-800"
                        onClick={() => emit('tri-open-quick-switcher', {})}
                    >
                        <span className="sr-only">Fechar</span>
                        {/* Using Lucide X icon would be ideal, but for now using text */}
                        ✕
                    </button>
                </div>

                <div className="space-y-2">
                    <label className="block text-sm font-medium text-ink-50 mb-1">Buscar servidores e canais</label>
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        className="block w-full rounded-md border-0 py-2 pl-3 pr-9 text-ink-50 shadow-sm ring-1 ring-inset ring-ink-700 placeholder:text-ink-400 focus:ring-2 focus:ring-inset focus:ring-brand-500 sm:text-sm sm:leading-6"
                        placeholder="Digite para buscar..."
                    />
                </div>

                {query.length > 0 && (
                    <>
                        <div className="flex items-center space-x-2 my-3">
                            <h4 className="text-sm font-medium text-ink-300">Servidores</h4>
                            {filteredServers.length === 0 && (
                                <p className="text-xs text-ink-400">Nenhum servidor encontrado</p>
                            )}
                        </div>
                        <div className="space-y-1">
                            {filteredServers.map(server => (
                                <div
                                    key={server.id}
                                    className="flex items-center px-3 py-2 rounded hover:bg-ink-800 cursor-pointer"
                                    onClick={() => handleServerSelect(server.id)}
                                >
                                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-700 text-xs font-semibold text-ink-200">
                                        {server.name.slice(0, 1).toUpperCase()}
                                    </div>
                                    <div className="flex-1 ml-3">
                                        <p className="text-sm text-ink-50">{server.name}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                <div className="flex items-center space-x-2 my-3">
                    <h4 className="text-sm font-medium text-ink-300">Canais</h4>
                    {filteredChannels.length === 0 && (
                        <p className="text-xs text-ink-400">Nenhum canal encontrado</p>
                    )}
                </div>
                <div className="space-y-1">
                    {filteredChannels.map(channel => (
                        <div
                            key={channel.id}
                            className="flex items-center px-3 py-2 rounded hover:bg-ink-800 cursor-pointer"
                            onClick={() => handleChannelSelect(channel.id, channel.serverId)}
                        >
                            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-700 text-xs font-semibold text-ink-200">
                                #
                            </div>
                            <div className="flex-1 ml-3 space-y-1">
                                <p className="text-sm text-ink-50">{channel.name}</p>
                                <p className="text-xs text-ink-400">#{channel.serverName}</p>
                            </div>
                        </div>
                    ))}
                </div>

                {query.length === 0 && (
                    <>
                        <div className="flex items-center space-x-2 my-3">
                            <h4 className="text-sm font-medium text-ink-300">Servidores</h4>
                        </div>
                        <div className="space-y-1">
                            {session.servers.map(server => (
                                <div
                                    key={server.id}
                                    className={`flex items-center px-3 py-2 rounded hover:bg-ink-800 cursor-pointer ${server.id === session.selectedServerId ? 'bg-ink-800' : ''}`}
                                    onClick={() => handleServerSelect(server.id)}
                                >
                                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-700 text-xs font-semibold text-ink-200">
                                        {server.name.slice(0, 1).toUpperCase()}
                                    </div>
                                    <div className="flex-1 ml-3">
                                        <p className="text-sm text-ink-50">{server.name}</p>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="flex items-center space-x-2 my-3">
                            <h4 className="text-sm font-medium text-ink-300">Canais (servidor selecionado)</h4>
                        </div>
                        <div className="space-y-1">
                            {session.categories
                                .filter(category => category.id === session.selectedServerId)
                                .flatMap(c => c.channels)
                                .map(channel => (
                                    <div
                                        key={channel.id}
                                        className={`flex items-center px-3 py-2 rounded hover:bg-ink-800 cursor-pointer ${session.connectedChannelId === channel.id ? 'bg-ink-800' : ''}`}
                                        onClick={() => handleChannelSelect(channel.id, session.selectedServerId)}
                                    >
                                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-700 text-xs font-semibold text-ink-200">
                                            #
                                        </div>
                                        <div className="flex-1 ml-3">
                                            <p className="text-sm text-ink-50">{channel.name}</p>
                                        </div>
                                    </div>
                                )) ?? []}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}