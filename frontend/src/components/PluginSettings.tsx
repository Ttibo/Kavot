import { type ReactNode, useEffect, useState } from 'react';
import { useRuntime } from '../app/runtime';
import { api } from '../services/api';
import { CollectionsSettings } from './CustomCollectionCreator';
import { ScholarlySourcesSettings } from './ScholarlySourcesSettings';
import { ZoteroSettings } from './ZoteroSettings';

export type PluginConnector = { id: string; label: string; permissions: string[] };
export type PluginInfo = {
  id: string; name: string; version: string; description: string; removable: boolean; enabled: boolean;
  collections: { id: string; name: string; removable: boolean }[];
  connectors: PluginConnector[];
};

/** Settings that belong to one plugin, shown on its page while it is active. */
const PLUGIN_SETTINGS: Record<string, () => ReactNode> = {
  papers: () => <><ZoteroSettings/><ScholarlySourcesSettings/></>,
};

let cache: PluginInfo[] | null = null;
export async function loadPlugins() {
  cache = await api<PluginInfo[]>('/plugins');
  return cache;
}

/** Plugins for the settings navigation; the list only changes at the next start. */
export function usePlugins() {
  const [plugins, setPlugins] = useState<PluginInfo[]>(cache || []);
  useEffect(() => { if (!cache) void loadPlugins().then(setPlugins).catch(() => setPlugins([])); }, []);
  return plugins;
}

/** Disabled plugin ids saved in the preferences, shared by every plugin page. */
function useDisabledPlugins() {
  const [disabled, setDisabled] = useState<string[] | null>(null);
  useEffect(() => { void api<{ disabled_plugins: string[] }>('/settings/preferences').then(result => setDisabled(result.disabled_plugins || [])).catch(() => setDisabled([])); }, []);
  async function save(next: string[]) {
    const result = await api<{ disabled_plugins: string[] }>('/settings/preferences', { method: 'PATCH', body: JSON.stringify({ disabled_plugins: next }) });
    setDisabled(result.disabled_plugins || []);
  }
  return [disabled, save] as const;
}

const hosts = (connector: PluginConnector) => connector.permissions.filter(item => item.startsWith('network:')).map(item => item.slice(8));

export function PluginSettings({ plugin }: { plugin: PluginInfo }) {
  const runtime = useRuntime();
  const [disabled, saveDisabled] = useDisabledPlugins();
  const [busy, setBusy] = useState(false);
  const wanted = !plugin.removable || (disabled ? !disabled.includes(plugin.id) : plugin.enabled);
  const restartNeeded = disabled !== null && plugin.removable && wanted !== plugin.enabled;
  const status = restartNeeded ? (wanted ? 'On after restart' : 'Off after restart') : plugin.enabled ? 'Active' : 'Off';
  const removable = plugin.collections.filter(collection => collection.removable).map(collection => collection.id);
  const connectors = plugin.connectors.filter(connector => hosts(connector).length);
  const extra = PLUGIN_SETTINGS[plugin.id];

  async function toggle(on: boolean) {
    if (!disabled) return;
    setBusy(true);
    try { await saveDisabled(on ? disabled.filter(id => id !== plugin.id) : [...disabled, plugin.id]); }
    catch (reason) { runtime.toast((reason as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  return <div className="plugin-settings">
    <article className="settings-card plugin-summary">
      <div className="plugin-summary-head">
        <div>
          <span className="plugin-eyebrow">Plugin · v{plugin.version}</span>
          <h3>{plugin.name}</h3>
          <p>{plugin.description}</p>
        </div>
        <span className={`plugin-status ${plugin.enabled && !restartNeeded ? 'active' : restartNeeded ? 'pending' : ''}`}>{status}</span>
      </div>
      <label className="plugin-toggle">
        <input type="checkbox" role="switch" checked={wanted} disabled={!plugin.removable || busy || disabled === null} onChange={event => void toggle(event.target.checked)}/>
        <span>
          <strong>Use this plugin</strong>
          <small>{!plugin.removable
            ? 'Kavot still depends on this plugin, so it cannot be turned off yet.'
            : 'Turning it off hides its views and tools. Its data stays in the workspace and comes back when you turn it on again.'}</small>
        </span>
      </label>
      {restartNeeded && <p className="plugin-restart" role="status">Restart Kavot to apply this change.</p>}
    </article>

    <article className="settings-card">
      <h3>Data</h3>
      <p>Collections this plugin adds to the workspace.</p>
      <ul className="plugin-collections">{plugin.collections.map(collection => <li key={collection.id}>
        <strong>{collection.name}</strong>
        <span>{plugin.enabled ? `${runtime.collectionItems(collection.id).length} items` : 'Kept in the workspace'}</span>
        {!collection.removable && <small>Always available</small>}
      </li>)}</ul>
    </article>

    {plugin.enabled && removable.length > 0 && <section className="plugin-section" aria-label={`${plugin.name} collections`}>
      <h3 className="plugin-section-title">Manage collections</h3>
      <CollectionsSettings include={removable}/>
    </section>}

    {plugin.enabled && extra && <section className="plugin-section" aria-label={`${plugin.name} settings`}>
      <h3 className="plugin-section-title">Connections</h3>
      {extra()}
    </section>}

    {connectors.length > 0 && <article className="settings-card">
      <h3>Network access</h3>
      <p>Services this plugin can contact. Nothing else leaves your computer through it.</p>
      <ul className="plugin-connectors">{connectors.map(connector => <li key={connector.id}><strong>{connector.label}</strong><code>{hosts(connector).join(', ')}</code></li>)}</ul>
    </article>}
  </div>;
}
