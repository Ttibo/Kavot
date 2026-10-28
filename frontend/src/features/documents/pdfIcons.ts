const paths = {
  previous: '<path d="m14 6-6 6 6 6"/>', next: '<path d="m10 6 6 6-6 6"/>',
  minus: '<path d="M5 12h14"/>', plus: '<path d="M5 12h14M12 5v14"/>',
  fit: '<path d="M8 4H4v16h4m8-16h4v16h-4M8 12h8m-6-3-3 3 3 3m4-6 3 3-3 3"/>',
  capture: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/>',
  read: '<path d="m5 3 14 10-7 1-3 7Z"/>',
  edit: '<path d="m15 4 5 5-11 11H4v-5ZM13 6l5 5"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  book: '<path d="M12 5v16M12 5C8 2 4 3 2 4v15c4-2 7-1 10 2 3-3 6-4 10-2V4c-2-1-6-2-10 1Z"/>',
  highlight: '<path d="m14 3 7 7-9 9-7-7Zm-9 9-2 7 7-2M3 22h18"/>',
  underline: '<path d="M6 3v8a6 6 0 0 0 12 0V3M4 21h16"/>',
  sticky: '<path d="M4 3h16v12l-5 6H4Zm11 18v-6h5M8 8h8M8 12h5"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 5H4v15h15v-6"/>',
};
export function pdfIcon(name: keyof typeof paths) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
