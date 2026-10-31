import { viewShown, escapeHtml, flushReaderAutosave, labels, main, modal, modalContent, noteAssetBase, rememberReadingProgress, renderMarkdown, state } from '../../app/state';
import { closeModal, openModal } from '../../components/dialogs/controller';
import { collectionField, openCollectionComposer } from '../../components/dialogs/collectionComposer';
import { paperCustomMetadata, paperFolderDescendantIds, paperFolderOptions, renderPapers } from './filters';
import { refreshData, setActiveNavigation, toast } from '../../app/navigation';
import { api } from '../../services/api';
import { flushCurrentNoteAutosave, flushSecondaryNoteAutosave, refreshWorkspaceTreeOnly, renderNotes, replaceActiveWorkspaceTab, replaceActiveWorkspaceTabPair, workspaceNoteTab, workspaceResourceTab } from '../documents/workspace';
import { currentMarkdownBlockInput, markdownBlockSourceOffset, setMarkdownBlockEditorContent } from '../documents/markdown';
import { editorSession } from '../../app/editorSession';
import { loadPdfEngine } from '../documents/pdfEngine';
import { bindPdfAnnotations } from '../documents/pdfAnnotations';
import { pdfIcon } from '../documents/pdfIcons';



export function newPaperModal(projectId = null) {
  const selectedFolder = !["all", "root"].includes(state.paperFolderFilter)
    ? Number(state.paperFolderFilter)
    : null;
  const field = (name: string, label: string, control: string, help = '') => collectionField('paper', name, label, control, help);
  openCollectionComposer({
    id: 'paper-form', title: 'Add article', eyebrow: 'Research library',
    description: 'Capture a reference, attach the source, and keep its contribution close.',
    main: `<div class="collection-title-field">${field('title', 'Article title <span>Required</span>', '<input required placeholder="Full publication title">')}</div>
      ${field('authors', 'Authors', '<input placeholder="First name Last name, First name Last name">', 'Separate authors with commas.')}
      <div class="collection-field-pair">${field('publication', 'Publication', '<input placeholder="Journal or conference">')}${field('published_at', 'Publication date', '<input placeholder="2026 or 2026-04">')}</div>
      <div class="collection-writing-field">${field('abstract', 'Abstract <span>Optional</span>', '<textarea placeholder="Summarize the research question, methods and main contribution…"></textarea>')}</div>`,
    details: `<div class="collection-section-heading"><div><h3>Source & organization</h3><p>Keep the reference connected to your work.</p></div></div>
      <div class="collection-file-field">${field('file', 'PDF document <span>Optional</span>', '<input type="file" accept="application/pdf,.pdf">', 'The PDF is copied into your local library.')}</div>
      ${field('doi', 'DOI', '<input placeholder="10.xxxx/xxxxx">')}
      ${field('url', 'Reference URL', '<input type="url" placeholder="https://…">')}
      ${field('folder_id', 'Library folder', `<select><option value="">Unfiled</option>${paperFolderOptions(selectedFolder)}</select>`)}
      ${field('tags', 'Tags', '<input placeholder="Methods, evaluation, corpus">', 'Separate tags with commas.')}
      <fieldset class="registry-fieldset"><legend>Related projects</legend><div class="relation-options">${state.projects.length ? state.projects.map(p => `<label class="relation-check"><input type="checkbox" name="project_ids" value="${p.id}" ${p.id === Number(projectId) ? 'checked' : ''}><span>${escapeHtml(p.name)}</span></label>`).join('') : '<p class="relation-empty">No projects yet.</p>'}</div></fieldset>`,
    actions: '<span class="collection-footer-hint">Only the title is required. You can attach a PDF later.</span><button type="button" class="button" data-close-modal>Cancel</button><button type="submit" class="button button-primary" id="paper-submit">Add article</button>',
  });
  document
    .querySelector("#paper-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const source = new FormData((event.target as HTMLFormElement));
      if (!String(source.get("title") || "").trim()) {
        toast("A title is required", "error");
        (document.querySelector("[name='title']") as HTMLInputElement)?.focus();
        return;
      }
      const form = new FormData();
      [
        "title",
        "abstract",
        "publication",
        "published_at",
        "doi",
        "url",
      ].forEach((key) => form.append(key, source.get(key) || ""));
      form.append(
        "authors",
        JSON.stringify(
          String(source.get("authors") || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      );
      form.append(
        "tags",
        JSON.stringify(
          String(source.get("tags") || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      );
      form.append(
        "project_ids",
        JSON.stringify(source.getAll("project_ids").map(Number)),
      );
      if (source.get("folder_id"))
        form.append("folder_id", source.get("folder_id"));
      form.append("reading_status", "to_read");
      const selectedFile = source.get("file");
      if (selectedFile instanceof File && selectedFile.name) form.append("file", selectedFile);
      try {
        const paper = await api("/papers", { method: "POST", body: form });
        closeModal();
        await refreshData();
        toast(paper.file_path ? "Article and PDF added" : "Article created; PDF can be added later");
        renderPapers();
      } catch (error) {
        toast(error.message, "error");
      }
    });
}

export function paperFolderModal(folderId = null, requestedParentId = null) {
  const folder = folderId
    ? state.paperFolders.find((item) => item.id === Number(folderId))
    : null;
  const excluded = folder ? paperFolderDescendantIds(folder.id) : new Set();
  const selectedParent = folder
    ? folder.parent_id
    : Number(requestedParentId) || null;
  openModal(
    `<header class="modal-header"><h2>${folder ? "Edit folder" : requestedParentId ? "New subfolder" : "New folder"}</h2><p>Organize articles without moving or duplicating their PDF files.</p></header><div class="modal-body"><form id="paper-folder-form" class="form-grid"><div class="form-field full"><label>Folder name</label><input name="name" required maxlength="120" value="${escapeHtml(folder?.name || "")}" placeholder="E.g. Methodology"></div><div class="form-field full"><label>Parent folder</label><select name="parent_id"><option value="">Library root</option>${paperFolderOptions(selectedParent, null, 0, excluded)}</select></div><div class="form-actions">${folder ? `<button type="button" class="button button-danger" data-delete-paper-folder="${folder.id}">Delete</button>` : ""}<button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">${folder ? "Save" : "Create folder"}</button></div></form></div>`,
  );
  document
    .querySelector("#paper-folder-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const data: Record<string, any> = Object.fromEntries(new FormData((event.target as HTMLFormElement)));
      data.parent_id = data.parent_id ? Number(data.parent_id) : null;
      try {
        const saved = await api(
          folder ? `/paper-folders/${folder.id}` : "/paper-folders",
          { method: folder ? "PATCH" : "POST", body: JSON.stringify(data) },
        );
        closeModal();
        await refreshData();
        state.paperFolderFilter = String(saved.id);
        if (viewShown("papers")) renderPapers();
        else renderNotes();
        toast(folder ? "Folder updated" : "Folder created");
      } catch (error) {
        toast(error.message, "error");
      }
    });
}

export function bindPdfCapture(
  paper,
  editor,
  preview,
  _assetBase,
  saveNote,
  getNoteRange,
  root: Document | HTMLElement = document,
  captureAvailable: boolean | (() => boolean) = true,
  options: { fileUrl?: string; annotationsEndpoint?: string; cropEndpoint?: string; initialPage?: number; onProgress?: (page: number) => void } = {},
) {
  const captureIsAvailable = () =>
    typeof captureAvailable === "function"
      ? Boolean(captureAvailable())
      : Boolean(captureAvailable);
  const stage = root.querySelector("#pdf-capture-stage");
  const pagesContainer = root.querySelector("#pdf-pages");
  const workspace = root instanceof HTMLElement && root.matches("#pdf-capture-workspace")
    ? root
    : root.querySelector("#pdf-capture-workspace");
  const pageInput = root.querySelector("#capture-page");
  const totalLabel = root.querySelector("#capture-total");
  const statusLabel = root.querySelector("#capture-status");
  const extractButton = root.querySelector("#pdf-extract-toggle");
  if (!stage || !pagesContainer || !workspace || !extractButton) return;
  let currentPage = Math.max(
    1,
    Number(options.initialPage ?? state.readingProgress[String(paper.id)] ?? 1),
  );
  let totalPages = 1;
  let zoom = 1;
  let fitWidth = 0;
  let extractionMode = false;
  let activeSurface = null;
  let activeImage = null;
  let selectionBox = null;
  let selection = null;
  let dragStart = null;
  let scrollFrame = null;
  let insertingCapture = false;
  let disposed = false;
  let pageObserver: IntersectionObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;
  const objectUrls = new Set<string>();
  let pageElements: HTMLElement[] = [];
  let pageOffsets: number[] = [];
  let progressTimer: ReturnType<typeof setTimeout>;
  const measurePages = () => { pageOffsets = pageElements.map(page => page.offsetTop); };
  let annotations: ReturnType<typeof bindPdfAnnotations>;

  const rememberProgress = () => options.onProgress ? options.onProgress(currentPage) : rememberReadingProgress(paper.id, currentPage);
  const updatePageControls = () => {
    (pageInput as HTMLInputElement).value = String(currentPage);
    (root.querySelector("#capture-prev") as HTMLButtonElement).disabled = currentPage === 1;
    (root.querySelector("#capture-next") as HTMLButtonElement).disabled =
      currentPage === totalPages;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(rememberProgress, 250);
  };
  const clearSelection = () => {
    selectionBox?.classList.add("hidden");
    selection = null;
    dragStart = null;
    activeSurface = null;
    activeImage = null;
    selectionBox = null;
  };
  const showSelection = () => {
    if (!selection || !selectionBox) {
      return;
    }
    selectionBox.classList.remove("hidden");
    Object.assign(selectionBox.style, {
      left: `${selection.x}px`,
      top: `${selection.y}px`,
      width: `${selection.width}px`,
      height: `${selection.height}px`,
    });
  };
  const applyZoom = () => {
    const width = Math.max(220, fitWidth * zoom);
    pagesContainer.querySelectorAll(".pdf-page-surface").forEach((surface) => {
      const ratio = Number((surface as HTMLElement).dataset.ratio) || 1.414;
      (surface as HTMLElement).style.width = `${width}px`;
      (surface as HTMLElement).style.height = `${Math.round(width * ratio)}px`;
    });
    annotations?.resize();
    measurePages();
    root.querySelector("#pdf-zoom-label").textContent =
      `${Math.round(zoom * 100)} %`;
  };
  const setZoom = (nextZoom, reset = false) => {
    clearSelection();
    const anchor = pagesContainer.querySelector(
      `[data-pdf-page="${currentPage}"]`,
    );
    const previousZoom = zoom;
    const relativeTop = anchor ? stage.scrollTop - (anchor as HTMLElement).offsetTop : 0;
    zoom = reset ? 1 : Math.max(0.5, Math.min(3, nextZoom));
    applyZoom();
    if (anchor)
      requestAnimationFrame(() => {
        stage.scrollTop = Math.max(
          0,
          (anchor as HTMLElement).offsetTop + relativeTop * (zoom / previousZoom),
        );
      });
  };
  const goToPage = (page) => {
    if (disposed) return;
    currentPage = Math.max(1, Math.min(totalPages, Number(page) || 1));
    updatePageControls();
    const targetPage = pagesContainer.querySelector(
      `[data-pdf-page="${currentPage}"]`,
    );
    if (targetPage)
      stage.scrollTo({
        top: Math.max(0, (targetPage as HTMLElement).offsetTop - 12),
        behavior: "instant",
      });
  };
  const setExtractionMode = (enabled) => {
    extractionMode = captureIsAvailable() && enabled;
    workspace.classList.toggle("extract-mode", extractionMode);
    extractButton.classList.toggle("active", extractionMode);
    extractButton.setAttribute("aria-pressed", String(extractionMode));
    (extractButton as HTMLButtonElement).disabled = !captureIsAvailable();
    extractButton.setAttribute('title', extractionMode ? 'Cancel capture' : 'Capture an area');
    clearSelection();
    statusLabel.textContent = !captureIsAvailable()
      ? "Open a note in an adjacent pane to capture an area."
      : extractionMode
        ? "Capture mode on · draw a rectangle on a page."
        : `${totalPages} page${totalPages > 1 ? "s" : ""} · continuous scrolling · reading mode.`;
  };

  annotations = bindPdfAnnotations(workspace as HTMLElement, paper.id, () => setExtractionMode(false), options.annotationsEndpoint);
  root
    .querySelector("#capture-prev")
    .addEventListener("click", () => goToPage(currentPage - 1));
  root
    .querySelector("#capture-next")
    .addEventListener("click", () => goToPage(currentPage + 1));
  pageInput.addEventListener("change", () => goToPage((pageInput as HTMLInputElement).value));
  root
    .querySelector("#pdf-zoom-in")
    .addEventListener("click", () => setZoom(zoom + 0.2));
  root
    .querySelector("#pdf-zoom-out")
    .addEventListener("click", () => setZoom(zoom - 0.2));
  root
    .querySelector("#pdf-fit-width")
    .addEventListener("click", () => setZoom(1, true));
  extractButton.addEventListener("click", () => {
    setExtractionMode(!extractionMode);
  });
  stage.addEventListener(
    "wheel",
    (event) => {
      if (!((event as KeyboardEvent).ctrlKey || (event as KeyboardEvent).metaKey)) return;
      event.preventDefault();
      setZoom(zoom + ((event as WheelEvent).deltaY < 0 ? 0.1 : -0.1));
    },
    { passive: false },
  );
  stage.addEventListener("scroll", () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      if (!pageOffsets.length) return;
      const top = stage.scrollTop + 12;
      // Cached positions avoid measuring every page during each scroll frame.
      let low = 0, high = pageOffsets.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (pageOffsets[middle] < top) low = middle + 1;
        else high = middle;
      }
      const index = low > 0 && Math.abs(pageOffsets[low - 1] - top) < Math.abs(pageOffsets[low] - top) ? low - 1 : low;
      if (currentPage !== index + 1) { currentPage = index + 1; updatePageControls(); }
    });
  });

  pagesContainer.addEventListener(
    "load",
    (event) => {
      const image = (event.target as HTMLElement).closest?.(".pdf-page-image");
      if (!(image as HTMLImageElement)?.naturalWidth) return;
      const surface = image.closest(".pdf-page-surface");
      (surface as HTMLElement).dataset.ratio = String((image as HTMLImageElement).naturalHeight / (image as HTMLImageElement).naturalWidth);
      surface.classList.remove("loading");
      const width = Math.max(220, fitWidth * zoom);
      (surface as HTMLElement).style.width = `${width}px`;
      (surface as HTMLElement).style.height = `${Math.round((width * (image as HTMLImageElement).naturalHeight) / (image as HTMLImageElement).naturalWidth)}px`;
      annotations.resize();
      measurePages();
    },
    true,
  );
  pagesContainer.addEventListener(
    "error",
    (event) => {
      const image = (event.target as HTMLElement).closest?.(".pdf-page-image");
      if (!image) return;
      image.closest(".pdf-page-surface")?.classList.add("error");
      statusLabel.textContent = `La page ${(image as HTMLImageElement).dataset.page} could not be rendered.`;
    },
    true,
  );

  pagesContainer.addEventListener("pointerdown", (event) => {
    const surface = (event.target as HTMLElement).closest(".pdf-page-surface");
    const image = surface?.querySelector(".pdf-page-image");
    if (
      insertingCapture ||
      !extractionMode ||
      (event as PointerEvent).button !== 0 ||
      !surface ||
      !(image as HTMLImageElement)?.complete ||
      !(image as HTMLImageElement).naturalWidth
    )
      return;
    clearSelection();
    activeSurface = surface;
    activeImage = image;
    selectionBox = surface.querySelector(".pdf-selection");
    currentPage = Number((surface as HTMLElement).dataset.page);
    updatePageControls();
    const bounds = activeSurface.getBoundingClientRect();
    dragStart = {
      x: Math.max(0, Math.min(bounds.width, (event as PointerEvent).clientX - bounds.left)),
      y: Math.max(0, Math.min(bounds.height, (event as PointerEvent).clientY - bounds.top)),
    };
    selection = { ...dragStart, width: 0, height: 0 };
    activeSurface.setPointerCapture((event as PointerEvent).pointerId);
    showSelection();
  });
  pagesContainer.addEventListener("pointermove", (event) => {
    if (!dragStart || !activeSurface) return;
    const bounds = activeSurface.getBoundingClientRect();
    const x = Math.max(0, Math.min(bounds.width, (event as PointerEvent).clientX - bounds.left));
    const y = Math.max(0, Math.min(bounds.height, (event as PointerEvent).clientY - bounds.top));
    selection = {
      x: Math.min(dragStart.x, x),
      y: Math.min(dragStart.y, y),
      width: Math.abs(x - dragStart.x),
      height: Math.abs(y - dragStart.y),
    };
    showSelection();
  });
  const finishSelection = () => {
    if (!extractionMode || !dragStart) return;
    dragStart = null;
    if (selection && (selection.width < 12 || selection.height < 12))
      selection = null;
    showSelection();
    if (selection) void insertCapture();
    else statusLabel.textContent = 'Select a larger area.';
  };
  pagesContainer.addEventListener("pointerup", finishSelection);
  pagesContainer.addEventListener("pointercancel", clearSelection);
  const insertCapture = async () => {
    const activeEditor = typeof editor === "function" ? editor() : editor;
    const activePreview = typeof preview === "function" ? preview() : preview;
    if (
      !captureIsAvailable() ||
      !activeEditor ||
      !saveNote ||
      insertingCapture ||
      !selection ||
      !activeImage ||
      !activeSurface
    )
      return;
    const surfaceWidth = activeSurface.clientWidth;
    const surfaceHeight = activeSurface.clientHeight;
    if (!surfaceWidth || !surfaceHeight) return;
    const captureRequest = {
      page: Number(activeSurface.dataset.page),
      x: selection.x / surfaceWidth,
      y: selection.y / surfaceHeight,
      width: selection.width / surfaceWidth,
      height: selection.height / surfaceHeight,
    };
    insertingCapture = true;
    (extractButton as HTMLButtonElement).disabled = true;
    statusLabel.textContent =
      "Saving and cropping the excerpt…";
    try {
      const rememberedRange = getNoteRange?.();
      const position = Math.max(
        0,
        Math.min(
          activeEditor.value.length,
          rememberedRange?.sourceEnd ??
            rememberedRange?.end ??
            activeEditor.selectionStart,
        ),
      );
      // Endish the pending draft first so it cannot overwrite the atomic capture insertion afterward.
      await flushReaderAutosave();
      const savedNote = await saveNote(false);
      if (!savedNote) throw new Error("Open a note beside the PDF first");
      const form = new FormData();
      form.append("page", String(captureRequest.page));
      form.append("note_id", String((savedNote as Note).id));
      form.append("cursor", String(position));
      form.append("x", String(captureRequest.x));
      form.append("y", String(captureRequest.y));
      form.append("width", String(captureRequest.width));
      form.append("height", String(captureRequest.height));
      const capture = await api(options.cropEndpoint || `/papers/${paper.id}/crops`, {
        method: "POST",
        body: form,
      });
        const parser = new DOMParser();
        const imageUrl = parser.parseFromString(renderMarkdown(capture.markdown || ''), 'text/html').querySelector('img')?.getAttribute('src');
        const images = parser.parseFromString(renderMarkdown(capture.content || ''), 'text/html').querySelectorAll('img');
        if (!imageUrl || ![...images].some(image => image.getAttribute('src') === imageUrl))
          throw new Error("The server could not add the image to the document");
      activeEditor.value = capture.content;
      activeEditor.setSelectionRange(capture.insertion_end, capture.insertion_end);
      activeEditor.dispatchEvent(new Event("select", { bubbles: true }));
      const cached = state.notes.find((item) => item.id === (savedNote as Note).id);
      if (cached) Object.assign(cached, capture.note);
      if (activePreview?.classList.contains("markdown-block-editor")) {
        const focusIndex = capture.content
          .slice(0, capture.insertion_end)
          .split("\n").length - 1;
        setMarkdownBlockEditorContent(
          activePreview,
          activeEditor,
          capture.content,
          noteAssetBase(capture.note || savedNote),
          focusIndex,
        );
        currentMarkdownBlockInput(activePreview)?.setSelectionRange(capture.insertion_end, capture.insertion_end);
      } else if (activePreview) {
        activePreview.innerHTML = renderMarkdown(
          capture.content,
          noteAssetBase(capture.note || savedNote),
        );
      }
      refreshWorkspaceTreeOnly().catch(() => {});
      setExtractionMode(false);
      statusLabel.textContent =
        'Capture added to the note and resources.';
      toast('Capture added to the note and resources');
    } catch (error) {
      statusLabel.textContent = "The capture could not be inserted.";
      toast(error.message, "error");
    } finally {
      insertingCapture = false;
      (extractButton as HTMLButtonElement).disabled = !captureIsAvailable();
    }
  };
  let loadingTask: ReturnType<typeof import('pdfjs-dist').getDocument> | undefined;
  loadPdfEngine().then(pdfjsLib => {
    if (disposed) return;
    loadingTask = pdfjsLib.getDocument({ url: options.fileUrl || `/api/papers/${paper.id}/file` });
    return loadingTask.promise;
  })
    .then((pdf) => {
      if (disposed || !pdf) return;
      totalPages = pdf.numPages;
      totalLabel.textContent = String(totalPages);
      (pageInput as HTMLInputElement).max = String(totalPages);
      pagesContainer.innerHTML = Array.from(
        { length: totalPages },
        (_, index) => {
          const page = index + 1;
          return `<section class="pdf-page-wrap" data-pdf-page="${page}" aria-label="Page ${page}"><span class="pdf-page-number">${page}</span><div class="pdf-page-surface loading" data-page="${page}"><img class="pdf-page-image" data-page="${page}" alt="PDF page ${page}" draggable="false"><div class="pdf-selection hidden"><i class="nw"></i><i class="ne"></i><i class="sw"></i><i class="se"></i></div></div></section>`;
        },
      ).join("");
      pageElements = [...pagesContainer.querySelectorAll<HTMLElement>('[data-pdf-page]')];
      const rendered = new Set<number>();
      const nearby = new Set<number>();
      const pending = new Set<number>();
      const rendering = new Set<number>();
      const releasePage = (pageNumber: number) => {
        const surface = pageElements[pageNumber - 1].querySelector<HTMLElement>('.pdf-page-surface');
        surface.querySelector('img').removeAttribute('src');
        surface.classList.add('loading');
        annotations.releasePage(surface);
        rendered.delete(pageNumber);
      };
      const drain = () => {
        if (disposed) return;
        while (rendering.size < 2 && pending.size) {
          const pageNumber = [...pending].sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage))[0];
          pending.delete(pageNumber);
          if (!nearby.has(pageNumber) || rendered.has(pageNumber)) continue;
          rendering.add(pageNumber);
          void renderPage(pageNumber).finally(() => {
            rendering.delete(pageNumber);
            if (!disposed && !nearby.has(pageNumber)) releasePage(pageNumber);
            drain();
          });
        }
      };
      const renderPage = async (pageNumber: number) => {
        if (rendered.has(pageNumber) || !workspace.isConnected) return;
        rendered.add(pageNumber);
        const image = pagesContainer.querySelector(`.pdf-page-image[data-page="${pageNumber}"]`) as HTMLImageElement | null;
        const surface = image?.closest(".pdf-page-surface") as HTMLElement | null;
        if (!image || !surface) return;
        surface.classList.remove('error');
        let pageUrl: string | undefined;
        const canvas = document.createElement("canvas");
        try {
          const page = await pdf.getPage(pageNumber);
          if (disposed) return;
          const viewport = page.getViewport({ scale: 1.55 });
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("Canvas rendering is unavailable");
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          if (disposed) return;
          surface.dataset.ratio = String(viewport.height / viewport.width);
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
          if (!blob) throw new Error("PDF page conversion failed");
          if (disposed) return;
          const objectUrl = URL.createObjectURL(blob);
          pageUrl = objectUrl;
          objectUrls.add(objectUrl);
          image.src = objectUrl;
          await image.decode();
          if (disposed) return;
          await annotations.renderText(page, surface, viewport);
          page.cleanup();
        } catch (error) {
          if (disposed) return;
          rendered.delete(pageNumber);
          annotations.releasePage(surface);
          surface.classList.remove("loading");
          surface.classList.add("error");
          statusLabel.textContent = `Page ${pageNumber} could not be rendered.`;
        } finally {
          canvas.width = canvas.height = 0;
          if (pageUrl) { URL.revokeObjectURL(pageUrl); objectUrls.delete(pageUrl); }
        }
      };
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.pdfPage);
          if (entry.isIntersecting) { nearby.add(pageNumber); pending.add(pageNumber); }
          else { nearby.delete(pageNumber); pending.delete(pageNumber); }
        }
        for (const pageNumber of rendered) {
          if (!nearby.has(pageNumber) && !rendering.has(pageNumber)) releasePage(pageNumber);
        }
        drain();
      }, { root: stage, rootMargin: "700px 0px" });
      pageObserver = observer;
      pagesContainer.querySelectorAll("[data-pdf-page]").forEach((page) => observer.observe(page));
      fitWidth = Math.max(280, stage.clientWidth - 48);
      applyZoom();
      currentPage = Math.min(currentPage, totalPages);
      updatePageControls();
      setExtractionMode(false);
      requestAnimationFrame(() => goToPage(currentPage));
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          const nextWidth = Math.max(280, stage.clientWidth - 48);
          if (nextWidth !== fitWidth) { fitWidth = nextWidth; applyZoom(); }
        });
        resizeObserver.observe(stage);
      }
    })
    .catch((error) => {
      if (disposed) return;
      statusLabel.textContent = "The local reader could not open this PDF.";
      toast(error.message, "error");
    });
  return () => {
    disposed = true;
    clearTimeout(progressTimer);
    rememberProgress();
    annotations.dispose();
    pageObserver?.disconnect(); resizeObserver?.disconnect();
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls.clear();
    void loadingTask?.destroy().catch(() => {});
  };
}

export function pdfCaptureWorkspaceMarkup(paperId, captureEnabled = true, fileUrl = `/api/papers/${paperId}/file`) {
  const button = (id, icon, label) => `<button type="button" id="${id}" aria-label="${label}" title="${label}">${pdfIcon(icon)}</button>`;
  return `<div class="pdf-capture-workspace document-pdf-capture ${captureEnabled ? '' : 'viewer-only'}" id="pdf-capture-workspace" data-document-pdf-capture="${paperId}" data-pdf-file-url="${escapeHtml(fileUrl)}"><div class="pdf-capture-toolbar" role="toolbar" aria-label="PDF tools"><div class="pdf-tool-group">${button('capture-prev', 'previous', 'Previous page')}<label><input id="capture-page" aria-label="Page" type="number" min="1" value="1"><span>/ <b id="capture-total">…</b></span></label>${button('capture-next', 'next', 'Page next')}</div><div class="pdf-tool-group pdf-zoom-tools">${button('pdf-zoom-out', 'minus', 'Zoom out')}<span id="pdf-zoom-label">100 %</span>${button('pdf-zoom-in', 'plus', 'Zoom in')}${button('pdf-fit-width', 'fit', 'Fit to width')}</div><button type="button" class="pdf-extract-toggle ${captureEnabled ? '' : 'hidden'}" id="pdf-extract-toggle" aria-label="Capture an area" title="Capture an area" aria-pressed="false">${pdfIcon('capture')}</button><a class="pdf-external-link" href="${escapeHtml(fileUrl)}" target="_blank" aria-label="Open the original PDF" title="Open the original PDF">${pdfIcon('external')}</a></div><div class="pdf-capture-stage" id="pdf-capture-stage"><div class="pdf-pages" id="pdf-pages" aria-label="PDF document pages"></div></div><div class="pdf-capture-footer"><span id="capture-status" role="status">Preparing the document…</span></div></div>`;
}
function workspacePdfCaptureTarget(captureRoot, root: Document | HTMLElement = document) {
  const workspace = captureRoot.closest(".notes-main-workspace") || root;
  const notePane = workspace.querySelector(
    ".secondary-note-pane, [data-primary-note-id]",
  );
  const noteId = Number(
    notePane?.dataset.secondaryNoteId || notePane?.dataset.primaryNoteId || 0,
  );
  const note = state.notes.find((item) => item.id === noteId);
  const editor = notePane?.querySelector(".note-content");
  const blockEditor = notePane?.querySelector(".markdown-block-editor");
  return note && editor && blockEditor
    ? { note, editor, blockEditor, secondary: notePane.matches(".secondary-note-pane") }
    : null;
}

export function bindWorkspacePdfExtractors(root) {
  root?.querySelectorAll("[data-document-pdf-capture]").forEach((captureRoot) => {
    const refreshAvailability = () => {
      const available = Boolean(workspacePdfCaptureTarget(captureRoot, root));
      const toggle = captureRoot.querySelector("#pdf-extract-toggle");
      const status = captureRoot.querySelector("#capture-status");
      if (toggle) toggle.disabled = !available;
      if (!available && status)
        status.textContent = "Open a note in an adjacent pane to capture an area.";
    };
    if (captureRoot.closest('[data-workspace-bound="true"]')) {
      refreshAvailability();
      return;
    }
    const paperId = Number(captureRoot.dataset.documentPdfCapture);
    const captureTarget = () => workspacePdfCaptureTarget(captureRoot, root);
    const initialTarget = captureTarget();
    const saveNote = async () => {
      const target = captureTarget();
      if (!target) return null;
      if (target.secondary) await flushSecondaryNoteAutosave();
      else await flushCurrentNoteAutosave();
      return state.notes.find((item) => item.id === target.note.id) || target.note;
    };
    const getRange = () => {
      const target = captureTarget();
      if (!target) return { end: 0, sourceEnd: 0 };
      const input = currentMarkdownBlockInput(target.blockEditor);
      return {
        end: input?.selectionEnd || 0,
        sourceEnd: markdownBlockSourceOffset(target.blockEditor, input),
      };
    };
    const dispose = bindPdfCapture(
      { id: paperId },
      () => captureTarget()?.editor,
      () => captureTarget()?.blockEditor,
      noteAssetBase(initialTarget?.note),
      saveNote,
      getRange,
      captureRoot,
      () => Boolean(captureTarget()),
      {},
    );
    const removalObserver = new MutationObserver(() => {
      if (!captureRoot.isConnected) { dispose?.(); removalObserver.disconnect(); }
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
    refreshAvailability();
  });
}

function customMetadataRow(key = "", value = "") {
  return `<div class="custom-metadata-row"><input data-meta-key value="${escapeHtml(key)}" placeholder="Name, e.g. population"><input data-meta-value value="${escapeHtml(value)}" placeholder="Value, e.g. adults"><button type="button" data-remove-metadata title="Remove">×</button></div>`;
}

export async function editPaperMetadataModal(paperId) {
  try {
    const paper = await api(`/papers/${paperId}`);
    const entries = Object.entries(paperCustomMetadata(paper));
    openModal(
      `<header class="modal-header"><h2>Tags and metadata</h2><p>${escapeHtml(paper.title)}</p></header><div class="modal-body"><form id="paper-metadata-form" class="form-grid"><div class="form-field full"><label>Tags</label><input name="tags" value="${escapeHtml((paper.tags || []).join(", "))}" placeholder="methodology, benchmark, to cite"><small>Separate tags with commas.</small></div><div class="form-field full"><div class="field-heading"><label>Custom metadata</label><button type="button" class="text-link" id="add-custom-metadata">＋ Add field</button></div><div class="custom-metadata-list" id="custom-metadata-list">${(entries.length ? entries : [["", ""] as [string, string]]).map(([key, value]) => customMetadataRow(key, String(value ?? ""))).join("")}</div><small>These local fields complement bibliographic data and remain searchable in the Library.</small></div><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">Save</button></div></form></div>`,
      true,
    );
    const list = document.querySelector("#custom-metadata-list");
    document
      .querySelector("#add-custom-metadata")
      .addEventListener("click", () =>
        list.insertAdjacentHTML("beforeend", customMetadataRow()),
      );
    list.addEventListener("click", (event) => {
      const remove = (event.target as HTMLElement).closest("[data-remove-metadata]");
      if (!remove) return;
      remove.closest(".custom-metadata-row")?.remove();
      if (!list.children.length)
        list.insertAdjacentHTML("beforeend", customMetadataRow());
    });
    document
      .querySelector("#paper-metadata-form")
      .addEventListener("submit", async (event) => {
        event.preventDefault();
        const tags = String(new FormData(event.target as HTMLFormElement).get("tags") || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        const custom = {};
        for (const row of list.querySelectorAll(".custom-metadata-row")) {
          const key = (row.querySelector("[data-meta-key]") as HTMLInputElement).value.trim();
          const value = (row.querySelector("[data-meta-value]") as HTMLInputElement).value.trim();
          if (!key && !value) continue;
          if (!key)
            return toast("Every metadata field must have a name", "error");
          if (Object.hasOwn(custom, key))
            return toast(`Metadata “${key}” is duplicated`, "error");
          custom[key] = value;
        }
        const metadata = { ...(paper.metadata || {}), customFields: custom };
        try {
          await api(`/papers/${paper.id}`, {
            method: "PATCH",
            body: JSON.stringify({ tags: [...new Set(tags)], metadata }),
          });
          closeModal();
          await refreshData();
          renderPapers();
          toast("Tags and metadata saved");
        } catch (error) {
          toast(error.message, "error");
        }
      });
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function savePaperProjects(source) {
  const paperId = Number(source?.dataset.paperId || 0);
  const selector = source?.closest(".paper-project-selector");
  if (!paperId || !selector) return;
  const projectIds = [
    ...selector.querySelectorAll('input[type="checkbox"]:checked'),
  ].map((input) => Number(input.value));
  try {
    await api(`/papers/${paperId}/projects`, {
      method: "PUT",
      body: JSON.stringify({ project_ids: projectIds }),
    });
    await refreshData();
    renderPapers();
    toast("Related projects updated");
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function editPaperModal(paperId) {
  const paper = await api(`/papers/${paperId}`);
  openModal(
    `<header class="modal-header"><h2>Edit article</h2><p>Update bibliographic information and local filing.</p></header><div class="modal-body"><form id="paper-edit-form" class="form-grid"><div class="form-field full"><label>Title</label><input name="title" required value="${escapeHtml(paper.title)}"></div><div class="form-field full"><label>Authors</label><input name="authors" value="${escapeHtml((paper.authors || []).join(", "))}"></div><div class="form-field"><label>Publication</label><input name="publication" value="${escapeHtml(paper.publication || "")}"></div><div class="form-field"><label>Date</label><input name="published_at" value="${escapeHtml(paper.published_at || "")}"></div><div class="form-field"><label>DOI</label><input name="doi" value="${escapeHtml(paper.doi || "")}"></div><div class="form-field"><label>URL</label><input name="url" type="url" value="${escapeHtml(paper.url || "")}"></div><div class="form-field"><label>Reading status</label><select name="status">${["to_read", "reading", "read", "key"].map((status) => `<option value="${status}" ${paper.status === status ? "selected" : ""}>${labels[status]}</option>`).join("")}</select></div><div class="form-field"><label>Folder</label><select name="folder_id"><option value="">Unfiled</option>${paperFolderOptions(paper.folder_id)}</select></div><div class="form-field full"><label>Tags</label><input name="tags" value="${escapeHtml((paper.tags || []).join(", "))}"></div><div class="form-field full"><label>Abstract</label><textarea name="abstract">${escapeHtml(paper.abstract || "")}</textarea></div><div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button class="button button-primary">Save</button></div></form></div>`,
    true,
  );
  document
    .querySelector("#paper-edit-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const data: Record<string, any> = Object.fromEntries(new FormData((event.target as HTMLFormElement)));
      data.authors = data.authors
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      data.tags = data.tags
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      data.folder_id = data.folder_id ? Number(data.folder_id) : null;
      if (!data.url) data.url = null;
      try {
        await api(`/papers/${paper.id}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        });
        closeModal();
        await refreshData();
        toast("Article updated");
        renderPapers();
      } catch (error) {
        toast(error.message, "error");
      }
    });
}

export // Articles open in the shared Documents workspace. This final declaration
// replaces the former dedicated reader while its PDF capture helpers remain
// available for already-created content.
function paperPdfWorkspaceNode(paperId, nodes = state.workspaceTree) {
  for (const node of nodes || []) {
    if (Number(node.paper_id) === Number(paperId) && node.kind === "pdf")
      return node;
    const child = paperPdfWorkspaceNode(paperId, node.children || []);
    if (child) return child;
  }
  return null;
}

export function paperPdfUploadModal(paperId) {
  const paper = state.papers.find((item) => item.id === Number(paperId));
  if (!paper) return toast("Article not found", "error");
  const attachLabel = paper.file_path ? "Replace PDF" : "Attach PDF";
  openModal(
    `<header class="modal-header"><h2>${paper.file_path ? "Replace PDF" : "Add PDF"}</h2><p>${escapeHtml(paper.title)}</p></header><div class="modal-body"><form id="paper-pdf-form" class="form-grid">
      <div class="form-field full"><label for="paper-pdf-file">PDF document</label><input id="paper-pdf-file" name="file" type="file" accept="application/pdf,.pdf" required><small>The PDF will be stored in this article’s local folder.</small></div>
      <p class="form-field full integration-error" data-pdf-error role="alert" hidden></p>
      <div class="form-actions"><button type="button" class="button" data-close-modal>Cancel</button><button type="submit" class="button button-primary">${attachLabel}</button></div>
    </form></div>`,
  );
  const form = document.querySelector<HTMLFormElement>("#paper-pdf-form");
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]');
  const errorMessage = form.querySelector<HTMLElement>('[data-pdf-error]');
  let busy = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true; errorMessage.hidden = true; submit.disabled = true;
    submit.textContent = 'Attaching PDF…';
    try {
      await api(`/papers/${paper.id}/file`, { method: "POST", body: new FormData(form) });
      // A user may have closed this dialog while the upload was running.
      if (form.isConnected) closeModal();
      await refreshData();
      if (viewShown("papers")) renderPapers();
      toast("PDF attached to article");
    } catch (error) {
      if (form.isConnected) { errorMessage.textContent = error.message; errorMessage.hidden = false; }
      else toast(error.message, "error");
    } finally {
      busy = false; submit.disabled = false; submit.textContent = attachLabel;
    }
  });
}

function paperPdfWorkspaceResource(paper, node = paperPdfWorkspaceNode(paper.id)) {
  return {
    type: "pdf",
    path: node?.path || `paper:${paper.id}:pdf`,
    title: paper.title,
    url: node?.url || `/api/papers/${paper.id}/file`,
    paperId: Number(paper.id),
  };
}

export function previewPaperPdfModal(paperId, projectId = null) {
  const paper = state.papers.find((item) => item.id === Number(paperId));
  if (!paper) return toast("Article not found", "error");
  openModal(
    `<header class="modal-header"><h2>${escapeHtml(paper.title)}</h2><p>${escapeHtml((paper.authors || []).join(", ") || "Local PDF")}</p></header><div class="paper-pdf-preview">${pdfCaptureWorkspaceMarkup(paper.id, false)}</div><footer class="paper-pdf-preview-actions"><button class="button" data-close-modal>Close</button><button class="button button-primary" data-action="open-paper-modal-note" data-paper-id="${paper.id}" data-project-id="${Number(projectId) || ""}">Read in workspace</button></footer>`,
    true,
  );
  modal.classList.add("modal-pdf-preview");
  editorSession.modalCleanup = bindPdfCapture({ id: paper.id }, null, null, "", null, null, modalContent as HTMLElement, false);
  modalContent.querySelector<HTMLElement>("[data-action='open-paper-modal-note']")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void closeModal().then(() => openPaper(paper.id, projectId)).catch((error) => toast(error.message, "error"));
  });
}

const readingNoteLoads = new Map<number, Promise<any>>();
export async function openPaperPdfExternally(paperId: number) {
  try {
    const paper = await api<Paper>(`/papers/${paperId}`);
    if (!paper.file_path) return toast('No PDF is attached to this article yet', 'error');
    const open = window.pywebview?.api?.open_project_resource;
    if (open) {
      if (!await open(paper.file_path)) throw new Error('Unable to open the PDF in the system reader');
      return;
    }
    const response = await fetch(`/api/papers/${paperId}/file`);
    if (!response.ok) throw new Error('Unable to download the article PDF');
    const downloadUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = 'paper.pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
    toast('PDF downloaded: open it with your PDF reader');
  } catch (error) { toast(error.message, 'error'); }
}

export function loadReadingNote(paper) {
  const current = readingNoteLoads.get(paper.id);
  if (current) return current;
  const pending = api(`/notes?paper_id=${paper.id}`).then(notes => notes[0] || api('/notes', {
    method: 'POST', body: JSON.stringify({ paper_id: paper.id, title: `Notes — ${paper.title}`, content: `# ${paper.title}\n\n## Notes\n\n` }),
  }));
  readingNoteLoads.set(paper.id, pending);
  const cleanup = () => { if (readingNoteLoads.get(paper.id) === pending) readingNoteLoads.delete(paper.id); };
  pending.then(cleanup, cleanup);
  return pending;
}


export async function openPaper(paperId, projectId = null, { withNote = true } = {}) {
  await flushReaderAutosave();
  const [paper, paperNotes] = await Promise.all([
    api(`/papers/${paperId}`),
    api(`/notes?paper_id=${paperId}`),
  ]);
  if (withNote && !paperNotes.length) {
    await api("/notes", {
      method: "POST",
      body: JSON.stringify({
        paper_id: Number(paperId),
        title: `Notes — ${paper.title}`,
        content: `# ${paper.title}\n\n## Notes\n\n`,
      }),
    });
  }
  await refreshData();
  const note = state.notes.find(
    (item) => Number(item.paper_id) === Number(paperId),
  );
  const pdfNode = paperPdfWorkspaceNode(paperId);
  if (!pdfNode && !paper.file_path)
    return toast("No PDF is available for this article", "error");
  state.view = "notes";
  state.selectedPaperId = Number(paperId);
  state.paperProjectContext = Number(projectId) || null;
  state.selectedProject = null;
  const pane =
    state.activeNotePane === "secondary" && state.workspaceTabs.secondary.length
      ? "secondary"
      : "primary";
  if (pane === "primary") {
    state.noteScope = `paper:${paperId}`;
    state.noteFolderId = "all";
    state.currentNoteId = null;
  }
  const pdfResource = paperPdfWorkspaceResource(paper, pdfNode);
  if (withNote && note)
    replaceActiveWorkspaceTabPair(pane, workspaceResourceTab(pdfResource), pane === "primary" ? "secondary" : "primary", workspaceNoteTab(note));
  else replaceActiveWorkspaceTab(pane, workspaceResourceTab(pdfResource));
  state.activeNotePane = pane;
  main.classList.remove("reader-mode", "tasks-mode", "calendar-mode");
  setActiveNavigation("notes");
  renderNotes();
  (main as HTMLElement).focus();
}

function normalizedPaperDoi(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi\s*:\s*/i, "");
}

export async function paperReferencesModal(paperId) {
  const paper = state.papers.find(item => item.id === Number(paperId));
  if (!paper) return toast("Article not found", "error");
  openModal(`<header class="modal-header"><h2>References</h2><p>${escapeHtml(paper.title)}</p></header><div class="modal-body library-reference-list" data-reference-list><p role="status">Loading references…</p></div><footer class="form-actions"><button class="button" data-close-modal>Close</button></footer>`, true);
  const content = modalContent.querySelector("[data-reference-list]");
  try {
    const references = await api(`/papers/${paper.id}/references`);
    if (!content.isConnected) return;
    content.innerHTML = references.length ? `<p>${references.length} reference(s)</p><div class="library-reference-table"><table><thead><tr><th>#</th><th>Reference</th><th>Library</th></tr></thead><tbody>${references.map(reference => {
      const matched = state.papers.find(item => item.id === Number(reference.matched_paper_id) || (normalizedPaperDoi(reference.doi) && normalizedPaperDoi(item.doi) === normalizedPaperDoi(reference.doi)));
      const authors = Array.isArray(reference.authors) ? reference.authors.join(", ") : reference.authors || "";
      const doi = normalizedPaperDoi(reference.doi);
      return `<tr><td>${escapeHtml(String(reference.position || ""))}</td><td><strong>${escapeHtml(reference.title || reference.raw_text || "Untitled reference")}</strong><p>${escapeHtml([authors, reference.year].filter(Boolean).join(" · "))}</p>${reference.raw_text && reference.title ? `<p>${escapeHtml(reference.raw_text)}</p>` : ""}${doi ? `<a href="https://doi.org/${escapeHtml(encodeURIComponent(doi))}" target="_blank" rel="noopener noreferrer">${escapeHtml(doi)} ↗</a>` : ""}</td><td>${matched ? `In library${matched.file_path ? `<br><button class="button button-small" data-action="open-paper-pdf" data-paper-id="${matched.id}">Read article</button>` : ""}` : "Outside library"}</td></tr>`;
    }).join("")}</tbody></table></div>` : `<p>No references extracted for this article.</p>`;
  } catch (error) {
    if (content.isConnected) content.innerHTML = `<p role="alert">${escapeHtml(error.message)}</p><button class="button" data-action="paper-references" data-paper-id="${paper.id}">Retry</button>`;
  }
}
