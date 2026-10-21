import type { ComponentChildren, JSX } from 'preact';
import { useRef } from 'preact/hooks';

interface SpotlightCardProps extends JSX.HTMLAttributes<HTMLDivElement> {
  children?: ComponentChildren;
  className?: string;
  spotlightColor?: string;
}

export function SpotlightCard({
  children,
  className = '',
  spotlightColor = 'rgba(0, 223, 216, 0.14)',
  ...props
}: SpotlightCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: MouseEvent) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    cardRef.current.style.setProperty('--mouse-x', `${x}`);
    cardRef.current.style.setProperty('--mouse-y', `${y}`);
  };

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      class={`tri-spotlight relative overflow-hidden rounded-2xl border border-white/[0.08] bg-space-800/75 p-5 backdrop-blur-xl shadow-glass transition-all duration-300 hover:border-white/20 ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
