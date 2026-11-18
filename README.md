# dsh-connect-mobile（手机工作台）

把 Android 手机接进 DSH：电脑侧 bridge（起/停/查）、通道清单、在手机 DSH 页面里执行 JS、以及随附的 **DSH Mobile 纯净版 APK**。

## APK 在哪

`dist/dsh-mobile-clean.apk`（317 MB）**不在 git 历史里** —— 它超出 GitHub 单文件 100 MB 硬限，而 GitHub LFS 的上传域 `github-cloud.s3.amazonaws.com` 在本机网络整段不可达。APK 改挂在 Release：

- 下载：<https://github.com/terryvvan/dsh-connect-mobile/releases/tag/v0.8.309-clean>
- 版本 / 字节数 / SHA-256 见 [`dist/apk-version.json`](dist/apk-version.json)
- 下载后放回本目录的 `dist/dsh-mobile-clean.apk`，插件面板的 `phone_apk` 与「下载 APK」才会用到它（插件其余功能不依赖）
- 也可以自己构建：`pwsh -File D:\dsh-mobile\tools\build-clean.ps1 -Bump`（产物直接落到 `dist/`）

## 装

```powershell
# 1) 放进 profile 的插件目录（或用 dsh plugin add）
#    本项目用的是 link 依赖，所以直接链过去即可
$profile = "$env:USERPROFILE\.dsh\profiles\web"
New-Item -ItemType Directory -Force "$profile\local-plugins" | Out-Null
cmd /c mklink /J "$profile\local-plugins\dsh-connect-mobile" "D:\plugin\dsh\dsh-connect-mobile"
```

然后把包名加进两处（缺一处都装不上）：

- `$profile\package.json` → `dependencies` 里加 `"dsh-connect-mobile": "link:./local-plugins/dsh-connect-mobile"`
- `$profile\package.json` → `dsh.profile.bundles` 数组里加 `"dsh-connect-mobile"`（**这才是激活开关**）

重启内核（DSH 桌面版：文件 → 重启；或关掉重开）后，插件页能看到 `dsh-connect-mobile`。

## 提供给 agent 的工具

| 工具 | 作用 |
|---|---|
| `phone_bridge` | `op=start` 起 bridge 子进程、`stop` 停、`status` 查端口/可达/accessKey |
| `phone_channels` | 列出手机能用的通道（局域网 / Tailscale / ngrok / Cloudflare）与对应地址 |
| `phone_eval` | 在手机当前 DSH 页面里跑一段 JS（读会话正文、点按钮、切访问模式） |
| `phone_apk` | 列出 `dist/` 里随附的纯净版 APK（版本、大小、路径） |

## 手机侧怎么接

1. 把 `dist/dsh-mobile-clean.apk` 装到手机上（没有就从上面 Release 下，或自己构建；也可用 `adb install -r -d`）。
2. 打开 App → 「配置桥接地址」→ 扫码 / 填 `phone_bridge` 报的地址（默认 `http://<电脑 IP>:8787`，也可用 Tailscale 域名）。
3. 首次同步后会下发人设/插件/记忆核心；纯净版自带 `dsh-memory-core`（无知识卡）、`dsh-purge`（红队模式）、`dsh-prompt-manager`，并带 Mika 的 71 份 App/网站知识库。

## 纯净版与常规版的区别（同一份源码，两套资产）

| 项 | 常规版 | 纯净版 |
|---|---|---|
| 人设 preset（`persona-preset.yml`） | 有 | 无 |
| 破甲注入（`prompt-inject.md`） | 有 | 无 |
| 桌宠素材（`pet.js` / `pet.html`） | 有 | 无 |
| 记忆核心知识卡 | 用你的 vault | 空 vault |
| App/网站知识库 | 71 份 | 71 份 |
| 预置插件 | 无（靠同步） | memory-core / purge / prompt-manager 随包 |
| 虚拟屏默认 | 开 | 关 |
| 授权与用户数据 | 你的 | 全新 |

构建：`pwsh -File D:\dsh-mobile\tools\build-clean.ps1 -Bump`（产物写到本目录 `dist/`）。

## 配置

`bridge/config.json`（bridge 自己读写，含 `port` / `accessKey` / 连接密码哈希）。**随包只带 `{ "port": 8787 }`** —— 首次 `phone_bridge op=start` 时 bridge 自己生成 `accessKey`，不会带上别人的凭据。

`bridge/server.cjs` 是 CommonJS（本包 `type: module`，所以 `.js` 会被当 ESM 而不是 CJS 跑，必须留 `.cjs` 后缀）；`ft.cjs` 同理，`server.cjs` 里 `require('./ft.cjs')` 已对齐。`bridge/node_modules/qrcode-generator` 随包带，别依赖宿主的 node_modules。

`cordis.patch.yml` 里的 `autoStart: true` 可让 bridge 随 DSH 启动自动拉起（默认 false，用 `phone_bridge` 手动起）。

## 排错

- `phone_bridge status` 报「可达: 否」：端口被占/防火墙拦；先看 `bridge/bridge.log`。
- `phone_eval` 报「下发失败」：手机 DSH 不在前台，或手机端填的桥接地址不是这台电脑。
- 插件装了但插件页没有：`package.json` 的 `dsh.profile.bundles` 没加（这一步才是激活）。
