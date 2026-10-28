import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { applyFontSizes, fontDefaults, FontSizes, getFontSizes } from '../app/typography';

const areas: [keyof FontSizes, string, string][] = [
  ['navigation', 'Navigation', 'Sidebar and tabs'],
  ['interface', 'Menus and forms', 'Buttons, fields and settings'],
  ['titles', 'Page titles', 'Headers of the main views'],
  ['editor', 'Notes and reading', 'Note text and Markdown preview'],
  ['tables', 'Tables and collections', 'Cells and item lists'],
  ['assistant', 'Assistant', 'Messages and input'],
  ['code', 'Code', 'Source files and diffs'],
];

export function TypographySettings() {
  const [sizes, setSizes] = useState(getFontSizes);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const sync = () => setSizes(getFontSizes());
    window.addEventListener('kavot:typography-changed', sync);
    return () => window.removeEventListener('kavot:typography-changed', sync);
  }, []);
  async function save(next: FontSizes) {
    const previous = getFontSizes();
    applyFontSizes(next); setBusy(true); setStatus('Saving…'); setError('');
    try {
      const saved = await api('/settings/preferences', { method: 'PATCH', body: JSON.stringify({ font_sizes: next }) });
      applyFontSizes(saved.font_sizes); setStatus('Sizes saved on this device.');
    } catch (reason) { applyFontSizes(previous); setStatus(''); setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <article className="settings-card typography-settings"><h3>Font sizes</h3><p>Adjust each area independently. Changes apply immediately and are kept after a restart.</p>
    <fieldset disabled={busy}><legend className="sr-only">Sizes by area</legend>{areas.map(([key, label, detail]) => <label className="typography-setting" key={key}><span><strong>{label}</strong><small>{detail}</small></span><select aria-label={`Taille : ${label}`} value={sizes[key]} onChange={event => void save({ ...sizes, [key]: Number(event.target.value) })}>{Array.from({ length: (key === 'titles' ? 40 : 24) - 9 }, (_, i) => i + 10).map(size => <option key={size} value={size}>{size} px{size === fontDefaults[key] ? ' (default)' : ''}</option>)}</select><span className="typography-preview" style={{ fontSize: sizes[key] }}>Aa</span></label>)}</fieldset>
    <button className="button" disabled={busy} onClick={() => void save({ ...fontDefaults })}>Restore default sizes</button><p role="status">{status}</p>{error && <p role="alert">{error}</p>}
  </article>;
}
