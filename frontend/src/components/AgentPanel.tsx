import { type PointerEvent as ReactPointerEvent } from 'react';
import { AgentWorkspace } from './AgentWorkspace';

/** Resizable shell; the assistant stays mounted while its panel is closed. */
export function AgentPanel({ project, width, onResize, onClose, hidden }: { project?: Project; width: number; onResize: (width: number) => void; onClose: () => void; hidden?: boolean }) {
  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const initialX = event.clientX;
    const initialWidth = width;
    const resize = (moveEvent: PointerEvent) => {
      const maximum = Math.max(300, Math.min(760, window.innerWidth - 180));
      onResize(Math.max(300, Math.min(maximum, initialWidth + initialX - moveEvent.clientX)));
    };
    const stop = () => {
      document.removeEventListener('pointermove', resize);
      document.removeEventListener('pointerup', stop);
    };
    document.addEventListener('pointermove', resize);
    document.addEventListener('pointerup', stop, { once: true });
  };
  return <aside className="agent-panel" style={{ width, flexBasis: width, display: hidden ? 'none' : undefined }} aria-label="Kavot assistant">
    <button className="agent-panel-resizer" aria-label="Resize assistant panel" title="Drag to resize" onPointerDown={startResize}/>
    <AgentWorkspace project={project} visible={!hidden} onClose={onClose}/>
  </aside>;
}
