import { closeModal } from '../../components/dialogs/controller';
import { state } from '../../app/state';

export async function openSettings(tab = 'general') {
  state.settingsTab = tab;
  closeModal();
  window.dispatchEvent(new CustomEvent('kavot:open-settings'));
}
