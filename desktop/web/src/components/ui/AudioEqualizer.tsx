interface AudioEqualizerProps {
  active?: boolean;
  className?: string;
  barCount?: number;
}

export function AudioEqualizer({ active = true, className = '', barCount = 4 }: AudioEqualizerProps) {
  if (!active) return null;

  return (
    <div class={`tri-audio-equalizer inline-flex items-end gap-1 h-4 ${className}`} aria-label="Equalizador de áudio ativo">
      {Array.from({ length: barCount }).map((_, i) => (
        <span
          key={i}
          class="tri-equalizer-bar w-0.5 rounded-full bg-gradient-to-t from-neon-cyan to-neon-emerald"
          style={{
            animationDelay: `${(i * 0.15).toFixed(2)}s`,
            animationDuration: `${(0.8 + (i % 3) * 0.2).toFixed(2)}s`,
          }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
