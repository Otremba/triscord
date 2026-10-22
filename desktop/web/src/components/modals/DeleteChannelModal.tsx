import { useEffect } from 'react';
import type { Bridge } from '@/bridge';
import { X, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function DeleteChannelModal({
    channelId,
    channelName,
    bridge,
    onClose,
}: {
    channelId: string;
    channelName: string;
    bridge: Bridge;
    onClose: () => void;
}) {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const handleDelete = () => {
        bridge.send({ name: 'deleteChannel', channelId });
        onClose();
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
            onClick={e => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="w-full max-w-md rounded-xl border border-ink-800 bg-ink-900 p-6 shadow-2xl">
                <div className="flex items-center justify-between pb-4 border-b border-ink-800">
                    <div className="flex items-center gap-2 text-critical">
                        <Trash2 size={20} />
                        <h2 className="text-lg font-bold text-ink-100">Excluir Canal</h2>
                    </div>
                    <button
                        type="button"
                        aria-label="Fechar"
                        onClick={onClose}
                        className="text-ink-400 hover:text-ink-100 transition-colors"
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="mt-4 space-y-3">
                    <p className="text-sm text-ink-300">
                        Tem certeza de que deseja excluir o canal{' '}
                        <span className="font-semibold text-ink-100">{channelName}</span>?
                    </p>
                    <p className="text-xs text-ink-400">
                        Esta ação é irreversível. Todas as mensagens e dados do canal serão permanentemente excluídos.
                    </p>
                </div>

                <div className="mt-6 flex justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={onClose}>
                        Cancelar
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        onClick={handleDelete}
                        className="bg-critical hover:bg-critical/80 text-white font-medium"
                    >
                        Excluir Canal
                    </Button>
                </div>
            </div>
        </div>
    );
}
