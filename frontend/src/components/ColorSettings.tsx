import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useRuntime } from '../app/runtime';
import { applyColors, colorRoles, ColorPreferences, getColors, paletteDefaults, ThemeName, themeDefaults } from '../app/colors';

export function ColorSettings() {
  const { state } = useRuntime();
  const [value, setValue] = useState(getColors);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const timer = useRef(0);
  useEffect(() => {
    const sync = () => setValue(getColors());
    window.addEventListener('kavot:colors-changed', sync);
    return () => { window.removeEventListener('kavot:colors-changed', sync); window.clearTimeout(timer.current); };
  }, []);
  // The colors edited are those of the interface theme chosen above.
  const theme: ThemeName = state.theme === 'dark' ? 'dark' : 'light';

  /** Applies at once; saves when the picker settles. */
  function change(next: ColorPreferences) {
    applyColors(next); setValue(getColors()); setError(''); setStatus('Saving…');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try { await api('/settings/preferences', { method: 'PATCH', body: JSON.stringify({ colors: next.colors, palette: next.palette }) }); setStatus('Colors saved on this device.'); }
      catch (reason) { setStatus(''); setError((reason as Error).message); }
    }, 400);
  }
  const colors = value.colors[theme];
  const setRole = (role: string, color: string | null) => {
    const next = { ...colors, [role]: color };
    if (!color) delete next[role as keyof typeof next];
    change({ ...value, colors: { ...value.colors, [theme]: next } });
  };
  const setPalette = (palette: string[]) => change({ ...value, palette });
  const label = theme === 'light' ? 'light' : 'dark';

  return <article className="settings-card color-settings"><h3>Colors</h3><p>Colors of the {label} theme. Changes apply immediately; a color you do not set follows the theme. Switch the theme above to edit the other one.</p>
    <div className="color-roles">{colorRoles.map(([role, title, detail]) => <div className="color-role" key={role}>
      <span><strong>{title}</strong><small>{detail}</small></span>
      <input type="color" aria-label={`${title} (${label} theme)`} value={colors[role] || themeDefaults[theme][role]} onChange={event => setRole(role, event.target.value)}/>
      <button className="button button-small" disabled={!colors[role]} title="Use the theme's color" onClick={() => setRole(role, null)}>Reset</button>
    </div>)}</div>
    <button className="button" disabled={!Object.keys(colors).length} onClick={() => change({ ...value, colors: { ...value.colors, [theme]: {} } })}>Restore the {label} theme colors</button>

    <h3 className="color-palette-title">Palette</h3><p>The colors suggested for cards, templates, projects and labels.</p>
    <div className="color-palette">{value.palette.map((color, index) => <span className="color-swatch" key={index}>
      <input type="color" aria-label={`Palette color ${index + 1}`} value={color} onChange={event => setPalette(value.palette.map((item, i) => i === index ? event.target.value : item))}/>
      <button type="button" aria-label={`Remove palette color ${index + 1}`} title="Remove" disabled={value.palette.length <= 1} onClick={() => setPalette(value.palette.filter((_, i) => i !== index))}>×</button>
    </span>)}
      {value.palette.length < 24 && <button type="button" className="button button-small" onClick={() => setPalette([...value.palette, colors.accent || themeDefaults[theme].accent])}>＋ Add</button>}
    </div>
    <button className="button" disabled={value.palette.join() === paletteDefaults.join()} onClick={() => setPalette([...paletteDefaults])}>Restore default palette</button>
    <p role="status">{status}</p>{error && <p role="alert">{error}</p>}
  </article>;
}
