import type { ComponentChildren } from 'preact';
import { Icon } from './Icon';
import { ModalLayer } from './ModalLayer';

// Modal dialog component with header, body and action footer.
export interface ModalAction { label: string; variant: 'primary' | 'secondary' | 'critical'; type?: 'button' | 'submit'; disabled?: boolean; onClick?: () => void }

// `onClose` starts the close animation (useModalClose); `closing` comes from the same hook.
export function Modal({ title, subtitle, label, onClose, closing = false, preview, actions = [], children, onSubmit }: {
  title: string; subtitle?: ComponentChildren; label?: string; onClose: () => void; closing?: boolean; preview?: ComponentChildren;
  actions?: ModalAction[]; children?: ComponentChildren; onSubmit?: (event: Event) => void;
}) {
  const content = (
    <>
      <header class="tri-dmodal__section tri-dmodal__header">
        <h1 class="tri-dmodal__title">{title}</h1>
        {subtitle && <div class="tri-dmodal__subtitle">{subtitle}</div>}
        <button type="button" class="tri-dmodal__close" aria-label="Fechar" onClick={onClose}><Icon name="Close" size={24} /></button>
      </header>
      {children && <div class="tri-dmodal__body"><main class="tri-dmodal__inner">{children}</main></div>}
      {preview && <footer class="tri-dmodal__section tri-dmodal__footer">{preview}</footer>}
      {actions.length > 0 && (
        <footer class="tri-dmodal__section tri-dmodal__actions">
          {actions.map(a => (
            <button key={a.label} type={a.type ?? 'button'} class={`tri-button tri-button--${a.variant}`} disabled={a.disabled} onClick={a.onClick}>{a.label}</button>
          ))}
        </footer>
      )}
    </>
  );
  return (
    <ModalLayer closing={closing} onRequestClose={onClose}>
      {onSubmit
        ? <form class="tri-dmodal" role="dialog" aria-label={label ?? title} onSubmit={e => { e.preventDefault(); onSubmit(e); }}>{content}</form>
        : <div class="tri-dmodal" role="dialog" aria-label={label ?? title}>{content}</div>}
    </ModalLayer>
  );
}
