import type { ComponentChildren, JSX } from 'preact';

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
  return (
    <div
      class={`tri-bento-card relative overflow-hidden p-5 ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
