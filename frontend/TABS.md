# Pages and tabs

Every view of Kavot opens as a **tab of the editor**. The main area always holds the editor; it has one or
two panes side by side, each with its own tabs. There is no full-page view any more. Settings open in their
own window.

```
Sidebar / launcher / links ──► navigate(view) ──► openPage(view)        a page (Tasks, Library…)
                                                └─► render()            the editor itself
Explorer, Ctrl+click …      ──► replaceActiveWorkspaceTab(pane, tab, newTab)
```

## What a tab holds

| Kind | Resource | Drawn by |
| --- | --- | --- |
| Note, drawing | `{ type: 'note', noteId }` | the editor engine (`features/documents/workspace.ts`) |
| Markdown, canvas, PDF article | `{ type: 'resource', resource: { type: 'markdown' \| 'canvas' \| …, path } }` | the editor engine |
| **Page** | `resource: { type: 'view', view, collectionId? }` | React: `components/PaneView.tsx` |
| **Project section** (Atelier) | `resource: { type: 'atelier', projectId, section, folderId? }` | React: `features/atelier/AtelierPane.tsx` |
| **Office document**, table, other PDF | `resource: { path, url }` | React: `features/atelier/WorkspaceDocument.tsx` |

React tabs share one mechanism (`app/tabs/`):

- `kinds.ts`: recognizes the React kind of a resource (`reactTabKind`), draws its placeholder in the pane
  (`reactTabPane`), and gives every tab its label and icon in the tab bar (`tabLabel`, `tabIcon`). It has
  no React dependency, so the editor engine imports it.
- `mount.tsx`: renders the component registered for each kind into its placeholder, and keeps the root
  (and the component's state) while the placeholder survives a redraw of the pane.

## Adding a page

1. `app/pages.ts`: an entry with its title and icon, plus `layout` if it needs a full-height container,
   and `launcher` to offer it in a new tab.
2. `app/pageComponents.tsx`: its component.
3. If it belongs in the navigation: a row in `components/Sidebar.tsx`, e.g. `{view('mypage')}`.

Navigation, Ctrl+click (new tab), "Open to the side", the tab bar, Back/Forward and the agent context
then work without any other change.

A page refreshes through the shared state: its component reads `useRuntime()` and redraws on `publish()`.
`showView(page)` also bumps `viewVersion(page)`, for pages that reload data on request (Home, Calendar).
To know whether a page is on screen (in any pane), use `viewShown(page)`, not `state.view`.

## Adding a kind of tab

1. `app/tabs/kinds.ts`: add the kind to `ReactTabKind`, recognize its resource in `reactTabKind`, give the
   props its component receives in `reactTabProps`, and its icon in `tabIcon`.
2. `app/tabs/mount.tsx`: register its component in `components`.
3. Open it like any document: `replaceActiveWorkspaceTab(pane, workspaceResourceTab(resource), newTab)`.

## Rules every tab follows

- **A click replaces the active tab; Ctrl/Cmd+click opens a new one.** Each tab keeps its own Back/Forward
  history (`navigateTabHistory`).
- Only the active tab of each pane is rendered. Anything that must outlive a hidden tab (a running agent
  request, a selection) lives outside the component: see `features/agents/runWatcher.ts`.
- The agents' context follows the **document pane**: the focused pane, or, when the focused tab is Agents,
  the tab open beside it (`documentPane` in `features/externalAgents/context.ts`). Its note, canvas, page
  and project are what a request is about. A component describes what it shows with `registerAgentContext`.
- A page fills its pane and scrolls inside itself; its layout adapts to the pane's width with
  `@container pane-view (…)` queries rather than viewport media queries.
