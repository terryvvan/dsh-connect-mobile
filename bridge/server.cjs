'use strict';
/**
 * DSH Mobile Bridge
 * -----------------
 * Exposes the *running* DeepSeek Harness desktop runtime to phones without
 * forking a second kernel (two kernels on one DSH_HOME would not share live
 * session state). It discovers the desktop kernel from desktop.log, mints the
 * per-process browser cookie itself, and reverse-proxies HTTP + WebSocket with
 * Host/Origin rewritten to the loopback authority. A bridge access key gates
 * the public side.
 */
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');
const { execFile, exec, execFileSync, spawn } = require('child_process');
const qrcode = require('qrcode-generator');

const VERSION = '0.5.8';
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_PATH = path.join(ROOT, 'bridge.log');
const PID_PATH = path.join(ROOT, 'bridge.pid');
const MOBILE_DIR = path.resolve(ROOT, '..', 'mobile');
const APK_PATH = (() => {
  const PACK = path.resolve(ROOT, '..')   // ROOT 是 bridge/，插件根在上一层
  const cands = [
    path.join(PACK, 'dist', 'dsh-mobile-clean.apk'),
    path.join(PACK, 'dist', 'dsh-mobile.apk'),
    path.resolve(PACK, '..', 'apk', 'dsh-mobile.apk'),
  ];
  for (const p of cands) { try { if (fs.existsSync(p) && fs.statSync(p).size > 0) return p; } catch {} }
  return cands[0];
})();

const DEFAULT_LOG = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'DeepSeek Harness', 'logs', 'desktop.log'
);

function nowIso() { return new Date().toISOString(); }
function log(...args) {
  const line = `[${nowIso()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* ignore */ }
}

function applyPortEnv(cfg) {
  const p = Number(process.env.DSH_CONNECT_MOBILE_PORT)
  if (Number.isFinite(p) && p > 0) cfg.port = p
  const u = Number(process.env.DSH_CONNECT_MOBILE_USB_PORT)
  if (Number.isFinite(u) && u > 0) cfg.usbPort = u
  return cfg
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  const out = {
    port: Number(process.env.DSH_CONNECT_MOBILE_PORT) || 8787,
    host: '0.0.0.0',
    accessKey: '',
    desktopLog: DEFAULT_LOG,
    target: '',
    dshHome: path.join(os.homedir(), '.dsh'),
    publicUrl: '',
    ipv6Url: '',
    ngrokUrl: '',
    ngrokApi: 'http://127.0.0.1:4040/api/tunnels',
    // Managed ngrok tunnel: authtoken is pasted once in the desktop plugin
    // and reused for every later start (no CLI, no ngrok config file needed).
    ngrok: { authtoken: '', domain: '' },
    tailscaleUrl: '',
    cloudflared: false,
    filesDir: path.join(ROOT, 'files'),
    // Chat-style phone <-> PC file transfer channel (see ft.js).
    ftDir: '',            // '' = <bridge>/ft
    usbPort: Number(process.env.DSH_CONNECT_MOBILE_USB_PORT) || 8791,        // loopback listener reached through `adb reverse`
    adbPath: '',          // '' = auto-detect
    passwordHash: '',
    passwordSalt: '',
    sessionSecret: '',
    ...cfg,
  };
  // A saved config may carry its own ngrok object; keep unknown keys but make
  // sure both fields exist so callers can read them without guards.
  out.ngrok = {
    authtoken: '',
    domain: '',
    ...(out.ngrok && typeof out.ngrok === 'object' ? out.ngrok : {}),
  };
  applyPortEnv(out)
// 纯净版默认打开 Cloudflare 免费隧道：别人装完扫码就能远程访问。
// 用户在 config.json 里显式写过 cloudflared（true/false）就尊重用户；
// 环境变量 DSH_CONNECT_MOBILE_TUNNEL=0/off/false 可一键关掉（离线或受限网络）。
applyTunnelDefault(out, cfg);
  let changed = false;
  if (!out.accessKey) {
    out.accessKey = crypto.randomBytes(18).toString('base64url');
    changed = true;
  }
  if (!out.sessionSecret) {
    out.sessionSecret = crypto.randomBytes(32).toString('base64url');
    changed = true;
  }
  if (changed) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8'); } catch (e) {
      log('WARN cannot write config.json:', e.message);
    }
  }
  return out;
}

/**
 * 纯净版默认打开 Cloudflare 免费隧道。
 * 新用户装完不用配置就能扫码从外网访问工作台；想关的人有两种办法：
 *   1) 在 config.json 里显式写 "cloudflared": false
 *   2) 启动时带环境变量 DSH_CONNECT_MOBILE_TUNNEL=0
 */
function applyTunnelDefault(out, stored) {
  const env = String(process.env.DSH_CONNECT_MOBILE_TUNNEL || '').toLowerCase();
  if (env === '0' || env === 'off' || env === 'false') { out.cloudflared = false; return; }
  // 只有用户自己改过（cloudflaredUserChoice=true）才尊重 false；
  // 老版本自动落盘的 "cloudflared": false 是默认值残留，不能当成用户意愿。
  if (stored && stored.cloudflaredUserChoice === true) return;
  out.cloudflared = true;
}

const cfg = loadConfig();

/* ------------------------------------------------------------------ */
/* Long-lived access: optional password + signed 30-day session        */
/* ------------------------------------------------------------------ */

const SESSION_COOKIE = 'dshm_sess';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
// QR-only automatic login. Never returned by the public address endpoints and
// rotated whenever the password changes; copying the URL never carries it.
let autoLoginToken = crypto.randomBytes(24).toString('base64url');

function persistConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) {
    log('WARN cannot write config.json:', e.message);
    return false;
  }
}

function passwordSet() {
  return !!(cfg.passwordHash && cfg.passwordSalt);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 32).toString('hex');
}

function verifyPassword(password) {
  if (!passwordSet()) return false;
  try {
    const got = Buffer.from(hashPassword(password, cfg.passwordSalt), 'hex');
    const want = Buffer.from(cfg.passwordHash, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

function issueSession() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const payload = `v1.${exp}`;
  const sig = crypto.createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function validSession(token) {
  const raw = String(token || '');
  const m = /^v1\.(\d{9,12})\.([A-Za-z0-9_-]{20,})$/.exec(raw);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const payload = `v1.${exp}`;
  const want = crypto.createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url');
  const got = m[2];
  try {
    return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  } catch {
    return false;
  }
}

function setSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${issueSession()}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; SameSite=Lax`);
}

function safeNext(value) {
  const s = String(value || '');
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\')) return '/';
  return s;
}

/* ------------------------------------------------------------------ */
/* Login guard: 3 wrong passwords lock the page for a day              */
/* ------------------------------------------------------------------ */
/* The password page is reachable from the phone QR and from any tunnel,
 * so it is the one place an outsider can guess at. Three wrong entries
 * lock new password attempts for 24 h; existing sessions keep working and
 * only the PC-side 「手机工作台」 popup may unlock (see handleSecurity*).
 * State lives next to config.json so a bridge restart cannot clear it. */

/** Best-effort client address. Tunnels (Cloudflare/ngrok) arrive from
 *  127.0.0.1, so prefer their forwarding headers when present. */
function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff && xff !== '127.0.0.1' && xff !== '::1') return xff;
  const a = (req.socket && req.socket.remoteAddress) || '?';
  return String(a).replace(/^::ffff:/, '');
}

const GUARD_PATH = path.join(path.dirname(CONFIG_PATH), 'login-guard.json');
const GUARD_MAX_FAILS = 3;
const GUARD_LOCK_MS = 24 * 60 * 60 * 1000;
const GUARD_EVENT_MAX = 80;
const GUARD_VISIT_GAP_MS = 10 * 60 * 1000;

function loadGuard() {
  const empty = { lockedUntil: 0, lockedIp: '', lockedUa: '', fails: 0, lastFailAt: 0, events: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(GUARD_PATH, 'utf8')) || {};
    return {
      lockedUntil: Number(raw.lockedUntil) || 0,
      lockedIp: String(raw.lockedIp || ''),
      lockedUa: String(raw.lockedUa || ''),
      fails: Number(raw.fails) || 0,
      lastFailAt: Number(raw.lastFailAt) || 0,
      events: Array.isArray(raw.events) ? raw.events.slice(-GUARD_EVENT_MAX) : [],
    };
  } catch {
    return empty;
  }
}

const guard = loadGuard();

function saveGuard() {
  try {
    fs.writeFileSync(GUARD_PATH, JSON.stringify(guard, null, 2) + '\n', 'utf8');
  } catch (e) {
    log('WARN cannot write login-guard.json:', e.message);
  }
}

function guardLocked() { return guard.lockedUntil > Date.now(); }
function guardRemainMs() { return Math.max(0, guard.lockedUntil - Date.now()); }

function guardPush(kind, ip, ua) {
  guard.events.push({ ts: Date.now(), kind, ip: String(ip || '?'), ua: String(ua || '').slice(0, 180) });
  if (guard.events.length > GUARD_EVENT_MAX) guard.events = guard.events.slice(-GUARD_EVENT_MAX);
  saveGuard();
}

/** Record where a request came from — used for the "不安全的访问" trail.
 *  Throttled per IP so a phone reloading the page does not flood the log. */
function guardRecordVisit(req, kind) {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  for (let i = guard.events.length - 1; i >= 0; i -= 1) {
    const e = guard.events[i];
    if (e.ip !== ip) continue;
    if (e.kind === (kind || 'visit') && Date.now() - e.ts < GUARD_VISIT_GAP_MS) return;
    break;
  }
  guardPush(kind || 'visit', ip, ua);
}

/** One wrong password: count it, and lock everything once it hits 3. */
function guardFail(req) {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  guard.fails += 1;
  guard.lastFailAt = Date.now();
  guardPush('fail', ip, ua);
  if (guard.fails >= GUARD_MAX_FAILS) {
    guard.lockedUntil = Date.now() + GUARD_LOCK_MS;
    guard.lockedIp = ip;
    guard.lockedUa = String(ua).slice(0, 180);
    guardPush('lock', ip, ua);
    log(`login locked for 24h after ${guard.fails} wrong passwords, last from ${ip}`);
    return true;
  }
  return false;
}

function guardSucceed(req) {
  if (guard.fails) guardPush('ok', clientIp(req), req.headers['user-agent'] || '');
  guard.fails = 0;
  guard.lastFailAt = 0;
  saveGuard();
}

function guardUnlock(req, by) {
  const wasLocked = guardLocked();
  guard.lockedUntil = 0;
  guard.lockedIp = '';
  guard.lockedUa = '';
  guard.fails = 0;
  guard.lastFailAt = 0;
  guardPush('unlock', `${by || 'pc'} · ${clientIp(req)}`, req.headers['user-agent'] || '');
  if (wasLocked) log(`login lock cleared from ${by || 'pc'}`);
}

function secView() {
  const locked = guardLocked();
  return {
    locked,
    lockedUntil: guard.lockedUntil,
    remainSec: Math.ceil(guardRemainMs() / 1000),
    fails: guard.fails,
    maxFails: GUARD_MAX_FAILS,
    lockHours: GUARD_LOCK_MS / 3600000,
    lockedIp: locked ? guard.lockedIp : '',
    lockedUa: locked ? guard.lockedUa : '',
    lastFailAt: guard.lastFailAt,
    events: guard.events.slice(-30).reverse(),
  };
}

function loginPage(res, next, error) {
  const safe = safeNext(next);
  const locked = guardLocked();
  const remainMs = guardRemainMs();
  const failsLeft = Math.max(0, GUARD_MAX_FAILS - guard.fails);
  const esc = escapeHtml;
  const lastIp = guard.lockedIp || (guard.events.length ? guard.events[guard.events.length - 1].ip : '');
  const lastAt = guard.lastFailAt ? new Date(guard.lastFailAt).toLocaleString('zh-CN', { hour12: false }) : '';

  const tipText = locked
    ? `连续 ${GUARD_MAX_FAILS} 次密码错误后，这台电脑的新登录已锁定 ${GUARD_LOCK_MS / 3600000} 小时。`
      + `最近一次来源：${lastIp || '未知'}${lastAt ? `（${lastAt}）` : ''}。`
      + '为了不让正在猜密码的人靠重启或换网络绕过，解锁只能在电脑上的「手机工作台」里做。'
    : `已经连续输错 ${guard.fails} 次密码，再错 ${failsLeft} 次就会锁定 ${GUARD_LOCK_MS / 3600000} 小时。`
      + `${lastIp ? `最近一次来源：${lastIp}${lastAt ? `（${lastAt}）` : ''}。` : ''}`
      + '锁定后只能用电脑上的「手机工作台」解锁。';

  const warnBanner = (locked || guard.fails > 0) ? `
<div class="warn${locked ? ' is-lock' : ''}">
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor"
    d="M12 2.2 1.9 20.4h20.2L12 2.2Zm0 4.6 6.6 11.9H5.4L12 6.8Zm-.95 4h1.9v4.4h-1.9v-4.4Zm0 5.5h1.9v1.9h-1.9v-1.9Z"/></svg>
  <span class="warn-t">不安全的访问</span>
  <span class="tipwrap" tabindex="0" aria-label="更多说明">
    <svg class="tipicon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor"
      d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3.2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm1.1 12.3h-2.2v-6.2h2.2v6.2Z"/></svg>
    <span class="tip" role="tooltip">${esc(tipText)}</span>
  </span>
  <span class="warn-s">${locked
    ? `已锁定 ${GUARD_LOCK_MS / 3600000} 小时`
    : `已输错 ${guard.fails} 次 · 还剩 ${failsLeft} 次机会`}</span>
</div>` : '';

  const lockCard = `
<div class="card lockcard">
  <div class="lockbig">🔒</div>
  <h2>已锁定，暂时不能登录</h2>
  <p class="lockp">连续输错 ${GUARD_MAX_FAILS} 次密码，这台电脑的密码登录已暂停。<br>
    剩余 <b id="cd" data-until="${guard.lockedUntil}">${formatRemain(remainMs)}</b> 后自动解除。</p>
  <div class="kv">
    <div><span>最近来源</span><b>${esc(lastIp || '未知')}</b></div>
    <div><span>时间</span><b>${esc(lastAt || '未知')}</b></div>
  </div>
  <p class="lockp">解锁只能在<b>电脑上的「手机工作台」</b>弹窗里点「解除锁定」——手机上、别的设备上都不行。
    已登录的设备不受影响，可以继续使用。</p>
</div>`;

  const formCard = `
<div class="card">
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <form method="post" action="/__dshm/login">
  <input type="hidden" name="next" value="${esc(safe)}">
  <label for="pw">连接密码</label>
  <input id="pw" name="password" type="password" inputmode="text" autocomplete="current-password"
   autofocus required placeholder="输入电脑插件里设置的密码">
  <button type="submit">连接</button>
  </form>
</div>`;

  res.writeHead(error ? 401 : 200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d10">
<title>DSH Mobile · 连接密码</title>
<style>
:root{color-scheme:dark;--fg:#eef1f7;--muted:#8d93a3;--accent:#6d8cff}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
background:radial-gradient(1200px 600px at 20% 0%,#18213f 0%,#0b0d10 55%);
color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(380px,100%)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.logo{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;
background:linear-gradient(145deg,#1b3a7a,#0d1730);border:1px solid rgba(120,160,255,.35);font-size:22px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:10px 0 6px}
p{color:var(--muted);margin:0 0 20px;font-size:13px}
.card{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:18px}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:8px}
input{width:100%;height:46px;border-radius:10px;border:1px solid rgba(255,255,255,.14);
background:#0f1218;color:var(--fg);font:inherit;padding:0 12px;outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(109,140,255,.18)}
button{width:100%;height:46px;margin-top:12px;border:0;border-radius:10px;font:inherit;font-weight:600;
color:#0b1220;background:linear-gradient(135deg,#8fb0ff,#6d8cff);cursor:pointer}
.err{color:#ff8a8a;font-size:13px;margin:0 0 12px}
.foot{color:#61687a;font-size:12px;margin-top:16px;text-align:center}
.warn{position:relative;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 14px;
padding:10px 12px;border-radius:12px;font-size:13px;color:#ffd6a8;
background:rgba(255,176,80,.09);border:1px solid rgba(255,176,80,.28)}
.warn.is-lock{color:#ffb7b7;background:rgba(255,90,90,.1);border-color:rgba(255,110,110,.32)}
.warn-t{font-weight:700;letter-spacing:.02em}
.warn-s{color:#9aa3b6;font-size:12px}
.tipwrap{display:inline-flex;align-items:center;color:inherit;opacity:.85;cursor:help;outline:none}
.tipwrap:focus-visible{opacity:1;text-decoration:underline}
.tip{position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:9;padding:10px 12px;border-radius:10px;
background:#11151d;border:1px solid rgba(255,255,255,.16);color:#dfe4ee;font-size:12px;line-height:1.55;
box-shadow:0 10px 26px rgba(0,0,0,.5);opacity:0;transform:translateY(-4px);pointer-events:none;transition:.14s}
.tipwrap:hover .tip,.tipwrap:focus .tip,.tipwrap:focus-within .tip{opacity:1;transform:translateY(0)}
.lockcard{text-align:center}
.lockbig{font-size:26px;line-height:1;margin-bottom:2px}
.lockp{color:var(--muted);font-size:13px;margin:8px 0 0;text-align:left}
.kv{display:flex;flex-direction:column;gap:6px;margin:12px 0;padding:10px 12px;border-radius:12px;
background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);font-size:12px;text-align:left}
.kv>div{display:flex;justify-content:space-between;gap:12px}
.kv span{color:var(--muted)}
.kv b{font-weight:600;word-break:break-all;text-align:right}
b{color:#fff}
</style></head><body><main>
<div class="brand"><div class="logo">🐋</div><div><h1>DSH Mobile</h1><p>电脑环境 · 已启用连接密码</p></div></div>
${warnBanner}
${locked ? lockCard : formCard}
<p class="foot">${locked
    ? '解锁入口：电脑端「手机工作台」→ 安全 → 解除锁定。'
    : `密码在电脑端「手机工作台」弹窗里设置；连续输错 ${GUARD_MAX_FAILS} 次会锁定 ${GUARD_LOCK_MS / 3600000} 小时。这台设备验证后会保持登录 30 天。`}</p>
</main>
${locked ? `<script>(function(){var el=document.getElementById('cd');if(!el)return;
var until=Number(el.getAttribute('data-until'))||0;
function tick(){var s=Math.max(0,Math.round((until-Date.now())/1000));
if(s<=0){el.textContent='0 秒';setTimeout(function(){location.reload()},1200);return;}
var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),ss=s%60;
el.textContent=(d>0?d+' 天 ':'')+(d>0||h>0?h+' 小时 ':'')+m+' 分 '+ss+' 秒';}
tick();setInterval(tick,1000);})();</script>` : ''}
</body></html>`);
}

function formatRemain(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d > 0 ? `${d} 天 ` : ''}${d > 0 || h > 0 ? `${h} 小时 ` : ''}${m} 分`;
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleLogin(req, res, u) {
  const next = safeNext(u.searchParams.get('next') || '/');
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (req.method === 'GET' && validSession(cookie)) {
    res.writeHead(302, { Location: next });
    res.end();
    return;
  }
  const ip = clientIp(req);
  if (req.method === 'GET') {
    guardRecordVisit(req, 'visit');
    loginPage(res, next, '');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }
  // A locked page refuses even the correct password: that is the point of the
  // lock, and it keeps a guesser from resetting the counter by getting lucky.
  if (guardLocked()) {
    log(`login blocked (locked) from ${ip}`);
    loginPage(res, next, '这台电脑的密码登录已锁定，请到电脑端「手机工作台」里解除。');
    return;
  }
  let body = '';
  try { body = await readBody(req); } catch { /* ignore */ }
  const form = new URLSearchParams(body);
  const password = form.get('password') || '';
  const target = safeNext(form.get('next') || next);
  if (!verifyPassword(password)) {
    const lockedNow = guardFail(req);
    log(`login failed from ${ip} (${guard.fails}/${GUARD_MAX_FAILS})${lockedNow ? ' -> locked 24h' : ''}`);
    loginPage(res, target, lockedNow
      ? `密码不正确。已经连续输错 ${GUARD_MAX_FAILS} 次，登录锁定 ${GUARD_LOCK_MS / 3600000} 小时。`
      : `密码不正确。再错 ${Math.max(0, GUARD_MAX_FAILS - guard.fails)} 次将锁定 ${GUARD_LOCK_MS / 3600000} 小时。`);
    return;
  }
  guardSucceed(req);
  setSessionCookie(res);
  log(`login ok from ${ip}`);
  res.writeHead(302, { Location: target });
  res.end();
}

/* PC-only: lock state for the 「手机工作台」 popup, and the only way out. */
async function handleSecurity(req, res) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (!pcOnly(req, res)) return;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: true, passwordSet: passwordSet(), ...secView() }));
}

async function handleSecurityUnlock(req, res) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (!pcOnly(req, res)) return;
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  guardUnlock(req, '手机工作台');
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: true, ...secView() }));
}

async function handlePassword(req, res) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (!pcOnly(req, res)) return;
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, passwordSet: passwordSet() }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  let body = '';
  try { body = await readBody(req); } catch { /* ignore */ }
  let password = '';
  let clear = false;
  try {
    const parsed = JSON.parse(body || '{}') || {};
    password = String(parsed.password || '');
    clear = parsed.clear === true;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
    return;
  }
  if (!clear && !password) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '请输入密码；清除密码请使用 clear:true' }));
    return;
  }
  if (!clear && (password.length < 4 || password.length > 128)) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '密码长度需要 4–128 个字符' }));
    return;
  }
  if (!clear) {
    cfg.passwordSalt = crypto.randomBytes(16).toString('hex');
    cfg.passwordHash = hashPassword(password, cfg.passwordSalt);
  } else {
    cfg.passwordSalt = '';
    cfg.passwordHash = '';
  }
  // Changing (or clearing) the password invalidates every existing session.
  cfg.sessionSecret = crypto.randomBytes(32).toString('base64url');
  autoLoginToken = crypto.randomBytes(24).toString('base64url');
  persistConfig();
  // Whoever can rewrite the password is the owner, so this also clears a lock.
  guardUnlock(req, clear ? '清除密码' : '修改密码');
  log(password ? 'connection password set' : 'connection password cleared');
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: true, passwordSet: passwordSet() }));
}


/* ------------------------------------------------------------------ */
/* Discovery of the currently running desktop kernel                    */
/* ------------------------------------------------------------------ */

const TARGET_RE = /(?:runtime ready at|dsh web:)\s+(https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/\?token=([A-Za-z0-9_-]+))/g;

function parseTargetFromLog(file) {
  try {
    const st = fs.statSync(file);
    const tail = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(tail);
    fs.readSync(fd, buf, 0, tail, st.size - tail);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    TARGET_RE.lastIndex = 0;
    let m, last = null;
    while ((m = TARGET_RE.exec(text))) last = { url: m[1], port: Number(m[2]), token: m[3] };
    return last;
  } catch {
    return null;
  }
}

function parseTargetOverride(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const token = u.searchParams.get('token');
    if (!token) return null;
    return { url: raw, port: Number(u.port || 80), token };
  } catch { return null; }
}

/** Ask the kernel for its per-process auth cookie. */
function mintCookie(target) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: target.port,
      path: `/?token=${encodeURIComponent(target.token)}`,
      method: 'GET',
      headers: {
        host: `127.0.0.1:${target.port}`,
        'user-agent': `dsh-mobile-bridge/${VERSION}`,
        accept: 'text/html',
      },
    }, (res) => {
      res.resume();
      const setCookies = res.headers['set-cookie'] || [];
      const auth = setCookies
        .map((c) => c.split(';')[0])
        .find((c) => c.startsWith('dsh-auth-'));
      if (auth) resolve({ cookie: auth, status: res.statusCode });
      else reject(new Error(`no dsh-auth cookie (HTTP ${res.statusCode})`));
    });
    req.setTimeout(6000, () => req.destroy(new Error('mint timeout')));
    req.on('error', reject);
    req.end();
  });
}

let target = null;             // { port, token, cookie, epoch, mintedAt }
let targetEpoch = 0;
let lastDiscoveryError = '';
let refreshInFlight = false;
let lastMintFailureLog = 0;
let waitingSince = 0;          // 手机端「环境启动中」计时的起点

async function refreshTarget(force = false) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const found = parseTargetOverride(cfg.target) || parseTargetFromLog(cfg.desktopLog);
    if (!found) {
      lastDiscoveryError = `waiting for a runtime line in ${cfg.desktopLog}`;
      if (!target && !waitingSince) waitingSince = Date.now();
      return;
    }
    if (!force && target && target.port === found.port && target.token === found.token && target.cookie) return;
    try {
      const minted = await mintCookie(found);
      target = { ...found, cookie: minted.cookie, epoch: ++targetEpoch, mintedAt: Date.now() };
      lastDiscoveryError = '';
      waitingSince = 0;
      log(`runtime attached: http://127.0.0.1:${found.port} (epoch ${target.epoch})`);
    } catch (e) {
      lastDiscoveryError = `mint failed: ${e.message}`;
      // A stale token means the old target is dead. Drop it so health says "waiting".
      if (target && target.token !== found.token) target = null;
      if (!target && !waitingSince) waitingSince = Date.now();
      if (Date.now() - lastMintFailureLog > 15000) {
        lastMintFailureLog = Date.now();
        log(`WARN ${lastDiscoveryError}`);
      }
    }
  } finally {
    refreshInFlight = false;
  }
}

setInterval(() => { refreshTarget().catch(() => {}); }, 2500);
refreshTarget().catch(() => {});

/* ------------------------------------------------------------------ */
/* Auth gate                                                           */
/* ------------------------------------------------------------------ */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function upstreamCookie(clientCookie) {
  const kept = String(clientCookie || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((c) => !c.startsWith('dsh-auth-') && !c.startsWith('dshm_key='));
  if (target && target.cookie) kept.push(target.cookie);
  return kept.join('; ');
}

function keyMatches(req, u) {
  if (!cfg.accessKey) return false;
  if (u.searchParams.get('k') === cfg.accessKey) return true;
  // 手机端 DSH 用 header 携带密钥，避免把 key 写进 URL 和代理日志。
  if (req.headers['x-dshm-key'] === cfg.accessKey) return true;
  return parseCookies(req.headers.cookie).dshm_key === cfg.accessKey;
}

function sessionMatches(req) {
  return validSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

function autoLoginMatches(u) {
  const got = u.searchParams.get('at');
  if (!got || !autoLoginToken) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(autoLoginToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorized(req, res) {
  const u = new URL(req.url, 'http://bridge.invalid');
  const keyOk = keyMatches(req, u);
  const sessOk = sessionMatches(req);

  // The PC itself (plugin modal, local browser) can always use the key.
  if (keyOk && isLocalPc(req)) {
    if (!parseCookies(req.headers.cookie).dshm_key) {
      res.setHeader('Set-Cookie', `dshm_key=${cfg.accessKey}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    }
    return true;
  }

  // Scanning the desktop QR carries a short-lived automatic-login token; it
  // mints the same 30-day session as the password form. Copied links never
  // contain this token.
  if (autoLoginMatches(u)) {
    setSessionCookie(res);
    return true;
  }

  if (passwordSet()) {
    if (sessOk) return true;
    // 手机端 DSH 的「电脑执行」通道：只认 header 里的密钥，不依赖 cookie 会话，
    // 这样手机上的 agent 用 curl -H 'x-dshm-key: …' 就能直接调，不必先登录。
    if (keyOk && (u.pathname === '/__dshm/pc/exec' || u.pathname === '/__dshm/pc/ask'
        || u.pathname === '/__dshm/health'
        || u.pathname === '/__dshm/dirs' || u.pathname === '/__dshm/dirs/mkdir'
        || u.pathname.startsWith('/__dshm/ft/'))) return true;
    // The phone's local-DSH key import still carries ?k=, but only over LAN /
    // Tailscale — never through a public tunnel.
    if (keyOk && (u.pathname === '/__dshm/local/provider'
        || u.pathname === '/__dshm/plugins/list'
        || u.pathname === '/__dshm/plugins.tar.gz'
        || u.pathname === '/__dshm/sync/manifest'
        || u.pathname === '/__dshm/sync/rebuild'
        || u.pathname === '/__dshm/sync.tar.gz'
        || u.pathname === '/__dshm/sync/runtime.tar.gz'
        || u.pathname === '/__dshm/artifact'
        || u.pathname === '/__dshm/debug/poll'
        || u.pathname === '/__dshm/debug/result') && isPrivateHost(req)) return true;
    const qs = new URLSearchParams(u.searchParams);
    qs.delete('k');
    const next = u.pathname + (qs.toString() ? `?${qs.toString()}` : '');
    // The file-transfer channel is consumed by native clients, never by a
    // browser form: answer with JSON 401 instead of the password page.
    if (u.pathname.startsWith('/__dshm/ft/')) {
      jsonOut(res, 401, { ok: false, error: '需要访问密钥（x-dshm-key）' });
      return false;
    }
    guardRecordVisit(req, 'visit');
    loginPage(res, next, '');
    return false;
  }

  if (!cfg.accessKey) return true;
  if (u.searchParams.get('k') === cfg.accessKey) {
    res.setHeader('Set-Cookie', `dshm_key=${cfg.accessKey}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    if (u.pathname === '/m' || u.pathname === '/__dshm/health'
        || u.pathname.startsWith('/__dshm/ft/')
        || u.pathname === '/__dshm/local/provider'
        || u.pathname === '/__dshm/plugins/list'
        || u.pathname === '/__dshm/plugins.tar.gz'
        || u.pathname === '/__dshm/sync/manifest'
        || u.pathname === '/__dshm/sync/rebuild'
        || u.pathname === '/__dshm/sync.tar.gz'
        || u.pathname === '/__dshm/sync/runtime.tar.gz'
        || u.pathname === '/__dshm/artifact'
        || u.pathname === '/__dshm/debug/poll'
        || u.pathname === '/__dshm/debug/result') return true; // keep ?k= for these
    u.searchParams.delete('k');
    const qs = u.searchParams.toString();
    res.writeHead(302, { Location: u.pathname + (qs ? `?${qs}` : '') });
    res.end();
    return false;
  }
  if (parseCookies(req.headers.cookie).dshm_key === cfg.accessKey) return true;

  if (u.pathname.startsWith('/__dshm/ft/')) {
    jsonOut(res, 401, { ok: false, error: '需要访问密钥（x-dshm-key）' });
    return false;
  }
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Mobile</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0f1115;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:340px;padding:28px;text-align:center}h1{font-size:18px}code{background:#24262c;padding:2px 6px;border-radius:6px}
p{color:#9a9ca3}</style>
<main><h1>需要访问密钥</h1><p>请使用电脑 bridge 控制台打印的完整地址（带 <code>?k=</code>）打开本页。</p></main>`);
  return false;
}

/* ------------------------------------------------------------------ */
/* Reverse proxy                                                       */
/* ------------------------------------------------------------------ */

function rewriteUrl(value, port) {
  if (!value) return value;
  try {
    const u = new URL(value);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return value;
    u.protocol = 'http:';
    u.hostname = '127.0.0.1';
    u.port = String(port);
    return u.toString();
  } catch { return value; }
}

function sendError(res, status, message) {
  if (res.headersSent) { try { res.destroy(); } catch {} return; }
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font:15px/1.5 system-ui,sans-serif;background:#0f1115;color:#e8e8ea;padding:24px">
<h3 style="margin:0 0 8px">DSH Mobile Bridge</h3><p style="color:#9a9ca3">${escapeHtml(message)}</p>
<p style="color:#666;font-size:12px">bridge ${VERSION} · ${nowIso()}</p></body>`);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ------------------------------------------------------------------ */
/* Phone landing page, QR, info and static assets                      */
/* ------------------------------------------------------------------ */

function isLoopback(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** True only for the PC itself: loopback socket *and* loopback Host header.
 *  A Cloudflare/local tunnel also connects from 127.0.0.1, so the socket
 *  address alone must never be trusted for password/QR/info endpoints. */
function isLocalPc(req) {
  if (!isLoopback(req)) return false;
  const h = hostName(req.headers.host || '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** LAN / Tailscale / private IPv6 hosts (for the phone key-import endpoint). */
function isPrivateHost(req) {
  const h = hostName(req.headers.host || '');
  if (!h) return false;
  if (h === '127.0.0.1' || h === 'localhost' || h === '::1') return true;
  if (isPrivateIp(h) || isTailscaleIp(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  if (/\.ts\.net$/i.test(h)) return true;
  return false;
}

function allowCors(req, res) {
  const o = req.headers.origin || '';
  // The createServer entry already answers /__dshm/* with a wider CORS header
  // set; never narrow it back down here.
  if (!res.getHeader('Access-Control-Allow-Origin')
    && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (!res.getHeader('Access-Control-Allow-Methods')) {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (!res.getHeader('Access-Control-Allow-Headers')) {
    res.setHeader('Access-Control-Allow-Headers', 'x-dshm-key, content-type, range, accept');
  }
}

/** QR/info/password expose the access key or change auth, so only the
 *  PC browser (not a tunnel that also arrives from 127.0.0.1) may use them. */
function pcOnly(req, res) {
  if (isLocalPc(req)) return true;
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('forbidden');
  return false;
}

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text).slice(0, 1400));
  qr.make();
  const n = qr.getModuleCount();
  const scale = 6;
  const margin = 3;
  const size = (n + margin * 2) * scale;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#0b0d10"/></svg>`;
}

function scoreAddress(address) {
  if (/^100\./.test(address)) return 0;      // Tailscale CGNAT range
  if (/^192\.168\./.test(address)) return 1;
  if (/^10\./.test(address)) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 3;
  return 4;
}

function isTailscaleIp(address) {
  const p = String(address).split('.').map(Number);
  return p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

function isPrivateIp(address) {
  const p = String(address).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return false;
  if (p[0] === 10) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  return false;
}

function normalizeBase(raw, defaultPort) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) {
    // A bare IPv6 literal must be bracketed before it becomes a URL.
    if (!s.startsWith('[') && /^[0-9a-f:]+$/i.test(s) && s.includes(':')) s = `[${s}]`;
    s = 'http://' + s;
  }
  try {
    const u = new URL(s);
    if (!u.port && defaultPort && u.protocol === 'http:') u.port = String(defaultPort);
    u.pathname = '/';
    u.search = '';
    u.hash = '';
    return u.origin;
  } catch {
    return '';
  }
}

function hostName(host) {
  const s = String(host || '').trim();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return (end > 0 ? s.slice(1, end) : s.slice(1)).toLowerCase();
  }
  // Unbracketed IPv6 has more than one colon; strip a trailing :port only
  // when the value is a normal host:port pair.
  if ((s.match(/:/g) || []).length > 1) return s.split('%')[0].toLowerCase();
  return s.split(':')[0].toLowerCase();
}

function isIpv6Literal(name) {
  return /^[0-9a-f:]+$/i.test(name) && name.includes(':');
}

function classifyHost(host) {
  const name = hostName(host);
  if (isTailscaleIp(name) || /\.ts\.net$/.test(name)) return { id: 'tailscale', label: 'Tailscale', hint: '经 Tailscale 私有网络访问' };
  if (/trycloudflare|cfargotunnel/.test(name)) return { id: 'cloudflared', label: 'Cloudflare 中转', hint: '经 Cloudflare 免费隧道访问，请保管好 ?k=' };
  if (/ngrok/.test(name)) return { id: 'ngrok', label: 'ngrok 公网', hint: '经公网隧道访问，请保管好 ?k=' };
  if (isIpv6Literal(name)) {
    if (/^fe80:/i.test(name) || /^f[cd][0-9a-f]{2}:/i.test(name) || name === '::1') return { id: 'lan', label: '局域网', hint: '同一 Wi-Fi / 局域网' };
    return { id: 'ipv6', label: 'IPv6 直连', hint: '公网 IPv6 直连；手机需有 IPv6' };
  }
  if (isPrivateIp(name) || name === '127.0.0.1' || name === 'localhost') return { id: 'lan', label: '局域网', hint: '同一 Wi-Fi / 局域网' };
  return { id: 'custom', label: '自定义', hint: '' };
}

let ngrokCache = { at: 0, url: '' };

async function detectNgrok() {
  const explicit = normalizeBase(cfg.ngrokUrl || cfg.publicUrl);
  if (explicit) return explicit;
  if (Date.now() - ngrokCache.at < 3000) return ngrokCache.url;
  let url = '';
  try {
    const res = await fetch(cfg.ngrokApi, { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      const data = await res.json();
      const tunnels = Array.isArray(data.tunnels) ? data.tunnels : [];
      const pick = tunnels.find((t) => t && /^https:\/\//i.test(t.public_url || '')
          && String((t.config && t.config.addr) || '').includes(String(cfg.port)))
        || tunnels.find((t) => t && /^https:\/\//i.test(t.public_url || ''));
      if (pick) url = normalizeBase(pick.public_url);
    }
  } catch { /* ngrok is optional */ }
  ngrokCache = { at: Date.now(), url };
  return url;
}

/* ------------------------------------------------------------------ */
/* Optional built-in public relay: Cloudflare quick tunnel             */
/* No account, no rented server; the desktop stays the origin.         */
/* ------------------------------------------------------------------ */

const CLOUDFLARED_BIN = path.join(ROOT, 'bin', 'cloudflared.exe');
const CF_GH = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
// 国内直连 GitHub 经常「握手成功、正文卡死」，所以镜像优先，官方兜底。
const CLOUDFLARED_URLS = [
  'https://gh-proxy.com/' + CF_GH,
  'https://ghfast.top/' + CF_GH,
  'https://ghproxy.net/' + CF_GH,
  CF_GH,
];
const CLOUDFLARED_URL = CLOUDFLARED_URLS[0];
const relay = { status: 'off', url: '', error: '', child: null };

async function downloadCloudflared() {
  if (fs.existsSync(CLOUDFLARED_BIN) && fs.statSync(CLOUDFLARED_BIN).size > 5 * 1024 * 1024) return;
  fs.mkdirSync(path.dirname(CLOUDFLARED_BIN), { recursive: true });
  relay.status = 'downloading';
  log('cloudflared: downloading helper (~55 MB, first run only) ...');
  let res = null, lastErr = null;
  for (const u of CLOUDFLARED_URLS) {
    try {
      const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
      if (r.ok) { res = r; log('cloudflared: using ' + u.split('/')[2]); break; }
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
    log('cloudflared: mirror failed ' + u.split('/')[2] + ': ' + (lastErr && lastErr.message));
  }
  if (!res) throw lastErr || new Error('download failed');
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const tmp = CLOUDFLARED_BIN + '.tmp';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let lastTick = Date.now();
  const idle = setInterval(() => {
    if (Date.now() - lastTick > 25000) { try { res.body.cancel(); } catch (e) { /* ignore */ } }
  }, 5000);
  try {
    for await (const chunk of res.body) {
      out.write(chunk);
      got += chunk.length;
      lastTick = Date.now();
    }
  } finally { clearInterval(idle); }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  fs.renameSync(tmp, CLOUDFLARED_BIN);
  log(`cloudflared: downloaded ${Math.round(got / 1048576)} MB`);
}

let cfRetry = 0;
let cfRetryTimer = null;

async function startCloudflared() {
  cfHold = false;
  if (!cfg.cloudflared || relay.child || relay.stopped) return;
  try {
    await downloadCloudflared();
    relay.status = 'starting';
    relay.url = '';
    const cp = require('child_process');
    const child = cp.spawn(CLOUDFLARED_BIN, [
      'tunnel', '--url', `http://127.0.0.1:${cfg.port}`, '--no-autoupdate',
    ], { windowsHide: true });
    relay.child = child;
    let buf = '';
    let tail = '';
    const onData = (d) => {
      const s = d.toString();
      buf += s;
      tail = (tail + s).slice(-3000);
      const m = buf.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !relay.url) {
        relay.url = normalizeBase(m[0]);
        relay.status = 'ready';
        relay.error = '';
        cfRetry = 0;
        log(`cloudflared: public URL ${relay.url}`);
      }
      if (buf.length > 65536) buf = buf.slice(-32768);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      relay.status = 'error';
      relay.error = e.message;
      log(`cloudflared: spawn error ${e.message}`);
      scheduleCloudflared();
    });
    child.on('exit', (code) => {
      if (relay.child === child) { relay.child = null; relay.url = ''; }
      // 主动 stop / restart 会 kill 进程，这里不能再把状态翻成 error（否则 stop 后是 error 不是 off）
      if (cfHold) {
        log(`cloudflared: exited ${code} (manual hold, keep off)`);
        return;
      }
      relay.status = 'error';
      relay.error = `cloudflared exited (${code})`;
      const brief = tail.replace(/\s+/g, ' ').trim().slice(-260);
      log(`cloudflared: exited ${code}${brief ? ' | ' + brief : ''}`);
      scheduleCloudflared();
    });
    setTimeout(() => {
      if (relay.status === 'starting' && !relay.url) {
        relay.status = 'error';
        relay.error = 'cloudflared 未在 45s 内拿到公网地址';
        log(`cloudflared: ${relay.error}`);
        scheduleCloudflared();
      }
    }, 45000).unref();
  } catch (e) {
    relay.status = 'error';
    relay.error = e.message;
    log(`cloudflared: ${e.message}`);
    scheduleCloudflared();
  }
}

/** Set while a manual stop/restart is in flight, so the exit handler does not queue a retry. */
let cfHold = false;

/** Kill the current quick tunnel and cancel pending retries (manual control). */
function stopCloudflared(reason) {
  cfHold = true;
  if (cfRetryTimer) { clearTimeout(cfRetryTimer); cfRetryTimer = null; }
  const child = relay.child;
  relay.child = null;
  relay.url = '';
  relay.status = 'off';
  relay.error = '';
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
    log(`cloudflared: stopped (${reason})`);
  }
}

/** Retry with backoff so a single crash does not silently kill the public tunnel. */
function scheduleCloudflared() {
  if (cfHold) return;
  if (!cfg.cloudflared || relay.stopped || relay.child || cfRetryTimer) return;
  if (cfRetry >= 8) {
    log('cloudflared: giving up after 8 retries (restart the bridge to retry)');
    return;
  }
  const delay = Math.min(60000, 2000 * Math.pow(2, cfRetry));
  cfRetry += 1;
  log(`cloudflared: retry #${cfRetry} in ${Math.round(delay / 1000)}s`);
  cfRetryTimer = setTimeout(() => {
    cfRetryTimer = null;
    startCloudflared();
  }, delay);
  if (cfRetryTimer.unref) cfRetryTimer.unref();
}

/**
 * A quick tunnel can stay "up" as a process while the edge drops the connection
 * (browsers then see Cloudflare 1033/530). Probe our own public URL and recycle
 * cloudflared after three consecutive failures.
 */
let cfHealthTimer = null;
let cfHealthFails = 0;

function startTunnelHealth() {
  if (cfHealthTimer) return;
  cfHealthTimer = setInterval(async () => {
    if (!cfg.cloudflared || relay.stopped || !relay.url || !relay.child) return;
    const ok = await probeTunnel(relay.url);
    if (ok) {
      cfHealthFails = 0;
      return;
    }
    cfHealthFails += 1;
    log(`cloudflared: public probe failed (${cfHealthFails}/3)`);
    if (cfHealthFails >= 3) {
      cfHealthFails = 0;
      log('cloudflared: tunnel unreachable, recycling the process');
      try {
        relay.child.kill();
      } catch (e) {
        /* exit handler schedules the retry */
      }
    }
  }, 30000);
  if (cfHealthTimer.unref) cfHealthTimer.unref();
}

async function probeTunnel(url) {
  const base = String(url).replace(/\?.*$/, '');
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    const res = await fetch(base + '/', { signal: ac.signal, redirect: 'manual' });
    clearTimeout(timer);
    return res.status === 200 || res.status === 302;
  } catch (e) {
    return false;
  }
}

function cloudflaredHint() {
  if (!cfg.cloudflared) return '在 config.json 设 "cloudflared": true 并重启 bridge（首次自动下载约 55 MB）';
  if (relay.status === 'downloading') return '首次运行：正在下载 Cloudflare 中转组件（约 55 MB）…';
  if (relay.status === 'starting') return 'Cloudflare 隧道启动中…';
  return relay.error || 'Cloudflare 隧道未就绪';
}

/* ------------------------------------------------------------------ */
/* Optional ngrok tunnel, managed from the desktop plugin               */
/* The authtoken is pasted once, persisted in config.json, and reused   */
/* for every later start: no ngrok CLI and no ngrok config.yml needed.  */
/* ------------------------------------------------------------------ */

const NGROK_DIR = path.join(ROOT, 'bin');
const NGROK_BIN = path.join(NGROK_DIR, 'ngrok.exe');
const NGROK_ZIP_URL = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip';
const ngrok = { status: 'off', url: '', error: '', child: null, logLines: [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ngrokBinCache = { at: 0, p: '' };
function findNgrokBin(force) {
  if (!force && Date.now() - ngrokBinCache.at < 5000) return ngrokBinCache.p;
  const list = [NGROK_BIN, path.join(process.env.LOCALAPPDATA || '', 'ngrok', 'ngrok.exe')];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const clean = dir.replace(/^"+|"+$/g, '');
    if (clean) list.push(path.join(clean, 'ngrok.exe'));
  }
  let found = '';
  for (const p of list) {
    try { if (fs.existsSync(p)) { found = p; break; } } catch { /* skip */ }
  }
  ngrokBinCache = { at: Date.now(), p: found };
  return found;
}

async function downloadNgrokBin() {
  if (fs.existsSync(NGROK_BIN)) return NGROK_BIN;
  fs.mkdirSync(NGROK_DIR, { recursive: true });
  ngrok.status = 'downloading';
  log('ngrok: downloading ngrok.exe (~30 MB, first run only) ...');
  let res;
  try {
    res = await fetch(NGROK_ZIP_URL, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  } catch (e) {
    throw new Error('下载 ngrok.exe 失败（网络问题）：' + e.message + '；可手动下载后放到 ' + NGROK_BIN);
  }
  if (!res.ok) throw new Error('下载 ngrok.exe 失败：HTTP ' + res.status);
  const zip = NGROK_BIN + '.zip';
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  try {
    const src = zip.replace(/'/g, "''");
    const dst = NGROK_DIR.replace(/'/g, "''");
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${src}' -DestinationPath '${dst}' -Force`],
    { timeout: 120000, windowsHide: true, stdio: 'ignore' });
  } finally {
    try { fs.unlinkSync(zip); } catch { /* ignore */ }
  }
  if (!fs.existsSync(NGROK_BIN)) throw new Error('ngrok.exe 解压失败：请手动下载后放到 ' + NGROK_BIN);
  ngrokBinCache = { at: 0, p: '' };
  log('ngrok: installed ' + NGROK_BIN);
  return NGROK_BIN;
}

function taskkill(args) {
  return new Promise((resolve) => {
    try { execFile('taskkill', args, { windowsHide: true }, () => resolve()); } catch { resolve(); }
  });
}

async function probeNgrokApi() {
  try {
    const res = await fetch(cfg.ngrokApi, { signal: AbortSignal.timeout(900) });
    if (!res.ok) return '';
    const data = await res.json();
    const tunnels = Array.isArray(data.tunnels) ? data.tunnels : [];
    const pick = tunnels.find((t) => t && /^https:\/\//i.test(t.public_url || '')
        && String((t.config && t.config.addr) || '').includes(String(cfg.port)))
      || tunnels.find((t) => t && /^https:\/\//i.test(t.public_url || ''));
    return pick ? normalizeBase(pick.public_url) : '';
  } catch {
    return '';
  }
}

function ngrokFailure(raw) {
  const s = String(raw || '');
  if (/ERR_NGROK_4018|authentication failed|invalid authtoken/i.test(s)) {
    return 'authtoken 无效或已过期：请到 ngrok.com → Your Authtoken 重新复制完整的 token';
  }
  if (/ERR_NGROK_108|simultaneous session/i.test(s)) {
    return '这个 authtoken 已有别的 ngrok 会话在运行（免费版只允许一个），先关掉它再启动';
  }
  if (/ERR_NGROK_3200|reserved domain|not a valid domain|ERR_NGROK_\d+.*domain/i.test(s)) {
    return '域名不可用：免费版请把域名留空（每次随机地址）；付费版请填控制台里已预留的域名';
  }
  if (/ERR_NGROK_105|not verified/i.test(s)) {
    return 'ngrok 账号未验证：登录 ngrok.com 完成邮箱验证后再试';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|connect|network|proxy/i.test(s)) {
    return '连不上 ngrok 服务器：检查网络/代理后重试';
  }
  return s ? 'ngrok 启动失败：' + s.slice(0, 300) : 'ngrok 启动失败（没有任何输出）：请先手动运行 ngrok 确认 authtoken';
}

function setNgrokRunningUrl(url) {
  ngrok.url = url || '';
  ngrokCache = { at: 0, url: '' };
}

async function startNgrok(options) {
  const opts = options || {};
  if (ngrok.child && ngrok.child.exitCode === null && ngrok.url) return ngrok.url;
  const token = String(opts.authtoken != null ? opts.authtoken : (cfg.ngrok.authtoken || '')).trim();
  if (!token) throw new Error('请先填写 ngrok authtoken（ngrok.com → Your Authtoken），保存后会自动复用');
  const domain = String(opts.domain != null ? opts.domain : (cfg.ngrok.domain || '')).trim();
  if (domain && !/^[A-Za-z0-9.-]+$/.test(domain)) throw new Error('域名格式不正确：只能包含字母、数字、点和连字符');
  ngrok.error = '';
  ngrok.logLines = [];
  ngrok.status = 'starting';
  const bin = findNgrokBin(true) || (await downloadNgrokBin());
  const args = ['http', String(cfg.port), '--log=stdout', '--log-format=json', '--authtoken=' + token];
  if (domain) args.push('--domain=' + domain);
  let child;
  try {
    child = spawn(bin, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    ngrok.status = 'error';
    ngrok.error = '无法启动 ' + bin + '：' + e.message;
    throw new Error(ngrok.error);
  }
  ngrok.child = child;
  const feed = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (!line.trim()) continue;
      ngrok.logLines.push(line);
      if (ngrok.logLines.length > 80) ngrok.logLines.shift();
      try {
        const j = JSON.parse(line);
        if (j && /started tunnel/i.test(String(j.msg || '')) && /^https:\/\//i.test(String(j.url || ''))) {
          setNgrokRunningUrl(normalizeBase(j.url));
        }
        if (j && (j.lvl === 'eror' || j.lvl === 'error') && (j.err || j.msg)) {
          ngrok.error = String(j.err || j.msg);
        }
      } catch { /* plain text line */ }
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('exit', (code) => {
    log('ngrok exited code=' + code);
    if (ngrok.child === child) ngrok.child = null;
    setNgrokRunningUrl('');
    if (ngrok.status === 'starting') {
      if (!ngrok.error) ngrok.error = ngrok.logLines.slice(-4).join(' | ');
      ngrok.status = 'error';
    } else if (ngrok.status === 'ready') {
      ngrok.status = 'off';
    }
  });
  child.on('error', (e) => {
    log('ngrok spawn error:', e.message);
    ngrok.error = 'ngrok 进程启动失败：' + e.message;
  });

  const deadline = Date.now() + 45000;
  let url = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    url = ngrok.url || (await probeNgrokApi());
    if (url) break;
    await sleep(400);
  }
  if (!url) {
    const detail = ngrokFailure(ngrok.error || ngrok.logLines.slice(-6).join(' | '));
    try { if (child.exitCode === null) await taskkill(['/PID', String(child.pid), '/T', '/F']); } catch {}
    if (ngrok.child === child) ngrok.child = null;
    setNgrokRunningUrl('');
    ngrok.status = 'error';
    ngrok.error = detail;
    throw new Error(detail);
  }
  setNgrokRunningUrl(url);
  ngrok.status = 'ready';
  ngrok.error = '';
  log('ngrok: ready ' + url);
  return url;
}

async function stopNgrok() {
  const child = ngrok.child;
  ngrok.child = null;
  setNgrokRunningUrl('');
  ngrok.status = 'off';
  ngrok.error = '';
  if (child && child.pid && child.exitCode === null) {
    await taskkill(['/PID', String(child.pid), '/T', '/F']);
  } else {
    // The bridge was restarted while ngrok kept running: the tunnel is not our
    // child anymore, so stop it by image name (single-user desktop helper).
    await taskkill(['/IM', 'ngrok.exe', '/F']);
  }
  ngrokCache = { at: 0, url: '' };
  log('ngrok: stopped');
}

async function ngrokSnapshot() {
  const live = (await detectNgrok()) || ngrok.url;
  const bin = findNgrokBin();
  return {
    installed: !!bin,
    bin: bin ? path.relative(ROOT, bin) : '',
    status: ngrok.status,
    running: !!live,
    url: live || '',
    authtokenSet: !!(cfg.ngrok.authtoken || '').trim(),
    domain: (cfg.ngrok.domain || '').trim(),
    error: ngrok.error || '',
  };
}

/** Manual control for the Cloudflare quick tunnel: GET status, POST start/stop/restart. */
async function handleCloudflared(req, res) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (!pcOnly(req, res)) return;
  const snapshot = () => ({
    ok: true,
    enabled: !!cfg.cloudflared,
    installed: fs.existsSync(CLOUDFLARED_BIN),
    status: relay.status,
    ready: relay.status === 'ready' && !!relay.url,
    url: relay.url,
    error: relay.error || '',
    running: !!relay.child,
    // 只有「真的处于 off 且被人为停下」才算 stopped：已经 ready 的隧道不该再报 true。
    stopped: relay.status === 'off' && !!relay.stopped,
    retries: cfRetry,
  });
  if (req.method === 'GET') { jsonOut(res, 200, snapshot()); return; }
  if (req.method !== 'POST') { jsonOut(res, 405, { ok: false, error: 'method not allowed' }); return; }
  let body = '';
  try { body = await readBody(req, 4096); } catch { /* ignore */ }
  let parsed;
  try {
    parsed = JSON.parse(body || '{}') || {};
  } catch (e) {
    jsonOut(res, 400, { ok: false, error: 'invalid json' });
    return;
  }
  const action = String(parsed.action || 'restart');
  if (action === 'stop') {
    relay.stopped = true;
    stopCloudflared('manual stop');
    jsonOut(res, 200, Object.assign(snapshot(), { note: '已停止；重启 bridge 才会再自动拉起' }));
    return;
  }
  if (action === 'start' || action === 'restart') {
    if (action === 'restart') stopCloudflared('manual restart');
    else cfHold = false;
    relay.stopped = false;
    relay.error = '';
    cfRetry = 0;
    if (cfRetryTimer) { clearTimeout(cfRetryTimer); cfRetryTimer = null; }
    startCloudflared();
    jsonOut(res, 200, Object.assign(snapshot(), { note: action === 'restart' ? '已重启，约 3-20 秒后拿到新地址' : '已启动' }));
    return;
  }
  jsonOut(res, 400, { ok: false, error: 'unknown action: ' + action });
}

async function handleNgrok(req, res) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (!pcOnly(req, res)) return;
  if (req.method === 'GET') {
    jsonOut(res, 200, Object.assign({ ok: true }, await ngrokSnapshot()));
    return;
  }
  if (req.method !== 'POST') {
    jsonOut(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  let body = '';
  try { body = await readBody(req, 16384); } catch { /* ignore */ }
  let parsed;
  try {
    parsed = JSON.parse(body || '{}') || {};
  } catch {
    jsonOut(res, 400, { ok: false, error: 'invalid json' });
    return;
  }
  const action = String(parsed.action || 'save');
  const hasToken = Object.prototype.hasOwnProperty.call(parsed, 'authtoken');
  const hasDomain = Object.prototype.hasOwnProperty.call(parsed, 'domain');
  if (hasToken) {
    const t = String(parsed.authtoken || '').trim();
    if (t && (t.length < 20 || /\s/.test(t))) {
      jsonOut(res, 400, { ok: false, error: 'authtoken 看起来不对：应为 ngrok 控制台的整串字符（至少 20 位、不含空格）' });
      return;
    }
    cfg.ngrok.authtoken = t;
  }
  if (hasDomain) {
    const d = String(parsed.domain || '').trim();
    if (d && !/^[A-Za-z0-9.-]+$/.test(d)) {
      jsonOut(res, 400, { ok: false, error: '域名格式不正确：只能包含字母、数字、点和连字符' });
      return;
    }
    cfg.ngrok.domain = d;
  }
  if (action !== 'status') persistConfig();
  if (action === 'stop') {
    await stopNgrok();
    jsonOut(res, 200, Object.assign({ ok: true }, await ngrokSnapshot()));
    return;
  }
  if (action === 'start') {
    try {
      await startNgrok({});
    } catch (e) {
      log('ngrok start failed:', e.message);
      jsonOut(res, 502, Object.assign({}, await ngrokSnapshot(), { ok: false, error: e.message }));
      return;
    }
    jsonOut(res, 200, Object.assign({ ok: true }, await ngrokSnapshot()));
    return;
  }
  jsonOut(res, 200, Object.assign({ ok: true }, await ngrokSnapshot()));
}


async function buildModes() {
  const key = encodeURIComponent(cfg.accessKey);
  const addrs = lanAddresses();
  const virtual = /vEthernet|WSL|Hyper-V|Loopback|VirtualBox|VMware|Tailscale|ZeroTier|docker|br-/i;
  const lanRank = (a) => a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2;
  const lan = addrs
    .filter((a) => isPrivateIp(a.address) && !virtual.test(a.name || ''))
    .sort((a, b) => lanRank(a) - lanRank(b) || a.address.localeCompare(b.address))[0]
    || addrs.filter((a) => isPrivateIp(a.address)).sort((a, b) => lanRank(a) - lanRank(b) || a.address.localeCompare(b.address))[0];
  const tsAddr = addrs.find((a) => isTailscaleIp(a.address));
  const tsBase = normalizeBase(cfg.tailscaleUrl, cfg.port)
    || (tsAddr ? normalizeBase(`http://${tsAddr.address}:${cfg.port}`) : '');
  const ngrokBase = (await detectNgrok()) || (ngrok.status === 'ready' ? ngrok.url : '');
  const ngrokInstalled = !!findNgrokBin();
  const v6 = stableIpv6();
  const ipv6Base = normalizeBase(cfg.ipv6Url, cfg.port)
    || (v6 ? normalizeBase(`http://[${v6}]:${cfg.port}`) : '');
  const cfBase = relay.status === 'ready' ? relay.url : '';
  const make = (id, label, base, hintOn, hintOff, opts) => ({
    id,
    label,
    // `available` = the chip can be picked; `ready` = a usable URL exists.
    // ngrok is pickable before it runs so the plugin can collect + persist the
    // authtoken and start the tunnel from the same panel.
    available: !!base || !!(opts && opts.selectable),
    ready: !!base,
    base: base || '',
    url: base ? `${base}/?k=${key}` : '',
    landing: base ? `${base}/m?k=${key}` : '',
    hint: base ? hintOn : hintOff,
  });
  const ngrokHintOff = () => {
    if (!ngrokInstalled) return '未安装 ngrok.exe：选中 ngrok 后可在面板里一键下载，或放到 bridge\\bin\\ngrok.exe';
    if (!(cfg.ngrok.authtoken || '').trim()) return '已安装 ngrok；选中 ngrok 后粘贴 authtoken 并点启动';
    return 'authtoken 已保存；选中 ngrok 后点「启动 ngrok」即可开公网隧道';
  };
  return [
    make('lan', '局域网', lan ? `http://${lan.address}:${cfg.port}` : '', '同一 Wi-Fi 下使用', '未检测到局域网 IPv4 地址'),
    make('ipv6', 'IPv6 直连', ipv6Base, '公网 IPv6 直连；手机需有 IPv6', '未检测到全局 IPv6 地址；可在 config.json 设置 ipv6Url'),
    make('cloudflared', 'Cloudflare 中转', cfBase, 'Cloudflare 免费快速隧道；电脑保持开机', cloudflaredHint()),
    make('tailscale', 'Tailscale', tsBase, '手机与电脑登录同一 tailnet', '未检测到 100.64/10 地址；安装并登录 Tailscale 后重启 bridge'),
    make('ngrok', 'ngrok', ngrokBase, '公网访问；请保管好带 ?k= 的地址', ngrokHintOff(), { selectable: true }),
  ];
}

function pcDshVersion() {
  try {
    const root = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'DeepSeek Harness', 'runtimes');
    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return entries.length ? entries[entries.length - 1] : '';
  } catch {
    return '';
  }
}

async function infoPayload() {
  const modes = await buildModes();
  const available = modes.filter((m) => m.available);
  // 同一局域网时 lan 最快（0–1ms）；出门在外 lan 探活失败，手机侧 ChannelPool
  // 会按 rank + rtt 自动落到 tailscale（打洞 18–70ms），再退 ipv6 / cloudflared
  const preferred = modes.find((m) => m.id === 'lan' && m.available)
    || modes.find((m) => m.id === 'tailscale' && m.available)
    || modes.find((m) => m.id === 'ipv6' && m.available)
    || modes.find((m) => m.id === 'cloudflared' && m.available)
    || modes.find((m) => m.id === 'ngrok' && m.available)
    || null;
  const apk = fs.existsSync(APK_PATH) ? { url: '/__dshm/app.apk', bytes: fs.statSync(APK_PATH).size } : null;
  const ngrokState = await ngrokSnapshot();
  return {
    ok: true,
    version: VERSION,
    dshVersion: pcDshVersion(),
    key: cfg.accessKey,
    modes,
    preferred: preferred ? preferred.id : '',
    urls: available.map((m) => ({ label: m.label, base: m.base, url: m.url, landing: m.landing })),
    webUrl: preferred ? preferred.url : '',
    landingUrl: preferred ? preferred.landing : '',
    autoLogin: autoLoginToken,
    qr: preferred ? `http://127.0.0.1:${cfg.port}/__dshm/qr.svg?u=${encodeURIComponent(preferred.landing + (preferred.landing.includes('?') ? '&' : '?') + 'at=' + encodeURIComponent(autoLoginToken))}` : '',
    apk,
    passwordSet: passwordSet(),
    ngrok: ngrokState,
    target: target ? { port: target.port, epoch: target.epoch } : null,
  };
}

// A tiny in-browser scanner for phones whose ROM has no shareable scanner app.
// getUserMedia needs a secure origin (https or localhost), so on a plain LAN
// http address the page degrades to the manual paste box.
function scanPage() {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<title>扫一扫连接电脑</title><style>'
    + '*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(160deg,#0a1122,#141e3a);color:#f3f6ff;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:14px 16px 20px;overflow-y:auto;-webkit-overflow-scrolling:touch}'
    + 'h1{font-size:18px;margin:4px 0 2px}p.sub{margin:0 0 10px;color:#97a6c9;font-size:12px;text-align:center}'
    + '.frame{position:relative;width:min(58vw,230px);aspect-ratio:1;border-radius:20px;overflow:hidden;background:#0a0f18;border:1px solid #2b3a66;box-shadow:0 14px 36px rgba(0,0,0,.45);flex:0 0 auto}'
    + 'video{width:100%;height:100%;object-fit:cover;display:block}'
    + '.corner{position:absolute;width:34px;height:34px;border:2px solid #4c8dff;border-radius:6px;opacity:.9}'
    + '.c1{left:12px;top:12px;border-right:0;border-bottom:0}.c2{right:12px;top:12px;border-left:0;border-bottom:0}'
    + '.c3{left:12px;bottom:12px;border-right:0;border-top:0}.c4{right:12px;bottom:12px;border-left:0;border-top:0}'
    + '#tip{margin-top:10px;font-size:12px;color:#97a6c9;text-align:center;min-height:30px;max-width:340px;word-break:break-all}'
    + '.box{margin-top:6px;width:min(100%,380px);display:flex;gap:8px}'
    + 'input{flex:1;min-width:0;padding:12px 14px;border-radius:14px;border:1px solid #2b3a66;background:#121c33;color:#e8eeff;font-size:13px;outline:none}'
    + 'button{padding:12px 16px;border:0;border-radius:14px;background:linear-gradient(135deg,#4c8dff,#7c5cff);color:#fff;font-size:14px;font-weight:600}'
    + '</style></head><body>'
    + '<h1>扫一扫连接电脑</h1>'
    + '<p class="sub">对准电脑端「手机工作台」里的二维码</p>'
    + '<div class="frame"><video id="video" playsinline muted autoplay></video>'
    + '<div class="corner c1"></div><div class="corner c2"></div><div class="corner c3"></div><div class="corner c4"></div></div>'
    + '<div id="tip">正在打开摄像头…</div>'
    + '<div class="box"><input id="manual" placeholder="或直接粘贴电脑地址" autocomplete="off"><button id="go">连接</button></div>'
    + '<script>'
    + 'var video=document.getElementById("video"),tip=document.getElementById("tip"),stopped=false;'
    + 'var sys=document.createElement("a");'
    + 'sys.href="dshmobile://scan-system";'
    + 'sys.textContent="用系统扫一扫";'
    + 'sys.style.cssText="margin-top:10px;color:#8fc4ff;font-size:12.5px;text-decoration:none";'
    + 'document.body.appendChild(sys);'
    + 'function say(t){tip.textContent=t;}'
    + 'function handle(text){'
    + '  var v=String(text||"").trim(); if(!v||stopped) return; stopped=true;'
    + '  var target=v;'
    + '  if(/^https?:\\/\\//i.test(v)) target="dshmobile://open?u="+encodeURIComponent(v);'
    + '  else if(!/^dshmobile:\\/\\//i.test(v)){say("这不是连接地址："+v.slice(0,120));return;}'
    + '  say("已识别，正在回到 App…");'
    + '  try{location.href=target;}catch(e){say("无法唤起 App，请手动粘贴地址");}'
    + '}'
    + 'function manualGo(){var el=document.getElementById("manual");var v=el&&el.value?el.value.trim():"";if(!v){say("先粘贴地址");return;}stopped=false;handle(v);}'
    + 'document.getElementById("go").addEventListener("click",manualGo);'
    + 'document.getElementById("manual").addEventListener("keydown",function(e){if(e.key==="Enter")manualGo();});'
    + 'function boot(){'
    + '  startCamera();'
    + '}'
    + 'var camBtn=document.createElement("button");'
    + 'camBtn.textContent="开始扫描";'
    + 'camBtn.style.cssText="margin-top:12px;padding:13px 26px;border:0;border-radius:16px;background:linear-gradient(135deg,#4c8dff,#7c5cff);color:#fff;font-size:15px;font-weight:600;box-shadow:0 10px 26px rgba(76,141,255,.35);display:none";'
    + 'camBtn.addEventListener("click",function(){startCamera();});'
    + 'function startCamera(){'
    + '  camBtn.style.display="none";'
    + '  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){say("这个 WebView 不支持网页摄像头。请返回上一页，用「用系统扫一扫」，或直接在下面粘贴电脑地址。");camBtn.textContent="重试";camBtn.style.display="";return;}'
    + '  if(!("BarcodeDetector" in window)){say("这个 WebView 不支持网页扫码（BarcodeDetector）。请在下面手动粘贴电脑地址，或返回用系统扫一扫。");camBtn.textContent="重试";camBtn.style.display="";return;}'
    + '  var det;'
    + '  try{det=new BarcodeDetector({formats:["qr_code"]});}catch(e){say("二维码识别不可用，请手动粘贴地址。");return;}'
    + '  navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}}}).then(function(stream){'
    + '    video.srcObject=stream; video.play().catch(function(){}); say("对准二维码…");'
    + '    var loop=function(){'
    + '      if(stopped) return;'
    + '      det.detect(video).then(function(codes){'
    + '        if(codes&&codes.length){handle(codes[0].rawValue);return;}'
    + '        setTimeout(loop,320);'
    + '      }).catch(function(){setTimeout(loop,500);});'
    + '    };'
    + '    loop();'
    + '  }).catch(function(err){'
    + '    say("摄像头打不开："+(err&&err.message?err.message:err)+"\\n可在下面手动粘贴地址。");'
    + '    camBtn.textContent="重试"; camBtn.style.display="";'
    + '  });'
    + '}'
    + 'document.body.appendChild(camBtn);'
    + 'boot();'
    + '</script></body></html>';
}

function landingHtml(req) {
  const host = req.headers.host || `127.0.0.1:${cfg.port}`;
  const mode = classifyHost(host);
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const origin = `${proto}://${host}`;
  const keyEnc = encodeURIComponent(cfg.accessKey);
  const apkBytes = fs.existsSync(APK_PATH) ? fs.statSync(APK_PATH).size : 0;
  const apkLabel = apkBytes ? (apkBytes >= 1048576 ? `${(apkBytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(apkBytes / 1024))} KB`) : '';
  const hasApk = apkBytes ? 'true' : 'false';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#07080c">
<title>DSH Mobile · 手机工作台</title>
<style>
:root{color-scheme:dark;--fg:#eef1f7;--muted:#8d93a3;--line:rgba(255,255,255,.1);--card:rgba(255,255,255,.045)}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:#07080c;color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;overflow-x:hidden;-webkit-font-smoothing:antialiased}
.bg{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0}
.bg i{position:absolute;border-radius:50%;filter:blur(70px);opacity:.55;animation:float 14s ease-in-out infinite alternate}
.b1{width:64vw;height:64vw;top:-24vw;right:-20vw;background:radial-gradient(circle,#2a5cff,transparent 65%)}
.b2{width:64vw;height:64vw;bottom:-30vw;left:-24vw;background:radial-gradient(circle,#00d3b8,transparent 62%);animation-delay:-6s}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:44px 44px;-webkit-mask-image:radial-gradient(ellipse at 50% 18%,#000 8%,transparent 70%);mask-image:radial-gradient(ellipse at 50% 18%,#000 8%,transparent 70%)}
@keyframes float{to{transform:translate3d(0,4vh,0) scale(1.08)}}
main{position:relative;z-index:1;max-width:520px;margin:0 auto;padding:calc(26px + env(safe-area-inset-top)) 20px calc(30px + env(safe-area-inset-bottom))}
.brand{display:flex;align-items:center;gap:11px;margin:4px 0 36px}
.logo{width:44px;height:44px;display:grid;place-items:center;border-radius:14px;background:linear-gradient(145deg,#1b2f7a,#0b1220);border:1px solid rgba(120,160,255,.35);font-size:23px;box-shadow:0 8px 30px rgba(40,90,255,.35)}
.brand b{display:block;font-size:14px;letter-spacing:.2px}
.brand small{display:block;color:var(--muted);font-size:10px;letter-spacing:2.4px;margin-top:1px}
h1{font-size:clamp(34px,10vw,44px);line-height:1.08;letter-spacing:-1.2px;margin:0 0 14px;font-weight:700}
h1 em{font-style:normal;background:linear-gradient(92deg,#7aa2ff,#46e0c8);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--muted);margin:0 0 30px;font-size:13.5px}
.sub code{color:#c9d4ff;background:rgba(120,160,255,.1);padding:2px 7px;border-radius:7px;font-size:12px;word-break:break-all}
.badge{display:inline-block;margin-left:7px;padding:2px 8px;border-radius:999px;background:rgba(120,160,255,.14);border:1px solid rgba(120,160,255,.3);color:#a9bdff;font-size:11px;vertical-align:1px}
.card{display:flex;align-items:center;gap:14px;width:100%;text-align:left;padding:17px 16px;margin:12px 0;border-radius:20px;border:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.028));color:var(--fg);font:inherit;text-decoration:none;-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);box-shadow:0 18px 50px rgba(0,0,0,.35);transition:transform .15s ease,border-color .15s ease;cursor:pointer}
.card:active{transform:scale(.985);border-color:rgba(140,170,255,.4)}
.card .ico{width:44px;height:44px;flex:0 0 44px;display:grid;place-items:center;border-radius:13px;background:rgba(120,160,255,.12);font-size:22px}
.card.app .ico{background:rgba(70,224,200,.12)}
.card .txt{flex:1;min-width:0}
.card b{display:block;font-size:16px;letter-spacing:.1px}
.card small{display:block;color:var(--muted);font-size:12.5px;margin-top:3px;line-height:1.45}
.card .arrow{color:var(--muted);font-size:18px}
.help{margin:16px 0;padding:16px;border-radius:18px;border:1px dashed rgba(255,255,255,.16);background:rgba(255,255,255,.03)}
.help[hidden]{display:none}
.help b{font-size:14px}
.help p{color:var(--muted);font-size:12.5px;margin:6px 0 12px}
.dl{display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(92deg,#4f7dff,#2bc7b0);color:#031015;text-decoration:none;font-weight:700;font-size:14px;padding:13px;border-radius:13px}
.dl span{font-weight:500;opacity:.75;font-size:12px}
.dl.disabled{opacity:.4;pointer-events:none}
.meta{color:#5f6472;font-size:11px;text-align:center;margin-top:28px;line-height:1.7}
@media (min-width:640px){main{padding-top:70px}h1{font-size:50px}}
</style>
</head>
<body>
<div class="bg"><i class="b1"></i><i class="b2"></i><i class="grid"></i></div>
<main>
  <div class="brand"><span class="logo">🐋</span><div><b>DeepSeek Harness</b><small>MOBILE BRIDGE</small></div></div>
  <h1>把工作台<br><em>装进口袋</em></h1>
  <p class="sub">与电脑上的 DSH 实时同步 · 当前连接 <code>${escapeHtml(host)}</code><span class="badge" title="${escapeHtml(mode.hint)}">${mode.label}</span></p>
  <a class="card" href="/?k=${keyEnc}">
    <span class="ico">🌐</span>
    <span class="txt"><b>网页工作台</b><small>浏览器直接打开，已适配手机</small></span>
    <span class="arrow">→</span>
  </a>
  <button class="card app" id="open-app" type="button">
    <span class="ico">📱</span>
    <span class="txt"><b>App 工作台</b><small>原生外壳 · 底部导航 · 更顺滑</small></span>
    <span class="arrow">→</span>
  </button>
  <a class="card" href="/__dshm/files?k=${keyEnc}">
    <span class="ico">📁</span>
    <span class="txt"><b>文件互传</b><small>手机 ↔ 电脑 · 上传下载</small></span>
    <span class="arrow">→</span>
  </a>
  <div class="help" id="help" hidden>
    <b>没有检测到 dsh-mobile</b>
    <p>局域网、IPv6、Cloudflare、Tailscale、ngrok 都可选；安装包已准备好，下载后打开安装，装好后回到本页再点一次「App 工作台」。</p>
    <a class="dl${apkBytes ? '' : ' disabled'}" id="dl" href="/__dshm/app.apk" download="dsh-mobile.apk">下载 APK <span>${apkLabel}</span></a>
  </div>
  <div class="meta">会话与电脑共享 · bridge v${VERSION} · 仅限获得密钥的设备访问</div>
</main>
<script>
(function () {
  var KEY = ${JSON.stringify(cfg.accessKey)};
  var HAS_APK = ${hasApk};
  var help = document.getElementById('help');
  var tried = false;
  function autoDownload() {
    if (tried || !HAS_APK) return;
    tried = true;
    try {
      var a = document.createElement('a');
      a.href = '/__dshm/app.apk';
      a.download = 'dsh-mobile.apk';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {}
  }
  function showHelp() {
    help.hidden = false;
    autoDownload();
  }
  document.getElementById('open-app').addEventListener('click', function () {
    var at = new URLSearchParams(location.search).get('at');
    var web = location.origin + '/?k=' + encodeURIComponent(KEY) + (at ? '&at=' + encodeURIComponent(at) : '');
    var scheme = 'dshmobile://open?u=' + encodeURIComponent(web);
    var left = false;
    function onVis() { if (document.hidden || document.visibilityState === 'hidden') left = true; }
    function onBlur() { left = true; }
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);
    var f = document.createElement('iframe');
    f.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0';
    f.src = scheme;
    document.body.appendChild(f);
    setTimeout(function () {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
      try { f.remove(); } catch (e) {}
      if (!left && !document.hidden) showHelp();
    }, 1600);
  });
  document.getElementById('dl').addEventListener('click', function () { tried = false; autoDownload(); });
})();
</script>
</body>
</html>`;
}

function serveMobileAsset(res, file, type) {
  fs.readFile(path.join(MOBILE_DIR, file), (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'public, max-age=60' });
    res.end(buf);
  });
}

function serveApk(req, res) {
  fs.stat(APK_PATH, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('APK not built yet');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': st.size,
      'content-disposition': 'attachment; filename="dsh-mobile.apk"',
      'cache-control': 'no-store',
    });
    fs.createReadStream(APK_PATH).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* Local (phone) provider bootstrap                                    */
/* ------------------------------------------------------------------ */

/**
 * Reads the DeepSeek provider that the desktop kernel is configured with.
 * The credential file stores a ref/env name, so resolve that first, then fall
 * back to an inline sk- key. Never return or log the credential anywhere else.
 */
function readDeepSeekProvider() {
  const home = cfg.dshHome || path.join(os.homedir(), '.dsh');
  let apiKey = process.env.DEEPSEEK_API_KEY || '';
  let source = 'environment';
  try {
    const credPath = path.join(home, '.credentials.yaml');
    const cred = fs.readFileSync(credPath, 'utf8');
    let ref = 'DEEPSEEK_API_KEY';
    const refMatch = cred.match(/DEEPSEEK_API_KEY[\s\S]{0,160}?ref:\s*([A-Za-z_][A-Za-z0-9_]*)/);
    if (refMatch) ref = refMatch[1];
    if (!apiKey) apiKey = process.env[ref] || '';
    if (!apiKey) {
      const sk = cred.match(/sk-[A-Za-z0-9_-]{16,}/);
      if (sk) apiKey = sk[0];
    }
    source = credPath;
  } catch { /* no credentials file */ }
  let model = 'deepseek-flash';
  let baseUrl = 'https://api.deepseek.com/v1';
  try {
    const patch = fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8');
    const mm = patch.match(/model:\s*['"]?(deepseek-[a-z0-9.-]+)/i);
    if (mm) model = mm[1];
    const bm = patch.match(/baseURL:\s*['"]?(https?:\/\/[^'"\s]+)/i)
      || patch.match(/baseUrl:\s*['"]?(https?:\/\/[^'"\s]+)/i);
    if (bm) baseUrl = bm[1];
  } catch { /* defaults */ }
  return { apiKey, model, baseUrl, source };
}

function serveLocalProvider(req, res) {
  try {
    const p = readDeepSeekProvider();
    if (!p.apiKey) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: '电脑端没有找到 DEEPSEEK_API_KEY，请检查 ~/.dsh/.credentials.yaml' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      apiKey: p.apiKey,
      baseUrl: p.baseUrl,
      model: p.model,
      source: p.source,
    }));
  } catch (e) {
    log('ERROR /__dshm/local/provider:', e.message);
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

/* ------------------------------------------------------------------ */
/* Sync user-installed desktop plugins into the phone-local profile    */
/* ------------------------------------------------------------------ */

const PLUGIN_TAR = path.join(ROOT, 'plugins.tar.gz');
const PLUGIN_PROFILE_NAMES = new Set(['base', 'web-app', 'dsh-mobile-qr']);
let pluginTarTask = null;

function localProfileDir() {
  return path.join(cfg.dshHome || path.join(os.homedir(), '.dsh'), 'profiles', 'web');
}

function userPluginBundles() {
  const names = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(localProfileDir(), 'package.json'), 'utf8'));
    const bundles = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
    if (!Array.isArray(bundles)) return names;
    for (const raw of bundles) {
      if (typeof raw !== 'string') continue;
      if (raw.startsWith('@deepseek-ai/')) continue; // DSH built-ins stay on the phone's own runtime
      if (PLUGIN_PROFILE_NAMES.has(raw)) continue;
      if (names.indexOf(raw) < 0) names.push(raw);
    }
  } catch (e) {
    log('WARN userPluginBundles:', e.message);
  }
  return names;
}

function ensurePluginTar() {
  if (pluginTarTask) return pluginTarTask;
  const profile = localProfileDir();
  const pkg = path.join(profile, 'package.json');
  let fresh = false;
  try {
    fresh = fs.statSync(PLUGIN_TAR).mtimeMs >= fs.statSync(pkg).mtimeMs;
  } catch { fresh = false; }
  if (fresh) return Promise.resolve(PLUGIN_TAR);
  pluginTarTask = new Promise((resolve, reject) => {
    const tmp = PLUGIN_TAR + '.tmp';
    log('building user-plugin tar from', profile);
    try { fs.unlinkSync(tmp); } catch { /* absent */ }
    execFile('tar.exe', [
      '-h', '-czf', tmp, '-C', profile,
      '--exclude', 'node_modules/@deepseek-ai',
      '--exclude', 'node_modules/.bin',
      'node_modules',
    ], { timeout: 240000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        pluginTarTask = null;
        log('ERROR plugin tar:', (stderr || err.message).toString().slice(0, 500));
        reject(err);
        return;
      }
      try {
        fs.renameSync(tmp, PLUGIN_TAR);
        log('user-plugin tar ready:', fs.statSync(PLUGIN_TAR).size, 'bytes');
        resolve(PLUGIN_TAR);
      } catch (e) {
        pluginTarTask = null;
        reject(e);
      }
    });
  });
  return pluginTarTask;
}

/* ------------------------------------------------------------------ */
/* Phone debug relay (debug-mode toggle in the app)                     */
/* ------------------------------------------------------------------ */

const debugQueue = [];
const debugResults = new Map();
let debugWaiter = null;
let debugSeq = 0;

function jsonOut(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function debugWake() {
  if (!debugWaiter) return;
  const w = debugWaiter;
  debugWaiter = null;
  clearTimeout(w.timer);
  const cmd = debugQueue.shift() || { id: 0 };
  jsonOut(w.res, 200, cmd);
}

function debugCommand(req, res) {
  if (req.method !== 'POST') { jsonOut(res, 405, { ok: false, error: 'POST only' }); return; }
  if (!pcOnly(req, res)) return;
  readBody(req, 256 * 1024).then((raw) => {
    const body = JSON.parse(raw || '{}');
    const id = ++debugSeq;
    const item = { id, cmd: String(body.cmd || ''), args: body.args || {}, ts: Date.now() };
    debugQueue.push(item);
    log('debug command queued:', id, item.cmd);
    jsonOut(res, 200, { ok: true, id });
    debugWake();
  }).catch((e) => jsonOut(res, 400, { ok: false, error: e.message }));
}

function debugPoll(req, res) {
  if (debugQueue.length) {
    jsonOut(res, 200, debugQueue.shift());
    return;
  }
  if (debugWaiter) {
    jsonOut(res, 409, { id: 0, error: 'another device is polling' });
    return;
  }
  debugWaiter = { res, timer: null };
  debugWaiter.timer = setTimeout(() => {
    if (debugWaiter && debugWaiter.res === res) {
      debugWaiter = null;
      jsonOut(res, 200, { id: 0 });
    }
  }, 25000);
  res.on('close', () => {
    if (debugWaiter && debugWaiter.res === res) {
      clearTimeout(debugWaiter.timer);
      debugWaiter = null;
    }
  });
}

function debugResult(req, res) {
  if (req.method !== 'POST') { jsonOut(res, 405, { ok: false, error: 'POST only' }); return; }
  readBody(req, 16 * 1024 * 1024).then((raw) => {
    const body = JSON.parse(raw || '{}');
    const id = Number(body.id) || 0;
    const rec = {
      id,
      ok: body.ok !== false,
      result: body.result === undefined ? null : body.result,
      image: body.image || '',
      ts: Date.now(),
    };
    debugResults.set(id, rec);
    while (debugResults.size > 20) debugResults.delete(debugResults.keys().next().value);
    log('debug result:', id, rec.ok ? 'ok' : 'error');
    jsonOut(res, 200, { ok: true });
  }).catch((e) => jsonOut(res, 400, { ok: false, error: e.message }));
}

function debugStatus(req, res) {
  if (!pcOnly(req, res)) return;
  const arr = [];
  for (const rec of debugResults.values()) arr.push(rec);
  jsonOut(res, 200, {
    ok: true,
    waiting: !!debugWaiter,
    queued: debugQueue.length,
    results: arr.slice(-8),
  });
}

function debugResultGet(req, res, u) {
  if (!pcOnly(req, res)) return;
  const id = Number(u.searchParams.get('id')) || 0;
  const rec = debugResults.get(id);
  if (!rec) { jsonOut(res, 404, { ok: false, error: 'no result' }); return; }
  jsonOut(res, 200, rec);
}


function servePluginList(req, res) {
  const plugins = userPluginBundles();
  let bytes = 0;
  let updated = null;
  try {
    const st = fs.statSync(PLUGIN_TAR);
    bytes = st.size;
    updated = st.mtime.toISOString();
  } catch { /* not built yet */ }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({
    ok: true,
    profile: localProfileDir(),
    plugins,
    count: plugins.length,
    bytes,
    updated,
    builtInExcluded: true,
  }));
}

function servePluginTar(req, res) {
  ensurePluginTar().then((file) => {
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': stat.size,
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  }).catch((e) => {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
  });
}


/* ------------------------------------------------------------------ */
/* Desktop -> phone config sync bundle                                 */
/* ------------------------------------------------------------------ */

const SYNC_DIR = path.join(ROOT, '..', 'sync');
const SYNC_TAR = path.join(SYNC_DIR, 'sync.tar.gz');
const SYNC_MANIFEST = path.join(SYNC_DIR, 'manifest.json');
const SYNC_RUNTIME_TAR = path.join(ROOT, '..', 'android', 'assets', 'runtime.tar.gz');

function serveFileRanged(req, res, file, contentType) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'not_found', file: path.basename(file) }));
    return;
  }
  const total = stat.size;
  let start = 0;
  let end = total - 1;
  let code = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        const tail = Number(m[2]);
        start = Math.max(0, total - tail);
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), total - 1);
      }
      if (start > end || start >= total) {
        res.writeHead(416, { 'content-range': `bytes */${total}`, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      code = 206;
    }
  }
  const headers = {
    'content-type': contentType,
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  if (code === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file, { start, end }).pipe(res);
}

/* 同步包新鲜度：手机点「同步」时，如果包比 home 里的受管文件旧，先让电脑重打包。
   以前这里只发静态文件，导致「同步成功」拿到的仍是几天前打的包。 */
function newestMtime(paths, budget) {
  let max = 0;
  const stack = paths.slice();
  let left = budget || 6000;
  while (stack.length && left-- > 0) {
    const p = stack.pop();
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs > max) max = st.mtimeMs;
    if (st.isDirectory()) {
      let ents = [];
      try { ents = fs.readdirSync(p); } catch { continue; }
      for (const name of ents) stack.push(path.join(p, name));
    }
  }
  return max;
}

function syncFreshness() {
  const home = cfg.dshHome || path.join(process.env.USERPROFILE || '', '.dsh');
  const src = newestMtime([
    path.join(home, 'AGENTS.md'),
    path.join(home, 'prompt-inject.md'),
    path.join(home, 'skills'),
    path.join(home, '.agent-presets'),
    path.join(home, 'memory-vault'),
  ]);
  let bundleMtime = 0;
  try { bundleMtime = fs.statSync(SYNC_TAR).mtimeMs; } catch { bundleMtime = 0; }
  const stale = src > bundleMtime + 60000;
  return {
    sourceMtime: src,
    bundleMtime,
    stale,
    staleHours: bundleMtime ? Math.round((src - bundleMtime) / 36e5) : -1,
  };
}

let syncRebuild = null;
function rebuildSyncBundle(req, res) {
  if (req.method !== 'POST') { jsonOut(res, 405, { ok: false, error: 'POST only' }); return; }
  if (syncRebuild) {
    syncRebuild.then((r) => jsonOut(res, r.ok ? 200 : 500, r)).catch((e) => jsonOut(res, 500, { ok: false, error: String(e) }));
    return;
  }
  const root = path.join(ROOT, '..');
  const script = path.join(root, 'tools', 'build-sync.mjs');
  const p = new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(process.execPath, [script], { cwd: root, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: 'spawn failed: ' + e.message });
      return;
    }
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const fuse = setTimeout(() => { try { child.kill(); } catch { } }, 240000);
    child.on('error', (e) => { clearTimeout(fuse); resolve({ ok: false, error: 'run failed: ' + e.message }); });
    child.on('exit', (code) => {
      clearTimeout(fuse);
      let generatedAt = '';
      try { generatedAt = JSON.parse(fs.readFileSync(SYNC_MANIFEST, 'utf8')).generatedAt || ''; } catch { }
      let bytes = 0;
      try { bytes = fs.statSync(SYNC_TAR).size; } catch { }
      resolve({
        ok: code === 0,
        code,
        ms: Date.now() - t0,
        generatedAt,
        bytes,
        tail: out.split('\n').filter((x) => x.trim()).slice(-2).join(' | '),
        error: code === 0 ? '' : (err || out).slice(-400),
      });
    });
  });
  syncRebuild = p;
  p.then(() => { syncRebuild = null; }).catch(() => { syncRebuild = null; });
  p.then((r) => jsonOut(res, r.ok ? 200 : 500, r)).catch((e) => jsonOut(res, 500, { ok: false, error: String(e) }));
}
function serveSyncManifest(req, res) {
  try {
    const raw = fs.readFileSync(SYNC_MANIFEST, 'utf8');
    const manifest = JSON.parse(raw);
    const bundle = fs.statSync(SYNC_TAR);
    let runtime = null;
    try {
      const st = fs.statSync(SYNC_RUNTIME_TAR);
      runtime = { bytes: st.size, path: '/__dshm/sync/runtime.tar.gz' };
    } catch { runtime = null; }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      manifest,
      bundle: { bytes: bundle.size, path: '/__dshm/sync.tar.gz', mtime: bundle.mtimeMs },
      runtime,
      ...syncFreshness(),
    }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
  }
}

/* ------------------------------------------------------------------ */
/* Phone <-> PC file transfer                                          */
/* ------------------------------------------------------------------ */

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const FILES_PAGE = path.join(ROOT, 'files.html');

function filesRoot() {
  const dir = cfg.filesDir ? path.resolve(String(cfg.filesDir)) : path.join(ROOT, 'files');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filesRel(raw) {
  const root = filesRoot();
  const clean = String(raw == null ? '' : raw).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径不合法');
  return { root, rel: path.relative(root, abs).split(path.sep).join('/'), abs };
}

function filesJson(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveFilesPage(req, res) {
  try {
    const html = fs.readFileSync(FILES_PAGE);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch (e) {
    sendError(res, 500, `文件传输页未就绪：${e.message}`);
  }
}

function serveFilesConfig(req, res) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!pcOnly(req, res)) return;
  if (req.method === 'GET') {
    filesJson(res, 200, { ok: true, dir: filesRoot() });
    return;
  }
  if (req.method !== 'POST') {
    filesJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  readBody(req, 8192).then((body) => {
    let data;
    try { data = JSON.parse(body || '{}'); } catch { throw new Error('JSON 无效'); }
    const raw = String(data.dir || '').trim();
    if (!raw || !path.isAbsolute(raw)) throw new Error('请填写电脑上的绝对路径');
    const dir = path.resolve(raw);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.statSync(dir).isDirectory()) throw new Error('不是文件夹');
    cfg.filesDir = dir;
    persistConfig();
    filesJson(res, 200, { ok: true, dir });
  }).catch((e) => filesJson(res, 400, { ok: false, error: e.message }));
}

function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    dest = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(dest)) return dest;
  }
  throw new Error('同名文件过多');
}

async function serveFileUpload(req, res, u) {
  const r = filesRel(u.searchParams.get('dir') || '');
  fs.mkdirSync(r.abs, { recursive: true });
  let name = path.basename(String(u.searchParams.get('name') || 'upload.bin'));
  name = name.replace(/[\u0000-\u001f]/g, '').slice(0, 180);
  if (!name || name === '.' || name === '..') name = 'upload.bin';
  const dest = uniqueDest(r.abs, name);
  const tmp = `${dest}.dshm-part-${crypto.randomBytes(4).toString('hex')}`;
  const out = fs.createWriteStream(tmp, { flags: 'wx' });
  let size = 0;
  let tooLarge = false;

  req.on('data', (chunk) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      tooLarge = true;
      try { req.unpipe(out); } catch {}
      try { out.destroy(); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      try {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '文件超过 1 GB 上限' }));
      } catch {}
      try { req.destroy(); } catch {}
    }
  });

  try {
    await new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
      req.pipe(out);
    });
    if (tooLarge) return;
    fs.renameSync(tmp, dest);
    filesJson(res, 200, {
      ok: true,
      name: path.basename(dest),
      path: path.relative(r.root, dest).split(path.sep).join('/'),
      bytes: size,
    });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (!res.headersSent) filesJson(res, 500, { ok: false, error: e.message });
  }
}

function serveArtifact(req, res, u) {
  const raw = u.searchParams.get('path') || '';
  if (!raw || !path.isAbsolute(raw)) {
    filesJson(res, 400, { ok: false, error: 'absolute path required' });
    return;
  }
  let st;
  try { st = fs.statSync(raw); } catch {
    filesJson(res, 404, { ok: false, error: 'not found' });
    return;
  }
  if (!st.isFile()) {
    filesJson(res, 400, { ok: false, error: 'not a file' });
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-store',
  });
  fs.createReadStream(raw).pipe(res);
}

async function serveFilesApi(req, res, u) {  const sub = u.pathname.slice('/__dshm/files'.length);
  try {
    if (sub === '/list') {
      const r = filesRel(u.searchParams.get('dir') || '');
      const st = fs.statSync(r.abs);
      if (!st.isDirectory()) throw new Error('不是文件夹');
      const entries = fs.readdirSync(r.abs, { withFileTypes: true }).map((d) => {
        const abs = path.join(r.abs, d.name);
        let s = null;
        try { s = fs.statSync(abs); } catch { /* race */ }
        return {
          name: d.name,
          isDir: d.isDirectory(),
          size: d.isDirectory() ? null : (s ? s.size : 0),
          mtime: s ? s.mtimeMs : 0,
          path: path.relative(r.root, abs).split(path.sep).join('/'),
        };
      }).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh-CN'));
      const rel = r.rel;
      filesJson(res, 200, {
        ok: true,
        dir: rel,
        root: r.root,
        parent: rel ? path.posix.dirname(rel).replace(/^\.$/, '') : null,
        entries,
      });
      return;
    }
    if (sub === '/upload') {
      if (req.method !== 'POST') { filesJson(res, 405, { ok: false, error: 'POST required' }); return; }
      await serveFileUpload(req, res, u);
      return;
    }
    if (sub === '/download') {
      const r = filesRel(u.searchParams.get('path') || '');
      const st = fs.statSync(r.abs);
      if (!st.isFile()) throw new Error('不是文件');
      const name = path.basename(r.abs);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': st.size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'no-store',
      });
      fs.createReadStream(r.abs).pipe(res);
      return;
    }
    if (sub === '/mkdir') {
      const body = await readBody(req, 8192);
      const data = JSON.parse(body || '{}');
      const name = path.basename(String(data.name || '')).replace(/[\u0000-\u001f]/g, '').trim();
      if (!name || name === '.' || name === '..') throw new Error('文件夹名称无效');
      const parent = filesRel(data.dir || '');
      const abs = path.join(parent.abs, name);
      if (!abs.startsWith(parent.root + path.sep)) throw new Error('路径不合法');
      fs.mkdirSync(abs, { recursive: false });
      filesJson(res, 200, { ok: true, path: path.relative(parent.root, abs).split(path.sep).join('/') });
      return;
    }
    if (sub === '/delete') {
      const body = await readBody(req, 8192);
      const data = JSON.parse(body || '{}');
      const r = filesRel(data.path || '');
      if (r.abs === r.root) throw new Error('不能删除根目录');
      const st = fs.statSync(r.abs);
      if (st.isDirectory()) fs.rmSync(r.abs, { recursive: false });
      else fs.unlinkSync(r.abs);
      filesJson(res, 200, { ok: true });
      return;
    }
    filesJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    if (!res.headersSent) filesJson(res, 400, { ok: false, error: e.message });
  }
}

/* ------------------------------------------------------------------ */
/* Phone directory picker: browse the PC's folders from the phone       */
/* ------------------------------------------------------------------ */
/* The desktop host answers "add workspace" with a native Windows file
 * dialog that never reaches the phone. The phone page therefore browses
 * the PC through this endpoint (mobile.js renders the sheet) and hands
 * the absolute path back to DSH, which creates the workspace as usual. */

const DIRS_MAX_ENTRIES = 1000;

function normalizeDirPath(raw) {
  if (!raw) return '';
  let p = String(raw).trim().replace(/\//g, '\\');
  if (/^[A-Za-z]:$/.test(p)) p += '\\';
  return p;
}

function windowsDrives() {
  if (process.platform !== 'win32') return [{ name: '根目录', path: '/' }];
  const out = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try { if (fs.existsSync(root)) out.push({ name: `${letter} 盘`, path: root }); } catch { /* skip */ }
  }
  return out;
}

function dirShortcuts(home) {
  const out = [];
  try { if (home && fs.existsSync(home)) out.push({ name: '用户目录', path: home }); } catch { /* skip */ }
  const known = [['桌面', 'Desktop'], ['下载', 'Downloads'], ['文档', 'Documents'],
    ['图片', 'Pictures'], ['音乐', 'Music'], ['视频', 'Videos']];
  for (const [cn, en] of known) {
    const p = path.join(home, en);
    try { if (fs.existsSync(p)) out.push({ name: cn, path: p }); } catch { /* skip */ }
  }
  return out;
}

function dirCrumbs(p) {
  const out = [];
  const root = path.parse(p).root || p;
  let cur = root;
  out.push({ name: cur.replace(/\\+$/, '') || cur, path: cur });
  const parts = p.slice(root.length).split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    cur = cur.endsWith('\\') ? cur + part : `${cur}\\${part}`;
    out.push({ name: part, path: cur });
  }
  return out;
}

function serveDirs(req, res, u) {
  const home = os.homedir();
  try {
    const p = normalizeDirPath(u.searchParams.get('path') || '');
    if (!p) {
      jsonOut(res, 200, {
        ok: true, path: '', home, parent: null, crumbs: [], entries: [],
        shortcuts: dirShortcuts(home), drives: windowsDrives(), truncated: false,
      });
      return;
    }
    if (!path.isAbsolute(p)) throw new Error('路径必须是绝对路径');
    const st = fs.statSync(p);
    if (!st.isDirectory()) throw new Error('不是文件夹');
    const entries = [];
    for (const d of fs.readdirSync(p, { withFileTypes: true })) {
      if (d.name === '.' || d.name === '..') continue;
      const abs = path.join(p, d.name);
      let isDir = d.isDirectory();
      if (!isDir && d.isSymbolicLink()) {
        try { isDir = fs.statSync(abs).isDirectory(); } catch { isDir = false; }
      }
      if (!isDir) continue;
      entries.push({ name: d.name, path: abs, isDirectory: true });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const truncated = entries.length > DIRS_MAX_ENTRIES;
    if (truncated) entries.length = DIRS_MAX_ENTRIES;
    const parent = path.dirname(p);
    jsonOut(res, 200, {
      ok: true, path: p, home,
      parent: parent && parent !== p ? parent : null,
      crumbs: dirCrumbs(p), entries,
      shortcuts: dirShortcuts(home), drives: windowsDrives(), truncated,
    });
  } catch (e) {
    jsonOut(res, 200, { ok: false, error: e.message, home });
  }
}

async function serveDirsMkdir(req, res) {
  try {
    const data = JSON.parse((await readBody(req, 8192)) || '{}');
    const parent = normalizeDirPath(data.path || '');
    const name = path.basename(String(data.name || '')).replace(/[\\/\u0000-\u001f]/g, '').trim();
    if (!parent || !path.isAbsolute(parent)) throw new Error('父目录无效');
    if (!name || name === '.' || name === '..') throw new Error('文件夹名称无效');
    const abs = path.join(parent, name);
    if (!abs.startsWith(parent)) throw new Error('路径不合法');
    fs.mkdirSync(abs, { recursive: false });
    jsonOut(res, 200, { ok: true, path: abs });
  } catch (e) {
    jsonOut(res, 200, { ok: false, error: e.message });
  }
}

async function serveInfo(req, res) {
  allowCors(req, res);
  if (!pcOnly(req, res)) return;
  try {
    const info = await infoPayload();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(info));
  } catch (e) {
    log('ERROR /__dshm/info:', e.message);
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

/* ── P2P 直连（UDP 打洞）─────────────────────────────────────────────
 * 公网隧道只负责交换一次「对方在公网看起来是哪个 IP:端口」，
 * 之后两端互相往对方发 UDP，打穿就是 0 中继直连；打不穿回落隧道。
 * 局域网本来就是直连，不参与这套。
 */
const P2P_PORT = Number((cfg.p2p && cfg.p2p.port) || process.env.DSH_CONNECT_MOBILE_P2P_PORT || process.env.DSHM_P2P_PORT || (Number(process.env.DSH_CONNECT_MOBILE_PORT) ? Number(process.env.DSH_CONNECT_MOBILE_PORT) - 61 : 0) || 8789);
const P2P_TOKEN = crypto.randomBytes(8).toString('hex');
const p2p = { sock: null, bound: false, peer: null, lastPeerAt: 0, waiters: new Map() };

function p2pKey(r) { return r.address + ':' + r.port; }

function p2pStart() {
  if (p2p.sock) return;
  const sock = dgram.createSocket('udp4');
  p2p.sock = sock;
  sock.on('error', (e) => log('p2p udp error:', e.message));
  sock.on('message', (buf, rinfo) => {
    const text = buf.toString('utf8');
    const key = p2pKey(rinfo);
    const w = p2p.waiters.get(key);
    if (w) { p2p.waiters.delete(key); clearTimeout(w.timer); w.resolve({ rinfo, text }); }
    if (text.startsWith('PING ')) {
      const nonce = text.slice(5).trim();
      try { sock.send('PONG ' + nonce, rinfo.port, rinfo.address); } catch {}
      return;
    }
    if (text.startsWith('HELLO ')) {
      const parts = text.split(' ');
      const token = (parts[1] || '').trim();
      const nonce = (parts[2] || '').trim();
      if (token !== P2P_TOKEN) { try { sock.send('HELLO-BAD', rinfo.port, rinfo.address); } catch {} return; }
      p2p.peer = { ip: rinfo.address, port: rinfo.port };
      p2p.lastPeerAt = Date.now();
      try { sock.send('HELLO-OK ' + nonce, rinfo.port, rinfo.address); } catch {}
      log('p2p: peer learned ' + key);
      return;
    }
    if (text.startsWith('HELLO-OK') || text.startsWith('PONG ') || text.startsWith('HELLO-BAD')) {
      if (text.startsWith('HELLO-OK')) { p2p.peer = { ip: rinfo.address, port: rinfo.port }; p2p.lastPeerAt = Date.now(); }
      return;
    }
  });
  sock.bind(P2P_PORT, '0.0.0.0', () => {
    p2p.bound = true;
    log('p2p: udp listening on 0.0.0.0:' + P2P_PORT + ' (token ' + P2P_TOKEN + ')');
  });
}

function p2pWait(ip, port, timeoutMs) {
  const key = ip + ':' + port;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { p2p.waiters.delete(key); resolve(null); }, timeoutMs);
    p2p.waiters.set(key, { resolve, timer });
  });
}

function p2pSend(text, ip, port) {
  if (!p2p.sock) return false;
  try { p2p.sock.send(text, port, ip); return true; } catch (e) { return false; }
}

function stunRequest(txid) {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(0x2112A442, 4);
  txid.copy(buf, 8);
  return buf;
}

function stunParse(msg) {
  if (msg.length < 20) return null;
  const type = msg.readUInt16BE(0);
  if ((type & 0x3fff) !== 0x0101) return null;
  let p = 20;
  while (p + 4 <= msg.length) {
    const at = msg.readUInt16BE(p);
    const len = msg.readUInt16BE(p + 2);
    const val = msg.subarray(p + 4, p + 4 + len);
    if (at === 0x0020 && val.length >= 8) {
      const port = val.readUInt16BE(2) ^ 0x2112;
      const ip = [val[4] ^ 0x21, val[5] ^ 0x12, val[6] ^ 0xa4, val[7] ^ 0x42].join('.');
      return { ip, port };
    }
    if (at === 0x0001 && val.length >= 8) {
      return { ip: [val[4], val[5], val[6], val[7]].join('.'), port: val.readUInt16BE(2) };
    }
    p += 4 + len + ((4 - (len % 4)) % 4);
  }
  return null;
}

function stunAsk(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const txid = crypto.randomBytes(12);
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.close(); } catch {} resolve(v); };
    sock.on('message', (m) => finish(stunParse(m)));
    sock.on('error', () => finish(null));
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.send(stunRequest(txid), port, host, (e) => { if (e) { clearTimeout(timer); finish(null); } });
  });
}

async function stunMapped() {
  const servers = [['stun.miwifi.com', 3478], ['stun.cloudflare.com', 3478], ['stun.l.google.com', 19302]];
  for (const [h, p] of servers) {
    const r = await stunAsk(h, p, 1500);
    if (r) return { ...r, server: h + ':' + p };
  }
  return null;
}

async function serveP2PInfo(req, res, u) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (!(keyMatches(req, u) || sessionMatches(req) || isLocalPc(req))) {
    jsonOut(res, 401, { ok: false, error: 'unauthorized' }); return;
  }
  const stun = await stunMapped().catch(() => null);
  jsonOut(res, 200, {
    ok: true,
    token: P2P_TOKEN,
    udp: { port: P2P_PORT, bound: p2p.bound },
    stun,
    peer: p2p.peer,
    bridgePort: cfg.port,
  });
}

async function serveP2PPeer(req, res, u) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (!(keyMatches(req, u) || sessionMatches(req) || isLocalPc(req))) {
    jsonOut(res, 401, { ok: false, error: 'unauthorized' }); return;
  }
  if (req.method !== 'POST') { jsonOut(res, 405, { ok: false, error: 'POST only' }); return; }
  let body = {};
  try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
  const ip = String(body.ip || '').trim();
  const port = Number(body.port || 0);
  if (!ip || !port) { jsonOut(res, 400, { ok: false, error: 'ip/port required' }); return; }
  p2p.peer = { ip, port };
  p2p.lastPeerAt = Date.now();
  p2pStart();
  const nonce = crypto.randomBytes(4).toString('hex');
  const started = Date.now();
  const wait = p2pWait(ip, port, 4000);
  p2pSend('HELLO ' + P2P_TOKEN + ' ' + nonce, ip, port);
  const got = await wait;
  const rtt = got ? Date.now() - started : -1;
  jsonOut(res, 200, { ok: !!got, rtt, reply: got ? got.text.slice(0, 40) : '', from: got ? p2pKey(got.rinfo) : '', token: P2P_TOKEN });
}


function serveVersion(req, res, u) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!(keyMatches(req, u) || sessionMatches(req) || isLocalPc(req))) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }
  const apkBytes = fs.existsSync(APK_PATH) ? fs.statSync(APK_PATH).size : 0;
  const meta = apkMeta();
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({
    ok: true,
    bridge: VERSION,
    dsh: pcDshVersion(),
    apkBytes,
    // 手机端「检查更新」靠这三项比对自身 versionCode；build.ps1 每次发版写
    // apk/apk-version.json，读不到就退回只看 apkBytes 的旧行为。
    apkVersionName: meta.versionName || '',
    apkVersionCode: meta.versionCode || 0,
    apkSha256: meta.sha256 || '',
    apkBuiltAt: meta.builtAt || '',
    passwordSet: passwordSet(),
    mobileMinVersion: '0.1.0',
  }));
}

/**
 * 通道池：把这个 bridge 当前能被手机访问到的所有地址一次给全。
 * 手机连上任意一条（扫码/局域网/ngrok/Cloudflare…）后就拉一次，
 * 存成本地备用池；当前通道断了自动挨个探测切换。
 * 地址里不带 ?k=，密钥由手机自己拼（避免把 key 写进日志/剪贴板）。
 */
async function channelsPayload() {
  const port = cfg.port;
  const list = [];
  const seen = new Set();
  const pending = [];
  const push = (id, kind, label, url, note) => {
    const u = normalizeBase(url);
    if (!u || seen.has(u)) return;
    seen.add(u);
    list.push({ id, kind, label, url: u, note: note || '', state: 'ready' });
  };
  // 隧道类通道即使没起来也要报状态，手机才能提示「哪条没启动、能不能让电脑拉起来」。
  const tunnelState = (id) => {
    if (id === 'ngrok') {
      if (ngrok.status === 'starting') return 'starting';
      if (ngrok.url) return 'ready';
      return (cfg.ngrok.authtoken || '').trim() ? 'off' : 'unconfigured';
    }
    if (id === 'cloudflared') {
      if (!cfg.cloudflared) return 'disabled';
      if (relay.status === 'ready' && relay.url) return 'ready';
      if (relay.status === 'starting' || relay.status === 'downloading') return 'starting';
      return 'off';
    }
    return 'ready';
  };
  // USB：adb reverse 把手机的 8787 转到电脑，只有插着线才通
  push('usb', 'usb', 'USB 直连', `http://127.0.0.1:${port}`, 'adb reverse tcp:' + port);
  const tsAddrs = lanAddresses().filter((a) => isTailscaleIp(a.address));
  for (const a of lanAddresses()) {
    if (isTailscaleIp(a.address)) {
      push('tailscale', 'tailscale', 'Tailscale 直连', `http://${a.address}:${port}`, '同一 tailnet；打洞 18–70ms，回落 DERP ~200ms');
    } else {
      push('lan', 'lan', '局域网 ' + a.address, `http://${a.address}:${port}`, a.name);
    }
  }
  const v6 = stableIpv6();
  if (v6) push('ipv6', 'ipv6', 'IPv6 直连', `http://[${v6}]:${port}`, '手机需有 IPv6');
  let ngrokUrl = '';
  try { ngrokUrl = await detectNgrok(); } catch { /* optional */ }
  if (ngrokUrl) push('ngrok', 'ngrok', 'ngrok 公网', ngrokUrl, '重启 ngrok 会换域名');
  if (relay.status === 'ready' && relay.url) {
    push('cloudflared', 'cloudflared', 'Cloudflare 中转', relay.url, 'quick tunnel，重启会换域名');
  }
  const ngrokState = tunnelState('ngrok');
  if (!ngrokUrl) pending.push({ id: 'ngrok', kind: 'ngrok', label: 'ngrok 公网', state: ngrokState, hint: ngrokState === 'unconfigured' ? '还没填 authtoken' : '未启动' });
  const cfState = tunnelState('cloudflared');
  if (!(relay.status === 'ready' && relay.url)) pending.push({ id: 'cloudflared', kind: 'cloudflared', label: 'Cloudflare 中转', state: cfState, hint: cfState === 'disabled' ? 'config.json 里 cloudflared 为 false' : '未启动' });
  if (!tsAddrs.length) pending.push({ id: 'tailscale', kind: 'tailscale', label: 'Tailscale 直连', state: 'unconfigured', hint: '未检测到 100.64/10 地址；装好 Tailscale 并登录后重启 bridge' });
  // `at` lets the phone mint a 30-day session on every channel it switches to
  // (cookies are per-host, so a LAN/USB switch would otherwise land on the
  // password form). Only already-authorized callers reach this point.
  return { ok: true, bridge: VERSION, port, at: autoLoginToken || '', generatedAt: new Date().toISOString(), channels: list, pending };
}

/**
 * 「同步电脑最新通道」：把还没起来的 ngrok / Cloudflare 拉起来，再重新枚举地址。
 * 两条隧道并行启动，各自最多等 45s；失败原因逐条回给手机。
 */
async function startMissingChannels() {
  const attempts = [];
  const jobs = [];

  const liveNgrok = await (async () => { try { return await detectNgrok(); } catch { return ''; } })();
  if (!liveNgrok) {
    jobs.push((async () => {
      const token = (cfg.ngrok.authtoken || '').trim();
      if (!token) {
        attempts.push({ id: 'ngrok', ok: false, state: 'unconfigured', message: '电脑端还没填 ngrok authtoken' });
        return;
      }
      try {
        const url = await startNgrok();
        attempts.push({ id: 'ngrok', ok: true, state: 'ready', message: url });
      } catch (e) {
        attempts.push({ id: 'ngrok', ok: false, state: 'error', message: e.message });
      }
    })());
  } else {
    attempts.push({ id: 'ngrok', ok: true, state: 'ready', message: liveNgrok });
  }

  const cfReady = relay.status === 'ready' && !!relay.url;
  if (!cfReady) {
    jobs.push((async () => {
      if (!cfg.cloudflared) {
        attempts.push({ id: 'cloudflared', ok: false, state: 'disabled', message: 'config.json 里 cloudflared 还是 false' });
        return;
      }
      try {
        relay.stopped = false;
        startCloudflared();
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          if (relay.status === 'ready' && relay.url) break;
          if (relay.status === 'error' && relay.error) break;
          await sleep(500);
        }
        if (relay.url) attempts.push({ id: 'cloudflared', ok: true, state: 'ready', message: relay.url });
        else attempts.push({ id: 'cloudflared', ok: false, state: 'error', message: relay.error || '45s 内没拿到公网地址' });
      } catch (e) {
        attempts.push({ id: 'cloudflared', ok: false, state: 'error', message: e.message });
      }
    })());
  } else {
    attempts.push({ id: 'cloudflared', ok: true, state: 'ready', message: relay.url });
  }

  await Promise.allSettled(jobs);
  return attempts;
}

async function serveChannelsRefresh(req, res, u) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!(keyMatches(req, u) || sessionMatches(req) || isLocalPc(req))) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'use POST' }));
    return;
  }
  try {
    const attempts = await startMissingChannels();
    const body = await channelsPayload();
    body.attempts = attempts;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function serveChannels(req, res, u) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!(keyMatches(req, u) || sessionMatches(req) || isLocalPc(req))) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }
  try {
    const body = await channelsPayload();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

/**
 * 服务器上那个 APK 的版本信息：build.ps1 发布时写的同目录 sidecar。
 * 按 mtime 缓存，重新构建换了文件立刻生效，不用重启 bridge。
 */
let apkMetaCache = { mtimeMs: -1, data: null };
function apkMeta() {
  const side = path.join(path.dirname(APK_PATH), 'apk-version.json');
  try {
    const st = fs.statSync(side);
    if (st.mtimeMs === apkMetaCache.mtimeMs && apkMetaCache.data) return apkMetaCache.data;
    const raw = JSON.parse(fs.readFileSync(side, 'utf8'));
    const data = {
      versionName: typeof raw.versionName === 'string' ? raw.versionName : '',
      versionCode: Number(raw.versionCode) || 0,
      sha256: typeof raw.sha256 === 'string' ? raw.sha256 : '',
      builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : '',
    };
    apkMetaCache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch (e) {
    return { versionName: '', versionCode: 0, sha256: '', builtAt: '' };
  }
}

function serveQr(req, res, u) {
  allowCors(req, res);
  if (!pcOnly(req, res)) return;
  const text = u.searchParams.get('u') || '';
  // http(s) for plain workbench links, dshmobile:// for the deep link we now encode
  if (!/^(https?|dshmobile):\/\//i.test(text) || text.length > 1400) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad url');
    return;
  }
  try {
    const svg = qrSvg(text);
    res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-length': Buffer.byteLength(svg),
      'cache-control': 'public, max-age=300',
    });
    res.end(svg);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('qr failed');
  }
}

function proxyHttp(req, res) {
  const t = target;
  const headers = { ...req.headers };
  delete headers['proxy-connection'];
  headers.host = `127.0.0.1:${t.port}`;
  if (headers.origin) headers.origin = `http://127.0.0.1:${t.port}`;
  if (headers.referer) headers.referer = rewriteUrl(headers.referer, t.port);
  headers.cookie = upstreamCookie(req.headers.cookie);
  if (!headers.cookie) delete headers.cookie;

  const upstream = http.request({
    host: '127.0.0.1',
    port: t.port,
    method: req.method,
    path: req.url,
    headers,
  }, (up) => {
    const out = { ...up.headers };
    // 内核给 /plugins/*、/assets/* 一律 no-store，公网隧道每次都要重拉 160+ 个文件，
    // 首屏能拖到一分钟。带 rev / 内容哈希的静态资源是内容寻址的，放心长缓存。
    try {
      const pth = String(req.url || '').split('?')[0];
      const cacheable = pth.startsWith('/plugins/') || pth.startsWith('/assets/') || pth.startsWith('/__dshm/mobile.');
      const hasRev = /[?&]rev=/.test(String(req.url || '')) || /-[A-Za-z0-9_-]{8}\.(js|css)$/.test(pth);
      if (cacheable && hasRev && up.statusCode === 200) {
        out['cache-control'] = 'public, max-age=31536000, immutable';
        delete out.etag;
        delete out['last-modified'];
      }
    } catch { /* ignore */ }
    if (out['set-cookie']) {
      const kept = out['set-cookie'].filter((c) => !c.startsWith('dsh-auth-'));
      if (kept.length) out['set-cookie'] = kept; else delete out['set-cookie'];
    }
    if (up.statusCode === 401 && t === target) {
      // Cookie expired/rotated (kernel restart). Re-mint in the background.
      target = null;
      refreshTarget(true).catch(() => {});
    }
    let forceMobile = false;
    try { forceMobile = new URL(req.url, 'http://bridge.invalid').searchParams.get('__dshm') === '1'; } catch { /* ignore */ }
    const mobile = forceMobile || /Android|iPhone|iPad|Mobile/i.test(req.headers['user-agent'] || '');
    const isHtml = /text\/html/i.test(up.headers['content-type'] || '');
    if (mobile && isHtml && up.statusCode === 200) {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        let body = Buffer.concat(chunks);
        const enc = String(up.headers['content-encoding'] || '').toLowerCase();
        let decoded = false;
        try {
          if (enc === 'gzip') { body = zlib.gunzipSync(body); decoded = true; }
          else if (enc === 'br') { body = zlib.brotliDecompressSync(body); decoded = true; }
          else if (enc === 'deflate') { body = zlib.inflateSync(body); decoded = true; }
          else if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') { body = zlib.zstdDecompressSync(body); decoded = true; }
          else if (!enc) decoded = true;
        } catch (e) {
          log('WARN html decode failed:', e.message);
        }
        if (!decoded) {
          res.writeHead(up.statusCode || 200, out);
          res.end(body);
          return;
        }
        let html = body.toString('utf8');
        if (!html.includes('/__dshm/mobile.js')) {
          const tag = '<link rel="stylesheet" href="/__dshm/mobile.css"><script defer src="/__dshm/mobile.js"></script>';
          html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '</body>') : html + tag;
        }
        // The directory-picker plugin reads this global *once* while its
        // module evaluates (long before the deferred mobile.js runs), so the
        // hook has to exist in <head> already. It forwards to whatever
        // mobile.js installs later; with no phone sheet present it resolves
        // null (= cancel) instead of opening the invisible Windows dialog.
        if (!html.includes('__DSH_DIRECTORY_PICKER__')) {
          const hook = '<script>window.__DSH_DIRECTORY_PICKER__={pick:function(){'
            + 'return window.__dshmDirPick?window.__dshmDirPick():Promise.resolve(null);}};</script>';
          html = /<head[^>]*>/i.test(html)
            ? html.replace(/<head[^>]*>/i, (m) => m + hook)
            : hook + html;
        }
        // 手机端插件批次里有个「巨无霸」：dsh-pet 把 8.2 MB GLB 和 24 张
        // webp 精灵图全 base64 内联进 client.js（单条 32 MB），整批 41 MB，
        // 走公网隧道等于永远转不完的加载条。手机端只用原生浮层桌宠，这里剔掉。
        html = stripHeavyPluginsForMobile(html);
        const buf = Buffer.from(html, 'utf8');
        const h = { ...out };
        delete h['content-length'];
        delete h['content-encoding'];
        delete h['transfer-encoding'];
        h['content-length'] = String(buf.length);
        res.writeHead(up.statusCode || 200, h);
        res.end(buf);
      });
      return;
    }
    res.writeHead(up.statusCode || 502, out);
    up.pipe(res);
  });

  // DSH serves some long-lived HTTP streams. A socket timeout here would
  // abort them every 10 minutes and (previously) invalidate the target, which
  // looked like the phone connection randomly dying. Keep the socket open;
  // the browser/client still aborts its own requests.
  upstream.setTimeout(0);
  upstream.on('error', (e) => {
    log('upstream error:', e.message);
    if (!res.headersSent) sendError(res, 502, `无法连接电脑上的 DSH 内核：${e.message}`);
    else try { res.destroy(); } catch {}
    // Only a dead/refused upstream justifies dropping the target. A client
    // abort or a long stream reset must not rotate the target epoch.
    if (target === t && (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH')) {
      target = null;
      refreshTarget(true).catch(() => {});
    }
  });
  req.on('aborted', () => { try { upstream.destroy(); } catch {} });
  req.pipe(upstream);
}

/**
 * 手机端：把体积离谱的客户端插件从 boot 里摘掉，其余原样保留。
 * 目前只有 dsh-pet：它把 8.2 MB 的 GLB + 二十多张 webp 精灵图全部 base64 内联，
 * 单模块 32 MB，整批 41 MB —— 走公网隧道时首屏永远加载不完（LAN 几秒就好，
 * 所以只有手机/远程才明显）。voice-input 只有 175 KB，必须留着。
 *
 * 内核的 /plugins/??a,b,c&rev=xxx 只认完整的批次列表（少一个就 404），但单个模块
 * /plugins/??<file>&rev=<entryRev> 是通的，所以这里把批次改指向 /__dshm/batch，
 * 由 bridge 按 boot 里的 per-entry rev 逐个取回再拼起来。
 */
const SLIM_HEAVY_FILE = 'dsh-pet/client.js';
const SLIM_HEAVY_ID = 'dsh-pet';
const slimBatchPlans = new Map();
const slimBatchCache = new Map();
const SLIM_PLAN_FILE = path.join(__dirname, '.slim-batches.json');
function slimSavePlans() {
  try {
    const obj = {};
    let n = 0;
    for (const [rev, plan] of slimBatchPlans) { if (n++ >= 8) break; obj[rev] = plan; }
    fs.writeFileSync(SLIM_PLAN_FILE, JSON.stringify(obj));
  } catch {}
}
function slimLoadPlans() {
  try {
    const obj = JSON.parse(fs.readFileSync(SLIM_PLAN_FILE, 'utf8'));
    for (const [rev, plan] of Object.entries(obj)) {
      if (Array.isArray(plan) && plan.length) slimBatchPlans.set(rev, plan);
    }
    log('slim plans restored: ' + slimBatchPlans.size);
  } catch {}
}
slimLoadPlans();

function planFromBoot(boot, batch) {
  const ids = Array.isArray(batch.entries) ? batch.entries : [];
  const plan = [];
  for (const id of ids) {
    const e = boot.entries.find((x) => x && x.id === id);
    if (!e || typeof e.url !== 'string') continue;
    const file = e.url.replace(/^plugins\/\?\?/, '').replace(/&rev=[^&]*$/, '');
    plan.push({ file, rev: e.rev || '' });
  }
  return plan;
}

async function serveSlimBatch(req, res, u) {
  allowCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!(keyMatches(req, u) || sessionMatches(req) || isLocalPc(req))) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }
  const rev = u.searchParams.get('rev') || '';
  const plan = slimBatchPlans.get(rev);
  if (!plan || !plan.length) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'unknown batch', rev }));
    return;
  }
  let buf = slimBatchCache.get(rev);
  if (!buf) {
    const parts = [];
    for (const item of plan) parts.push(await fetchOneModule(item.file, item.rev));
    buf = Buffer.concat(parts);
    if (slimBatchCache.size >= 8) slimBatchCache.clear();
    slimBatchCache.set(rev, buf);
    log('slim batch built: rev ' + rev + ', ' + plan.length + ' module(s), ' + buf.length + ' bytes');
  }
  const accept = String(req.headers['accept-encoding'] || '');
  let enc = '';
  if (/\bgzip\b/.test(accept)) enc = 'gzip';
  else if (/\bbr\b/.test(accept)) enc = 'br';
  let out = buf;
  if (enc) {
    const key = rev + ':' + enc;
    out = slimBatchCache.get(key);
    if (!out) {
      try {
        out = enc === 'br'
          ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
          : zlib.gzipSync(buf, { level: 6 });
      } catch { out = buf; enc = ''; }
    }
    if (out !== buf) {
      if (slimBatchCache.size >= 16) { for (const k of slimBatchCache.keys()) { if (String(k).includes(':')) slimBatchCache.delete(k); } }
      slimBatchCache.set(key, out);
    }
  }
  const headers = {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': out.length,
    'cache-control': 'public, max-age=86400',
    'access-control-allow-origin': '*',
    'vary': 'accept-encoding',
  };
  if (enc) headers['content-encoding'] = enc;
  res.writeHead(200, headers);
  res.end(out);
}

async function fetchOneModule(file, rev) {
  const base = 'http://127.0.0.1:' + cfg.port + '/plugins/??' + file;
  const tries = rev ? ['&rev=' + encodeURIComponent(rev), ''] : [''];
  let last = '';
  for (const suffix of tries) {
    try {
      const r = await fetch(base + suffix, {
        headers: { 'x-dshm-key': cfg.accessKey },
        signal: AbortSignal.timeout(20000),
      });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      last = String(r.status);
    } catch (e) {
      last = e.message;
    }
  }
  throw new Error('module fetch failed: ' + file + ' (' + last + ')');
}


function stripHeavyPluginsForMobile(html) {
  const m = html.match(/__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) return html;
  let boot;
  try {
    boot = JSON.parse(m[1]);
  } catch {
    return html;
  }
  if (!Array.isArray(boot.entries)) return html;

  const before = boot.entries.length;
  boot.entries = boot.entries.filter((e) => !(e && e.id === SLIM_HEAVY_ID));
  const droppedEntries = before - boot.entries.length;

  const rewrites = [];
  for (const b of Array.isArray(boot.batches) ? boot.batches : []) {
    if (!b || typeof b.url !== 'string') continue;
    if (!b.url.includes(SLIM_HEAVY_FILE)) continue;
    const rev = String(b.rev || '');
    const plan = planFromBoot(boot, b);
    if (!plan.length) continue;
    slimBatchPlans.set(rev, plan);
    slimSavePlans();
    const slim = '/__dshm/batch?rev=' + encodeURIComponent(rev);
    rewrites.push({ from: b.url, to: slim });
    b.url = slim;
    if (Array.isArray(b.entries)) b.entries = b.entries.filter((x) => x !== SLIM_HEAVY_ID);
  }

  let out = html.replace(m[0], '__DSH_BOOT__"] = ' + JSON.stringify(boot) + ';</script>');
  for (const r of rewrites) {
    out = out.split(r.from).join(r.to);
    out = out.split(r.from.replace(/&/g, '&amp;')).join(r.to.replace(/&/g, '&amp;'));
  }
  if (droppedEntries || rewrites.length) {
    log('boot slimmed for mobile: dropped ' + droppedEntries + ' entry, rebuilt ' + rewrites.length + ' batch(es)');
  }
  return out;
}

function proxyWebSocket(req, socket, head) {
  const t = target;
  if (!t) { socket.destroy(); return; }
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${t.port}`;
  if (headers.origin) headers.origin = `http://127.0.0.1:${t.port}`;
  if (headers.referer) headers.referer = rewriteUrl(headers.referer, t.port);
  headers.cookie = upstreamCookie(req.headers.cookie);
  if (!headers.cookie) delete headers.cookie;

  const upstream = http.request({
    host: '127.0.0.1',
    port: t.port,
    method: 'GET',
    path: req.url,
    headers,
  });

  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    let raw = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || 'Switching Protocols'}\r\n`;
    for (const [k, v] of Object.entries(upRes.headers)) {
      for (const vv of Array.isArray(v) ? v : [v]) raw += `${k}: ${vv}\r\n`;
    }
    raw += '\r\n';
    socket.write(raw);
    if (upHead && upHead.length) upSocket.write(upHead);
    if (head && head.length) upSocket.write(head);
    socket.setNoDelay(true);
    upSocket.setNoDelay(true);
    socket.pipe(upSocket);
    upSocket.pipe(socket);
    const kill = () => { try { socket.destroy(); } catch {} try { upSocket.destroy(); } catch {} };
    socket.on('error', kill);
    upSocket.on('error', kill);
    socket.on('close', kill);
    upSocket.on('close', kill);
  });

  upstream.on('response', (r) => {
    r.resume();
    try {
      socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage || 'Error'}\r\n\r\n`);
    } catch {}
    socket.destroy();
  });
  upstream.on('error', () => { try { socket.destroy(); } catch {} });
  upstream.setTimeout(0);
  upstream.end();
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

/**
 * 电脑侧 DSH 环境的启动阶段。手机端用它区分「内核正在启动（继续等）」
 * 与「根本连不上（可以弹重试）」：
 *   ready   : 内核已就绪，可以直接打开工作台
 *   minting : 日志里已有内核地址，正在换取登录 cookie（内核刚起来）
 *   waiting : 日志里还没有内核地址，电脑上的 DSH 还没启动或还在加载配置
 */
function envStage() {
  if (target) return { state: 'ready', detail: '', waitingSec: 0 };
  const reason = lastDiscoveryError || '';
  return {
    state: reason.startsWith('mint failed') ? 'minting' : 'waiting',
    detail: reason,
    waitingSec: waitingSince ? Math.round((Date.now() - waitingSince) / 1000) : 0,
  };
}

function healthPayload() {
  const stage = envStage();
  return {
    ok: true,
    bridge: { version: VERSION, pid: process.pid, uptimeSec: Math.round(process.uptime()) },
    target: target
      ? {
        port: target.port, epoch: target.epoch,
        ageSec: Math.round((Date.now() - target.mintedAt) / 1000),
        ready: true, state: 'ready',
      }
      : { ready: false, state: stage.state, reason: lastDiscoveryError, detail: stage.detail, waitingSec: stage.waitingSec },
    env: stage,
    mobile: { minVersion: '0.1.0' },
  };
}

// --- P2P rendezvous ------------------------------------------------------
// 手机与电脑各自主动外连到同一 bridge（可经 cloudflared 公网隧道），把本机公网
// IPv6 候选地址写进来、再把对方的取走，随后**同时**向对方发包。IPv6 没有 NAT，
// 唯一障碍是状态化防火墙：出站包会建 conntrack 表项，回包因此被放行。
// 这条路不需要改路由器、不需要租服务器、不依赖 UPnP。
const RV_TTL_MS = 90 * 1000;
const rvRooms = new Map(); // room -> Map(role -> { addrs:string[], meta:object, ts:number })

function rvPrune() {
  const now = Date.now();
  for (const [room, m] of rvRooms) {
    for (const [role, v] of m) if (now - v.ts > RV_TTL_MS) m.delete(role);
    if (m.size === 0) rvRooms.delete(room);
  }
}
setInterval(rvPrune, 30 * 1000).unref();

function rvClean(s, max) {
  return String(s == null ? '' : s).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, max);
}

/* ------------------------------------------------------------------ */
/* PC 侧命令执行：手机端 DSH 反向驱动电脑                              */
/* 认证走 header `x-dshm-key: <accessKey>`，不把密钥塞进 URL。          */
/* ------------------------------------------------------------------ */

let pcExecRunning = false;

async function servePcExec(req, res, u) {
  const send = (status, obj) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
  let raw = '';
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 256 * 1024) return send(413, { ok: false, error: 'request too large' });
    }
  } catch (e) {
    return send(400, { ok: false, error: 'read body failed: ' + e.message });
  }
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return send(400, { ok: false, error: 'bad json' });
  }
  const cmd = String(payload.cmd || '').trim();
  if (!cmd) return send(400, { ok: false, error: 'cmd required' });
  if (pcExecRunning) return send(429, { ok: false, error: 'busy: 电脑上已有一条命令在执行，稍后重试' });

  const cwd = payload.cwd ? String(payload.cwd) : os.homedir();
  const timeoutMs = Math.min(Math.max(parseInt(payload.timeoutMs, 10) || 60000, 1000), 300000);
  const started = Date.now();
  pcExecRunning = true;
  log('pc/exec from', (req.socket && req.socket.remoteAddress) || '?', 'cwd=' + cwd, 'cmd=' + cmd.slice(0, 200));

  try {
    const out = await new Promise((resolve) => {
      exec(
        cmd,
        { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
        (err, stdout, stderr) => resolve({ err, stdout: stdout || Buffer.alloc(0), stderr: stderr || Buffer.alloc(0) }),
      );
    });
    const decode = (b) => {
      const s = b.toString('utf8');
      if (!s.includes('\ufffd')) return s;
      try {
        return new TextDecoder('gbk', { fatal: false }).decode(b);
      } catch {
        return s;
      }
    };
    const code = out.err && typeof out.err.code === 'number' ? out.err.code : out.err ? 1 : 0;
    send(200, {
      ok: code === 0,
      code,
      ms: Date.now() - started,
      cwd,
      stdout: decode(out.stdout).slice(0, 200000),
      stderr: decode(out.stderr).slice(0, 200000),
      error: code !== 0 && out.err ? String(out.err.message || out.err) : '',
    });
  } catch (e) {
    send(500, { ok: false, error: e.message });
  } finally {
    pcExecRunning = false;
  }
}

// ---------------------------------------------------------------------------
// /__dshm/pc/ask —— 让电脑端 DSH 回答一条任务（headless 一次性运行）
// 手机端 agent 用它跟电脑上的 dsh-desktop 对话，而不是只能跑 shell。
// 传 sessionId 可以续同一段会话；不传就开新会话并把 id 回给调用方。
// ---------------------------------------------------------------------------
let pcAskRunning = false;

function findDshBin() {
  const base = path.join(process.env.APPDATA || '', 'DeepSeek Harness', 'runtimes');
  const rel = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  try {
    const versions = fs.readdirSync(base)
      .filter((v) => fs.existsSync(path.join(base, v, rel)))
      .sort();
    if (versions.length) return path.join(base, versions[versions.length - 1], rel);
  } catch (e) { /* runtime dir absent */ }
  return '';
}

function dshApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const m = fs.readFileSync(p, 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/);
    if (m) return m[1];
  } catch (e) { /* no credential file */ }
  return '';
}

async function servePcAsk(req, res, u) {
  const send = (status, obj) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
  let body;
  try { body = JSON.parse(await readBody(req, 1 << 20)); }
  catch (e) { return send(400, { ok: false, error: 'bad json: ' + e.message }); }
  const task = String(body.task || '').trim();
  if (!task) return send(400, { ok: false, error: 'task required' });
  const sessionId = body.sessionId ? String(body.sessionId).trim() : '';
  const timeoutMs = Math.min(300000, Math.max(15000, Number(body.timeoutMs) || 180000));
  const bin = findDshBin();
  if (!bin) return send(500, { ok: false, error: '找不到电脑端 dsh 运行时（DeepSeek Harness/runtimes/*/node_modules/@deepseek-ai/dsh/lib/bin.js）' });
  const key = dshApiKey();
  if (!key) return send(500, { ok: false, error: '电脑端没有可用的 DEEPSEEK_API_KEY（~/.dsh/.credentials.yaml 里也没读到）' });
  if (pcAskRunning) return send(429, { ok: false, error: 'busy: 电脑端上一条任务还在跑，稍后重试' });

  const args = [bin, 'headless', '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  args.push(task);

  const t0 = Date.now();
  pcAskRunning = true;
  try {
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, args, {
        cwd: os.homedir(),
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: Object.assign({}, process.env, {
          DSH_HOME: path.join(os.homedir(), '.dsh'),
          DEEPSEEK_API_KEY: key,
        }),
      }, (err, stdout, stderr) => {
        if (err && !String(stdout || '').trim()) {
          const e = new Error(err.message);
          e.stderr = String(stderr || '');
          return reject(e);
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
    let sid = sessionId;
    let answer = '';
    for (const line of out.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'session' && ev.sessionId) sid = ev.sessionId;
      if (ev.type === 'final' && typeof ev.text === 'string') answer = ev.text;
    }
    if (!answer) {
      return send(502, {
        ok: false, sessionId: sid, ms: Date.now() - t0,
        error: '电脑端没有产出最终回答', stderr: out.stderr.slice(0, 4000),
      });
    }
    send(200, { ok: true, ms: Date.now() - t0, sessionId: sid, answer, stderr: out.stderr.slice(0, 2000) });
  } catch (e) {
    send(500, {
      ok: false, ms: Date.now() - t0,
      error: String((e && e.message) || e),
      stderr: String((e && e.stderr) || '').slice(0, 4000),
    });
  } finally {
    pcAskRunning = false;
  }
}

async function serveRendezvous(req, res, u) {
  const room = rvClean(u.searchParams.get('room'), 40);
  if (!room) return sendError(res, 400, 'room required');
  let m = rvRooms.get(room);
  if (!m) { m = new Map(); rvRooms.set(room, m); }

  if (req.method === 'POST') {
    let j;
    try { j = JSON.parse(await readBody(req, 16 * 1024)); }
    catch { return sendError(res, 400, 'bad json'); }
    const role = rvClean(j.role, 20);
    if (!role) return sendError(res, 400, 'role required');
    const addrs = (Array.isArray(j.addrs) ? j.addrs : [])
      .filter((a) => typeof a === 'string' && a.length < 64)
      .slice(0, 8);
    m.set(role, { addrs, meta: j.meta && typeof j.meta === 'object' ? j.meta : {}, ts: Date.now() });
    log(`rendezvous: room=${room} role=${role} addrs=${addrs.join(',') || '-'}`);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, room, role, peers: [...m.keys()].filter((k) => k !== role) }));
    return;
  }

  const self = rvClean(u.searchParams.get('role'), 20);
  const now = Date.now();
  const peers = {};
  for (const [role, v] of m) {
    if (now - v.ts > RV_TTL_MS) { m.delete(role); continue; }
    if (role === self) continue;
    peers[role] = { addrs: v.addrs, meta: v.meta, ageMs: now - v.ts };
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: true, room, self, peers }));
}

/* ------------------------------------------------------------------ */
/* Chat-style file transfer channel (phone <-> PC)                     */
/* ------------------------------------------------------------------ */

const ft = require('./ft.cjs')({
  cfg,
  ROOT,
  log,
  jsonOut,
  VERSION,
  keyMatches,
});

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://bridge.invalid');
  if (u.pathname.startsWith('/__dshm/')) {
    // The phone page is same-origin, but the DSH Web GUI lives on another
    // 127.0.0.1 port: every /__dshm/* response needs CORS headers. Loopback
    // origins only — info/password expose the access key. A custom
    // x-dshm-key header forces a preflight, which must answer 204.
    const o = req.headers.origin || '';
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'x-dshm-key, content-type, range, accept');
    res.setHeader('Access-Control-Expose-Headers',
      'content-range, content-disposition, content-length, accept-ranges, x-dshm-name');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }
  if (u.pathname === '/__dshm/mobile.css') {
    serveMobileAsset(res, 'mobile.css', 'text/css; charset=utf-8');
    return;
  }
  if (u.pathname === '/__dshm/mobile.js') {
    serveMobileAsset(res, 'mobile.js', 'application/javascript; charset=utf-8');
    return;
  }
  if (u.pathname === '/__dshm/app.apk') {
    serveApk(req, res);
    return;
  }
  if (u.pathname === '/__dshm/login') {
    handleLogin(req, res, u).catch((e) => log('login error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/password') {
    handlePassword(req, res).catch((e) => log('password error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/security') {
    handleSecurity(req, res).catch((e) => log('security error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/security/unlock') {
    handleSecurityUnlock(req, res).catch((e) => log('security error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/cloudflared') {
    handleCloudflared(req, res).catch((e) => log('cloudflared api error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/ngrok') {
    handleNgrok(req, res).catch((e) => log('ngrok error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/files/config') {
    serveFilesConfig(req, res);
    return;
  }
  if (u.pathname === '/__dshm/info' || u.pathname === '/__dshm/qr.svg') {
    if (req.method === 'OPTIONS') {
      allowCors(req, res);
      if (!pcOnly(req, res)) return;
      res.writeHead(204);
      res.end();
      return;
    }
    if (u.pathname === '/__dshm/qr.svg') serveQr(req, res, u);
    else serveInfo(req, res);
    return;
  }
  if (u.pathname === '/__dshm/version') {
    serveVersion(req, res, u);
    return;
  }
  if (u.pathname === '/__dshm/channels') {
    serveChannels(req, res, u).catch((e) => log('channels error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/channels/refresh') {
    serveChannelsRefresh(req, res, u).catch((e) => log('channels refresh error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/p2p/info') {
    serveP2PInfo(req, res, u).catch((e) => log('p2p info error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/p2p/peer') {
    serveP2PPeer(req, res, u).catch((e) => log('p2p peer error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/batch') {
    serveSlimBatch(req, res, u).catch((e) => log('slim batch error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/scan') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(scanPage());
    return;
  }
  if (!authorized(req, res)) return;
  if (u.pathname.startsWith('/__dshm/ft/')) {
    ft.dispatch(req, res, u);
    return;
  }
  if (u.pathname === '/__dshm/rendezvous') {
    serveRendezvous(req, res, u).catch((e) => log('rendezvous error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/pc/exec') {
    servePcExec(req, res, u).catch((e) => log('pc/exec error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/pc/ask') {
    servePcAsk(req, res, u).catch((e) => log('pc/ask error:', e.message));
    return;
  }
  if (u.pathname === '/__dshm/artifact') {
    serveArtifact(req, res, u);
    return;
  }
  if (u.pathname === '/__dshm/files') {
    serveFilesPage(req, res);
    return;
  }
  if (u.pathname.startsWith('/__dshm/files/')) {
    serveFilesApi(req, res, u).catch((e) => log('files api error:', e.message));
    return;
  }
  if (u.pathname === '/m') {
    const html = landingHtml(req);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  if (u.pathname === '/__dshm/dirs') {
    serveDirs(req, res, u);
    return;
  }
  if (u.pathname === '/__dshm/dirs/mkdir') {
    serveDirsMkdir(req, res).catch((e) => jsonOut(res, 200, { ok: false, error: e.message }));
    return;
  }
  if (u.pathname === '/__dshm/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(healthPayload()));
    return;
  }
  if (u.pathname === '/__dshm/local/provider') {
    serveLocalProvider(req, res);
    return;
  }
  if (u.pathname === '/__dshm/plugins/list') {
    servePluginList(req, res);
    return;
  }
  if (u.pathname === '/__dshm/plugins.tar.gz') {
    servePluginTar(req, res);
    return;
  }
  if (u.pathname === '/__dshm/sync/manifest') {
    serveSyncManifest(req, res);
    return;
  }
  if (u.pathname === '/__dshm/sync.tar.gz') {
    serveFileRanged(req, res, SYNC_TAR, 'application/gzip');
    return;
  }
  if (u.pathname === '/__dshm/sync/rebuild') {
    rebuildSyncBundle(req, res);
    return;
  }
  if (u.pathname === '/__dshm/sync/runtime.tar.gz') {
    serveFileRanged(req, res, SYNC_RUNTIME_TAR, 'application/gzip');
    return;
  }
  if (u.pathname === '/__dshm/debug/command') {
    debugCommand(req, res);
    return;
  }
  if (u.pathname === '/__dshm/debug/poll') {
    debugPoll(req, res);
    return;
  }
  if (u.pathname === '/__dshm/debug/result') {
    if (req.method === 'GET') debugResultGet(req, res, u);
    else debugResult(req, res);
    return;
  }
  if (u.pathname === '/__dshm/debug/status') {
    debugStatus(req, res);
    return;
  }
  if (u.pathname === '/__dshm/ping') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  if (!target) {
    sendError(res, 503, `等待电脑上的 DSH 内核启动…（${lastDiscoveryError || '尚未发现内核'}）`);
    return;
  }
  proxyHttp(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://bridge.invalid');
  let ok;
  if (passwordSet()) {
    ok = sessionMatches(req) || (keyMatches(req, u) && isLocalPc(req));
  } else if (!cfg.accessKey) {
    ok = true;
  } else {
    ok = keyMatches(req, u);
  }
  if (!ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!target) { socket.destroy(); return; }
  proxyWebSocket(req, socket, head);
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});

/* ------------------------------------------------------------------ */
/* Startup banner                                                      */
/* ------------------------------------------------------------------ */

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function ipv6Addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv6' || a.internal) continue;
      const ip = a.address.split('%')[0];
      if (ip === '::1' || /^fe80:/i.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip)) continue;
      out.push({ address: ip, scopeid: a.scopeid || 0 });
    }
  }
  return out;
}

let stableV6Cache = { at: 0, ip: '' };
/** Prefer the DHCPv6 (stable) global address; privacy addresses rotate. */
function stableIpv6() {
  if (Date.now() - stableV6Cache.at < 60000) return stableV6Cache.ip;
  let ip = '';
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike 'fe80*' -and $_.IPAddress -ne '::1' -and $_.SuffixOrigin -eq 'Dhcp' } | Select-Object -First 1 -ExpandProperty IPAddress",
      ], { timeout: 4000, encoding: 'utf8', windowsHide: true });
      ip = String(out || '').trim().split(/\r?\n/)[0] || '';
    } catch { /* fall back to Node's interface list */ }
  }
  if (!ip) {
    const list = ipv6Addresses();
    list.sort((a, b) => a.address.length - b.address.length);
    ip = list[0] ? list[0].address : '';
  }
  stableV6Cache = { at: Date.now(), ip };
  return ip;
}

function banner() {
  const lines = [];
  lines.push('');
  lines.push(`  DSH Mobile Bridge ${VERSION}`);
  lines.push(`  desktop log : ${cfg.desktopLog}`);
  lines.push(`  access key  : ${cfg.accessKey}`);
  lines.push('');
  lines.push(`  Local       : http://127.0.0.1:${cfg.port}/?k=${cfg.accessKey}`);
  for (const a of lanAddresses()) {
    lines.push(`  LAN (${a.name}) : http://${a.address}:${cfg.port}/?k=${cfg.accessKey}`);
  }
  const v6 = stableIpv6();
  if (v6) lines.push(`  IPv6        : http://[${v6}]:${cfg.port}/?k=${cfg.accessKey}`);
  lines.push('');
  lines.push('  Open one of these on your phone (same Wi-Fi), or expose this port');
  lines.push('  through IPv6 / Cloudflare / Tailscale / ngrok. Keep the ?k= part.');
  if (cfg.cloudflared) lines.push('  Cloudflare quick tunnel: ' + (relay.url || relay.status));
  lines.push('');
  return lines.join('\n');
}

const LISTEN_HOST = !cfg.host || cfg.host === '0.0.0.0' ? '::' : cfg.host;
server.listen(cfg.port, LISTEN_HOST, () => {
  log(`listening on http://${LISTEN_HOST}:${cfg.port}`);
  console.log(banner());
  ft.start();
  p2pStart();
  try { fs.writeFileSync(PID_PATH, String(process.pid)); } catch {}
  if (cfg.cloudflared) {
    startCloudflared().catch((e) => log('cloudflared:', e.message));
    startTunnelHealth();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`ERROR port ${cfg.port} is already in use. Close the other bridge or change "port" in config.json.`);
  } else {
    log('ERROR server:', e.message);
  }
  process.exit(1);
});

function shutdown(sig) {
  log(`shutting down (${sig})`);
  try { ft.stop(); } catch {}
  try { if (relay.child) relay.child.kill(); } catch {}
  try {
    if (ngrok.child && ngrok.child.pid) {
      execFileSync('taskkill', ['/PID', String(ngrok.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  } catch { /* ignore */ }
  try { fs.unlinkSync(PID_PATH); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function parentPidOf(pid) {
  if (process.platform !== 'win32' || !(pid > 0)) return 0;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue).ParentProcessId`,
    ], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    return Number(String(out || '').trim()) || 0;
  } catch {
    return 0;
  }
}

// The bridge must outlive DSH kernel restarts, but die when the desktop app
// closes. The plugin host passes the Electron PID; older hosts only pass the
// kernel PID, so resolve its parent as a fallback.
let watchPid = Number(process.env.DSHM_DESKTOP_PID || 0);
let watchReason = 'desktop-exit';
if (!watchPid) {
  const kernelPid = Number(process.env.DSHM_KERNEL_PID || 0);
  watchPid = parentPidOf(kernelPid) || kernelPid;
  watchReason = watchPid === kernelPid ? 'kernel-exit' : 'desktop-exit';
}
if (process.env.DSHM_PARENT_WATCH === '1' && watchPid > 0) {
  log(`parent watch: pid=${watchPid} (${watchReason})`);
  const watchTimer = setInterval(() => {
    try {
      process.kill(watchPid, 0);
    } catch {
      shutdown(watchReason);
    }
  }, 2000);
  watchTimer.unref();
}















