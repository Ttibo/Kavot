/** Interface colors chosen in the settings: overrides of the theme tokens, and the palette offered by color pickers. */
export type ThemeName = 'light' | 'dark';
export type ColorRole = 'canvas' | 'surface' | 'sidebar' | 'ink' | 'muted' | 'line' | 'accent';
export type ThemeColors = Partial<Record<ColorRole, string>>;
export type ColorPreferences = { colors: Record<ThemeName, ThemeColors>; palette: string[] };

export const colorRoles: [ColorRole, string, string][] = [
  ['canvas', 'Background', 'Behind pages, notes and canvases'],
  ['surface', 'Cards and panels', 'Cards, menus, dialogs and fields'],
  ['sidebar', 'Sidebar', 'Navigation and title bar'],
  ['ink', 'Text', 'Titles and body text'],
  ['muted', 'Secondary text', 'Descriptions, dates and hints'],
  ['line', 'Borders', 'Separators and outlines'],
  ['accent', 'Accent', 'Links, selection and main buttons'],
];
/** The colors of each theme, as set by its stylesheet (styles/obsidian.css). */
export const themeDefaults: Record<ThemeName, Record<ColorRole, string>> = {
  light: { canvas: '#ffffff', surface: '#ffffff', sidebar: '#f6f6f6', ink: '#222222', muted: '#5c5c5c', line: '#e3e3e3', accent: '#1f8a5b' },
  dark: { canvas: '#1e1e1e', surface: '#252525', sidebar: '#262626', ink: '#dadada', muted: '#b3b3b3', line: '#363636', accent: '#5fcf96' },
};
export const paletteDefaults = ['#087e86', '#3282c4', '#39917d', '#d08b33', '#bc4c7b', '#59aaba', '#c75555', '#7b61c4'];

const HEX = /^#[0-9a-f]{6}$/i;
const STORAGE_KEY = 'kavot-colors';
let current: ColorPreferences = { colors: { light: {}, dark: {} }, palette: [...paletteDefaults] };

export function getColors(): ColorPreferences {
  return { colors: { light: { ...current.colors.light }, dark: { ...current.colors.dark } }, palette: [...current.palette] };
}
export function getPalette(): string[] { return [...current.palette]; }

/** Dark or light text, whichever reads better on `color`. */
function readableOn(color: string) {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#ffffff';
}

/** Each role sets its token and the shades the stylesheets derive from it. */
function declarations(role: ColorRole, color: string): string[] {
  const mix = (amount: number, other: string) => `color-mix(in srgb, ${color} ${amount}%, ${other})`;
  switch (role) {
    case 'canvas': return [`--canvas: ${color}`, `--canvas-deep: ${mix(95, 'var(--ink)')}`];
    case 'surface': return [`--surface: ${color}`, `--surface-raised: ${color}`, `--surface-soft: ${mix(95, 'var(--ink)')}`];
    case 'sidebar': return [`--sidebar-surface: ${color}`, `--titlebar-surface: ${mix(94, 'var(--ink)')}`];
    case 'ink': return [`--ink: ${color}`, `--text: ${color}`];
    case 'muted': return [`--muted: ${color}`, `--subtle: ${mix(72, 'var(--canvas)')}`];
    case 'line': return [`--line: ${color}`, `--line-strong: ${mix(80, 'var(--ink)')}`];
    case 'accent': return [`--accent: ${color}`, `--accent-strong: ${mix(82, 'var(--ink)')}`, `--accent-soft: ${mix(14, 'var(--surface)')}`,
      `--primary-fill: ${color}`, `--primary-hover: ${mix(82, 'var(--ink)')}`, `--primary-ink: ${readableOn(color)}`, `--focus-ring: ${mix(25, 'transparent')}`];
  }
}

function themeRule(theme: ThemeName, colors: ThemeColors) {
  const lines = colorRoles.flatMap(([role]) => colors[role] ? declarations(role, colors[role]!) : []);
  // The themes also set their tokens on .research-shell, so the overrides must reach it too.
  return lines.length ? `html[data-theme="${theme}"], html[data-theme="${theme}"] .research-shell { ${lines.map(line => `${line} !important`).join('; ')}; }` : '';
}

function clean(value: any): ColorPreferences {
  const theme = (colors: any): ThemeColors => Object.fromEntries(colorRoles
    .map(([role]) => [role, colors?.[role]]).filter(([, color]) => typeof color === 'string' && HEX.test(color))
    .map(([role, color]) => [role, color.toLowerCase()]));
  const palette = Array.isArray(value?.palette) ? value.palette.filter((color: any) => typeof color === 'string' && HEX.test(color)).map((color: string) => color.toLowerCase()) : [];
  return { colors: { light: theme(value?.colors?.light), dark: theme(value?.colors?.dark) }, palette: palette.length ? palette : [...paletteDefaults] };
}

export function applyColors(value: Partial<ColorPreferences> | undefined, remember = true) {
  current = clean(value);
  let style = document.getElementById('kavot-colors');
  if (!style) { style = document.createElement('style'); style.id = 'kavot-colors'; }
  style.textContent = [themeRule('light', current.colors.light), themeRule('dark', current.colors.dark)].join('\n');
  // Last in the head, after every stylesheet.
  document.head.append(style);
  let list = document.getElementById('kavot-palette');
  if (!list) { list = document.createElement('datalist'); list.id = 'kavot-palette'; document.body.append(list); }
  list.innerHTML = current.palette.map(color => `<option value="${color}"></option>`).join('');
  if (remember) {
    // Lets the next start paint the chosen colors before the preferences load.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (_) { /* the saved preference stays the source */ }
  }
  window.dispatchEvent(new Event('kavot:colors-changed'));
}

/** Every color picker of the app offers the palette. */
function offerPalette(event: Event) {
  const input = event.target as HTMLElement;
  if (input instanceof HTMLInputElement && input.type === 'color' && !input.hasAttribute('list')) input.setAttribute('list', 'kavot-palette');
}
document.addEventListener('pointerdown', offerPalette, true);
document.addEventListener('focusin', offerPalette, true);

try { applyColors(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || undefined, false); }
catch (_) { applyColors(undefined, false); }
