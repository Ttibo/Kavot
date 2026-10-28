/**
 * Network access for scripts (`kavot.fetch`). Calls go through the local proxy,
 * which only reaches URLs the user approved one by one; an unknown URL opens a
 * confirmation dialog first. Refusals last until the app is reloaded.
 */
import { escapeHtml } from "../../../app/state";
import { api } from "../../../services/api";
import { dialogShell } from "./shared";

export type ScriptRequest = { url: string; method?: string; headers?: Record<string, string>; body?: string | null };
type ProxyResult = { approved: false; url: string }
  | { approved: true; url: string; status: number; status_text: string; headers: [string, string][]; body: string };
export type NetworkApproval = { url: string; script: string; approved_at: string };

const refused = new Set<string>();
const prompts = new Map<string, Promise<boolean>>();
let queue: Promise<unknown> = Promise.resolve();

/** Not sent through api(): a slow remote call must not hold back cloud refreshes like a pending write. */
async function proxy(request: ScriptRequest): Promise<ProxyResult> {
  const response = await fetch("/api/note-scripts/network/fetch", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `Request failed (${response.status})`);
  return data;
}

function confirmUrl(url: string, method: string, scriptName: string) {
  return new Promise<boolean>(resolve => {
    const dialog = dialogShell("kv-network-dialog", "Allow network access?");
    dialog.innerHTML = `<form method="dialog">
      <header class="kv-dialog-head"><h3>Allow network access?</h3></header>
      <p>The script <strong>${escapeHtml(scriptName || "Script")}</strong> wants to call this address:</p>
      <p class="kv-network-url"><span>${escapeHtml(method)}</span><code>${escapeHtml(url)}</code></p>
      <div class="kv-network-warning" role="alert">
        <strong>Only allow servers you trust.</strong>
        Once allowed, scripts can send data to this address, including the content of your notes and collections,
        and display what it returns. The approval covers this exact address, whatever its query string,
        for every script. You can revoke it in <em>Settings → Scripts</em>.
      </div>
      <footer class="form-actions">
        <span class="kv-spacer"></span>
        <button type="button" data-refuse autofocus>Refuse</button>
        <button type="button" class="primary" data-allow>Allow this URL</button>
      </footer>
    </form>`;
    let allowed = false;
    dialog.querySelector("[data-allow]")!.addEventListener("click", () => { allowed = true; dialog.close(); });
    dialog.querySelector("[data-refuse]")!.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => resolve(allowed));
    dialog.showModal();
  });
}

/** One dialog at a time; requests waiting on the same URL share its answer. */
function askApproval(url: string, method: string, scriptName: string) {
  let pending = prompts.get(url);
  if (!pending) {
    pending = queue.then(() => confirmUrl(url, method, scriptName)).then(async allowed => {
      if (allowed) await api("/note-scripts/network/approvals", { method: "POST", body: JSON.stringify({ url, script: scriptName }) });
      else refused.add(url);
      return allowed;
    }).finally(() => prompts.delete(url));
    queue = pending.catch(() => false);
    prompts.set(url, pending);
  }
  return pending;
}

export async function scriptFetch(request: ScriptRequest, scriptName: string) {
  // Each round can stop at a new unapproved URL (the request itself, then redirect targets).
  for (let round = 0; round < 8; round++) {
    const result = await proxy(request);
    if (result.approved) return result;
    if (refused.has(result.url) || !await askApproval(result.url, (request.method || "GET").toUpperCase(), scriptName))
      throw new Error(`Network access to ${result.url} was refused`);
  }
  throw new Error("Network access could not be approved");
}

export const networkApprovals = () => api<NetworkApproval[]>("/note-scripts/network/approvals");

export async function revokeNetworkApproval(url: string) {
  await api(`/note-scripts/network/approvals?url=${encodeURIComponent(url)}`, { method: "DELETE" });
}
