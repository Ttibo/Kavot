import katex from 'katex';

type MathExpression = { from: number; to: number; source: string; display: boolean };

/** Keep code and escaped dollar signs literal when locating TeX delimiters. */
export function mathExpressions(text: string): MathExpression[] {
  const expressions: MathExpression[] = [];
  const pattern = /(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\2[^\n]*(?=\n|$)|(?![\s\S])))|(`+)[^`]*?\3|\\\$|(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<![\\$])\$(?![\s$])((?:\\.|[^$\n])+?)(?<![\\\s])\$(?!\d)|(?<!\\)\\\(([\s\S]+?)\\\)|(?<!\\)\\\[([\s\S]+?)\\\]/gm;
  for (const match of text.matchAll(pattern)) {
    const source = match[4] ?? match[5] ?? match[6] ?? match[7];
    if (source == null) continue;
    expressions.push({ from: match.index, to: match.index + match[0].length, source, display: match[4] != null || match[7] != null });
  }
  return expressions;
}

export function renderMath(source: string, display = false) {
  return katex.renderToString(source, { displayMode: display, throwOnError: false, trust: false, maxSize: 20, maxExpand: 1000, strict: 'ignore' });
}

/** Protect TeX from Markdown escaping and emphasis processing. */
export function protectMath(source: string) {
  let prefix = '\uE000MATH';
  while (source.includes(prefix)) prefix += 'M';
  const tokens = new Map<string, MathExpression>();
  let text = '', cursor = 0;
  for (const expression of mathExpressions(source)) {
    const token = `${prefix}${tokens.size}\uE001`;
    tokens.set(token, expression);
    text += source.slice(cursor, expression.from) + token;
    cursor = expression.to;
  }
  text += source.slice(cursor);
  return {
    text,
    isDisplay: (token: string) => Boolean(tokens.get(token)?.display),
    restore: (html: string) => {
      for (const [token, expression] of tokens) html = html.replaceAll(token, () => renderMath(expression.source, expression.display));
      return html;
    },
  };
}
