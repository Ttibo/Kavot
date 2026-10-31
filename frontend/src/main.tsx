import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import { flushSync } from 'react-dom';
import { AppShell } from './components/AppShell';
import { setRuntime } from './app/runtime';
import './app/colors';
import { publish } from './app/viewBridge';
import { canonicalView, isPage } from './app/pages';
import './styles/integration.css';
import './styles/research-workspace.css';
import './styles/features/library-refined.css';
import './styles/features/article-watch.css';
import './styles/features/canvas-studio.css';
import './styles/components/context-menu.css';
import './styles/modern.css';
import './styles/features/collection-unified.css';
import './styles/features/notes-explorer.css';
import './styles/typography.css';
import './styles/research-home.css';
import './styles/obsidian.css';
import './styles/views-harmony.css';
import './styles/features/canvas-cards.css';
import './styles/view-layout.css';
import './styles/polish.css';

async function start() {
  const container = document.getElementById('root')!;
  flushSync(() => createRoot(container).render(<AppShell/>));
  const main = document.getElementById('main-content')!;
  main.textContent = 'Preparing your research workspace…';
  try {
    const [runtime, state, router, history, menus, cloud] = await Promise.all([
      import('./app/workspace'), import('./app/state'), import('./app/ViewRouter'),
      import('./app/navigationHistory'), import('./app/contextMenus'), import('./app/cloudRefresh'),
    ]);
    state.bindInterfaceElements();
    setRuntime(runtime);
    router.attachViewRouter(main);
    history.initializeNavigationHistory();
    runtime.initializeEvents();
    menus.initializeAppContextMenus();
    await runtime.refreshData();
    publish();
    // The start page opens as the first tab of the editor (Home when the saved view is not a page).
    const start = canonicalView(runtime.state.view);
    await runtime.navigate(isPage(start) || start === 'notes' ? start : 'dashboard');
    cloud.startCloudRefresh(runtime);
  } catch (error) {
    console.error('Unable to initialize Kavot', error);
    main.replaceChildren();
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = `Unable to load Kavot: ${error instanceof Error ? error.message : String(error)}`;
    const retry = document.createElement('button');
    retry.className = 'button'; retry.textContent = 'Retry';
    retry.onclick = () => window.location.reload();
    main.append(message, retry);
  }
}
void start();
