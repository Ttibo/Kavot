// Injected on every native page, including startup and error screens.
(() => {
  function install() {
    if (!window.pywebview?.api?.resize_window || document.getElementById('native-resize-handles')) return;
    const host = document.createElement('div');
    host.id = 'native-resize-handles';
    const edges = {
      n: 'top:0;left:10px;right:10px;height:5px;cursor:ns-resize',
      s: 'bottom:0;left:10px;right:10px;height:5px;cursor:ns-resize',
      w: 'left:0;top:10px;bottom:10px;width:5px;cursor:ew-resize',
      e: 'right:0;top:10px;bottom:10px;width:5px;cursor:ew-resize',
      nw: 'top:0;left:0;width:10px;height:10px;cursor:nwse-resize',
      ne: 'top:0;right:0;width:10px;height:10px;cursor:nesw-resize',
      sw: 'bottom:0;left:0;width:10px;height:10px;cursor:nesw-resize',
      se: 'bottom:0;right:0;width:10px;height:10px;cursor:nwse-resize',
    };
    for (const [edge, style] of Object.entries(edges)) {
      const handle = document.createElement('div');
      handle.dataset.resizeEdge = edge;
      handle.setAttribute('aria-hidden', 'true');
      handle.style.cssText = `position:fixed;z-index:2147483647;touch-action:none;user-select:none;${style}`;
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        // The native loop owns the pointer until release; no JS move/resize loop.
        window.pywebview.api.resize_window(edge).catch(error => console.error('Window resize failed', error));
      });
      host.append(handle);
    }
    const sync = () => { host.style.display = window.pywebview.state?.maximized ? 'none' : ''; };
    window.pywebview.state?.addEventListener('change', sync);
    sync();
    document.body.append(host);
    // Override pywebview's coordinate-only dragging on Windows. Wait for a real
    // drag so clicks and double-clicks do not restore a maximized window.
    let drag = null;
    window.addEventListener('mousedown', event => {
      if (event.button !== 0 || !window.pywebview.api.move_window ||
          !event.target.closest('.pywebview-drag-region')) return;
      event.stopImmediatePropagation();
      drag = { x: event.clientX, y: event.clientY, anchor: event.clientX / window.innerWidth };
    }, true);
    window.addEventListener('mousemove', event => {
      if (!drag) return;
      if (!(event.buttons & 1)) { drag = null; return; }
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
      const start = drag;
      drag = null;
      window.pywebview.api.move_window(start.anchor, start.y)
        .catch(error => console.error('Window move failed', error));
    }, true);
    window.addEventListener('mouseup', () => { drag = null; }, true);
    window.addEventListener('blur', () => { drag = null; });
  }
  if (window.pywebview?.api?.resize_window) install();
  else window.addEventListener('pywebviewready', install, { once: true });
})();
