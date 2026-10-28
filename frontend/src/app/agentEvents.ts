/** Editors register saves that must finish before an agent reads or writes. */
const saves = new Set<() => Promise<unknown>>();
export function registerAgentSave(save: () => Promise<unknown>) {
  saves.add(save);
  return () => { saves.delete(save); };
}
export async function flushAgentSaves() {
  for (const save of saves) await save();
}
