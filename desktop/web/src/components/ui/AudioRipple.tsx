import type { ComponentChildren } from 'preact';

interface AudioRippleProps {
  speaking: boolean;
  children: ComponentChildren;
  className?: string;
}

export function AudioRipple({ speaking, children, className = '' }: AudioRippleProps) {
  return (
    <div class={`tri-audio-ripple-container ${speaking ? 'is-speaking' : ''} ${className}`}>
      {speaking && (
        <>
          <span class="tri-audio-ripple" aria-hidden="true" />
          <span class="tri-audio-ripple" aria-hidden="true" />
          <span class="tri-audio-ripple" aria-hidden="true" />
        </>
      )}
      {children}
    </div>
  );
}
