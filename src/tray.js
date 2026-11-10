/**
 * Tray presence: the shell stays reachable while the window is hidden.
 *
 * Linux trays are implementation-specific (StatusNotifierItem or XEmbed), so
 * the menu repeats every action that matters; a single click only focuses the
 * window where the desktop environment delivers click events at all.
 */
import { Menu, Tray } from 'electron'

/**
 * @param {object} options - Tray wiring.
 * @param {string} options.iconPath - Absolute PNG icon path.
 * @param {object} options.actions - Callbacks owned by the main process.
 * @param {() => boolean} options.actions.isWindowVisible - Whether the window is shown.
 * @param {() => void} options.actions.showWindow - Show and focus the window.
 * @param {() => void} options.actions.hideWindow - Hide the window.
 * @param {() => void} options.actions.reconnect - Re-run discovery and attach.
 * @param {() => void} options.actions.openSettings - Show the settings panel.
 * @param {() => void} options.actions.openInBrowser - Open the target in the system browser.
 * @param {() => void} options.actions.openPairing - Show the phone/tablet pairing QR panel.
 * @param {() => void} options.actions.refreshTray - Rebuild the tray menu after a state change.
 * @param {boolean} options.launchAtLogin - Current autostart state.
 * @param {(enabled: boolean) => void} options.actions.setLaunchAtLogin - Toggle autostart.
 * @param {() => void} options.actions.quit - Quit the whole application.
 * @returns {{ tray: Tray, refresh: () => void, destroy: () => void }} Tray handle.
 */
export function createTray({ iconPath, actions }) {
  const tray = new Tray(iconPath)
  tray.setToolTip('DSH Desktop')
  const refresh = () => {
    const visible = actions.isWindowVisible()
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const template = [
      { label: visible ? '隐藏窗口' : '显示窗口', click: () => (visible ? actions.hideWindow() : actions.showWindow()) },
      { type: 'separator' },
      { label: '重新连接', click: () => actions.reconnect() },
      { label: '设置…', click: () => actions.openSettings() },
      { label: '在浏览器中打开', click: () => actions.openInBrowser() },
      { label: '手机 / 平板配对…', click: () => actions.openPairing() },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: actions.launchAtLogin,
        click: (item) => actions.setLaunchAtLogin(item.checked),
      },
      { type: 'separator' },
      { label: '退出', click: () => actions.quit() },
    ]
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }
  refresh()
  tray.on('click', () => {
    if (actions.isWindowVisible()) actions.hideWindow()
    else actions.showWindow()
  })
  tray.on('double-click', () => actions.showWindow())
  return {
    tray,
    refresh,
    destroy: () => tray.destroy(),
  }
}
