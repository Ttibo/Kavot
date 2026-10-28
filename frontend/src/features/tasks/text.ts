/** Reading a task description, written in Markdown (older tasks) or HTML (rich editor). */

export type TaskDigest = { summary: string; done: number; total: number; links: number };

const isHtml = (value: string) => /^\s*<[a-z][\s\S]*>/i.test(value);

export function taskDigest(description: string | null | undefined, checklist: { done: boolean }[] = []): TaskDigest {
  const source = String(description || '');
  let summary = '', done = checklist.filter(item => item.done).length, total = checklist.length, links = 0;
  if (isHtml(source)) {
    const body = new DOMParser().parseFromString(source, 'text/html').body;
    const items = body.querySelectorAll('li[data-type="taskItem"]');
    total += items.length;
    done += [...items].filter(item => item.getAttribute('data-checked') === 'true').length;
    links = body.querySelectorAll('a[href]').length;
    items.forEach(item => item.remove());
    body.querySelectorAll('h1, h2, h3, h4').forEach(heading => { if (/^(to do|steps?|checklist)$/i.test(heading.textContent?.trim() || '')) heading.remove(); });
    summary = (body.textContent || '').replace(/\s+/g, ' ').trim();
  } else {
    const boxes = [...source.matchAll(/^\s*-\s+\[([ xX])\]\s+/gm)];
    total += boxes.length;
    done += boxes.filter(box => box[1].toLowerCase() === 'x').length;
    links = [...source.matchAll(/\]\((?:#|\.\/|https?:)/g)].length;
    summary = source.replace(/^\s*-\s+\[[ xX]\]\s+.*$/gm, '').replace(/^#{1,6}\s+(to do|steps?|checklist)\s*$/gim, '')
      .replace(/^#{1,6}\s+/gm, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  }
  return { summary, done, total, links };
}

/** "Overdue 3 d", "Due today", "Due in 2 d" or a date, and how urgent it is. */
export function dueLabel(due: string | null | undefined, formatDate: (value: string) => string): { text: string; tone: 'overdue' | 'soon' | 'later' } | null {
  if (!due) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(`${due}T00:00:00`);
  const days = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return { text: `Overdue ${-days} d`, tone: 'overdue' };
  if (days === 0) return { text: 'Due today', tone: 'soon' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'soon' };
  if (days <= 7) return { text: `Due in ${days} d`, tone: 'soon' };
  return { text: `Due ${formatDate(due)}`, tone: 'later' };
}

export function relativeTime(value: string | null | undefined) {
  if (!value) return '';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(value).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
