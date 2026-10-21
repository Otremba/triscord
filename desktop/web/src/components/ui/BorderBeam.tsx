import type { ComponentChildren } from 'preact';

interface BorderBeamProps {
  children?: ComponentChildren;
  className?: string;
  duration?: number;
  borderWidth?: number;
  colorFrom?: string;
  colorTo?: string;
}

export function BorderBeam({
  children,
  className = '',
  duration = 4,
}: BorderBeamProps) {
  return (
    <div class={`relative overflow-hidden rounded-inherit ${className}`}>
      {children}
      <div
        class="tri-border-beam pointer-events-none absolute inset-0 rounded-inherit"
        style={{ animationDuration: `${duration}s` }}
        aria-hidden="true"
      />
    </div>
  );
}
