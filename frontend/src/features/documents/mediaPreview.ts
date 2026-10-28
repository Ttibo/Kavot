const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function safeMediaUrl(value: string): string {
  if (!value || /[\u0000-\u0020\\]/.test(value)) return '';
  if (/^https?:\/\//i.test(value) || /^\/api\/(databases\/resources\/files\/|notes\/\d+\/assets\/|workspace\/file\?|papers\/\d+\/file)/.test(value)) return value;
  return '';
}

export function mediaKind(url: string): string {
  const path = url.startsWith('/api/workspace/file?')
    ? new URL(url, location.origin).searchParams.get('path')?.toLowerCase() || ''
    : url.split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(path)) return 'image';
  if (/\.pdf$/.test(path)) return 'pdf';
  if (/\.(mp4|webm|ogv|mov)$/.test(path)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(path)) return 'audio';
  return '';
}

export function mediaPreview(url: string, title: string, kind = mediaKind(url)): string {
  const safe = safeMediaUrl(url);
  if (!safe || !['image', 'pdf', 'video', 'audio'].includes(kind)) return '';
  const src = escape(safe), label = escape(title || 'File');
  const content = kind === 'image' ? `<img src="${src}" alt="${label}" loading="lazy">`
    : kind === 'pdf' ? `<iframe src="${src}" title="${label}" loading="lazy" referrerpolicy="no-referrer"></iframe>`
    : `<${kind} src="${src}" controls preload="metadata" aria-label="${label}"></${kind}>`;
  return `<figure class="resource-media-preview resource-media-${kind}">${content}<figcaption><a href="${src}" target="_blank" rel="noopener noreferrer">${label} ↗</a></figcaption></figure>`;
}

/** Existing standalone attachment links gain previews without rewriting notes. */
export function markdownMediaPreview(line: string): string {
  const match = line.trim().match(/^!?\[((?:\\.|[^\]])*)\]\((?:<([^>]+)>|([^\s]+))\)$/);
  if (!match) return '';
  return mediaPreview(match[2] || match[3], match[1].replace(/\\([\[\]])/g, '$1'));
}
