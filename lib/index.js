// dsh-connect-mobile — 插件入口（宿主半）
//
// 设计要点（与 dsh-memory-core / dsh-prompt-manager 同一套兼容策略）：
//   * inject 不要写 'tools'：DSH 0.2.2 里它不是可 inject 的服务名，写进去 fiber 会永久 pending；
//     一律 serviceOf(ctx,'tools') 惯性取 + typeof 守卫 + 轮询等待（全新 profile 上 tools 来得晚）。
//   * 不依赖任何一版 settings API；bridge 配置自持于 <plugin>/bridge/config.json（bridge 自己读写）。
//   * bridge 是独立子进程（bridge/server.js），本插件只负责起/停/查询与转发，崩了不影响宿主。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'connect-mobile'
export const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BRIDGE_DIR = path.join(ROOT, 'bridge')
const BRIDGE_ENTRY = path.join(BRIDGE_DIR, 'server.cjs')
const BRIDGE_CONFIG = path.join(BRIDGE_DIR, 'config.json')
const DIST_DIR = path.join(ROOT, 'dist')

const VERSION = '0.1.0'

let child = null
let registered = false

function log(msg) {
  console.log('[connect-mobile] ' + msg)
}

function serviceOf(ctx, serviceName) {
  try {
    const get = typeof ctx?.get === 'function' ? ctx.get.bind(ctx) : null
    const v = get ? get(serviceName) : undefined
    if (v) return v
  } catch {}
  try {
    const direct = ctx?.[serviceName]
    if (direct) return direct
  } catch {}
  return undefined
}

function readBridgeConfig() {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_CONFIG, 'utf8'))
  } catch {
    return {}
  }
}

function bridgePort() {
  // 允许用环境变量覆盖：隔离测试时指向自己的端口，避免和用户正在跑的 bridge 抢 8787
  const env = Number(process.env.DSH_CONNECT_MOBILE_PORT)
  if (Number.isFinite(env) && env > 0) return env
  const n = Number(readBridgeConfig().port)
  return Number.isFinite(n) && n > 0 ? n : 8787
}

function accessKey() {
  const k = readBridgeConfig().accessKey
  return typeof k === 'string' ? k : ''
}

function callBridge(method, pathname, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const key = accessKey()
    const sep = pathname.includes('?') ? '&' : '?'
    const url = key ? pathname + sep + 'k=' + encodeURIComponent(key) : pathname
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        host: '127.0.0.1',
        port: bridgePort(),
        path: url,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text, json })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('bridge 响应超时 ' + timeoutMs + 'ms')))
    req.on('error', (e) => resolve({ ok: false, status: 0, text: '', error: e.message }))
    if (payload) req.write(payload)
    req.end()
  })
}

async function bridgeAlive() {
  const r = await callBridge('GET', '/__dshm/ping', undefined, 1500)
  return r.ok
}

function startBridge() {
  if (!fs.existsSync(BRIDGE_ENTRY)) return { ok: false, message: '找不到 bridge/server.js：' + BRIDGE_ENTRY }
  if (child && child.exitCode === null) return { ok: true, message: 'bridge 已在运行（pid ' + child.pid + '）', pid: child.pid }
  const out = fs.openSync(path.join(BRIDGE_DIR, 'bridge.log'), 'a')
  child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: BRIDGE_DIR,
    stdio: ['ignore', out, out],
    env: { ...process.env, DSH_CONNECT_MOBILE: '1', DSH_CONNECT_MOBILE_PORT: String(bridgePort()), DSH_CONNECT_MOBILE_P2P_PORT: String(bridgePort() + 1) },
  })
  child.on('exit', (code) => log('bridge exited code=' + code))
  log('bridge spawned pid=' + child.pid + ' port=' + bridgePort())
  return { ok: true, message: 'bridge 已启动，端口 ' + bridgePort() + '（首次启动会在 bridge/config.json 生成 accessKey）', pid: child.pid }
}

function stopBridge() {
  if (!child || child.exitCode !== null) return { ok: true, message: 'bridge 不是本进程拉起的（或已退出），未动它' }
  const pid = child.pid
  try {
    child.kill()
  } catch {}
  child = null
  return { ok: true, message: 'bridge 已停止（pid ' + pid + '）' }
}

function apkInfo() {
  const result = { dir: DIST_DIR, files: [], version: '' }
  try {
    for (const f of fs.readdirSync(DIST_DIR)) {
      if (!f.toLowerCase().endsWith('.apk')) continue
      const st = fs.statSync(path.join(DIST_DIR, f))
      let version = ''
      try {
        const side = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'apk-version.json'), 'utf8'))
        if (side && typeof side.versionName === 'string') {
          version = side.versionName
          result.version = side.versionName
        }
      } catch {}
      result.files.push({ name: f, bytes: st.size, mtime: st.mtime.toISOString(), version })
    }
  } catch {}
  return result
}

// ── 给客户端面板用的 JSON：bridge 状态 + 通道 + 二维码 + 随包 APK ──────────
async function apiPayload() {
  const alive = await bridgeAlive()
  const cfg = readBridgeConfig()
  const channels = alive ? await callBridge('GET', '/__dshm/channels', undefined, 12000) : null
  const rows = Array.isArray(channels?.json?.channels) ? channels.json.channels : []
  // 首选地址：https 优先，其次局域网
  const pick = rows.find((c) => /https/i.test(String(c.url || ''))) || rows.find((c) => String(c.kind || '').toLowerCase().includes('lan')) || rows[0]
  const baseUrl = pick ? String(pick.url || pick.baseUrl || '') : ''
  let qr = ''
  if (alive && baseUrl) {
    const q = await callBridge('GET', '/__dshm/qr?data=' + encodeURIComponent(baseUrl), undefined, 8000)
    if (q.ok && /<svg/i.test(q.text)) qr = q.text
  }
  return {
    ok: true,
    port: bridgePort(),
    alive,
    accessKey: cfg.accessKey ? '已配置' : '未生成',
    baseUrl,
    channels: rows.map((c) => ({ kind: String(c.kind || c.type || ''), url: String(c.url || c.baseUrl || ''), note: String(c.note || '') })),
    qr,
    apk: apkInfo(),
    repoHint: '构建纯净版：pwsh -File D:\\dsh-mobile\\tools\\build-clean.ps1 -Bump',
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function mountApi(ctx) {
  const webServer = serviceOf(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    log('webServer 服务不可用，跳过 /connect-mobile/api（面板退化为只读 bridge 状态）')
    return undefined
  }
  const dispose = webServer.register({
    kind: 'prefix',
    path: '/connect-mobile',
    handler: async (req, res) => {
      try {
        if (/\/connect-mobile\/base(\?|$)/.test(req.url || '')) {
          return sendJson(res, 200, { bridge: 'http://127.0.0.1:' + bridgePort(), port: bridgePort() })
        }
        if (/[?&]start=1/.test(req.url || '')) {
          const started = startBridge()
          log(started.message)
          await new Promise((ok) => setTimeout(ok, 1500))
        }
        sendJson(res, 200, await apiPayload())
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) })
      }
    },
  })
  log('已挂载 /connect-mobile/api')
  return () => {
    try {
      dispose?.()
    } catch {}
  }
}

// defineTool 只是类型辅助：拿不到就用恒等函数（工具照常注册，参数 schema 由宿主校验）。
// 解析顺序抄 dsh-memory-core 的 hostImport：以「当前运行时入口」为锚点，再退 profile junction。
async function loadDefineTool() {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const bases = []
  const argv1 = process.argv[1]
  if (argv1 && /[\\/]/.test(argv1)) bases.push(argv1)
  try {
    const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
    bases.push(path.join(home, 'profiles', 'node_modules', '__connect_mobile_resolver__.cjs'))
  } catch {}
  bases.push(path.join(ROOT, '__resolver__.cjs'))
  for (const base of bases) {
    for (const spec of ['@deepseek-ai/dsh-tools']) {
      try {
        const req = createRequire(base)
        const resolved = req.resolve(spec)
        const m = await import(pathToFileURL(resolved).href)
        const fn = m.defineTool || m.default?.defineTool
        if (typeof fn === 'function') return fn
      } catch {}
    }
  }
  log('defineTool 取不到，用恒等函数兜底')
  return (t) => t
}

// 输出契约：宿主对 object schema 要求自带 render；直接用 string schema + render 最稳
// （抄 dsh-memory-core：schema: {type:'string'} + render 返回 text part）。
const OUT = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  },
}

const textOut = (text) => String(text ?? '')

async function registerTools(ctx, tools) {
  const defineTool = await loadDefineTool()
  if (!defineTool) {
    log('拿不到 defineTool（@deepseek-ai/dsh-tools 不可用），跳过工具注册')
    return
  }
  if (registered) return
  registered = true

  tools.register(
    defineTool({
      name: 'phone_bridge',
      description:
        '手机工作台的电脑侧 bridge：起/停/查。bridge 是本机 HTTP 服务（默认 8787），手机上的 DSH Mobile 通过它连过来（局域网/Tailscale/隧道任一通道）。' +
        '换电脑或首次使用时先 op=start 拉起来，再在手机上「设置 → 配置桥接地址」扫码或填地址。',
      parameters: { op: { type: 'string', required: true, description: 'start 启动 / stop 停止 / status 查状态' } },
      output: OUT,
      async execute(args) {
        const op = String(args?.op || 'status').trim().toLowerCase()
        if (op === 'start') return textOut(startBridge().message)
        if (op === 'stop') return textOut(stopBridge().message)
        const alive = await bridgeAlive()
        const cfg = readBridgeConfig()
        const info = alive ? await callBridge('GET', '/__dshm/info') : null
        return textOut(
          [
            'bridge 端口: ' + bridgePort(),
            '可达: ' + (alive ? '是' : '否'),
            'accessKey: ' + (cfg.accessKey ? '已配置' : '未生成（首次启动 bridge 后出现）'),
            '子进程: ' + (child && child.exitCode === null ? 'pid ' + child.pid : '无'),
            info?.json ? 'info: ' + JSON.stringify(info.json).slice(0, 600) : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'phone_channels',
      description:
        '列出手机当前可用的接入通道（局域网 / Tailscale / ngrok / Cloudflare 等）与手机端该填的地址。手机连不上时先查这里，别瞎猜 IP。',
      parameters: {},
      output: OUT,
      async execute() {
        const r = await callBridge('GET', '/__dshm/channels', undefined, 12000)
        if (!r.ok) return textOut('查通道失败：' + (r.error || 'HTTP ' + r.status))
        const rows = Array.isArray(r.json?.channels) ? r.json.channels : []
        if (!rows.length) return textOut('当前没有可用通道。先 phone_bridge op=start，必要时开 Tailscale/隧道。')
        return textOut(rows.map((c) => '- ' + (c.kind || c.type || '?') + '  ' + (c.url || c.baseUrl || '') + (c.note ? '  （' + c.note + '）' : '')).join('\n'))
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'phone_eval',
      description:
        '在手机当前的 DSH 页面里执行一段 JavaScript 并回读取值 —— 用来读会话正文、点按钮、切「访问模式」，以及没有 adb 时探状态。只读优先：先取 innerText 判断界面，再决定动作。',
      parameters: { js: { type: 'string', required: true, description: '要执行的 JS 表达式（可 return 字符串）' } },
      output: OUT,
      async execute(args) {
        const js = String(args?.js || '').trim()
        if (!js) return textOut('js 不能为空')
        const post = await callBridge('POST', '/__dshm/debug/command', { cmd: 'eval', args: { js } }, 10000)
        if (!post.ok) return textOut('下发失败：' + (post.error || 'HTTP ' + post.status) + '（手机 DSH 是否在前台？bridge 是否可达？）')
        const id = post.json?.id
        if (!id) return textOut('bridge 未返回 id：' + post.text.slice(0, 300))
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500))
          const st = await callBridge('GET', '/__dshm/debug/status', undefined, 8000)
          const hit = Array.isArray(st.json?.results) ? st.json.results.find((x) => x && x.id === id) : undefined
          if (!hit) continue
          if (hit.ok === false) return textOut('手机侧报错：' + String(hit.error || hit.result || '').slice(0, 800))
          return textOut(String(hit.result ?? '').slice(0, 4000))
        }
        return textOut('等了 10 秒没有结果（命令 ' + id + '）')
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'phone_apk',
      description: '本插件 dist/ 里随附的 DSH Mobile 纯净版 APK（版本、大小、路径）。要给手机装/升级时先看这里，别猜文件名。',
      parameters: {},
      output: OUT,
      async execute() {
        const info = apkInfo()
        if (!info.files.length) return textOut('dist/ 里还没有 APK（用 D:\\dsh-mobile\\tools\\build-clean.ps1 构建）')
        return textOut(info.files.map((f) => `${f.name}  ${f.version || '?'}  ${(f.bytes / 1048576).toFixed(1)} MB  ${f.mtime}\n${path.join(info.dir, f.name)}`).join('\n'))
      },
    }),
  )

  log('tools registered: phone_bridge / phone_channels / phone_eval / phone_apk')
}

function registerWhenReady(ctx, attempt = 1) {
  const tools = serviceOf(ctx, 'tools')
  if (!tools || typeof tools.register !== 'function') {
    if (attempt > 30) {
      log('tools 服务 60 秒内没出现，放弃注册（插件本身已激活；建过 agent 会话后重启即可）')
      return
    }
    if (attempt === 1) log('tools 还没就绪，开始轮询（每 2s，共 30 次）')
    setTimeout(() => registerWhenReady(ctx, attempt + 1), 2000)
    return
  }
  void registerTools(ctx, tools)
}

export function apply(ctx) {
  log('apply enter v' + VERSION)
  // 面板打开时若 bridge 没在跑，UI 只会停「正在等待桥接服务启动」。
  // 插件加载后主动拉一次，行为对齐参考实现（dsh-mobile-qr 的 watchdog）。
  void (async () => {
    try {
      if (!(await bridgeAlive())) log(startBridge().message)
    } catch (e) {
      log('ensureBridge failed: ' + String(e?.message || e))
    }
  })()

  // 客户端面板（侧栏「手机」按钮 + 预览弹窗）要的数据口
  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['webServer'], (wctx) => mountApi(wctx))
    } else {
      mountApi(ctx)
    }
  } catch (e) {
    log('挂 /connect-mobile/api 失败：' + String(e?.message || e))
  }

  registerWhenReady(ctx)
}
