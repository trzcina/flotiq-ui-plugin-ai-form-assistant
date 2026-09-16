import { registerFn } from '../common/plugin-element-cache';
import pluginInfo from '../plugin-manifest.json';
import cssString from 'inline:./styles/style.css';
import { registerFormAssistant } from './form-assistant';
import { registerPluginSettings } from './settings';

registerFn(pluginInfo, (handler, client, globals) => {
  /**
   * Add plugin styles to the head of the document
   */
  if (!document.getElementById(`${pluginInfo.id}-styles`)) {
    const style = document.createElement('style');
    style.id = `${pluginInfo.id}-styles`;
    style.textContent = cssString;
    document.head.appendChild(style);
  }

  registerFormAssistant(handler, client, globals, pluginInfo);
  registerPluginSettings(handler);
});
