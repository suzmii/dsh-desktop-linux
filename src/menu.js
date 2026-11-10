/**
 * Application menu. Linux keeps the standard application menu, so the shell
 * exposes only what a hosted web UI cannot provide itself.
 */
import { Menu } from 'electron'

/**
 * @param {object} actions - Callbacks owned by the main process.
 * @param {() => void} actions.reconnect - Re-run discovery and attach.
 * @param {() => void} actions.openSettings - Show the settings panel.
 * @param {() => void} actions.openInBrowser - Open the target in the system browser.
 * @param {() => void} actions.openPairing - Show the phone/tablet pairing QR panel.
 * @param {() => void} actions.openLogs - Show the shell log.
 * @param {() => void} actions.about - Show the About dialog.
 * @param {() => void} actions.refreshMenu - Rebuild this menu after a state change.
 * @param {boolean} actions.launchAtLogin - Current autostart state.
 * @param {(enabled: boolean) => void} actions.setLaunchAtLogin - Toggle autostart.
 * @param {() => void} actions.quit - Quit the whole application.
 * @returns {import('electron').Menu} Application menu.
 */
export function buildApplicationMenu(actions) {
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '重新连接', accelerator: 'CmdOrCtrl+Shift+R', click: () => actions.reconnect() },
        { label: '在浏览器中打开', click: () => actions.openInBrowser() },
        { label: '手机 / 平板配对…', accelerator: 'CmdOrCtrl+Shift+M', click: () => actions.openPairing() },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => actions.openSettings() },
        { label: '打开日志', click: () => actions.openLogs() },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => actions.quit() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载页面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '托盘',
      submenu: [
        {
          label: '开机自启',
          type: 'checkbox',
          checked: actions.launchAtLogin,
          click: (item) => actions.setLaunchAtLogin(item.checked),
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 DSH Desktop (Linux)', click: () => actions.about() },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}
