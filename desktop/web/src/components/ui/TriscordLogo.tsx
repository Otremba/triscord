interface TriscordLogoProps {
  size?: number;
  className?: string;
  glow?: boolean;
}

export function TriscordLogo({ size = 28, className = '', glow = true }: TriscordLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      class={`tri-logo transition-transform duration-300 ${className} ${glow ? 'filter drop-shadow-[0_0_8px_rgba(0,223,216,0.6)]' : ''}`}
      aria-label="Triscord Aurora"
    >
      <defs>
        <linearGradient id="tri-aurora-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#7928ca" />
          <stop offset="50%" stop-color="#00dfd8" />
          <stop offset="100%" stop-color="#00f5a0" />
        </linearGradient>
      </defs>
      {/* Outer geometric triangular ring */}
      <path
        d="M16 3L29 25.5H3L16 3Z"
        stroke="url(#tri-aurora-grad)"
        stroke-width="2.5"
        stroke-linejoin="round"
      />
      {/* Dynamic central pulse core */}
      <circle cx="16" cy="18" r="4.5" fill="url(#tri-aurora-grad)" />
      <path
        d="M16 11V15M11 22L13.5 19.5M21 22L18.5 19.5"
        stroke="#ffffff"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
  );
}
