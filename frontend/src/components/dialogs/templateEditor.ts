import { escapeHtml, modal, renderMarkdown, state } from '../../app/state';
import { editorSession } from '../../app/editorSession';
import { refreshData, toast } from '../../app/navigation';
import { api } from '../../services/api';
import { bindMarkdownBlockEditor, currentMarkdownBlockInput, markdownBlockEditorMarkup } from '../../features/documents/markdown';
import { applyMarkdownToEditor, interfaceIcon } from '../../features/documents/workspace';
import { openSettings } from '../../features/settings/actions';
import { openModal, projectOptions } from './controller';
import { getPalette } from '../../app/colors';

const icons = [['note', 'Note'], ['bulb', 'Idea'], ['chart', 'Results'], ['flask', 'Experiment'], ['calendar', 'Calendar'], ['check', 'Decision'], ['question', 'Question'], ['file', 'Document'], ['task', 'Task'], ['database', 'Database'], ['link', 'Link']];

export function templateEditorModal(templateId = null, duplicate = false) {
  const source = state.noteTemplates.find(item => item.id === Number(templateId));
  const template = duplicate && source ? { ...source, id: null, name: `${source.name} (copy)`, auto_create: false, is_article_default: false } : source;
  const editing = Boolean(template?.id);
  openModal(`<header class="modal-header template-studio-header"><span class="template-studio-eyebrow">Reusable cards</span><h2>${editing ? 'Edit template' : 'New template'}</h2><p>Design once. Start a new card with it in any project.</p></header>
    <form id="template-form" class="template-studio-form">
      <div class="template-studio-layout"><section class="template-studio-compose">
        <div class="form-field"><label for="template-name">Template name</label><input id="template-name" name="name" required maxlength="120" value="${escapeHtml(template?.name || '')}" placeholder="e.g. Experiment, Meeting, Reading note"></div>
        <div class="template-studio-appearance"><div class="form-field"><label for="template-icon">Card icon</label><select id="template-icon" name="icon">${icons.map(([value, label]) => `<option value="${value}" ${(template?.icon || 'note') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="form-field"><label for="template-color">Card color</label><div class="template-color-palette">${getPalette().map(color => `<button type="button" data-template-color="${color}" style="--swatch:${color}" aria-label="Use ${color}"></button>`).join('')}<input id="template-color" name="color" type="color" value="${escapeHtml(template?.color || '#087e86')}" aria-label="Card color"></div></div></div>
        <div class="form-field"><label for="template-title">Document title</label><input id="template-title" name="title_template" required maxlength="240" value="${escapeHtml(template?.title_template || '')}" placeholder="e.g. Experiment — {{project_name}}"></div>
        <div class="template-context-chips"><span>Insert into title or content</span>${[['today','Date'],['project_name','Project'],['article_title','Article title'],['article_authors','Authors']].map(([key,label]) => `<button type="button" data-template-field="{{${key}}}">${label} <span>＋</span></button>`).join('')}</div>
        <div class="template-studio-writing"><div class="template-writing-heading"><label for="template-content-source">Starting content</label><div class="markdown-toolbar" aria-label="Template formatting">${[['bold','Bold','B'],['italic','Italic','I'],['heading','Heading','H₂'],['list','Bullet list','≡'],['task','Checklist','☑'],['link','Link','↗']].map(([action,label,text]) => `<button type="button" data-template-md="${action}" aria-label="${label}" title="${label}">${text}</button>`).join('')}</div></div><div class="template-studio-editor">${markdownBlockEditorMarkup(template?.content_template || '', { sourceId:'template-content-source', editorId:'template-content-editor', ariaLabel:'Template Markdown content' })}</div><small>Write headings, prompts or a checklist. Each new card gets its own copy.</small></div>
      </section><aside class="template-studio-preview"><div class="template-preview-heading"><strong>Live preview</strong><span data-template-preview-state>Ready</span></div><article class="template-preview-card"><header><span data-template-preview-icon></span><div><small data-template-preview-name></small><h3 data-template-preview-title>Untitled card</h3></div></header><div id="template-preview-result" class="markdown-preview"></div></article>
        <details class="template-preview-context"><summary>Preview with context</summary><label class="form-field">Project context<select id="template-preview-project"><option value="">Example project</option>${projectOptions()}</select></label><label class="form-field">Article context<select id="template-preview-paper"><option value="">Example article</option>${state.papers.map(paper => `<option value="${paper.id}">${escapeHtml(paper.title)}</option>`).join('')}</select></label><small>Preview only. Each card uses its own project and article.</small></details>
        <details class="template-studio-options" ${template?.is_article_default ? 'open' : ''}><summary>Creation defaults</summary><label><input type="checkbox" name="is_article_default" ${template?.is_article_default ? 'checked' : ''}><span>Use for article notes<small>Replaces the current article note template.</small></span></label></details>
        <p class="template-preservation-hint">Existing card titles and content stay unchanged when you edit this template.</p>
      </aside></div><footer class="template-studio-footer"><span data-template-error role="alert"></span><button type="button" class="button" data-action="manage-templates">Cancel</button><button type="submit" class="button button-primary">${editing ? 'Save' : 'Create template'}</button></footer>
    </form>`, true);
  modal.classList.add('modal-template-studio');
  const form = modal.querySelector<HTMLFormElement>('#template-form')!;
  const editor = form.querySelector<HTMLElement>('#template-content-editor')!;
  const content = form.querySelector<HTMLTextAreaElement>('#template-content-source')!;
  content.name = 'content_template';
  bindMarkdownBlockEditor(editor, content);
  const title = form.elements.namedItem('title_template') as HTMLInputElement;
  const name = form.elements.namedItem('name') as HTMLInputElement;
  const color = form.elements.namedItem('color') as HTMLInputElement;
  const icon = form.elements.namedItem('icon') as HTMLSelectElement;
  let activeField: 'title' | 'content' = 'content';
  form.addEventListener('focusin', event => { if (event.target === title) activeField = 'title'; else if ((event.target as HTMLElement).closest('#template-content-editor')) activeField = 'content'; });
  form.querySelectorAll<HTMLElement>('[data-template-field]').forEach(button => {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      const input = activeField === 'title' ? title : currentMarkdownBlockInput(editor, true);
      input.setRangeText(button.dataset.templateField, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
      input.dispatchEvent(new Event('input', { bubbles:true })); input.focus();
    });
  });
  form.querySelectorAll<HTMLElement>('[data-template-md]').forEach(button => {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => applyMarkdownToEditor(currentMarkdownBlockInput(editor, true), button.dataset.templateMd));
  });
  form.querySelectorAll<HTMLElement>('[data-template-color]').forEach(button => button.addEventListener('click', () => { color.value = button.dataset.templateColor!; color.dispatchEvent(new Event('input', { bubbles:true })); }));
  let timer: ReturnType<typeof setTimeout>;
  let version = 0;
  let alive = true;
  let controller: AbortController;
  const previewState = form.querySelector<HTMLElement>('[data-template-preview-state]')!;
  const preview = form.querySelector<HTMLElement>('#template-preview-result')!;
  function schedulePreview() {
    const current = ++version;
    clearTimeout(timer); controller?.abort();
    form.querySelector<HTMLElement>('.template-preview-card')!.style.setProperty('--template-color', color.value);
    form.querySelector('[data-template-preview-icon]')!.innerHTML = interfaceIcon(icon.value);
    form.querySelector('[data-template-preview-name]')!.textContent = name.value || 'Your template';
    form.querySelector('[data-template-preview-title]')!.textContent = title.value || 'Untitled card';
    form.querySelectorAll<HTMLElement>('[data-template-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.templateColor === color.value)));
    previewState.textContent = 'Updating…';
    timer = setTimeout(async () => {
      controller = new AbortController();
      try {
        const result = await api<{title:string;content:string}>('/note-templates/preview', { method:'POST', signal:controller.signal, body:JSON.stringify({ title_template:title.value, content_template:content.value, project_id:Number((form.querySelector('#template-preview-project') as HTMLSelectElement).value)||null, paper_id:Number((form.querySelector('#template-preview-paper') as HTMLSelectElement).value)||null }) });
        if (!alive || current !== version) return;
        form.querySelector('[data-template-preview-title]')!.textContent = result.title || 'Untitled card';
        preview.innerHTML = result.content ? renderMarkdown(result.content) : '<p class="template-preview-empty">Your starting content will appear here.</p>';
        previewState.textContent = 'Up to date';
      } catch (error) { if (alive && current === version && !controller.signal.aborted) previewState.textContent = 'Preview unavailable'; }
    }, 220);
  }
  form.addEventListener('input', schedulePreview);
  form.addEventListener('change', schedulePreview);
  schedulePreview();
  const previousCleanup = editorSession.modalCleanup;
  editorSession.modalCleanup = () => { alive = false; clearTimeout(timer); controller?.abort(); previousCleanup?.(); modal.classList.remove('modal-template-studio'); };
  let saving = false;
  form.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation(); form.requestSubmit();
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return;
    saving = true;
    const save = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const error = form.querySelector<HTMLElement>('[data-template-error]')!;
    save.disabled = true; save.textContent = 'Saving…'; error.textContent = '';
    try {
      const fields = new FormData(form);
      await api(editing ? `/note-templates/${template.id}` : '/note-templates', { method:editing ? 'PATCH' : 'POST', body:JSON.stringify({ name:fields.get('name'), title_template:fields.get('title_template'), content_template:fields.get('content_template'), color:fields.get('color'), icon:fields.get('icon'), auto_create:false, is_article_default:fields.has('is_article_default') }) });
      await refreshData(); await openSettings('templates'); toast(editing ? 'Template updated' : 'Template created');
    } catch (reason) { error.textContent = reason.message; }
    finally { saving = false; save.disabled = false; save.textContent = editing ? 'Save' : 'Create template'; }
  });
}
