import type { ComponentChildren } from 'preact';

export function StatePanel({title,description,children,busy=false,error=false}:{title:string;description:string;children?:ComponentChildren;busy?:boolean;error?:boolean}) {
  return <section class={`tri-state-panel ${error?'tri-state-panel--error':''}`} aria-busy={busy}>
    <div role={error?'alert':'status'} aria-live="polite"><h2>{title}</h2><p>{description}</p></div>
    {children&&<div class="tri-state-panel__actions">{children}</div>}
  </section>;
}
