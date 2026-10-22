import { useEffect, useRef, useState } from 'react';
import { Send, Trash2 } from 'lucide-react';
import type { Bridge } from '../bridge';
import type { ChatMessage } from '../protocol';

function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '🎉'];

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
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
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

    const handleDelete = (messageId: string) => {
        bridge.send({ name: 'deleteChatMessage', messageId });
        setConfirmDeleteId(null);
    };

    const handleReaction = (messageId: string, emoji: string) => {
        bridge.send({ name: 'toggleReaction', messageId, emoji });
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div ref={listRef} className="selectable flex-1 overflow-y-auto px-4 py-4">
                {messages.length === 0 ? (
                    <p className="text-sm text-ink-500">Nenhuma mensagem ainda. Comece a conversa.</p>
                ) : (
                    <div className="space-y-4">
                        {messages.map(msg => (
                            <div key={msg.id} className="group relative flex gap-3 rounded-lg p-1.5 -mx-1.5 hover:bg-ink-900/50 transition-colors">
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-700 text-sm font-semibold text-ink-200">
                                    {msg.authorName.slice(0, 1).toUpperCase()}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-sm font-semibold text-ink-100">{msg.authorName}</span>
                                        <span className="text-xs text-ink-500">{formatTime(msg.timestamp)}</span>
                                    </div>
                                    <p className="whitespace-pre-wrap break-words text-sm text-ink-200">{msg.text}</p>

                                    {/* Reactions list */}
                                    {msg.reactions && msg.reactions.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-1.5">
                                            {msg.reactions.map(r => (
                                                <button
                                                    key={r.emoji}
                                                    type="button"
                                                    onClick={() => handleReaction(msg.id, r.emoji)}
                                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                                                        r.me
                                                            ? 'border-brand-500 bg-brand-500/20 text-brand-300'
                                                            : 'border-ink-800 bg-ink-900/80 text-ink-300 hover:border-ink-700 hover:text-ink-100'
                                                    }`}
                                                >
                                                    <span>{r.emoji}</span>
                                                    <span>{r.count}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* Floating hover action bar */}
                                <div className="absolute right-2 -top-3 hidden group-hover:flex items-center gap-1 rounded-md border border-ink-800 bg-ink-900 px-1.5 py-0.5 shadow-lg">
                                    {QUICK_EMOJIS.map(emoji => (
                                        <button
                                            key={emoji}
                                            type="button"
                                            onClick={() => handleReaction(msg.id, emoji)}
                                            className="hover:scale-125 p-1 text-xs transition-transform"
                                            title={`Reagir com ${emoji}`}
                                        >
                                            {emoji}
                                        </button>
                                    ))}

                                    {msg.own && (
                                        <>
                                            <div className="h-3 w-px bg-ink-800 mx-0.5" />
                                            {confirmDeleteId === msg.id ? (
                                                <div className="flex items-center gap-1 px-1">
                                                    <span className="text-[11px] text-critical font-medium">Excluir?</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleDelete(msg.id)}
                                                        className="rounded px-1.5 py-0.5 text-[11px] font-bold bg-critical text-white hover:bg-critical/90"
                                                    >
                                                        Sim
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setConfirmDeleteId(null)}
                                                        className="rounded px-1.5 py-0.5 text-[11px] text-ink-400 hover:text-ink-200"
                                                    >
                                                        Não
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    type="button"
                                                    aria-label="Excluir mensagem"
                                                    onClick={() => setConfirmDeleteId(msg.id)}
                                                    className="flex h-6 w-6 items-center justify-center rounded text-ink-400 hover:bg-critical/15 hover:text-critical transition-colors"
                                                    title="Excluir mensagem"
                                                >
                                                    <Trash2 size={13} />
                                                </button>
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div className="shrink-0 border-t border-ink-800 p-3">
                <div className={`flex gap-2 rounded-lg bg-ink-800 px-3 py-1.5 ${draft.includes('\n') ? 'items-end' : 'items-center'}`}>
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
                        className="max-h-40 min-h-0 flex-1 resize-none bg-transparent py-1 text-sm leading-5 text-ink-100 placeholder:text-ink-500 focus:outline-none"
                    />
                    <button
                        type="button"
                        aria-label="Enviar mensagem"
                        onClick={send}
                        disabled={!draft.trim()}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-300 hover:bg-ink-700 hover:text-ink-100 disabled:opacity-40"
                    >
                        <Send size={18} />
                    </button>
                </div>
            </div>
        </div>
    );
}