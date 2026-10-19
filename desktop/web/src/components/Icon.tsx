import { ICON_PATHS, type IconName } from '../icons.generated';

// Icons are 24x24 viewBox paths recovered from Discord's bundle (see icons.generated.ts); colour follows
// currentColor so state colours come from CSS tokens.
export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg class={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" fill-rule="evenodd" d={ICON_PATHS[name]} />
    </svg>
  );
}
