/**
 * Script library: the user's saved scripts and the portable exchange format.
 *
 * A package is plain JSON so it can be sent as a file today and served by an
 * online catalogue later:
 *   { "format": "kavot-scripts", "scripts": [LibraryScript, …] }
 * Each script carries a stable `uid`; importing a script whose uid already
 * exists updates it instead of duplicating it.
 */
import { state } from "../../app/state";
import { api } from "../../services/api";
import { refreshState } from "../../app/navigation";

const SCRIPT_PACKAGE_FORMAT = "kavot-scripts";
const MAX_SCRIPTS_PER_FILE = 200;

type ScriptOrigin = { kind: "local" | "file" | "example" | "online"; url?: string | null; remote_id?: string | null };

export type LibraryScript = {
  id?: number;
  uid?: string;
  name: string;
  description: string;
  author: string;
  tags: string[];
  source?: ScriptOrigin;
  html: string;
  css: string;
  js: string;
  created_at?: string;
  updated_at?: string;
};

const text = (value: unknown, max: number) => String(value ?? "").slice(0, max);

function normalizeScript(value: any, origin?: ScriptOrigin): LibraryScript {
  if (!value || typeof value !== "object") throw new Error("Invalid script.");
  const name = text(value.name, 120).trim();
  if (!name) throw new Error("A script in the file has no name.");
  const uid = typeof value.uid === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value.uid) ? value.uid : undefined;
  const tags = Array.isArray(value.tags) ? value.tags.map((tag: unknown) => text(tag, 40).trim()).filter(Boolean).slice(0, 20) : [];
  return {
    uid,
    name,
    description: text(value.description, 1000),
    author: text(value.author, 120),
    tags,
    source: origin || (value.source && typeof value.source === "object" ? value.source : { kind: "local" }),
    html: text(value.html, 100000),
    css: text(value.css, 100000),
    js: text(value.js, 200000),
  };
}

/** Fields sent to the API and written to exported files (no local ids or timestamps). */
function payload(script: LibraryScript) {
  const { id: _id, created_at: _created, updated_at: _updated, ...rest } = script;
  return rest;
}

/** Accept a package, a single exported script, or a bare list of scripts. */
export function parseScriptPackage(source: string, origin: ScriptOrigin = { kind: "file" }): LibraryScript[] {
  let data: any;
  try {
    data = JSON.parse(source);
  } catch {
    throw new Error("This is not a Kavot scripts file (invalid JSON).");
  }
  const list = data?.format === SCRIPT_PACKAGE_FORMAT ? data.scripts : Array.isArray(data) ? data : data?.name ? [data] : null;
  if (!Array.isArray(list) || !list.length) throw new Error("No scripts found in this file.");
  if (list.length > MAX_SCRIPTS_PER_FILE) throw new Error(`A file can contain at most ${MAX_SCRIPTS_PER_FILE} scripts.`);
  return list.map(item => normalizeScript(item, origin));
}

export function downloadScripts(scripts: LibraryScript[], name = "scripts") {
  const fileName = `${name.replace(/[^\p{L}\p{N} _-]/gu, "_").trim() || "scripts"}.kavot-scripts.json`;
  const contents = { format: SCRIPT_PACKAGE_FORMAT, exported_at: new Date().toISOString(), scripts: scripts.map(payload) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(contents, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const libraryScripts = (): LibraryScript[] => state.noteScripts || [];

export async function saveLibraryScript(script: LibraryScript, id?: number) {
  const saved = await api<LibraryScript>(id ? `/note-scripts/${id}` : "/note-scripts", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(payload(script)),
  });
  await refreshState(["noteScripts"]);
  return saved;
}

export async function deleteLibraryScript(id: number) {
  await api(`/note-scripts/${id}`, { method: "DELETE" });
  await refreshState(["noteScripts"]);
}

export async function importLibraryScripts(scripts: LibraryScript[]) {
  const result = await api<{ created: number; updated: number }>("/note-scripts/import", {
    method: "POST",
    body: JSON.stringify({ scripts: scripts.map(payload) }),
  });
  await refreshState(["noteScripts"]);
  return result;
}
