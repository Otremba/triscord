import glyph from '../../assets/triscord-glyph.png';

interface TriscordLogoProps {
  size?: number;
  className?: string;
  glow?: boolean; // Retained for callers; the identity has no decorative glow.
}

export function TriscordLogo({ size = 28, className = '' }: TriscordLogoProps) {
  return <img src={glyph} width={size} height={size} class={`tri-logo ${className}`} alt="Triscord" />;
}
