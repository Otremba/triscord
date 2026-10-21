import type { ComponentChildren } from 'preact';

interface AudioRippleProps {
  speaking: boolean;
  children: ComponentChildren;
  className?: string;
}

export function AudioRipple({ speaking, children, className = '' }: AudioRippleProps) {
  if (!speaking) return <div class={`relative inline-flex items-center justify-center ${className}`}>{children}</div>;

  return (
    <div class={`tri-audio-ripple-container relative inline-flex items-center justify-center ${className}`}>
      <span class="tri-audio-ripple" aria-hidden="true" />
      <span class="tri-audio-ripple" aria-hidden="true" />
      <span class="tri-audio-ripple" aria-hidden="true" />
      {children}
    </div>
  );
}
