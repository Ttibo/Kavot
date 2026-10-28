import type { TextLayer } from 'pdfjs-dist';
import { loadPdfEngine } from './pdfEngine';
import { api } from '../../services/api';
import './pdfAnnotations.css';
import { pdfIcon } from './pdfIcons';
import { precisePdfSelection, selectedPdfTextRects } from './pdfTextSelection';

type Rectangle = { x: number; y: number; width: number; height: number };
type Annotation = { id: string; page: number; kind: 'highlight' | 'underline' | 'sticky'; color: string; rects: Rectangle[]; text: string };
const colors = { yellow: '#facc15', green: '#4ade80', pink: '#f472b6', blue: '#60a5fa' };

export function bindPdfAnnotations(workspace: HTMLElement, paperId: number, cancelCapture: () => void, endpoint = `/papers/${paperId}/annotations`) {
  const toolbar = document.createElement('div');
  toolbar.className = 'pdf-annotation-toolbar';
  toolbar.setAttribute('aria-label', 'Annotations PDF');
  toolbar.innerHTML = (['read', 'highlight', 'underline', 'sticky'] as const).map((tool, i) => `<button type="button" data-pdf-tool="${tool}" aria-label="${['Select', 'Highlight', 'Underline', 'Sticky note'][i]}" title="${['Select', 'Highlight', 'Underline', 'Sticky note'][i]}" aria-pressed="${i === 0}">${pdfIcon(tool)}</button>`).join('') + `<label class="pdf-color-picker" title="Couleur des annotations"><span aria-hidden="true"></span><select aria-label="Couleur des annotations">${Object.keys(colors).map((color, i) => `<option value="${color}">${['Jaune', 'Vert', 'Rose', 'Bleu'][i]}</option>`).join('')}</select></label>`;
  workspace.querySelector('#pdf-extract-toggle').before(toolbar);
  const status = workspace.querySelector<HTMLElement>('#capture-status');
  toolbar.querySelector('select').addEventListener('change', () => toolbar.style.setProperty('--annotation-swatch', colors[toolbar.querySelector('select').value]));
  const panel = document.createElement('div');
  panel.className = 'pdf-annotation-panel';
  panel.hidden = true;
  panel.innerHTML = '<label>Commentaire<textarea maxlength="20000" aria-label="Texte du post-it"></textarea></label><button type="button" data-save>Save</button><button type="button" data-delete>Delete</button><button type="button" data-close>Close</button>';
  workspace.querySelector('.pdf-capture-toolbar').after(panel);
  let annotations: Annotation[] = [];
  let mode = 'read';
  let ready = false;
  let disposed = false;
  let editing: Annotation | null = null;
  const pages = workspace.querySelector<HTMLElement>('#pdf-pages');
  const selectionTracker = precisePdfSelection(pages, () => ready && !workspace.classList.contains('extract-mode') && (mode === 'highlight' || mode === 'underline'));
  const layers: { layer: TextLayer; host: HTMLElement; width: number }[] = [];
  const setMode = (next: string) => {
    selectionTracker.clear();
    mode = next;
    workspace.dataset.annotationTool = next;
    toolbar.querySelectorAll<HTMLElement>('[data-pdf-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.pdfTool === next)));
  };
  const showEditor = (annotation: Annotation) => {
    editing = structuredClone(annotation);
    panel.hidden = false;
    panel.querySelector('label').hidden = annotation.kind !== 'sticky';
    panel.querySelector<HTMLButtonElement>('[data-save]').hidden = annotation.kind !== 'sticky';
    panel.querySelector<HTMLTextAreaElement>('textarea').value = annotation.text;
    panel.querySelector<HTMLButtonElement>('[data-delete]').hidden = !annotations.some(a => a.id === annotation.id);
    if (annotation.kind === 'sticky') panel.querySelector('textarea').focus();
  };
  const draw = (onlySurface?: HTMLElement) => {
    (onlySurface || workspace).querySelectorAll('.pdf-annotation-mark').forEach(element => element.remove());
    for (const annotation of annotations) {
      if (onlySurface && Number(onlySurface.dataset.page) !== annotation.page) continue;
      const surface = workspace.querySelector<HTMLElement>(`.pdf-page-surface[data-page="${annotation.page}"]`);
      if (!surface || !surface.querySelector('.pdf-selectable-text')) continue;
      for (const rect of annotation.rects) {
        const mark = document.createElement('button');
        mark.type = 'button';
        mark.className = `pdf-annotation-mark ${annotation.kind}`;
        mark.title = annotation.text || (annotation.kind === 'highlight' ? 'Highlight' : 'Soulignement');
        mark.setAttribute('aria-label', `${mark.title} — edit or delete`);
        Object.assign(mark.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });
        mark.style.setProperty('--annotation-color', colors[annotation.color]);
        if (annotation.kind === 'sticky') mark.textContent = '▤';
        mark.addEventListener('click', event => { event.stopPropagation(); showEditor(annotation); });
        surface.append(mark);
      }
    }
  };
  const save = async (annotation: Annotation) => {
    status.textContent = 'Saving…';
    try {
      const saved = await api(`${endpoint}/${annotation.id}`, { method: 'PUT', body: JSON.stringify(annotation) });
      if (disposed) return;
      annotations = [...annotations.filter(a => a.id !== saved.id), saved];
      draw(); status.textContent = 'Annotation saved';
      panel.hidden = true;
    } catch (error) { status.textContent = `Save failed: ${error.message}`; }
  };
  panel.querySelector('[data-close]').addEventListener('click', () => { panel.hidden = true; });
  panel.querySelector('[data-save]').addEventListener('click', async () => {
    if (!editing) return;
    const button = panel.querySelector<HTMLButtonElement>('[data-save]');
    button.disabled = true;
    await save({ ...editing, text: panel.querySelector('textarea').value });
    button.disabled = false;
  });
  panel.querySelector('[data-delete]').addEventListener('click', async () => {
    if (!editing) return;
    const id = editing.id;
    try {
      await api(`${endpoint}/${id}`, { method: 'DELETE' });
      annotations = annotations.filter(a => a.id !== id); draw(); panel.hidden = true; status.textContent = 'Annotation deleted';
    } catch (error) { status.textContent = `Unable to delete: ${error.message}`; }
  });
  toolbar.querySelectorAll<HTMLElement>('[data-pdf-tool]').forEach(button => button.addEventListener('click', () => {
    if (!ready) return;
    cancelCapture(); setMode(button.dataset.pdfTool);
    status.textContent = mode === 'sticky' ? 'Click the page to place a sticky note.' : mode === 'read' ? 'Select text or click an annotation.' : 'Select the text to annotate.';
  }));
  workspace.querySelector('#pdf-extract-toggle').addEventListener('click', () => setMode('read'));
  workspace.querySelector('#pdf-pages').addEventListener('pointerup', event => {
    if (!ready || workspace.classList.contains('extract-mode') || (event as PointerEvent).button !== 0) return;
    if ((event.target as HTMLElement).closest('.pdf-annotation-mark')) return;
    const color = toolbar.querySelector('select').value;
    const surface = (event.target as HTMLElement).closest<HTMLElement>('.pdf-page-surface');
    if (mode === 'sticky' && surface && !surface.classList.contains('loading')) {
      const bounds = surface.getBoundingClientRect();
      showEditor({ id: crypto.randomUUID(), page: Number(surface.dataset.page), kind: 'sticky', color, text: '', rects: [{ x: Math.max(0, Math.min(.96, ((event as PointerEvent).clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(.96, ((event as PointerEvent).clientY - bounds.top) / bounds.height)), width: .04, height: .04 }] });
      setMode('read');
    } else if (mode === 'highlight' || mode === 'underline') {
      const range = selectionTracker.take();
      if (!range || range.collapsed) return;
      if (!workspace.contains(range.startContainer) || !workspace.contains(range.endContainer)) return;
      const text = range.toString().slice(0, 20000);
      const kind = mode;
      const selectedRects = selectedPdfTextRects(range, pages);
      const changes: Annotation[] = [];
      workspace.querySelectorAll<HTMLElement>('.pdf-page-surface').forEach(page => {
        const bounds = page.getBoundingClientRect();
        const rects = selectedRects.flatMap(rect => {
          const left = Math.max(rect.left, bounds.left), top = Math.max(rect.top, bounds.top);
          const right = Math.min(rect.right, bounds.right), bottom = Math.min(rect.bottom, bounds.bottom);
          if (right - left < 1 || bottom - top < 1) return [];
          return [{ x: (left - bounds.left) / bounds.width, y: (top - bounds.top) / bounds.height, width: (right - left) / bounds.width, height: (bottom - top) / bounds.height }];
        });
        if (rects.length) changes.push({ id: crypto.randomUUID(), page: Number(page.dataset.page), kind, color, rects, text });
      });
      void (async () => { for (const annotation of changes) await save(annotation); })();
    }
  });
  void api(endpoint).then(items => {
    if (disposed) return;
    annotations = items; ready = true; draw(); status.textContent = 'Annotations ready';
  }).catch(error => { status.textContent = `Annotations indisponibles : ${error.message}`; });
  return {
    async renderText(page, surface: HTMLElement, viewport) {
      const { TextLayer } = await loadPdfEngine();
      if (disposed) return;
      const host = document.createElement('div');
      host.className = 'pdf-selectable-text';
      host.style.setProperty('--total-scale-factor', String(viewport.scale));
      surface.append(host);
      const layer = new TextLayer({ textContentSource: await page.getTextContent(), container: host, viewport });
      if (disposed) return;
      layers.push({ layer, host, width: viewport.width });
      await layer.render();
      host.style.transform = `scale(${surface.clientWidth / viewport.width})`;
      draw(surface);
    },
    releasePage(surface: HTMLElement) {
      for (let index = layers.length - 1; index >= 0; index--) {
        if (layers[index].host.parentElement !== surface) continue;
        layers[index].layer.cancel(); layers[index].host.remove(); layers.splice(index, 1);
      }
      surface.querySelectorAll('.pdf-annotation-mark').forEach(mark => mark.remove());
    },
    resize() { layers.forEach(({ host, width }) => { host.style.transform = `scale(${host.parentElement.clientWidth / width})`; }); },
    dispose() { disposed = true; layers.forEach(({ layer }) => layer.cancel()); },
  };
}
