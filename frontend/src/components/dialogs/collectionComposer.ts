import { escapeHtml, modal } from '../../app/state';
import { openModal } from './controller';

/** Shared composition surface for collection records; field names stay API-native. */
export function collectionField(prefix: string, name: string, label: string, control: string, help = '') {
  const id = `${prefix}-${name}`;
  return `<div class="form-field collection-field"><label for="${id}">${label}</label>${control.replace(/<(input|select|textarea)\b/, `<$1 id="${id}" name="${name}"${help ? ` aria-describedby="${id}-help"` : ''}`)}${help ? `<small id="${id}-help">${help}</small>` : ''}</div>`;
}

export function collectionInput(value = '', attributes = '') {
  return `<input value="${escapeHtml(value)}" ${attributes}>`;
}

export function openCollectionComposer({ id, title, eyebrow, description, main, details, actions }: {
  id: string; title: string; eyebrow: string; description: string; main: string; details: string; actions: string;
}) {
  openModal(`<header class="modal-header collection-composer-header"><span class="collection-eyebrow">${eyebrow}</span><h2>${title}</h2><p>${description}</p></header>
    <form id="${id}" class="collection-composer-form"><div class="collection-composer-layout">
      <section class="collection-composer-main" aria-label="Record content">${main}</section>
      <aside class="collection-composer-details" aria-label="Record details">${details}</aside>
    </div><footer class="collection-composer-footer">${actions}</footer></form>`, true);
  modal.classList.add('modal-collection-composer');
}
