# DSH Desktop (Linux)

一个**只连你自己启动的 dsh web** 的轻量桌面壳：不打包 dsh、不自带 Node、不启动第二个 host、不写 `~/.dsh`。
把 `dsh web` 已经在跑的那个 Web UI 装进一个原生窗口，补上托盘、开机自启、断线自动重连、窗口/缩放记忆，
再给手机/平板生成一张配对二维码。

## 为什么不是官方的 `apps/desktop`

官方仓库确实带一个 Electron 桌面端，但它与「复用已经跑起来的 dsh」方向相反：

- 打包目标只有 `mac-arm64` / `mac-x64` / `win-x64`，`apps/desktop/packaging/README.md` 原话是
  *"Linux is not a supported Desktop release target."*；
- 它**独占** `$DSH_HOME/profiles/desktop`、自己用 Electron Node 模式拉起 host 进程，有单实例锁；
- 社区的「官方壳 Linux 移植」项目（AppImage/deb/pacman 若干）都保留了这个自带 host 的模型。

所以这里没有 fork 官方仓库，而是写一个 ~1000 行的 attach 壳：启动 → 发现本机 `dsh … web` 监听端口 →
用 dsh 持久化的 browser-session secret 直接签会话 cookie → 把那个 URL 装进窗口。

## 功能

| 能力 | 说明 |
|---|---|
| 自动发现 | `ss -tlnp` 找出本地监听端口，用 `/proc/<pid>/cmdline` 只保留 `dsh … web` 进程持有的端口，再探测根路径指纹（200 的 dsh 页面或 401 认证提示） |
| 自动鉴权 | 读 `$DSH_HOME/.credentials.yaml` 里 `client-connection/browser-session` 的 32 字节 secret，按 dsh 的 `v1` cookie 格式 HMAC 签名；secret 只读，不复制 |
| 失败回退 | cookie 被拒时弹出「粘贴 dsh 启动时打印的 `?token=` 地址」，换取手机/桌面自己的 30 天 cookie，token 不落盘 |
| 托盘常驻 | 点 × 最小化到托盘（首次提示），托盘菜单可显示/隐藏、重连、设置、配对、开机自启、退出 |
| 开机自启 | 写 `$XDG_CONFIG_HOME/autostart/dsh-desktop.desktop`，以 `--hidden` 启动，只留托盘 |
| 断线重连 | 找不到服务时显示本地说明页并每 8 秒重试；连上后自动进入 |
| 桌面细节 | 窗口位置/大小/缩放记忆、外链走系统浏览器、下载走保存对话框、单实例、日志 |
| 手机 / 平板 | 见下方「手机与平板」：不需要 APK，配对二维码 + Chrome PWA |
| 发行包 | AppImage、deb、Arch pacman 包（`makepkg` 产出 `.pkg.tar.zst`），外加一键写应用菜单的脚本 |

## 安装

### AppImage（Arch 等发行版，推荐）

```sh
npm run dist                       # 产出 dist/*.AppImage 与 deb
chmod +x "dist/DSH Desktop-0.1.0.AppImage"
"./dist/DSH Desktop-0.1.0.AppImage"
scripts/install-desktop-entry.sh   # 复制到 ~/.local/bin 并写入应用菜单
```

若系统没有 FUSE2，可 `./DSH\ Desktop-0.1.0.AppImage --appimage-extract-and-run` 或在
`scripts/install-desktop-entry.sh` 的 Exec 里加该参数。

### deb（Debian / Ubuntu）

```sh
sudo apt install ./dist/dsh-desktop-linux_0.1.0_amd64.deb
```

### pacman（Arch Linux，原生包）

`packaging/arch/PKGBUILD` 把 electron-builder 的 `dist/linux-unpacked` 重新打成标准 Arch 包
（装到 `/opt/dsh-desktop-linux`，带 `/usr/bin/dsh-desktop` 启动器、`.desktop` 与 hicolor 图标）：

```sh
npm run dist                                   # 先生成 dist/linux-unpacked
cd packaging/arch && makepkg -f                # 产出 dsh-desktop-linux-0.1.0-1-x86_64.pkg.tar.zst
sudo pacman -U dsh-desktop-linux-0.1.0-1-x86_64.pkg.tar.zst
```

- 包信息：压缩后 ~114 MiB、安装后 ~276 MiB，运行时依赖见 PKGBUILD（gtk3、nss、libsecret、alsa-lib 等，不依赖 Node/dsh）。
- 卸载：`sudo pacman -Rns dsh-desktop-linux`。
- 与 AppImage 的菜单项会重复，切换前先 `scripts/install-desktop-entry.sh --remove`。
- 只打了 `x86_64`。arm64 需先 `npx electron-builder --linux --arm64`，再把 PKGBUILD 的 `arch` 改成 `('aarch64')` 重打。
- 这是本机重打包，不是 AUR 包：没有 pkgbuild 源拉取、没有签名；要上 AUR 需要把源码/产物放到可校验的 `source` 并补 `sha256sums`。

### 首次运行前

壳本身没有运行时依赖，但需要本机已装 dsh（`npm i -g @deepseek-ai/dsh` 或 bun 全局安装均可）
并且**已经在跑** Web 服务，例如：

```sh
dsh web --host 192.168.1.10 --port 47827
# 或默认
dsh web
```

## 使用

1. 启动 dsh web，记下终端打印的 `dsh web: http://…` 那一行（只有这一行带 token）。
2. 启动壳。它会自动找到刚启动的 dsh web 并直接进入；找不到时显示说明页并自动重试。
3. 需要固定地址、关掉自动鉴权、关闭最小化到托盘等，用菜单 **文件 → 设置…**（`Ctrl+,`）。
4. 点 × 后窗口隐藏到托盘；托盘菜单 → 退出 才真正结束。

### 鉴权是怎么工作的

`dsh web` 每次启动都会在内存里生成一个 launch token，打印在 URL 的 `?token=` 上；浏览器打开后
用 token 换一个绑定 `host:port` 的签名 cookie（默认 30 天）。壳拿不到那个 token，但 dsh 把
**签名密钥**持久化在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录里，
格式是：

```
name  = dsh-auth-<base64url(sha256(authority))>
value = v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>
```

壳只读取这条记录（`0600`，不修改），为本机 authority 签一个 29 天的 cookie 注入 Electron 会话。
因此 dsh 重启、端口不变时依然免 token；只有 `cookieMaxAgeDays` 被改小、或 secret 记录被替换时，
才会回退到粘贴 token 地址。把地址发给别人等于把会话发出去，注意别公开。

## 手机与平板

Android / iOS 上 Electron 跑不了，也不需要另写 App：dsh 自带的就是响应式 PWA
（`manifest.webmanifest`、`display: standalone`、适合安装的图标）。壳负责把「配对」这一步变简单：

1. 桌面菜单 **文件 → 手机 / 平板配对…**（`Ctrl+Shift+M`）；
2. 粘贴 dsh 打印的 `?token=` 地址 → 生成二维码；
3. 用手机相机扫码打开，跳转到不带 token 的地址后，浏览器菜单里「添加到主屏幕 / 安装应用」；
4. 之后从主屏图标启动即可，cookie 约 30 天后过期再配对一次。

前提是手机能连到电脑：`dsh web --host <局域网地址>` 绑定的就是手机要访问的地址（当前示例是
`192.168.1.10:47827`）；不在同一网段就自己做端口转发。

验证方式（仓库不附带真实会话截图）：配对面板用壳的 `DSH_DESKTOP_SMOKE_PANEL=pair` 冒烟模式实际渲染并
断言 `QR_RENDERED`；手机/平板布局是在 390×844 与 1024×768 视口下打开同一台机器的 dsh web 实测
（窄屏自动切成底部输入栏 + 折叠侧栏，平板保留侧栏）；壳本身也在这两个视口下能做完整 attach
（`npm start -- --size=390x844`）。

## 跨平台状态（如实）

| 平台 | 状态 |
|---|---|
| Linux (X11 / Wayland) | 完整：发现、鉴权、托ray、自启、打包、真机验证 |
| macOS / Windows | Electron 代码本身可运行，但发现逻辑（`ss` + `/proc`）是 Linux 专用；托盘、XDG 自启也未适配。只能靠设置里填地址 + 默认 3080，**未验证** |
| Android / iOS | 用 dsh 自带 PWA + 配对二维码（本仓库提供二维码生成），不提供原生壳 |
| WSL | 未验证 |

如果之后要「三端原生壳」，建议另立项目复用本仓库的鉴权/配对思路，而不是把 Android 塞进 Electron。

## 已知限制

- `cookieMaxAgeDays` 小于 29 天时自动鉴权会 401 → 改用 token 地址（壳会提示）。
- dsh 换端口 / 换网卡地址后，旧 cookie 失效，需要重新配对或粘贴新 token 地址。
- 手机端 cookie 由手机浏览器持有；PWA 无法注入 cookie，所以配对必须粘贴一次带 token 的地址。
- 未做系统托盘的环境下点 × 会真正退出（壳会检测托盘是否创建成功）。
- 三种发行包都未签名、未做应用内更新；AppImage 依赖 FUSE2 或 `--appimage-extract-and-run`。
- pacman 包只覆盖 x86_64，且从本机 `dist/linux-unpacked` 重打包，不经 AUR。
- Electron 在 Wayland 下可能打印 `--ozone-platform=wayland not compatible with Vulkan` 警告，不影响使用。
- `package.json` 的 `homepage` 是占位地址，发布前请改成实际仓库地址。

## 开发

```sh
npm install
# 首次若没下到 Electron 二进制：
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js

npm start                     # 开发运行
npm test                      # 45 个单测（config/auth/discovery/attach/pair/args/autostart）
npm run sync-assets           # 从已安装的 dsh 前端同步图标
DSH_DESKTOP_SMOKE_SHOT=/tmp/shot.png npm start    # 冒烟：连上后截图并退出
DSH_DESKTOP_SMOKE_PANEL=pair DSH_DESKTOP_SMOKE_SHOT=/tmp/shot.png npm start   # 连上后渲染配对二维码并断言
npm run dist                  # AppImage + deb
cd packaging/arch && makepkg -f  # Arch pacman 包
```

冒烟模式会读取运行中的 dsh web，写一张截图并输出 `{ok,title,url,text}`，退出码即成败，可用于回归。

### 目录

```
src/
  main.js        Electron 主进程：窗口、托盘、菜单、重连、IPC、冒烟
  config.js      $XDG_CONFIG_HOME/dsh-desktop-linux/config.json（原子写、0600）
  attach.js      候选探测 → 选目标；401 时报告 auth-required
  auth.js        从 .credentials.yaml 读 secret + 签 dsh v1 cookie
  discovery.js   ss 解析、/proc 进程识别、无代理 HTTP 指纹探测
  pair.js        手机/平板配对 URL 校验 + 二维码 SVG
  autostart.js   XDG autostart 条目
  menu.js/tray.js
  ui/            settings / unavailable / auth / pair 四个本地页面
  preload.cjs    仅壳页面可用的 IPC 桥
tests/           node:test 单测
scripts/         sync-assets、install-desktop-entry
```

## 安全说明

- 只**读** `$DSH_HOME/.credentials.yaml`，不写入、不复制 secret；
- token 不落盘，只在内存里换一次 cookie；设置的 URL 会去掉 `?token=` 后保存；
- cookie 只注入 Electron 自己的 session，且 `httpOnly`、`sameSite=strict`，有效期 29 天；
- 壳页面（settings/auth/pair/unavailable）之外无法访问 IPC；托管页面拿不到 Node 能力；
- 外链一律交给系统浏览器，不在壳内打开。
