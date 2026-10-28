import DOMPurify from "dompurify";
import { marked } from "marked";

export const isHtmlDocument = (value: string) =>
  /<(?:!doctype|html\b|p\b|h[1-6]\b|div\b|section\b|table\b|figure\b|ul\b|ol\b|blockquote\b|pre\b|img\b|span\b|aside\b|details\b|math\b|video\b|audio\b)/i.test(
    value,
  );

/** One inert content boundary for editor, previews and imported clipboard HTML. */
export function documentHtml(value: string, assetBase = ""): string {
  let html = String(value || "");
  if (!isHtmlDocument(html))
    html = marked.parse(html, { async: false }) as string;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const content = parsed.querySelector("[data-kavot-content]");
  html = content ? content.innerHTML : parsed.body.innerHTML;
  html = DOMPurify.sanitize(html, {
    ADD_ATTR: ["colwidth"],
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["contenteditable"],
  });
  const root = document.createElement("div");
  root.innerHTML = html;
  root.querySelectorAll<HTMLLIElement>("li.task-list-item").forEach((item) => {
    const checkbox = item.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    item.dataset.type = "taskItem";
    item.dataset.checked = String(checkbox?.checked || false);
    item.parentElement!.dataset.type = "taskList";
  });
  root.querySelectorAll<HTMLElement>("*").forEach((element) => {
    for (const attribute of ["href", "src"]) {
      const original = element.getAttribute(`data-kavot-${attribute}`);
      if (original) {
        element.setAttribute(attribute, original);
        element.removeAttribute(`data-kavot-${attribute}`);
      }
      const url = element.getAttribute(attribute);
      if (
        url &&
        /^[\s\S]*?:/.test(url) &&
        !/^(https?:|mailto:)/i.test(url.trim())
      ) {
        element.removeAttribute(attribute);
        continue;
      }
      if (assetBase && url?.startsWith("assets/"))
        element.setAttribute(attribute, assetBase + url.slice(7));
    }
    // Keep formatting but reject layout that can cover application controls.
    const allowed = new Set([
      "color",
      "background-color",
      "font-size",
      "font-family",
      "line-height",
      "text-align",
      "text-decoration",
      "width",
      "height",
      "max-width",
      "min-width",
      "vertical-align",
      "flex-basis",
    ]);
    for (const name of Array.from(element.style || []))
      if (
        !allowed.has(name) ||
        /url\s*\(/i.test(element.style.getPropertyValue(name))
      )
        element.style.removeProperty(name);
  });
  return root.innerHTML;
}
