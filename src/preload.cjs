/**
 * Preload for the shell's own pages (unavailable, settings, auth).
 *
 * Only these local pages get this bridge; the hosted dsh UI runs in the same
 * window without it, so dsh never sees shell IPC.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshShell', {
  /** @returns {Promise<object>} Current attach state. */
  getState: () => ipcRenderer.invoke('shell:state'),
  /** Re-run discovery and attach. */
  retry: () => ipcRenderer.send('shell:retry'),
  /** @param {string} url Tokenized `dsh web:` URL @returns {Promise<object>} QR payload. */
  generatePairing: (url) => ipcRenderer.invoke('pair:generate', url),
  /** @param {string} text Text to copy @returns {Promise<boolean>} Whether it was copied. */
  copyText: (text) => ipcRenderer.invoke('pair:copy', text),
  /** Open the shell log file. */
  openLogs: () => ipcRenderer.send('shell:open-logs'),
  /** Open the settings panel from the unavailable page. */
  openSettings: () => ipcRenderer.send('shell:open-settings'),
  /** Quit the whole application. */
  quit: () => ipcRenderer.send('shell:quit'),
  /** @param {{ url: string, autoAuth: boolean, closeToTray: boolean, launchAtLogin: boolean, startHidden: boolean }} value */
  saveSettings: (value) => ipcRenderer.invoke('shell:save-settings', value),
  /** @returns {Promise<{ candidates: string[], error: string | null }>} Probe-based discovery results. */
  detect: () => ipcRenderer.invoke('shell:detect'),
  /** Close the modal panel without applying anything. */
  closePanel: () => ipcRenderer.send('panel:close'),
  /** @param {string} url Tokenized `dsh web:` URL */
  submitAuth: (url) => ipcRenderer.invoke('shell:submit-auth', url),
  /**
   * Subscribe to retry status updates.
   * @param {(status: { attempt: number, nextRetryMs: number, message: string }) => void} listener Status listener.
   * @returns {() => void} Unsubscribe.
   */
  onRetryStatus: (listener) => {
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('shell:retry-status', handler)
    return () => ipcRenderer.removeListener('shell:retry-status', handler)
  },
})
