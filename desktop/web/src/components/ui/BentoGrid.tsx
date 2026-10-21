import type { ComponentChildren, JSX } from 'preact';
import { useRef } from 'preact/hooks';

interface BentoGridProps extends JSX.HTMLAttributes<HTMLDivElement> {
  children: ComponentChildren;
  className?: string;
}

export function BentoGrid({ children, className = '', ...props }: BentoGridProps) {
  return (
    <div class={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4 ${className}`} {...props}>
      {children}
    </div>
  );
}

interface BentoCardProps extends JSX.HTMLAttributes<HTMLDivElement> {
  children?: ComponentChildren;
  title?: string;
  description?: string;
  badge?: string;
  badgeVariant?: 'cyan' | 'violet' | 'emerald';
  className?: string;
  header?: ComponentChildren;
}

export function BentoCard({
  children,
  title,
  description,
  badge,
  badgeVariant = 'cyan',
  className = '',
  header,
  ...props
}: BentoCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: MouseEvent) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    cardRef.current.style.setProperty('--mouse-x', `${x}`);
    cardRef.current.style.setProperty('--mouse-y', `${y}`);
  };

  const badgeStyles = {
    cyan: 'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/30',
    violet: 'bg-neon-violet/15 text-purple-300 border-neon-violet/30',
    emerald: 'bg-neon-emerald/15 text-neon-emerald border-neon-emerald/30',
  }[badgeVariant];

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      class={`tri-spotlight group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-white/[0.08] bg-space-800/70 p-6 backdrop-blur-xl shadow-glass transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:shadow-glow-aurora ${className}`}
      {...props}
    >
      {header && <div class="mb-4">{header}</div>}
      <div class="space-y-2">
        {badge && (
          <span class={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider border ${badgeStyles}`}>
            {badge}
          </span>
        )}
        {title && <h3 class="text-lg font-semibold text-white tracking-tight">{title}</h3>}
        {description && <p class="text-sm text-slate-400 leading-relaxed">{description}</p>}
        {children}
      </div>
    </div>
  );
}
