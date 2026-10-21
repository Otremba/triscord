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
  class: classValue = '',
  className = '',
  type = 'button',
  ...props
}: ShimmerButtonProps) {
  return (
    <button
      {...props}
      type={type}
      data-variant={variant}
      class={`tri-shimmer-btn ${classValue} ${className}`}
    >
      {children}
    </button>
  );
}
