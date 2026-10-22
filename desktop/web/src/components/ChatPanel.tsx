import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import type { Bridge } from '../bridge';
import type { ChatMessage } from '../protocol';

function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ChatPanel({
    channelName,
    messages,
    bridge,
}: {
    channelName: string;
    messages: ChatMessage[];
    bridge: Bridge;
}) {
    const [draft, setDraft] = useState('');
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }, [messages.length]);

    const send = () => {
        const text = draft.trim();
        if (!text) return;
        bridge.send({ name: 'sendChatMessage', text });
        setDraft('');
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center border-b border-ink-800 px-4">
                <span className="text-sm font-semibold text-ink-100"># {channelName}</span>
            </div>
            <div ref={listRef} className="selectable flex-1 overflow-y-auto px-4 py-4">
                {messages.length === 0 ? (
                    <p className="text-sm text-ink-500">Nenhuma mensagem ainda. Comece a conversa.</p>
                ) : (
                    <div className="space-y-4">
                        {messages.map(msg => (
                            <div key={msg.id} className="group flex gap-3">
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-700 text-sm font-semibold text-ink-200">
                                    {msg.authorName.slice(0, 1).toUpperCase()}
                                </span>
                                <div className="min-w-0">
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-sm font-semibold text-ink-100">{msg.authorName}</span>
                                        <span className="text-xs text-ink-500">{formatTime(msg.timestamp)}</span>
                                    </div>
                                    <p className="whitespace-pre-wrap break-words text-sm text-ink-200">{msg.text}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div className="shrink-0 border-t border-ink-800 p-3">
                <div className="flex items-end gap-2 rounded-lg bg-ink-800 px-3 py-2">
                    <textarea
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                send();
                            }
                        }}
                        placeholder={`Mensagem em #${channelName}`}
                        rows={1}
                        className="max-h-40 min-h-0 flex-1 resize-none bg-transparent text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none"
                    />
                    <button
                        type="button"
                        aria-label="Enviar mensagem"
                        onClick={send}
                        disabled={!draft.trim()}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-ink-300 hover:bg-ink-700 hover:text-ink-100 disabled:opacity-40"
                    >
                        <Send size={18} />
                    </button>
                </div>
            </div>
        </div>
    );
}