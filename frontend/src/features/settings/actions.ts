import { closeModal } from '../../components/dialogs/controller';
import { state } from '../../app/state';
import { showView } from '../../app/viewBridge';

export async function openSettings(tab = 'general') {
  state.settingsTab = tab;
  closeModal();
  window.dispatchEvent(new CustomEvent('kavot:open-settings'));
}

export function renderSettings() { showView('settings'); }
