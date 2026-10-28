import { useSyncExternalStore } from 'react';
import { snapshot, subscribe } from './viewBridge';
export type Runtime = typeof import('./workspace');
let runtime: Runtime | undefined;
export function setRuntime(value: Runtime) { runtime = value; }
export function getRuntime(): Runtime { if (!runtime) throw new Error('Workspace is still loading'); return runtime; }
export function useRuntime() { useSyncExternalStore(subscribe, snapshot); return getRuntime(); }
export function useOptionalRuntime() { useSyncExternalStore(subscribe, snapshot); return runtime; }
