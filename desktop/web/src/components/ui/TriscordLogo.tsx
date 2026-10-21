interface TriscordLogoProps {
  size?: number;
  className?: string;
  glow?: boolean;
}

export function TriscordLogo({ size = 28, className = '', glow = false }: TriscordLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      class={`tri-logo ${className}`}
      aria-label="Triscord"
    >
      {/* Outer geometric triangular ring */}
      <path
        d="M16 3L29 25.5H3L16 3Z"
        stroke="var(--ui-accent)"
        stroke-width="2.5"
        stroke-linejoin="round"
      />
      {/* Central mark */}
      <circle cx="16" cy="18" r="4.5" fill="var(--ui-accent)" />
      <path
        d="M16 11V15M11 22L13.5 19.5M21 22L18.5 19.5"
        stroke="#ffffff"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
  );
}
