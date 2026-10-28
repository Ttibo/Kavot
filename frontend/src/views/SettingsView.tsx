import { SharingPanel } from '../components/SharingPanel';
import { TypographySettings } from '../components/TypographySettings';
import { ColorSettings } from '../components/ColorSettings';
import { CollectionsSettings } from '../components/CustomCollectionCreator';
import { templateEditorModal } from '../components/dialogs/controller';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { useRuntime } from '../app/runtime';
import { publish } from '../app/viewBridge';
import { api } from '../services/api';
import { cssVars, PageHeader } from '../components/common';
import { ExternalAgentSettings } from '../components/ExternalAgentSettings';
import { WorkspaceMapSettings } from '../components/WorkspaceMapSettings';
import { CloudSyncSettings } from '../components/CloudSyncSettings';
import { ProjectArchiveSettings } from '../components/ProjectArchiveSettings';
import { ScriptLibrarySettings } from '../components/ScriptLibrarySettings';
import { WorkspaceBackupsSettings } from '../components/WorkspaceBackupsSettings';
import { PluginSettings, usePlugins } from '../components/PluginSettings';

type Section = { id: string; title: string; description: string };
const PLUGIN_PREFIX = 'plugin:';
const WORKSPACE: Section[] = [
  { id: 'general', title: 'General', description: 'Theme, colors, text size, sample data' },
  { id: 'databases', title: 'Collections', description: 'Your own collections' },
  { id: 'templates', title: 'Templates', description: 'Cards and article notes' },
  { id: 'scripts', title: 'Scripts', description: 'Note scripts, network access' },
];
const AI: Section[] = [{ id: 'llm', title: 'AI and agents', description: 'Agent tools, workspace map' }];
const DATA: Section[] = [
  { id: 'storage', title: 'Storage and backups', description: 'Local folder, sync, backups' },
  { id: 'sharing', title: 'Sharing', description: 'Shares received and sent' },
  { id: 'archive', title: 'Archive', description: 'Archived and deleted projects, archived tasks' },
];
/** Older section ids still used by links elsewhere in the app. */
const ALIASES: Record<string, string> = { cloud: 'storage', integrations: `${PLUGIN_PREFIX}papers` };
const settingsTab = (tab: string) => ALIASES[tab] || tab;

export function SettingsView() {
  const runtime = useRuntime(); const { state } = runtime;
  const plugins = usePlugins();
  const [tab, setTab] = useState(settingsTab(state.settingsTab));
  useEffect(() => setTab(settingsTab(state.settingsTab)), [state.settingsTab]);
  const [storage, setStorage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { const controller = new AbortController(); api<{ path: string }>('/settings/storage', { signal: controller.signal }).then(result => setStorage(result.path)).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }); return () => controller.abort(); }, []);
  async function changeTheme(theme: string) {
    try { await api('/settings/preferences', { method: 'PATCH', body: JSON.stringify({ theme }) }); state.theme = runtime.setInterfaceTheme(theme, false); publish(); }
    catch (reason) { runtime.toast((reason as Error).message, 'error'); }
  }
  async function changeStorage() {
    const next = window.pywebview?.api?.pick_storage_folder ? await window.pywebview.api.pick_storage_folder() : window.prompt('Full path of the new storage folder:', storage);
    if (!next) return;
    setBusy(true);
    try { const result = await api<{ path: string }>('/settings/storage', { method: 'POST', body: JSON.stringify({ path: next }) }); setStorage(result.path); await runtime.refreshData(); window.dispatchEvent(new Event('kavot:storage-updated')); runtime.toast('Storage location updated'); }
    catch (reason) { runtime.toast((reason as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  const groups = [
    { id: 'workspace', label: 'Workspace', sections: WORKSPACE },
    { id: 'ai', label: 'AI', sections: AI },
    { id: 'plugins', label: 'Plugins', sections: plugins.map(plugin => ({ id: PLUGIN_PREFIX + plugin.id, title: plugin.name, description: plugin.enabled ? plugin.collections.map(collection => collection.name).join(', ') : 'Off' })) },
    { id: 'data', label: 'Your data', sections: DATA },
  ].filter(group => group.sections.length);
  const order = groups.flatMap(group => group.sections.map(section => section.id));
  const plugin = tab.startsWith(PLUGIN_PREFIX) ? plugins.find(item => PLUGIN_PREFIX + item.id === tab) : undefined;
  const pluginCollections = plugins.flatMap(item => item.collections.map(collection => collection.id));

  function select(id: string) { setTab(id); state.settingsTab = id; }
  function onNavKey(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = order.indexOf(tab);
    const next = order[event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length];
    select(next);
    document.querySelector<HTMLElement>(`[data-settings-section="${CSS.escape(next)}"]`)?.focus();
  }

  return <div className="settings-page"><PageHeader title="Settings" description="Your workspace, the plugins that extend it, and where your data lives."/>
  <nav className="settings-tabs" aria-label="Settings sections" onKeyDown={onNavKey}>{groups.map(group => <div key={group.id} className="settings-nav-group" role="group" aria-labelledby={`settings-group-${group.id}`}>
    <span className="settings-nav-label" id={`settings-group-${group.id}`}>{group.label}</span>
    {group.sections.map(section => <button key={section.id} data-settings-section={section.id} aria-current={tab === section.id ? 'page' : undefined} tabIndex={tab === section.id || (!order.includes(tab) && section.id === order[0]) ? 0 : -1} className={tab === section.id ? 'active' : ''} onClick={() => select(section.id)}><div><strong>{section.title}</strong><small>{section.description}</small></div></button>)}
  </div>)}</nav>
  <div className="settings-panels"><section className="settings-section" aria-label={groups.flatMap(group => group.sections).find(section => section.id === tab)?.title || 'Settings'}>
  {tab === 'general' && <><article className="settings-card"><h3>Interface theme</h3><p>Your choice is saved on this device.</p><div className="theme-choice" role="group" aria-label="Interface theme">{['light', 'dark'].map(theme => <button key={theme} className={state.theme === theme ? 'active' : ''} aria-pressed={state.theme === theme} onClick={() => void changeTheme(theme)}><span aria-hidden="true">{theme === 'light' ? '☀' : '◐'}</span><strong>{theme === 'light' ? 'Light' : 'Dark'}</strong></button>)}</div></article><ColorSettings/><TypographySettings/><article className="settings-card"><h3>Sample data</h3><p>Load a demo project with tasks, articles and notes.</p><button className="button" data-action="load-demo" disabled={state.projects.length > 0}>Load sample data</button></article></>}
  {tab === 'databases' && <CollectionsSettings exclude={pluginCollections}/>}
  {tab === 'templates' && <>
    <header><h3>Card templates</h3><p>Create reusable cards with default content, an icon and a color.</p><button className="button button-primary" onClick={() => templateEditorModal()}>＋ New template</button></header>
    <div className="template-manager-list">{state.noteTemplates.map((template: any) => <article key={template.id} className="template-manager-item" style={cssVars({ '--template-color': template.color || '#087e86' })}>
      <div><span className={`template-state ${template.is_article_default ? 'automatic' : ''}`}>{template.archived ? 'Archived · existing cards kept' : template.is_article_default ? "Default article note" : 'Card template'}</span><strong><i className="template-color-dot"/>{template.name}</strong><small>{template.title_template}</small></div>
      <div className="form-actions"><button className="button button-small" onClick={() => templateEditorModal(template.id)}>Edit</button><button className="button button-small" onClick={() => templateEditorModal(template.id, true)}>Duplicate</button><button className="button button-small" onClick={async () => { try { await api(`/note-templates/${template.id}`, { method: 'PATCH', body: JSON.stringify({ archived: !template.archived }) }); await runtime.refreshData(); } catch (reason) { runtime.toast((reason as Error).message, 'error'); } }}>{template.archived ? 'Restore' : 'Archive'}</button></div>
    </article>)}</div>
  </>}
  {tab === 'scripts' && <ScriptLibrarySettings/>}
  {tab === 'archive' && <ProjectArchiveSettings/>}
  {tab === 'llm' && <><ExternalAgentSettings/><WorkspaceMapSettings/></>}
  {plugin && <PluginSettings key={plugin.id} plugin={plugin}/>}
  {tab.startsWith(PLUGIN_PREFIX) && !plugin && <p role="status">{plugins.length ? 'This plugin is not installed.' : 'Loading plugins…'}</p>}
  {tab === 'storage' && <><CloudSyncSettings storageBusy={busy} localStorage={<article className="settings-card storage-location-card"><div className="storage-card-heading"><span className="storage-card-icon" aria-hidden="true">▣</span><div><span className="storage-eyebrow">On this device</span><h3>Local folder</h3></div></div><p>Your documents stay available on this device, even offline.</p><span className="storage-field-label">Current location</span>{error ? <p role="alert">{error}</p> : <div className="storage-path">{storage || 'Loading…'}</div>}<div className="form-actions"><button className="button" disabled={busy || !storage} onClick={() => void changeStorage()}>{busy ? 'Moving…' : 'Change folder…'}</button></div><p className="settings-hint">Your files will be moved to the new folder. Choose an empty folder.</p></article>}/><WorkspaceBackupsSettings/></>}
  {tab === 'sharing' && <SharingPanel/>}
  </section></div></div>;
}
