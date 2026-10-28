/** Restrict persisted presentation values before inserting them into CSS. */
function canvasTextStyle(node: any) {
  const style = node.textStyle || {};
  const color = (value: unknown, fallback: string) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  return {
    fontSize: Math.max(10, Math.min(96, Number(style.fontSize) || 18)),
    bold: style.bold === true,
    italic: style.italic === true,
    align: ['left', 'center', 'right'].includes(style.align) ? style.align : 'left',
    color: color(style.color, '#292e38'),
    background: color(style.background, '#fff8df'),
    shape: style.shape === 'card' ? 'card' : 'bubble',
  };
}

export function canvasTextCss(node: any) {
  if (node.type !== 'text') return '';
  const s = canvasTextStyle(node);
  return `;--text-size:${s.fontSize}px;--text-weight:${s.bold ? 700 : 400};--text-style:${s.italic ? 'italic' : 'normal'};--text-align:${s.align};--text-color:${s.color};--text-background:${s.background};--text-radius:${s.shape === 'bubble' ? 28 : 10}px`;
}

export function canvasTextControls(node: any) {
  const s = canvasTextStyle(node);
  return `<fieldset class="canvas-text-controls form-field full"><legend>Bubble style</legend>
    <label>Text size<input name="textSize" type="number" min="10" max="96" value="${s.fontSize}"></label>
    <label>Forme<select name="textShape" aria-label="Forme"><option value="bubble" ${s.shape === 'bubble' ? 'selected' : ''}>Bulle</option><option value="card" ${s.shape === 'card' ? 'selected' : ''}>Carte</option></select></label>
    <label>Text color<input name="textColor" type="color" value="${s.color}"></label>
    <label>Couleur du fond<input name="textBackground" type="color" value="${s.background}"></label>
    <label>Alignement<select name="textAlign" aria-label="Alignement">${['left', 'center', 'right'].map((value, i) => `<option value="${value}" ${s.align === value ? 'selected' : ''}>${['Gauche', 'Centered', 'Droite'][i]}</option>`).join('')}</select></label>
    <div class="canvas-text-emphasis"><label><input name="textBold" type="checkbox" ${s.bold ? 'checked' : ''}>Gras</label><label><input name="textItalic" type="checkbox" ${s.italic ? 'checked' : ''}>Italique</label></div>
    <small>Resize the bubble from its bottom-right corner. Connect it using the dots on its edges.</small>
  </fieldset>`;
}
