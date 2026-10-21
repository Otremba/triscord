import type { ComponentChildren, JSX } from 'preact';

interface ShimmerButtonProps extends JSX.HTMLAttributes<HTMLButtonElement> {
  children?: ComponentChildren;
  variant?: 'aurora' | 'violet' | 'cyan' | 'glass';
  className?: string;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  form?: string;
}

export function ShimmerButton({
  children,
  variant = 'aurora',
  className = '',
  ...props
}: ShimmerButtonProps) {
  const variantStyles = {
    aurora: 'bg-gradient-to-r from-neon-violet via-neon-cyan to-neon-emerald shadow-glow-aurora text-white',
    violet: 'bg-gradient-to-r from-neon-violet to-purple-600 shadow-glow-violet text-white',
    cyan: 'bg-gradient-to-r from-neon-cyan to-blue-500 shadow-glow-cyan text-slate-950 font-bold',
    glass: 'bg-white/10 hover:bg-white/15 text-white border border-white/20 shadow-glass',
  }[variant];

  return (
    <button
      class={`tri-shimmer-btn relative inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 ${variantStyles} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
