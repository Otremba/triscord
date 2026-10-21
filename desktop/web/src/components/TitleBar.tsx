import type { Bridge } from '../bridge';
import type { Server } from '../protocol';
import { ServerIcon } from './ServerRail';

// Custom title bar with draggable region and window controls.
function dragWindow(down: MouseEvent, bridge: Bridge) {
  const move = (e: MouseEvent) => {
    if (!(e.buttons & 1)) return stop();
    if (Math.abs(e.screenX - down.screenX) + Math.abs(e.screenY - down.screenY) < 3) return;
    stop(); bridge.send({ name: 'window', action: 'move' });
  };
  const stop = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', stop); };
  addEventListener('mousemove', move); addEventListener('mouseup', stop);
}

// Frameless window (like Discord): dragging the bar moves the window, a double click maximizes or restores it.
export function TitleBar({ server, bridge }: { server?: Server; bridge: Bridge }) {
  const outside = (e: MouseEvent) => !(e.target as HTMLElement).closest('button');
  return (
    <header class="tri-titlebar" onMouseDown={e => { if (e.button === 0 && outside(e)) dragWindow(e, bridge); }}
      onDblClick={e => { if (outside(e)) bridge.send({ name: 'window', action: 'maximize' }); }}>
      <div class="tri-titlebar__buttons">
        <button class="tri-winbutton" aria-label="Minimizar" onClick={() => bridge.send({ name: 'window', action: 'minimize' })}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0" y="5" width="10" height="1" fill="currentColor" /></svg>
        </button>
        <button class="tri-winbutton" aria-label="Maximizar" onClick={() => bridge.send({ name: 'window', action: 'maximize' })}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
        </button>
        <button class="tri-winbutton tri-winbutton--close" aria-label="Fechar" onClick={() => bridge.send({ name: 'window', action: 'close' })}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0 10 10M10 0 0 10" stroke="currentColor" stroke-width="1" /></svg>
        </button>
      </div>
    </header>
  );
}

// Call popout window (observed 17/10, Discord PopoutWindow): no system frame and a 24px bar with only the window buttons
// (24px wide, 4px apart); the window itself is titled with the channel. Dragging the bar moves the window and the
// edges resize it (the host's startSystemMove/startSystemResize).
// Also the bar over the login and loading screens (className tri-titlebar--overlay): the frameless main window still
// needs its buttons and a place to drag it there. INFERRED: Discord's pre-login bar was not observed.
export function PopoutBar({ bridge, className = 'tri-titlebar--popout' }: { bridge: Bridge; className?: string }) {
  const move = (e: MouseEvent) => { if (e.button === 0 && !(e.target as HTMLElement).closest('button')) dragWindow(e, bridge); };
  return (
    <header class={`tri-titlebar tri-titlebar--bare ${className}`} onMouseDown={move} onDblClick={e => { if (!(e.target as HTMLElement).closest('button')) bridge.send({ name: 'window', action: 'maximize' }); }}>
      <div class="tri-titlebar__buttons">
        <button class="tri-winbutton" aria-label="Minimizar" onClick={() => bridge.send({ name: 'window', action: 'minimize' })}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0" y="5" width="10" height="1" fill="currentColor" /></svg>
        </button>
        <button class="tri-winbutton" aria-label="Maximizar" onClick={() => bridge.send({ name: 'window', action: 'maximize' })}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
        </button>
        <button class="tri-winbutton tri-winbutton--close" aria-label="Fechar" onClick={() => bridge.send({ name: 'window', action: 'close' })}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0 10 10M10 0 0 10" stroke="currentColor" stroke-width="1" /></svg>
        </button>
      </div>
    </header>
  );
}

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
// 4px edges and 6px corners of the frameless windows (main and popout): mousedown starts the system resize.
export function ResizeEdges({ bridge }: { bridge: Bridge }) {
  return <>{EDGES.map(edge => <div key={edge} class={`tri-resize-edge tri-resize-edge--${edge}`} aria-hidden="true"
    onMouseDown={e => { if (e.button === 0) { e.preventDefault(); bridge.send({ name: 'window', action: `resize-${edge}` }); } }} />)}</>;
}
