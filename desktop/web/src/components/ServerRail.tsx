import { Plus, Home } from 'lucide-react';
import type { Bridge } from '../bridge';
import type { Server } from '../protocol';
import { cn } from '../lib/utils';
import { Tooltip } from './ui/tooltip';
import { emit, EVENTS } from '../events';

function acronym(name: string): string {
    return name.replace(/'s /g, ' ').replace(/\w+/g, w => w[0]).replace(/\s/g, '').slice(0, 3).toUpperCase();
}

export function ServerIcon({ server, size = 40 }: { server: Server; size?: number }) {
    if (server.iconUrl) {
        return <img src={server.iconUrl} width={size} height={size} alt="" className="rounded-full object-cover" />;
    }
    return (
        <span
            className="flex items-center justify-center rounded-full bg-ink-700 font-semibold text-ink-200"
            style={{ width: size, height: size, fontSize: size * 0.36 }}
        >
            {acronym(server.name)}
        </span>
    );
}

export function ServerRail({
    servers,
    selectedId,
    bridge,
}: {
    servers: Server[];
    selectedId: string;
    bridge: Bridge;
}) {
    return (
        <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-ink-800 bg-ink-900 py-3">
            <Tooltip label="Início" side="right">
                <button
                    type="button"
                    aria-label="Início"
                    onClick={() => bridge.send({ name: 'selectServer', serverId: '@me' })}
                    className={cn(
                        'flex h-12 w-12 items-center justify-center rounded-full transition-all',
                        selectedId === '@me' ? 'rounded-2xl bg-brand-500 text-white shadow-md' : 'bg-ink-700 text-ink-200 hover:rounded-2xl hover:bg-brand-500 hover:text-white',
                    )}
                >
                    <Home size={22} />
                </button>
            </Tooltip>
            <div className="h-px w-8 bg-ink-700" />
            {servers.map(server => (
                <Tooltip key={server.id} label={server.name} side="right">
                    <button
                        type="button"
                        aria-label={server.name}
                        onClick={() => bridge.send({ name: 'selectServer', serverId: server.id })}
                        className={cn(
                            'flex h-12 w-12 items-center justify-center rounded-full transition-all',
                            selectedId === server.id ? 'rounded-2xl ring-2 ring-brand-400' : 'hover:rounded-2xl',
                        )}
                    >
                        <ServerIcon server={server} size={48} />
                    </button>
                </Tooltip>
            ))}
            <Tooltip label="Adicionar servidor" side="right">
                <button
                    type="button"
                    aria-label="Adicionar servidor"
                    onClick={() => emit(EVENTS.openModal, { kind: 'createServer' })}
                    className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-700 text-positive transition-all hover:rounded-2xl hover:bg-positive hover:text-ink-950"
                >
                    <Plus size={22} />
                </button>
            </Tooltip>
        </nav>
    );
}