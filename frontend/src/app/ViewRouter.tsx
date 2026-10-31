import { watchReactTabs } from './tabs/mount';

/** The main area always holds the editor: every page opens as one of its tabs (see pages.ts and tabs/). */
export function attachViewRouter(main: HTMLElement) {
  watchReactTabs(main);
}
