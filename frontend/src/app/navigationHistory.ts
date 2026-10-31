import { navigateTabHistory } from '../features/documents/workspace';

/** Back and Forward act on the active tab only, never on the whole application:
 * the titlebar arrows, Alt+←/→, the browser keys and the mouse's side buttons. */
export function initializeNavigationHistory() {
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    const back = event.key === 'BrowserBack' || (event.altKey && event.key === 'ArrowLeft');
    const forward = event.key === 'BrowserForward' || (event.altKey && event.key === 'ArrowRight');
    if (!back && !forward) return;
    event.preventDefault();
    void navigateTabHistory(back ? -1 : 1);
  });
  // Mouse buttons 4 and 5; the default would leave the page in a browser.
  document.addEventListener('mouseup', event => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    void navigateTabHistory(event.button === 3 ? -1 : 1);
  });
}
