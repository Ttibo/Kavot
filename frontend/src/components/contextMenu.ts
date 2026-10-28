export interface ContextAction {
  label: string;
  run: () => unknown;
  danger?: boolean;
  /** Trusted SVG markup shown before the label. */
  icon?: string;
  /** Draw a divider above this item. */
  separator?: boolean;
}

let menu: HTMLDivElement | null = null;
let origin: HTMLElement | null = null;

export function closeContextMenu(restoreFocus = false) {
  menu?.remove();
  menu = null;
  if (restoreFocus && origin?.isConnected) origin.focus({ preventScroll: true });
  origin = null;
}

export function showContextMenu(actions: ContextAction[], x: number, y: number, source: HTMLElement, label = 'Context menu') {
  closeContextMenu();
  if (!actions.length) return;
  origin = source.closest<HTMLElement>('button, a, [tabindex]') || source.querySelector<HTMLElement>('button, a, [tabindex]') || document.activeElement as HTMLElement;
  menu = document.createElement('div');
  menu.className = 'app-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    if (action.icon) {
      const icon = document.createElement('span');
      icon.className = 'app-context-menu-icon';
      icon.innerHTML = action.icon;
      button.append(icon);
    }
    button.append(action.label);
    if (action.danger) button.className = 'danger';
    if (action.separator && menu.childElementCount) {
      const divider = document.createElement('div');
      divider.className = 'app-context-menu-separator';
      divider.setAttribute('role', 'separator');
      menu.append(divider);
    }
    button.addEventListener('click', event => {
      event.stopPropagation();
      closeContextMenu(true);
      action.run();
    });
    menu.append(button);
  }
  menu.addEventListener('keydown', event => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = index;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next].focus();
  });
  document.body.append(menu);
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector('button')?.focus({ preventScroll: true });
}

export function initializeContextMenuDismissal() {
  document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target as Node)) closeContextMenu(); }, true);
  document.addEventListener('keydown', event => {
    if (!menu) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeContextMenu(true);
    } else if (event.key === 'Tab') closeContextMenu(true);
  }, true);
  document.addEventListener('scroll', event => { if (menu && !menu.contains(event.target as Node)) closeContextMenu(); }, true);
  window.addEventListener('resize', () => closeContextMenu());
  window.addEventListener('blur', () => closeContextMenu());
}
