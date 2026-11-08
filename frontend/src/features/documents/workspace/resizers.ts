import { state } from '../../../app/state';

export function bindNotesResizers(root) {
  const layout = root?.querySelector(".notes-layout");
  const sidebarHandle = root?.querySelector(".notes-sidebar-resizer");
  const workbench = root?.querySelector(".note-editor .markdown-workbench");
  const splitHandle = root?.querySelector(".note-editor .note-split-resizer");
  const secondaryWorkbench = root?.querySelector(
    ".secondary-markdown-workbench",
  );
  const secondarySplitHandle = root?.querySelector(
    ".secondary-note-split-resizer",
  );
  const workspace = root?.querySelector(".notes-main-workspace.with-secondary");
  const workspaceHandle = root?.querySelector(".note-workspace-resizer");

  const bindHandle = (handle, move, reset, keyboard) => {
    if (!handle || handle.dataset.resizeBound === "true") return;
    handle.dataset.resizeBound = "true";
    const stop = () => {
      document.body.classList.remove("resizing-notes");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
    };
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      document.body.classList.add("resizing-notes");
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
    });
    handle.addEventListener("dblclick", reset);
    handle.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      keyboard(event.key === "ArrowRight" ? 1 : -1);
    });
  };

  const setSidebarWidth = (width) => {
    if (!layout || !sidebarHandle) return;
    const maxWidth = Math.min(520, Math.max(230, layout.clientWidth - 380));
    state.noteSidebarWidth = Math.round(
      Math.max(230, Math.min(maxWidth, width)),
    );
    layout.style.setProperty(
      "--notes-sidebar-width",
      `${state.noteSidebarWidth}px`,
    );
    sidebarHandle.setAttribute("aria-valuenow", String(state.noteSidebarWidth));
  };
  bindHandle(
    sidebarHandle,
    (event) =>
      setSidebarWidth(event.clientX - layout.getBoundingClientRect().left),
    () => setSidebarWidth(340),
    (direction) => setSidebarWidth(state.noteSidebarWidth + direction * 20),
  );

  const setSplitPercent = (percent) => {
    if (!workbench || !splitHandle) return;
    state.noteSplitPercent = Math.round(Math.max(25, Math.min(75, percent)));
    workbench.style.setProperty(
      "--note-editor-left",
      `${state.noteSplitPercent}%`,
    );
    splitHandle.setAttribute("aria-valuenow", String(state.noteSplitPercent));
  };
  bindHandle(
    splitHandle,
    (event) => {
      const bounds = workbench.getBoundingClientRect();
      setSplitPercent(((event.clientX - bounds.left) / bounds.width) * 100);
    },
    () => setSplitPercent(50),
    (direction) => setSplitPercent(state.noteSplitPercent + direction * 2),
  );

  const setSecondarySplitPercent = (percent) => {
    if (!secondaryWorkbench || !secondarySplitHandle) return;
    state.secondaryNoteSplitPercent = Math.round(
      Math.max(25, Math.min(75, percent)),
    );
    secondaryWorkbench.style.setProperty(
      "--note-editor-left",
      `${state.secondaryNoteSplitPercent}%`,
    );
    secondarySplitHandle.setAttribute(
      "aria-valuenow",
      String(state.secondaryNoteSplitPercent),
    );
  };
  bindHandle(
    secondarySplitHandle,
    (event) => {
      const bounds = secondaryWorkbench.getBoundingClientRect();
      setSecondarySplitPercent(
        ((event.clientX - bounds.left) / bounds.width) * 100,
      );
    },
    () => setSecondarySplitPercent(50),
    (direction) =>
      setSecondarySplitPercent(state.secondaryNoteSplitPercent + direction * 2),
  );

  const setWorkspaceSplit = (percent) => {
    if (!workspace || !workspaceHandle) return;
    state.noteWorkspaceSplitPercent = Math.round(
      Math.max(25, Math.min(75, percent)),
    );
    workspace.style.setProperty(
      "--note-workspace-left",
      `${state.noteWorkspaceSplitPercent}%`,
    );
    workspaceHandle.setAttribute(
      "aria-valuenow",
      String(state.noteWorkspaceSplitPercent),
    );
  };
  bindHandle(
    workspaceHandle,
    (event) => {
      const bounds = workspace.getBoundingClientRect();
      setWorkspaceSplit(((event.clientX - bounds.left) / bounds.width) * 100);
    },
    () => setWorkspaceSplit(50),
    (direction) =>
      setWorkspaceSplit(state.noteWorkspaceSplitPercent + direction * 2),
  );
}
