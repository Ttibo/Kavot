/**
 * Script sandbox: each script runs in an opaque-origin iframe (sandbox="allow-scripts")
 * with a CSP that blocks network access. Data reaches it only through the `kavot`
 * bridge, answered here over postMessage; `kavot.fetch` calls URLs the user approved.
 */
import { toast } from "../../../app/navigation";
import { openCollectionItem } from "../../collections/catalog";
import { activeItems, itemFields } from "./collectionData";
import { scriptFetch, type ScriptRequest } from "./scriptNetwork";
import { collectionList, plainText } from "./shared";

export type ScriptSource = {
  name: string;
  html: string;
  css: string;
  js: string;
  height: string;
  /* Library metadata, unused by blocks in notes. */
  description?: string;
  author?: string;
  tags?: string[];
};

export const emptyScript = (): ScriptSource => ({ name: "New script", html: "", css: "", js: "", height: "auto" });

const CDNS = "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com";
const CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS} https://esm.sh`,
  `style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
  "font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "img-src data: blob:",
  "media-src data: blob:",
  // Scripts never reach the local API or the network directly: kavot.fetch goes through the bridge.
  "connect-src 'none'",
].join("; ");

/** Injected before user code: defines window.kavot and reports size and errors to the parent. */
const BRIDGE = `(() => {
  let seq = 0;
  const pending = new Map();
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ kavot: 'call', id, method, args }, '*');
  });
  addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || !data || data.kavot !== 'reply') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    data.error ? entry.reject(new Error(data.error)) : entry.resolve(data.result);
  });
  const toBase64 = bytes => {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  // fetch-like: same arguments, returns a real Response. Each new URL needs the user's approval.
  const request = async (input, init = {}) => {
    const url = new URL(String(input && typeof input === 'object' && 'url' in input ? input.url : input)).href;
    const method = String(init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers || {}));
    let body = null;
    if (init.body != null) {
      // Response serializes strings, blobs, buffers, URLSearchParams and FormData with their content type.
      const encoded = new Response(init.body);
      if (!headers['content-type'] && encoded.headers.get('content-type')) headers['content-type'] = encoded.headers.get('content-type');
      body = toBase64(new Uint8Array(await encoded.arrayBuffer()));
    }
    const result = await call('fetch', { url, method, headers, body });
    const empty = method === 'HEAD' || [101, 204, 205, 304].includes(result.status);
    const response = new Response(empty ? null : Uint8Array.from(atob(result.body), c => c.charCodeAt(0)),
      { status: result.status, statusText: result.status_text, headers: result.headers });
    Object.defineProperty(response, 'url', { value: result.url });
    return response;
  };
  const report = () => parent.postMessage({ kavot: 'size', height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)) }, '*');
  const fail = message => parent.postMessage({ kavot: 'error', message: String(message) }, '*');
  addEventListener('error', event => fail(event.message || event.error));
  addEventListener('unhandledrejection', event => fail(event.reason && event.reason.message || event.reason));
  addEventListener('load', () => { report(); new ResizeObserver(report).observe(document.body); });
  window.kavot = Object.freeze({
    theme: document.documentElement.dataset.theme,
    collections: () => call('collections'),
    items: collection => call('items', collection),
    note: () => call('note'),
    scrollTo: id => call('scrollTo', String(id)),
    open: item => call('open', item),
    toast: message => call('toast', String(message)),
    fetch: request,
    resize: report,
  });
})();`;

const BASE_STYLE = `html,body{margin:0;background:transparent;color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}body{padding:2px}
button,input,select,textarea{font:inherit;color:inherit}
button{border:1px solid var(--line);background:var(--surface);border-radius:6px;padding:4px 10px;cursor:pointer}button:hover{background:var(--surface-soft)}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left}th{color:var(--muted);font-weight:600}a{color:var(--accent)}`;

const themeVariables = ["ink", "muted", "subtle", "line", "canvas", "surface", "surface-soft", "accent", "accent-soft", "red", "amber", "teal"];

function scriptDocument(script: ScriptSource) {
  const computed = getComputedStyle(document.documentElement);
  const variables = themeVariables.map(name => `--${name}:${computed.getPropertyValue(`--${name}`).trim() || "inherit"}`).join(";");
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const css = String(script.css || "").replace(/<\/style/gi, "<\\/style");
  const js = String(script.js || "").replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + `<style>:root{${variables};color-scheme:${theme}}${BASE_STYLE}\n${css}</style>`
    + `<script>${BRIDGE}</script></head><body>${script.html || ""}<script type="module">${js}</script></body></html>`;
}

type FrameHost = {
  frame: HTMLIFrameElement;
  attached?: boolean;
  onSize?: (height: number) => void;
  onError?: (message: string) => void;
  noteTitle?: () => string;
  /** Shown in the network approval dialog. */
  scriptName?: string;
};
const frames = new Set<FrameHost>();
let listening = false;

function frameHost(source: MessageEventSource | null) {
  for (const host of frames) {
    // Frames are created before ProseMirror inserts them; only forget frames that were shown then removed.
    if (host.frame.isConnected) host.attached = true;
    else if (host.attached) { frames.delete(host); continue; }
    if (source && host.frame.contentWindow === source) return host;
  }
  return null;
}

/** Text and outline of the note that contains a script (embedded blocks excluded). */
function noteContent(frame: HTMLIFrameElement) {
  const scope = frame.closest(".rich-content, .continuous-reading");
  if (!scope) return { text: "", words: 0, headings: [] };
  const copy = scope.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".kv-embed, .rich-block-handle, .rich-table-add, button").forEach(el => el.remove());
  copy.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre").forEach(el => el.append(" "));
  const text = (copy.textContent || "").replace(/\s+/g, " ").trim();
  const headings = [...scope.querySelectorAll<HTMLElement>("h1, h2, h3, h4")]
    .filter(heading => !heading.closest(".kv-embed"))
    .map(heading => ({ level: Number(heading.tagName[1]), text: (heading.textContent || "").trim(), id: heading.id }))
    .filter(heading => heading.text);
  return { text: text.slice(0, 200000), words: text ? text.split(" ").length : 0, headings };
}

function bridgeItem(item) {
  return {
    id: item.id, type: item.type, collection: item.databaseId, title: String(item.title ?? ""),
    detail: plainText(item.detail).slice(0, 400), fields: itemFields(item),
  };
}

const bridgeMethods: Record<string, (host: FrameHost, args: unknown[]) => unknown> = {
  collections: () => collectionList(),
  items: (_host, [collection]) => activeItems(String(collection || "")).map(bridgeItem),
  note: host => ({ title: host.noteTitle?.() || "", ...noteContent(host.frame) }),
  scrollTo: (host, [id]) => {
    const scope = host.frame.closest(".rich-content, .continuous-reading");
    const target = scope?.querySelector(`[id="${CSS.escape(String(id || ""))}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    return !!target;
  },
  fetch: (host, [request]) => scriptFetch(request as ScriptRequest, host.scriptName || "Script"),
  toast: (_host, [message]) => { toast(String(message || "").slice(0, 300), "info"); return true; },
  open: (_host, [reference]) => {
    const ref = reference as { type?: string; id?: unknown; collection?: string };
    if (!ref?.type || ref.id == null) throw new Error("Invalid item");
    openCollectionItem({ type: ref.type, id: ref.id, databaseId: ref.collection });
    return true;
  },
};

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", async event => {
    const data = event.data;
    if (!data || typeof data !== "object" || !("kavot" in data)) return;
    const host = frameHost(event.source);
    if (!host) return;
    if (data.kavot === "size") host.onSize?.(Number(data.height) || 0);
    else if (data.kavot === "error") host.onError?.(String(data.message || "Error"));
    else if (data.kavot === "call") {
      const reply = (payload: object) => (event.source as Window).postMessage({ kavot: "reply", id: data.id, ...payload }, "*");
      try {
        const method = bridgeMethods[String(data.method)];
        if (!method) throw new Error(`Unknown method: ${data.method}`);
        reply({ result: await method(host, Array.isArray(data.args) ? data.args : []) });
      } catch (error) {
        reply({ error: (error as Error).message });
      }
    }
  });
}

/** (Re)run a script inside an isolated frame. */
export function runScript(frame: HTMLIFrameElement, script: ScriptSource, host: Omit<FrameHost, "frame"> = {}) {
  listen();
  frame.setAttribute("sandbox", "allow-scripts allow-modals");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("loading", "lazy");
  for (const entry of frames) if (entry.frame === frame) frames.delete(entry);
  frames.add({ frame, scriptName: script.name, ...host });
  frame.srcdoc = scriptDocument(script);
}

/** Read a script block stored in a note: data attributes plus one <pre data-lang> per language. */
export function scriptFromElement(element: Element): ScriptSource {
  const code = (lang: string) => element.querySelector(`pre[data-lang="${lang}"]`)?.textContent || "";
  return {
    name: element.getAttribute("data-script-name") || "Script",
    height: element.getAttribute("data-height") || "auto",
    html: code("html"),
    css: code("css"),
    js: code("js"),
  };
}
