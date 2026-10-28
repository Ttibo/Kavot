/** Mutable editor lifecycle state, shared explicitly by the document modules. */
export const editorSession = {
  activeDragType: null,
  activeDragPayload: "",
  noteAutosaveTimer: null,
  noteAutosaveVersion: 0,
  noteLinkRange: null,
  secondaryNoteLinkRange: null,
  readerAutosaveTimer: null,
  pendingReaderSave: null,
  secondaryNoteAutosaveTimer: null,
  modalCleanup: null,
  modalBeforeClose: null as null | (() => Promise<boolean>),
};
