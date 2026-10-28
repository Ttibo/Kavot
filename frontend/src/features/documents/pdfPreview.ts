import { loadPdfEngine } from './pdfEngine';
const previews = new Map<string, Promise<string>>();

function firstPage(url: string) {
  if (!previews.has(url)) {
    const pending = (async () => {
      const { getDocument } = await loadPdfEngine();
      const task = getDocument({ url });
      try {
        const pdf = await task.promise;
        const page = await pdf.getPage(1);
        const original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 900 / original.width) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        return canvas.toDataURL('image/png');
      } finally { await task.destroy(); }
    })();
    previews.set(url, pending);
    pending.catch(() => previews.delete(url));
    if (previews.size > 40) previews.delete(previews.keys().next().value);
  }
  return previews.get(url);
}

export function renderPdfPreviews(root: Element) {
  root.querySelectorAll<HTMLElement>('[data-canvas-pdf-preview]').forEach(host => {
    const url = host.dataset.canvasPdfPreview;
    if (!url) return;
    void firstPage(url).then(source => {
      if (!host.isConnected) return;
      const image = document.createElement('img');
      image.src = source;
      image.alt = host.getAttribute('aria-label') || 'PDF preview';
      image.draggable = false;
      host.replaceChildren(image);
      host.dataset.previewReady = 'true';
    }).catch(() => {
      if (host.isConnected) host.textContent = 'PDF preview unavailable.';
    });
  });
}
