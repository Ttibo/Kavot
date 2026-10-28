import { escapeHtml, modal, modalBackdrop, modalContent, state } from '../../app/state';
import { editorSession } from '../../app/editorSession';
import { setActiveNavigation } from '../../app/navigation';

let modalReturnFocus: HTMLElement | null = null;


function modalFocusableElements() {
  return [...modal.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.offsetParent !== null);
}


export function openModal(content, wide = false) {
  if (modalBackdrop.classList.contains("hidden"))
    modalReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  editorSession.modalCleanup?.();
  editorSession.modalCleanup = null;
  editorSession.modalBeforeClose = null;
  modalContent.innerHTML = content;
  const title = modalContent.querySelector("h1, h2, h3");
  if (title) {
    title.id = "modal-title";
    modal.setAttribute("aria-labelledby", "modal-title");
    modal.removeAttribute("aria-label");
  } else {
    modal.removeAttribute("aria-labelledby");
    modal.setAttribute("aria-label", "Dialog");
  }
  modal.classList.toggle("modal-wide", wide);
  modalBackdrop.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  setTimeout(() => {
    // The dialog's own [autofocus] field first; otherwise its first field, the close button last.
    const initial = modalContent.querySelector<HTMLElement>("[autofocus]") || modalContent.querySelector<HTMLElement>(
      "input:not([disabled]):not([type=hidden]), textarea:not([disabled]):not([hidden]), select:not([disabled]), button:not([disabled]), a[href]",
    ) || modal.querySelector<HTMLElement>("button:not([disabled])");
    (initial || (modal as HTMLElement)).focus();
  }, 20);
}


let closingModal = false;
export async function closeModal() {
  const guard = editorSession.modalBeforeClose;
  if (guard) {
    if (closingModal) return;
    closingModal = true;
    try {
      if (!await guard() || editorSession.modalBeforeClose !== guard) return;
    } finally { closingModal = false; }
  }
  editorSession.modalBeforeClose = null;
  const returnFocus = modalReturnFocus;
  modalReturnFocus = null;
  editorSession.modalCleanup?.();
  editorSession.modalCleanup = null;
  modalBackdrop.classList.add("hidden");
  document.body.style.overflow = "";
  modalContent.innerHTML = "";
  modal.classList.remove("modal-wide");
  modal.classList.remove("modal-archives");
  modal.classList.remove("modal-task");
  modal.classList.remove("modal-collection-composer");
  modal.classList.remove("modal-settings");
  modal.classList.remove("modal-pdf-preview");
  modal.classList.remove("modal-paper-note");
  modal.classList.remove("modal-canvas-note");
  setActiveNavigation(state.view);
  setTimeout(() => {
    if (returnFocus?.isConnected && modalBackdrop.classList.contains("hidden")) returnFocus.focus({ preventScroll: true });
  }, 0);
}


export function projectOptions(selected = null) {
  return state.projects
    .map(
      (project) =>
        `<option value="${project.id}" ${project.id === Number(selected) ? "selected" : ""}>${escapeHtml(project.name)}</option>`,
    )
    .join("");
}


export { templateEditorModal } from './templateEditor';

export function initializeDialogs() {



modal?.addEventListener("keydown", (event) => {
  const keyboardEvent = event as KeyboardEvent;
  if (keyboardEvent.key !== "Tab") return;
  const focusable = modalFocusableElements();
  if (!focusable.length) {
    event.preventDefault();
    (modal as HTMLElement).focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (keyboardEvent.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!keyboardEvent.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
}
