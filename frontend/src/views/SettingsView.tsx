import { SharingPanel } from '../components/SharingPanel';
import { TypographySettings } from '../components/TypographySettings';
import { ColorSettings } from '../components/ColorSettings';
import { templateEditorModal } from '../components/dialogs/controller';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { useRuntime } from '../app/runtime';
import { publish } from '../app/viewBridge';
import { api } from '../services/api';
import { cssVars } from '../components/common';
import { Icon } from '../components/Icon';
import '../styles/pages/settings.css';
import { ExternalAgentSettings } from '../components/ExternalAgentSettings';
import { WorkspaceMapSettings } from '../components/WorkspaceMapSettings';
import { CloudSyncSettings } from '../components/CloudSyncSettings';
import { ProjectArchiveSettings } from '../components/ProjectArchiveSettings';
import { ScriptLibrarySettings } from '../components/ScriptLibrarySettings';
import { WorkspaceBackupsSettings } from '../components/WorkspaceBackupsSettings';
import { ScholarlySourcesSettings } from '../components/ScholarlySourcesSettings';
import { ZoteroSettings } from '../components/ZoteroSettings';

type Section = { id: string; title: string; description: string; icon: string };
const WORKSPACE: Section[] = [
  { id: 'general', title: 'Appearance', description: 'Theme, colors and text size of the interface.', icon: 'eye' },
  { id: 'library', title: 'Library', description: 'Zotero and the scholarly sources used to find and import articles.', icon: 'papers' },
  { id: 'templates', title: 'Templates', description: 'Reusable cards and the default note of an article.', icon: 'notes' },
  { id: 'scripts', title: 'Scripts', description: 'Scripts available in notes, and their network access.', icon: 'code' },
];
const AI: Section[] = [{ id: 'llm', title: 'Agents', description: 'The agent tools installed on this computer, and the map of the workspace they read.', icon: 'agents' }];
const DATA: Section[] = [
  { id: 'storage', title: 'Storage', description: 'Where your files live, their sync and their backups.', icon: 'local' },
  { id: 'sharing', title: 'Sharing', description: 'What you shared and what was shared with you.', icon: 'link' },
  { id: 'archive', title: 'Archive', description: 'Archived and deleted projects, archived tasks.', icon: 'archive' },
];
/** Older section ids still used by links elsewhere in the app. */
const ALIASES: Record<string, string> = { cloud: 'storage', integrations: 'library', 'plugin:papers': 'library', databases: 'general' };
const settingsTab = (tab: string) => ALIASES[tab] || tab;

export function SettingsView() {
  const runtime = useRuntime(); const { state } = runtime;
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
    { id: 'ai', label: 'Agents', sections: AI },
    { id: 'data', label: 'Your data', sections: DATA },
  ].filter(group => group.sections.length);
  const order = groups.flatMap(group => group.sections.map(section => section.id));

  function select(id: string) { setTab(id); state.settingsTab = id; }
  function onNavKey(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = order.indexOf(tab);
    const next = order[event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length];
    select(next);
    document.querySelector<HTMLElement>(`[data-settings-section="${CSS.escape(next)}"]`)?.focus();
  }

  const current = groups.flatMap(group => group.sections).find(section => section.id === tab) || groups[0].sections[0];
  return <div className="sv">
  <nav className="sv-nav" aria-label="Settings sections" onKeyDown={onNavKey}>
    <h2>Settings</h2>
    {groups.map(group => <div key={group.id} className="sv-nav-group" role="group" aria-labelledby={`settings-group-${group.id}`}>
      <span className="sv-nav-label" id={`settings-group-${group.id}`}>{group.label}</span>
      {group.sections.map(section => <button key={section.id} type="button" data-settings-section={section.id} aria-current={tab === section.id ? 'page' : undefined}
        tabIndex={tab === section.id || (!order.includes(tab) && section.id === order[0]) ? 0 : -1} className={tab === section.id ? 'active' : ''} onClick={() => select(section.id)}>
        <Icon name={section.icon} size={15}/><span>{section.title}</span></button>)}
    </div>)}
  </nav>
  <div className="sv-main"><header className="sv-head"><h1>{current.title}</h1><p>{current.description}</p></header>
  <section className="sv-body settings-section" aria-label={current.title}>
  {tab === 'general' && <><article className="settings-card"><h3>Interface theme</h3><p>Your choice is saved on this device.</p><div className="theme-choice" role="group" aria-label="Interface theme">{['light', 'dark'].map(theme => <button key={theme} className={state.theme === theme ? 'active' : ''} aria-pressed={state.theme === theme} onClick={() => void changeTheme(theme)}><span aria-hidden="true">{theme === 'light' ? '☀' : '◐'}</span><strong>{theme === 'light' ? 'Light' : 'Dark'}</strong></button>)}</div></article><ColorSettings/><TypographySettings/><article className="settings-card"><h3>Sample data</h3><p>Load a demo project with tasks, articles and notes.</p><button className="button" data-action="load-demo" disabled={state.projects.length > 0}>Load sample data</button></article></>}
  {tab === 'library' && <><ZoteroSettings/><ScholarlySourcesSettings/></>}
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
  {tab === 'storage' && <><CloudSyncSettings storageBusy={busy} localStorage={<article className="settings-card storage-location-card"><div className="storage-card-heading"><span className="storage-card-icon" aria-hidden="true">▣</span><div><span className="storage-eyebrow">On this device</span><h3>Local folder</h3></div></div><p>Your documents stay available on this device, even offline.</p><span className="storage-field-label">Current location</span>{error ? <p role="alert">{error}</p> : <div className="storage-path">{storage || 'Loading…'}</div>}<div className="form-actions"><button className="button" disabled={busy || !storage} onClick={() => void changeStorage()}>{busy ? 'Moving…' : 'Change folder…'}</button></div><p className="settings-hint">Your files will be moved to the new folder. Choose an empty folder.</p></article>}/><WorkspaceBackupsSettings/></>}
  {tab === 'sharing' && <SharingPanel/>}
  </section></div></div>;
}
