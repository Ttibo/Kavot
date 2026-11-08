import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** Colours of the app's theme, read from its CSS variables, so the terminal follows light and dark. */
function theme() {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return { background: value('--canvas', '#1e1e1e'), foreground: value('--ink', '#e6e6e6'), cursor: value('--accent', '#e6e6e6'),
    selectionBackground: value('--accent-soft', '#3a3d41') };
}

/** One agent terminal: xterm.js on the console's WebSocket. Every key goes to the agent CLI, so its whole
 * interface (slash commands, permissions, model choice…) works as in any terminal. */
export function AgentTerminal({ consoleId, visible, onExit }: { consoleId: string; visible: boolean; onExit: (code: number | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const exit = useRef(onExit);
  exit.current = onExit;

  useEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace', fontSize: 13,
      scrollback: 5000, allowProposedApi: false, theme: theme() });
    const fitter = new FitAddon();
    terminal.loadAddon(fitter);
    terminal.open(host.current);
    fit.current = fitter;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/api/agents/consoles/${consoleId}/ws`);
    const send = (message: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
    const resize = () => {
      if (!host.current?.offsetWidth) return;
      try { fitter.fit(); } catch { return; }
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
    };
    socket.onopen = () => { resize(); terminal.focus(); };
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'output') terminal.write(message.data);
      if (message.type === 'exit') {
        terminal.write(`\r\n\x1b[2m[The agent stopped${message.code != null ? ` (code ${message.code})` : ''}.]\x1b[0m\r\n`);
        exit.current(message.code ?? null);
      }
    };
    socket.onclose = event => { if (event.code === 4404) terminal.write('\r\n\x1b[2m[This terminal is closed.]\x1b[0m\r\n'); };
    const input = terminal.onData(data => send({ type: 'input', data }));
    const observer = new ResizeObserver(() => resize());
    observer.observe(host.current);
    // The app's theme can change while the terminal is open.
    const themeObserver = new MutationObserver(() => { terminal.options.theme = theme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    return () => { input.dispose(); observer.disconnect(); themeObserver.disconnect(); socket.close(); terminal.dispose(); fit.current = null; };
  }, [consoleId]);

  useEffect(() => { if (visible) requestAnimationFrame(() => { try { fit.current?.fit(); } catch { /* Hidden. */ } }); }, [visible]);

  return <div className="agent-terminal" ref={host} hidden={!visible}/>;
}
