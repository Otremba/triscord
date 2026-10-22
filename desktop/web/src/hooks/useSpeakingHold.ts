import { useEffect, useState } from 'react';

/**
 * Smooth speaking hold hook that activates immediately when speech starts
 * and sustains for `holdMs` (default 200ms) across natural pauses, preventing
 * flickering and premature cut-off of the voice activity green indicator.
 */
export function useSpeakingHold(active: boolean, holdMs = 200): boolean {
    const [speaking, setSpeaking] = useState(active);

    useEffect(() => {
        if (active) {
            setSpeaking(true);
        } else {
            const timer = setTimeout(() => setSpeaking(false), holdMs);
            return () => clearTimeout(timer);
        }
    }, [active, holdMs]);

    return speaking;
}
