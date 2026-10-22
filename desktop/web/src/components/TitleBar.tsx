import { Minus, Square, X } from 'lucide-react';
import type { Bridge } from '../bridge';
import type { Server } from '../protocol';
import { cn } from '../lib/utils';

// Frameless window title bar: draggable region with native window controls.
export function TitleBar({ bridge }: { server?: Server; bridge: Bridge }) {
    return (
        <header
            className="flex h-8 shrink-0 items-center justify-between border-b border-ink-800 bg-ink-900"
            onMouseDown={e => {
                if (e.button === 0 && !(e.target as HTMLElement).closest('button')) {
                    bridge.send({ name: 'window', action: 'move' });
                }
            }}
            onDoubleClick={e => {
                if (!(e.target as HTMLElement).closest('button')) bridge.send({ name: 'window', action: 'maximize' });
            }}
        >
            <div className="flex-1 h-full" />
            <div className="flex h-full items-stretch">
                <WindowButton label="Minimizar" onClick={() => bridge.send({ name: 'window', action: 'minimize' })}>
                    <Minus size={14} />
                </WindowButton>
                <WindowButton label="Maximizar" onClick={() => bridge.send({ name: 'window', action: 'maximize' })}>
                    <Square size={12} />
                </WindowButton>
                <WindowButton label="Fechar" danger onClick={() => bridge.send({ name: 'window', action: 'close' })}>
                    <X size={14} />
                </WindowButton>
            </div>
        </header>
    );
}

function WindowButton({
    children,
    label,
    danger,
    onClick,
}: {
    children: React.ReactNode;
    label: string;
    danger?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn(
                'flex w-11 items-center justify-center text-ink-400 transition-colors hover:bg-ink-700 hover:text-ink-100',
                danger && 'hover:bg-critical hover:text-white',
            )}
        >
            {children}
        </button>
    );
}