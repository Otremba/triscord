import * as React from 'react';
import { cn } from '@/lib/utils';

// Lightweight tooltip: a positioned label on hover/focus, respecting reduced motion.
export function Tooltip({
    label,
    children,
    side = 'top',
    className,
}: {
    label: React.ReactNode;
    children: React.ReactElement;
    side?: 'top' | 'bottom' | 'left' | 'right';
    className?: string;
}) {
    const [open, setOpen] = React.useState(false);
    const id = React.useId();

    return (
        <span
            className="relative inline-flex"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
        >
            {React.cloneElement(children, { 'aria-describedby': open ? id : undefined })}
            {open && (
                <span
                    id={id}
                    role="tooltip"
                    className={cn(
                        'pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-ink-700 px-2 py-1 text-xs text-ink-100 shadow-lg',
                        side === 'top' && 'bottom-full left-1/2 mb-1 -translate-x-1/2',
                        side === 'bottom' && 'top-full left-1/2 mt-1 -translate-x-1/2',
                        side === 'left' && 'right-full top-1/2 mr-1 -translate-y-1/2',
                        side === 'right' && 'left-full top-1/2 ml-1 -translate-y-1/2',
                        className,
                    )}
                >
                    {label}
                </span>
            )}
        </span>
    );
}