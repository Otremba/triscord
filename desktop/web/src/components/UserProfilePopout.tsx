import { useEffect, useRef } from 'react';
import type { Session } from '@/protocol';
import { emit, EVENTS } from '@/events';
import { UserCheck } from 'lucide-react';

export function UserProfilePopout({
    session,
    onClose,
}: {
    session: Session;
    onClose: () => void;
}) {
    const popoutRef = useRef<HTMLDivElement>(null);
    const { account, profile } = session;

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (popoutRef.current && !popoutRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };

        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside);
            document.addEventListener('keydown', handleKeyDown);
        }, 10);

        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [onClose]);

    const bannerStyle = profile?.bannerDataUrl
        ? { backgroundImage: `url(${profile.bannerDataUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
        : profile?.banner_color
        ? { backgroundColor: profile.banner_color }
        : undefined;

    return (
        <div
            ref={popoutRef}
            className="absolute bottom-16 left-2 z-50 w-72 rounded-xl border border-ink-750 bg-ink-900 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        >
            {/* Header / Banner */}
            <div
                className="h-16 w-full bg-gradient-to-r from-brand-600 via-indigo-600 to-purple-600 relative"
                style={bannerStyle}
            />

            {/* Avatar overlapping banner */}
            <div className="relative px-4 pb-4">
                <div className="-mt-9 mb-2.5 flex items-end justify-between">
                    <div className="relative">
                        <div className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-ink-900 bg-ink-800 text-xl font-bold text-ink-100 shadow-md overflow-hidden">
                            {account.avatarUrl ? (
                                <img src={account.avatarUrl} alt="" className="h-full w-full object-cover" />
                            ) : (
                                account.displayName.slice(0, 1).toUpperCase()
                            )}
                        </div>
                        {/* Status dot */}
                        <span className="absolute bottom-0 right-0 h-4 w-4 rounded-full border-2 border-ink-900 bg-positive" />
                    </div>
                </div>

                {/* Name & Username */}
                <div className="rounded-lg bg-ink-950/60 p-3 border border-ink-800/80">
                    <div className="font-bold text-base text-ink-100 truncate">{account.displayName}</div>
                    <div className="text-xs text-ink-400">@{account.username}</div>

                    {profile?.pronouns && (
                        <div className="mt-1 text-xs text-ink-400 font-medium">{profile.pronouns}</div>
                    )}

                    {account.customStatus && (
                        <div className="mt-2 text-xs text-ink-200 italic bg-ink-900/80 rounded px-2 py-1 border border-ink-800/60">
                            {account.customStatus}
                        </div>
                    )}

                    {profile?.bio && (
                        <div className="mt-2 text-xs text-ink-300 border-t border-ink-800/60 pt-2 whitespace-pre-wrap line-clamp-4">
                            {profile.bio}
                        </div>
                    )}

                    <div className="mt-3 border-t border-ink-800/80 pt-2.5">
                        <button
                            type="button"
                            onClick={() => {
                                onClose();
                                emit(EVENTS.openSettings, { page: 'account' });
                            }}
                            className="w-full flex items-center justify-center gap-1.5 rounded-md bg-ink-800 hover:bg-ink-700 px-3 py-1.5 text-xs font-semibold text-ink-200 hover:text-ink-100 transition-colors"
                        >
                            <UserCheck size={14} />
                            <span>Editar Perfil</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
