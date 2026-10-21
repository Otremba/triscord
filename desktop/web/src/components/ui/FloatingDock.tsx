import type { ComponentChildren, JSX } from 'preact';

interface FloatingDockProps extends JSX.HTMLAttributes<HTMLDivElement> {
  children?: ComponentChildren;
  className?: string;
}

export function FloatingDock({ children, className = '', ...props }: FloatingDockProps) {
  return (
    <div
      class={`tri-floating-dock flex items-center gap-2 p-2 rounded-2xl bg-space-900/80 backdrop-blur-2xl border border-white/10 shadow-glass transition-all duration-300 ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
