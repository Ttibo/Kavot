export const fontDefaults = { navigation: 13, interface: 13, titles: 26, editor: 12, tables: 13, assistant: 14, code: 12 };
export type FontSizes = typeof fontDefaults;
let current = { ...fontDefaults };
export function getFontSizes(): FontSizes { return { ...current }; }
export function applyFontSizes(value: Partial<FontSizes> = {}) {
  current = { ...fontDefaults };
  for (const key of Object.keys(fontDefaults) as (keyof FontSizes)[]) {
    const size = value?.[key];
    if (Number.isInteger(size) && size >= 10 && size <= (key === 'titles' ? 40 : 24)) current[key] = size;
    document.documentElement.style.setProperty(`--font-${key}`, `${current[key]}px`);
    document.documentElement.toggleAttribute(`data-font-${key}`, current[key] !== fontDefaults[key]);
  }
  window.dispatchEvent(new Event('kavot:typography-changed'));
}
