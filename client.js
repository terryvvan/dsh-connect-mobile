window.__ModuleLoader__.load({
  id: 'dsh-connect-mobile',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // bridge 地址由宿主插件 /connect-mobile/base 下发（端口可被 DSH_CONNECT_MOBILE_PORT 覆盖）。
// 用同步 XHR：客户端 bundle 在 factory 里同步执行，拿不到 await。
const BRIDGE = (function () {
  try {
    const x = new XMLHttpRequest()
    x.open('GET', '/connect-mobile/base', false)
    x.send()
    const d = JSON.parse(x.responseText)
    if (d && typeof d.bridge === 'string' && /^https?:\/\//.test(d.bridge)) return d.bridge.replace(/\/$/, '')
  } catch {}
  return 'http://127.0.0.1:8787'
})()
    const S = {
      overlay: 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(3,5,9,.72);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
      card: 'position:relative;width:min(440px,100%);max-height:min(90vh,780px);overflow:auto;border-radius:22px;padding:20px 20px 18px;background:linear-gradient(180deg,#181d28,#0f1219);border:1px solid rgba(255,255,255,.12);box-shadow:0 30px 90px rgba(0,0,0,.65);color:#eef1f7;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;',
      head: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;',
      title: 'font-size:17px;font-weight:650;letter-spacing:.2px;',
      close: 'width:32px;height:32px;border:0;border-radius:9px;background:rgba(255,255,255,.06);color:#c9cfdb;font-size:15px;line-height:1;cursor:pointer;',
      body: 'display:flex;flex-direction:column;gap:12px;',
      chips: 'display:flex;flex-wrap:wrap;gap:8px;',
      chip: 'border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#c9cfdb;border-radius:999px;padding:6px 11px;font-size:12px;cursor:pointer;',
      chipOn: 'border:1px solid rgba(109,140,255,.65);background:rgba(109,140,255,.16);color:#e8ecff;border-radius:999px;padding:6px 11px;font-size:12px;cursor:pointer;',
      chipOff: 'border:1px dashed rgba(255,255,255,.14);background:rgba(255,255,255,.02);color:#6f7686;border-radius:999px;padding:6px 11px;font-size:12px;cursor:not-allowed;',
      note: 'font-size:12px;color:#7d8496;line-height:1.6;',
      qrBox: 'align-self:center;display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px;border-radius:16px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.3);',
      qr: 'display:block;width:220px;height:220px;border-radius:4px;',
      qrCap: 'color:#5b6272;font-size:12px;',
      qrErr: 'width:220px;padding:40px 0;text-align:center;color:#7a4150;font-size:12px;',
      label: 'font-size:12px;color:#8d93a3;',
      url: 'padding:9px 11px;border-radius:10px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.07);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;color:#cdd4e2;',
      row: 'display:flex;flex-wrap:wrap;gap:8px;',
      primary: 'border:0;border-radius:11px;padding:9px 13px;background:linear-gradient(135deg,#6d8cff,#46e0c8);color:#081018;font-weight:650;font-size:13px;cursor:pointer;',
      secondary: 'border:1px solid rgba(255,255,255,.12);border-radius:11px;padding:9px 13px;background:rgba(255,255,255,.055);color:#eef1f7;font-size:13px;cursor:pointer;',
      hint: 'font-size:12px;color:#7d8496;line-height:1.6;',
      loading: 'padding:28px 0;text-align:center;color:#8d93a3;',
      errTitle: 'font-size:15px;font-weight:600;color:#ffb4b4;',
      errMsg: 'font-size:12px;color:#c98f8f;word-break:break-all;',
      status: 'font-size:12px;color:#71e0c0;min-height:16px;',
      pwBox: 'display:flex;flex-direction:column;gap:8px;padding:10px 11px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07);',
      pwRow: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;',
      input: 'flex:1;min-width:120px;padding:8px 10px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.22);color:#eef1f7;font:13px/1.4 inherit;',
      tiny: 'border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:8px 10px;background:rgba(255,255,255,.055);color:#eef1f7;font-size:12px;cursor:pointer;',
      tabs: 'display:flex;gap:6px;margin:0 0 12px;padding:4px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);',
      tab: 'flex:1;border:0;background:transparent;color:#9aa2b3;border-radius:9px;padding:8px 10px;font-size:13px;cursor:pointer;',
      tabOn: 'flex:1;border:0;background:linear-gradient(135deg,#4c6dff,#8a5cff);color:#fff;border-radius:9px;padding:8px 10px;font-size:13px;font-weight:650;cursor:pointer;box-shadow:0 4px 14px rgba(88,108,255,.35);',
      ftDrop: 'border:1px dashed rgba(120,150,255,.42);border-radius:14px;padding:15px;text-align:center;color:#9fb2dd;font-size:12.5px;line-height:1.6;cursor:pointer;background:linear-gradient(135deg,rgba(76,109,255,.12),rgba(138,92,255,.10));',
      ftList: 'display:flex;flex-direction:column;gap:8px;max-height:330px;overflow:auto;padding-right:2px;',
      ftRow: 'position:relative;display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:13px;background:linear-gradient(135deg,rgba(30,42,74,.92),rgba(22,32,58,.92));border:1px solid rgba(96,124,196,.34);transition:border-color .12s,box-shadow .12s;',
      ftTag: 'width:42px;height:42px;flex:0 0 42px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;background:linear-gradient(135deg,#4c6dff,#8a5cff);',
      ftThumb: 'width:42px;height:42px;flex:0 0 42px;border-radius:11px;object-fit:cover;background:#0b1220;border:1px solid rgba(96,124,196,.3);',
      ftName: 'font-size:13px;color:#eaf0ff;word-break:break-all;',
      ftMeta: 'font-size:11px;color:#8fa1c6;margin-top:2px;',
      ftActs: 'display:flex;gap:6px;flex:0 0 auto;align-items:center;',
      ftMini: 'border:1px solid rgba(110,140,220,.42);border-radius:9px;padding:5px 9px;background:linear-gradient(135deg,rgba(76,109,255,.22),rgba(138,92,255,.18));color:#dce7ff;font-size:11.5px;cursor:pointer;',
      ftBar: 'height:4px;border-radius:2px;background:rgba(255,255,255,.1);overflow:hidden;margin-top:6px;',
      ftBarOn: 'height:100%;width:0%;background:linear-gradient(90deg,#6d8cff,#46e0c8);transition:width .15s;',
      ftProg: 'display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:11px;background:rgba(109,140,255,.09);border:1px solid rgba(109,140,255,.22);',
    }

    let overlay = null
    let card = null
    let info = null
    let modeId = ''
    let fileDir = ''
    let statusEl = null
    let tabId = 'cfg'
    let ftTimer = null
    let ftLoading = false
    let ftItems = []
    let ftBefore = 0
    let ftHasMore = false
    let ftListEl = null
    let ftStatusEl = null
    let ftInputEl = null

    function readMode() {
      try { return window.localStorage.getItem('dshm.mode') || '' } catch { return '' }
    }

    function saveMode(id) {
      try { window.localStorage.setItem('dshm.mode', id) } catch { /* ignore */ }
    }

    function modesOf(x) {
      if (x && Array.isArray(x.modes) && x.modes.length) return x.modes
      const urls = x && Array.isArray(x.urls) ? x.urls : []
      return urls.map((u, i) => ({
        id: 'url-' + i,
        label: u.label || '连接',
        available: true,
        ready: true,
        base: u.base,
        url: u.url,
        landing: u.landing,
        hint: '',
      }))
    }

    function mk(tag, style, text) {
      const n = document.createElement(tag)
      if (style) n.style.cssText = style
      if (text != null) n.textContent = text
      return n
    }

    function btn(label, onClick, primary) {
      const b = mk('button', primary ? S.primary : S.secondary, label)
      b.type = 'button'
      b.addEventListener('click', onClick)
      return b
    }

    function header() {
      const row = mk('div', S.head)
      const left = mk('div', 'display:flex;align-items:center;gap:8px;min-width:0;')
      left.appendChild(mk('div', S.title, '手机工作台'))
      if (sec && sec.locked) left.appendChild(lockBadge())
      row.appendChild(left)
      const x = mk('button', S.close, '✕')
      x.type = 'button'
      x.title = '关闭'
      x.addEventListener('click', close)
      row.appendChild(x)
      return row
    }

    /* ---------------- 登录安全：3 次输错锁 24 小时，只能在这里解锁 ---------------- */

    let sec = null

    function lockBadge() {
      const b = mk('span', 'display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;'
        + 'font-size:11.5px;font-weight:650;color:#ffc9c9;background:rgba(255,80,80,.14);border:1px solid rgba(255,110,110,.42);')
      b.title = '密码登录已锁定；点下方「解除锁定」恢复'
      b.textContent = '🔒 登录已锁定'
      return b
    }

    async function loadSec() {
      try {
        const res = await fetch(BRIDGE + '/__dshm/security', { cache: 'no-store' })
        if (!res.ok) return null
        const body = await res.json().catch(() => null)
        if (body && body.ok) { sec = body; return body }
      } catch { /* bridge older than 0.5.8 */ }
      return null
    }

    function badgeSvg() {
      const span = mk('span', 'display:inline-flex;align-items:center;gap:6px;color:#ffc9a8;font-weight:700;font-size:12px;')
      span.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" style="flex:0 0 auto">'
        + '<path fill="currentColor" d="M12 2.2 1.9 20.4h20.2L12 2.2Zm0 4.6 6.6 11.9H5.4L12 6.8Zm-.95 4h1.9v4.4h-1.9v-4.4Zm0 5.5h1.9v1.9h-1.9v-1.9Z"/></svg>'
        + '<span>不安全的访问</span>'
      return span
    }

    function tipNode(text) {
      const wrap = mk('span', 'position:relative;display:inline-flex;align-items:center;color:#c9b28f;opacity:.9;cursor:help;')
      wrap.tabIndex = 0
      const icon = mk('span', 'display:inline-flex;')
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">'
        + '<path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3.2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm1.1 12.3h-2.2v-6.2h2.2v6.2Z"/></svg>'
      wrap.appendChild(icon)
      const tip = mk('div', 'position:absolute;left:-8px;top:150%;z-index:5;width:250px;padding:9px 11px;border-radius:10px;'
        + 'background:#0c1017;border:1px solid rgba(255,255,255,.16);color:#dfe4ee;font-size:11.5px;line-height:1.55;'
        + 'box-shadow:0 12px 30px rgba(0,0,0,.55);opacity:0;transform:translateY(-4px);pointer-events:none;transition:.14s;font-weight:400;', text)
      wrap.appendChild(tip)
      const show = () => { tip.style.opacity = '1'; tip.style.transform = 'translateY(0)' }
      const hide = () => { tip.style.opacity = '0'; tip.style.transform = 'translateY(-4px)' }
      wrap.addEventListener('mouseenter', show)
      wrap.addEventListener('mouseleave', hide)
      wrap.addEventListener('focus', show)
      wrap.addEventListener('blur', hide)
      wrap.title = text
      return wrap
    }

    async function doUnlock(btnEl) {
      if (btnEl) btnEl.disabled = true
      try {
        const res = await fetch(BRIDGE + '/__dshm/security/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status))
        sec = body
        paintTab()
      } catch (err) {
        if (btnEl) btnEl.disabled = false
        if (statusEl) { statusEl.style.color = '#ffb4b4'; statusEl.textContent = '解锁失败：' + String((err && err.message) || err) }
      }
    }

    /** Compact red strip pinned above the QR while the login is locked, so the
     *  owner sees it without scrolling to the security box at the bottom. */
    function lockBanner() {
      const box = mk('div', 'display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:12px;'
        + 'font-size:12.5px;line-height:1.55;color:#ffb7b7;background:rgba(255,90,90,.12);border:1px solid rgba(255,110,110,.36);')
      const row = mk('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;')
      row.appendChild(badgeSvg())
      row.appendChild(tipNode(`连续输错 ${sec.maxFails || 3} 次密码，登录已锁定 ${sec.lockHours || 24} 小时。最近来源：${sec.lockedIp || '未知'}。`
        + '为了不让正在猜密码的人靠重启 bridge 或换网络绕过，解锁只能在电脑上的「手机工作台」里做。'))
      box.appendChild(row)
      box.appendChild(mk('div', 'color:#ffb7b7;',
        `已锁定 ${sec.lockHours || 24} 小时，剩余 ${fmtRemain(sec.remainSec)}。手机现在登录不了，已登录的设备不受影响。`))
      const acts = mk('div', S.pwRow)
      const unlock = btn('立即解除锁定', () => doUnlock(unlock), true)
      unlock.title = '清空锁定与错误计数；只有电脑本机能点'
      acts.appendChild(unlock)
      acts.appendChild(btn('查看详情', () => {
        const t = [].slice.call(document.querySelectorAll('div')).filter((e) => /登录安全（密码错误锁定）/.test(e.textContent || '') && e.children.length < 4)[0]
        if (t) t.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }))
      box.appendChild(acts)
      return box
    }

    function securityBox() {
      const box = mk('div', S.pwBox)
      const head = mk('div', 'display:flex;align-items:center;gap:7px;flex-wrap:wrap;')
      head.appendChild(mk('div', S.label, '登录安全（密码错误锁定）'))
      box.appendChild(head)

      if (!sec) {
        box.appendChild(mk('div', S.note, 'bridge 版本较旧，没有登录锁定信息；升级 bridge 后这里会显示锁定状态与访问来源。'))
        return box
      }

      const locked = !!sec.locked
      if (locked || sec.fails > 0) {
        const warn = mk('div', 'display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;padding:9px 10px;border-radius:11px;'
          + 'font-size:12px;line-height:1.55;color:' + (locked ? '#ffb7b7' : '#ffd6a8') + ';'
          + 'background:' + (locked ? 'rgba(255,90,90,.1)' : 'rgba(255,176,80,.09)') + ';'
          + 'border:1px solid ' + (locked ? 'rgba(255,110,110,.32)' : 'rgba(255,176,80,.28)') + ';')
        const row = mk('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;')
        row.appendChild(badgeSvg())
        row.appendChild(tipNode(locked
          ? `连续输错 ${sec.maxFails || 3} 次密码，登录已锁定 ${sec.lockHours || 24} 小时。最近来源：${sec.lockedIp || '未知'}。`
            + '为了不让正在猜密码的人靠重启 bridge 或换网络绕过，解锁只能在电脑上的「手机工作台」里做。'
          : `已经连续输错 ${sec.fails} 次密码，再错 ${Math.max(0, (sec.maxFails || 3) - sec.fails)} 次就会锁定 ${sec.lockHours || 24} 小时。`
            + (sec.lockedIp ? '' : '')
            + ' 锁定后只能在电脑上的「手机工作台」里解锁。'))
        warn.appendChild(row)
        warn.appendChild(mk('div', 'flex:1 1 100%;color:' + (locked ? '#ffb7b7' : '#e7c49a') + ';',
          locked
            ? `已锁定 ${sec.lockHours || 24} 小时，剩余 ${fmtRemain(sec.remainSec)}。`
            : `已输错 ${sec.fails} 次。`))
        box.appendChild(warn)
      } else {
        box.appendChild(mk('div', S.note, `正常：手机/隧道上的密码登录连续输错 ${sec.maxFails || 3} 次会锁定 ${sec.lockHours || 24} 小时；`
          + '已登录的设备不受影响。'))
      }

      if (locked) {
        const acts = mk('div', S.pwRow)
        const unlock = btn('解除锁定', () => doUnlock(unlock), true)
        unlock.title = '清空锁定与错误计数；只有电脑本机能点'
        acts.appendChild(unlock)
        acts.appendChild(btn('刷新状态', () => loadSec().then(() => paintTab())))
        box.appendChild(acts)
        box.appendChild(mk('div', S.note, '解锁记录会写进 bridge 日志，同时清空错误计数；已经登录的设备本来就不受影响。'))
      }

      const recent = (sec.events || []).filter((e) => e.kind === 'fail' || e.kind === 'lock' || e.kind === 'unlock').slice(0, 5)
      if (recent.length) {
        const list = mk('div', 'display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:#9aa3b6;')
        list.appendChild(mk('div', 'color:#7d8496;', '最近尝试（含访问来源 IP）'))
        recent.forEach((e) => {
          const line = mk('div', 'display:flex;justify-content:space-between;gap:10px;')
          const label = e.kind === 'fail' ? '密码错误' : e.kind === 'lock' ? '已锁定' : '已解锁'
          const color = e.kind === 'fail' ? '#ffb4b4' : e.kind === 'lock' ? '#ff9a9a' : '#71e0c0'
          line.appendChild(mk('span', 'color:' + color + ';flex:0 0 auto;', label))
          line.appendChild(mk('span', 'font:11.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;text-align:right;',
            e.ip + ' · ' + fmtTime(e.ts)))
          list.appendChild(line)
        })
        box.appendChild(list)
      }
      return box
    }

    function fmtRemain(secLeft) {
      const s = Math.max(0, Number(secLeft) || 0)
      const d = Math.floor(s / 86400)
      const h = Math.floor((s % 86400) / 3600)
      const m = Math.floor((s % 3600) / 60)
      return `${d > 0 ? d + ' 天 ' : ''}${d > 0 || h > 0 ? h + ' 小时 ' : ''}${m} 分`
    }

    function fmtTime(ts) {
      const n = Number(ts)
      if (!Number.isFinite(n) || n <= 0) return '—'
      try {
        return new Date(n).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      } catch { return '' }
    }

    function hostOf(base) {
      try { return new URL(base).host } catch { return String(base) }
    }

    function paint(node) {
      if (!card) return
      card.textContent = ''
      card.appendChild(header())
      card.appendChild(tabs())
      if (node) card.appendChild(node)
    }

    function tabs() {
      const row = mk('div', S.tabs)
      const items = [['cfg', '配置'], ['ft', '文件传输']]
      items.forEach((pair) => {
        const id = pair[0]
        const text = pair[1]
        const b = mk('button', tabId === id ? S.tabOn : S.tab, text)
        b.type = 'button'
        b.addEventListener('click', () => {
          if (tabId === id) return
          tabId = id
          stopFtPoll()
          if (!info) {
            refresh()
            return
          }
          paintTab()
        })
        row.appendChild(b)
      })
      return row
    }

    function paintTab() {
      paint(tabId === 'cfg' ? contentConfig() : contentFt())
    }

    async function copy(text) {
      try {
        await navigator.clipboard.writeText(text)
        if (statusEl) statusEl.textContent = '已复制到剪贴板'
      } catch {
        window.prompt('复制地址', text)
      }
    }

    function qrBox(u) {
      const box = mk('div', S.qrBox)
      const img = mk('img', S.qr)
      img.alt = '手机工作台二维码'
      img.width = 220
      img.height = 220
      const landingUrl = u.landing + (info && info.autoLogin ? (u.landing.includes('?') ? '&' : '?') + 'at=' + encodeURIComponent(info.autoLogin) : '')
      // Encode as an app deep link: the in-app scanner decodes it directly, and a system
      // scanner hands it to DSH Mobile instead of opening a browser tab.
      const target = 'dshmobile://open?u=' + encodeURIComponent(landingUrl)
      img.src = BRIDGE + '/__dshm/qr.svg?u=' + encodeURIComponent(target)
      img.addEventListener('error', () => {
        img.remove()
        box.appendChild(mk('div', S.qrErr, '二维码加载失败；请直接复制下方地址。'))
      })
      box.appendChild(img)
      box.appendChild(mk('div', S.qrCap, '扫码打开手机工作台'))
      return box
    }

    function apkButton() {
      if (!(info && info.apk && info.apk.url)) return null
      const bytes = info.apk.bytes || 0
      const size = bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : bytes ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : ''
      return btn('下载 APK' + (size ? ' · ' + size : ''), () => { window.location.href = BRIDGE + info.apk.url })
    }

    /* ---------------- ngrok: config once, start/stop from here ---------------- */

    function ngrokState() {
      return (info && info.ngrok) || {}
    }

    function ngrokNote(noteEl, text, bad) {
      if (!noteEl) return
      noteEl.style.color = bad ? '#ffb4b4' : ''
      noteEl.textContent = text
    }

    async function ngrokPost(action, payload) {
      const res = await fetch(BRIDGE + '/__dshm/ngrok', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status))
      if (info) info.ngrok = body
      return body
    }

    function ngrokBox(mode) {
      const st = ngrokState()
      const box = mk('div', S.pwBox)
      box.appendChild(mk('div', S.label, 'ngrok 公网隧道'))

      if (mode.ready) {
        box.appendChild(qrBox(mode))
        box.appendChild(mk('div', S.label, '工作台地址（ngrok）'))
        box.appendChild(mk('div', S.url, mode.url))
        const row = mk('div', S.row)
        row.appendChild(btn('直接进入工作台', () => { window.open(mode.url, '_blank') }, true))
        row.appendChild(btn('打开手机落地页', () => { window.open(mode.landing, '_blank') }))
        box.appendChild(row)
        const note = mk('div', S.status)
        const row2 = mk('div', S.row)
        row2.appendChild(btn('复制地址', () => copy(mode.url)))
        const apk = apkButton()
        if (apk) row2.appendChild(apk)
        const stop = btn('停止 ngrok', async () => {
          stop.disabled = true
          ngrokNote(note, '正在停止 ngrok…')
          try {
            await ngrokPost('stop')
            await refresh()
          } catch (err) {
            ngrokNote(note, '停止失败：' + String((err && err.message) || err), true)
            stop.disabled = false
          }
        })
        row2.appendChild(stop)
        box.appendChild(row2)
        box.appendChild(note)
        box.appendChild(mk('div', S.note, '隧道运行中，配置已锁定：authtoken 已保存'
          + (st.domain ? '，域名 ' + st.domain : '，域名随机') + '。点「停止 ngrok」后可修改配置。'))
        return box
      }

      const token = mk('input', S.input)
      token.type = 'password'
      token.autocomplete = 'off'
      token.placeholder = st.authtokenSet ? '已保存 authtoken；粘贴新的可替换' : '粘贴 authtoken（ngrok.com → Your Authtoken）'
      const tokenRow = mk('div', S.pwRow)
      tokenRow.appendChild(token)
      box.appendChild(tokenRow)

      const domain = mk('input', S.input)
      domain.placeholder = '预留域名（可选；免费版留空，每次随机地址）'
      domain.value = st.domain || ''
      const domainRow = mk('div', S.pwRow)
      domainRow.appendChild(domain)
      box.appendChild(domainRow)

      const note = mk('div', S.status)
      const payloadOf = () => {
        const p = { domain: domain.value.trim() }
        const t = token.value.trim()
        if (t) p.authtoken = t
        return p
      }
      const needToken = () => {
        if (token.value.trim() || st.authtokenSet) return false
        ngrokNote(note, '先粘贴 authtoken 再继续（ngrok.com 控制台 → Your Authtoken）', true)
        return true
      }

      const save = btn('保存配置', async () => {
        if (needToken()) return
        save.disabled = true
        ngrokNote(note, '正在保存…')
        try {
          await ngrokPost('save', payloadOf())
          await refresh()
        } catch (err) {
          ngrokNote(note, '保存失败：' + String((err && err.message) || err), true)
          save.disabled = false
        }
      })

      const start = btn('启动 ngrok', async () => {
        if (needToken()) return
        start.disabled = true
        save.disabled = true
        ngrokNote(note, '正在启动 ngrok…（首次会先下载 ngrok.exe 约 30 MB，可能要 20–60 秒）')
        try {
          await ngrokPost('start', payloadOf())
          await refresh()
        } catch (err) {
          ngrokNote(note, '启动失败：' + String((err && err.message) || err), true)
          start.disabled = false
          save.disabled = false
        }
      }, !st.authtokenSet)

      const acts = mk('div', S.pwRow)
      acts.appendChild(start)
      acts.appendChild(save)
      box.appendChild(acts)
      if (st.error) box.appendChild(mk('div', S.errMsg, '上次启动失败：' + st.error))
      box.appendChild(note)
      box.appendChild(mk('div', S.note, '配置保存在电脑 bridge\\config.json：authtoken 只需填一次，以后点「启动 ngrok」即可开隧道，点「停止 ngrok」关闭。'))
      if (!st.installed) {
        box.appendChild(mk('div', S.note, '未检测到 ngrok.exe：点启动会自动下载到 D:\\dsh-mobile\\bridge\\bin；也可手动下载后放到该目录。'))
        const r = mk('div', S.pwRow)
        r.appendChild(btn('打开 ngrok 下载页', () => { window.open('https://ngrok.com/download', '_blank') }))
        box.appendChild(r)
      }
      return box
    }

    function contentConfig() {
      const modes = modesOf(info)
      const avail = modes.filter((m) => m.available)
      if (!avail.length) {
        return errorBox(new Error('没有可用的连接方式：局域网未检测到、Tailscale 未安装/未登录。请检查 bridge\\config.json 后重启 bridge。'), '没有可用的连接方式')
      }
      const saved = modeId || readMode()
      if (!avail.some((m) => m.id === saved)) {
        modeId = (info && info.preferred && avail.some((m) => m.id === info.preferred)) ? info.preferred : avail[0].id
      } else {
        modeId = saved
      }
      const mode = avail.find((m) => m.id === modeId) || avail[0]
      const wrap = mk('div', S.body)

      const chips = mk('div', S.chips)
      modes.forEach((item) => {
        const selectable = !!item.available
        const cls = !selectable ? S.chipOff : item.id === mode.id ? S.chipOn : S.chip
        const text = item.label + (item.ready ? ' · ' + hostOf(item.base) : selectable ? ' · 待启动' : ' · 未配置')
        const c = mk('button', cls, text)
        c.type = 'button'
        c.title = item.hint || ''
        if (selectable) {
          c.addEventListener('click', () => { modeId = item.id; saveMode(item.id); paintTab() })
        } else {
          c.disabled = true
        }
        chips.appendChild(c)
      })
      wrap.appendChild(chips)
      if (sec && sec.locked) wrap.appendChild(lockBanner())
      if (mode.hint) wrap.appendChild(mk('div', S.note, mode.hint))

      if (mode.id === 'ngrok') {
        wrap.appendChild(ngrokBox(mode))
      } else {
        wrap.appendChild(qrBox(mode))

        wrap.appendChild(mk('div', S.label, '工作台地址（' + mode.label + '）'))
        wrap.appendChild(mk('div', S.url, mode.url))

        const row = mk('div', S.row)
        row.appendChild(btn('直接进入工作台', () => { window.open(mode.url, '_blank') }, true))
        row.appendChild(btn('打开手机落地页', () => { window.open(mode.landing, '_blank') }))
        wrap.appendChild(row)

        const row2 = mk('div', S.row)
        row2.appendChild(btn('复制地址', () => copy(mode.url)))
        const apk = apkButton()
        if (apk) row2.appendChild(apk)
        wrap.appendChild(row2)
      }

      wrap.appendChild(securityBox())
      wrap.appendChild(passwordBox())
      wrap.appendChild(filesBox())

      statusEl = mk('div', S.status)
      wrap.appendChild(statusEl)
      wrap.appendChild(mk('div', S.hint, '局域网 / IPv6 / Cloudflare / Tailscale / ngrok 任选；扫码后选择「App 工作台」，已安装会直接唤起 dsh-mobile，未安装会提示下载。'))
      return wrap
    }

    function passwordBox() {
      const box = mk('div', S.pwBox)
      box.appendChild(mk('div', S.label, '连接密码（手机首次连接时输入）'))
      const row = mk('div', S.pwRow)
      const input = mk('input', S.input)
      input.type = 'password'
      input.autocomplete = 'new-password'
      input.placeholder = info && info.passwordSet ? '已设置；输入新密码可替换' : '未设置；留空表示不启用'
      const save = btn(info && info.passwordSet ? '更新密码' : '设置密码', () => savePassword(input.value, false), !(info && info.passwordSet))
      row.appendChild(input)
      row.appendChild(save)
      if (info && info.passwordSet) row.appendChild(btn('清除密码', () => savePassword('', true)))
      box.appendChild(row)
      box.appendChild(mk('div', S.note, info && info.passwordSet
        ? '已启用：手机扫码/打开地址后先输入此密码，再进入工作台。电脑本机不受影响。'
        : '设置后，手机会先要求输入密码；电脑本机仍可直接打开。密码只保存在电脑 bridge 配置中。'))
      return box
    }

    async function savePassword(value, clear) {
      const text = String(value || '')
      if (!clear && !text.trim()) {
        if (statusEl) {
          statusEl.style.color = '#ffd28a'
          statusEl.textContent = '请输入新密码；如果要取消密码，请点「清除密码」'
        }
        return
      }
      if (statusEl) { statusEl.style.color = ''; statusEl.textContent = '正在保存…' }
      try {
        const res = await fetch(BRIDGE + '/__dshm/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(clear ? { clear: true } : { password: text }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status))
        if (info) info.passwordSet = !!body.passwordSet
        paintTab()
        if (statusEl) statusEl.textContent = body.passwordSet ? '密码已保存，手机下次连接需输入' : '已关闭密码，手机凭二维码地址直接进入'
      } catch (err) {
        if (statusEl) {
          statusEl.style.color = '#ffb4b4'
          statusEl.textContent = '保存失败：' + String((err && err.message) || err)
        }
      }
    }

    function filesUrl() {
      const k = info && info.key ? '?k=' + encodeURIComponent(info.key) : ''
      return BRIDGE + '/__dshm/files' + k
    }

    function filesBox() {
      const box = mk('div', S.pwBox)
      box.appendChild(mk('div', S.label, '文件互传（手机 ↔ 电脑）'))
      const row = mk('div', S.pwRow)
      const input = mk('input', S.input)
      input.value = fileDir || ''
      input.placeholder = '电脑保存目录，例如 D:\\DSH\\files'
      input.title = '电脑端接收上传文件的目录'
      const save = btn('保存目录', () => saveFileDir(input.value, st), true)
      row.appendChild(input)
      row.appendChild(save)
      box.appendChild(row)
      const row2 = mk('div', S.pwRow)
      row2.appendChild(btn('打开文件传输页', () => window.open(filesUrl(), '_blank')))
      row2.appendChild(btn('复制页面地址', () => copy(filesUrl())))
      box.appendChild(row2)
      const st = mk('div', S.status)
      box.appendChild(st)
      box.appendChild(mk('div', S.note, '手机打开传输页即可上传/下载；手机下载的文件进入系统「下载」目录。电脑端文件保存在上面配置的目录，默认在 bridge\\files。'))
      return box
    }

    async function saveFileDir(value, st) {
      const dir = String(value || '').trim()
      if (!dir) { if (st) st.textContent = '请填写电脑上的绝对路径'; return }
      if (st) { st.style.color = ''; st.textContent = '正在保存…' }
      try {
        const res = await fetch(BRIDGE + '/__dshm/files/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status))
        fileDir = body.dir || dir
        if (st) st.textContent = '已保存：' + fileDir
      } catch (err) {
        if (st) { st.style.color = '#ffb4b4'; st.textContent = '保存失败：' + String((err && err.message) || err) }
      }
    }

    async function loadFileDir() {
      try {
        const res = await fetch(BRIDGE + '/__dshm/files/config', { cache: 'no-store' })
        if (!res.ok) return
        const body = await res.json().catch(() => ({}))
        if (body && body.ok && body.dir) fileDir = body.dir
      } catch { /* bridge older than 0.5.1 */ }
    }

    function errorBox(err, title) {
      const box = mk('div', S.body)
      box.appendChild(mk('div', S.errTitle, title || '桥接服务未连接'))
      box.appendChild(mk('div', S.errMsg, String((err && err.message) || err)))
      if (!title) box.appendChild(mk('div', S.url, 'D:\\dsh-mobile\\bridge> node server.js'))
      const row = mk('div', S.row)
      row.appendChild(btn('重试', refresh, true))
      box.appendChild(row)
      if (!title) box.appendChild(mk('div', S.hint, '桌面 watchdog 会在几秒内自动拉起；若仍失败，运行 D:\\dsh-mobile\\bridge\\start-bridge.ps1 后点重试。'))
      return box
    }

    /* ---------------- 文件传输 tab ---------------- */

    function ftKey() {
      return info && info.key ? String(info.key) : ''
    }

    function ftUrl(path, params) {
      const q = []
      const key = ftKey()
      if (key) q.push('k=' + encodeURIComponent(key))
      if (params) {
        Object.keys(params).forEach((name) => {
          const v = params[name]
          if (v === undefined || v === null || v === '') return
          q.push(encodeURIComponent(name) + '=' + encodeURIComponent(String(v)))
        })
      }
      return BRIDGE + path + (q.length ? '?' + q.join('&') : '')
    }

    function ftFetch(path, params, opts) {
      const o = Object.assign({ cache: 'no-store' }, opts || {})
      o.headers = Object.assign({ 'x-dshm-key': ftKey() }, (opts && opts.headers) || {})
      return fetch(ftUrl(path, params), o)
    }

    function stopFtPoll() {
      if (ftTimer) {
        clearTimeout(ftTimer)
        ftTimer = null
      }
    }

    function scheduleFtPoll(ms) {
      stopFtPoll()
      ftTimer = setTimeout(() => { ftTimer = null; pullFt(true) }, ms === undefined ? 3200 : ms)
    }

    function ftSize(n) {
      const v = Number(n) || 0
      if (v < 1024) return v + ' B'
      if (v < 1048576) return (v / 1024).toFixed(1) + ' KB'
      if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB'
      return (v / 1073741824).toFixed(2) + ' GB'
    }

    function pad2(n) {
      return n < 10 ? '0' + n : '' + n
    }

    function ftTime(ts) {
      const d = new Date(Number(ts) || Date.now())
      const now = new Date()
      const sameDay = d.toDateString() === now.toDateString()
      return (sameDay ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }

    function ftExt(name) {
      const m = /\.([A-Za-z0-9]{1,6})$/.exec(String(name || ''))
      return m ? m[1].toUpperCase() : 'FILE'
    }

    function ftPreviewable(mime, name) {
      const m = String(mime || '').toLowerCase()
      if (/^image\//.test(m) || /^video\//.test(m) || /^audio\//.test(m)) return true
      if (m === 'application/pdf') return true
      if (/^text\//.test(m)) return true
      return /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|mkv|mp3|wav|m4a|pdf|txt|md|json|log|csv)$/i.test(String(name || ''))
    }

    function ftDesc(it) {
      if (it.kind === 'text') {
        const t = String(it.text || '')
        const len = Number(it.textLen) || t.length
        const short = t.length > 160 ? t.slice(0, 160) : t
        if (it.textCut || len > t.length) return short.replace(/\s+$/, '') + '…（共 ' + len + ' 字）'
        return short
      }
      return String(it.name || '未命名文件')
    }

    /** Copy the full body — list rows only carry a preview when the text is long. */
    function copyFtText(it, row) {
      const body = String(it.text || '')
      const len = Number(it.textLen) || body.length
      if (!it.textCut && len <= body.length) {
        ftCopy(body, row)
        return
      }
      if (row) ftFlash(row, '读取全文…')
      ftFetch('/__dshm/ft/text', { id: it.id }).then((r) => r.json()
        .catch(() => ({}))).then((j) => {
          if (!j || !j.ok) throw new Error((j && j.error) || '读取失败')
          it.text = String(j.text || '')
          it.textLen = it.text.length
          it.textCut = false
          ftCopy(it.text, row)
        }).catch((err) => {
          if (row) ftFlash(row, '复制失败：' + (err && err.message ? err.message : err))
        })
    }

    /**
     * Copy the file itself, not its name: the bridge puts it on the Windows
     * clipboard as a real file (CF_HDROP), exactly like Explorer's Ctrl+C, so it
     * can be pasted into WeChat, Explorer or any app that takes files.
     */
    function copyFtFile(it, row) {
      if (row) ftFlash(row, '复制文件…')
      ftFetch('/__dshm/ft/copy', null, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: it.id }),
      }).then((r) => r.json().catch(() => ({}))).then((j) => {
        if (!j || !j.ok) throw new Error((j && j.error) || '复制失败')
        ftFlash(row, '已复制文件')
      }).catch((err) => {
        ftFlash(row, '复制失败：' + (err && err.message ? err.message : err))
      })
    }

    /**
     * Right-click on a desktop message copies it: the text for text rows, the
     * file itself for file rows. The config tab's status line is not visible in
     * this tab, so confirm with a short inline badge instead.
     */
    function ftFlash(row, text) {
      if (!row) return
      const old = row.querySelector('.ft-flash')
      if (old) old.remove()
      const tip = mk('div', 'position:absolute;right:10px;top:50%;transform:translateY(-50%);'
        + 'background:#2b3550;color:#cfe0ff;font-size:11px;padding:2px 8px;border-radius:8px;'
        + 'pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.35)', text)
      tip.className = 'ft-flash'
      row.appendChild(tip)
      setTimeout(() => { tip.remove() }, 900)
    }

    function ftCopy(text, row) {
      const value = String(text || '')
      if (!value) return
      const done = () => { ftFlash(row, '已复制') }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done).catch(() => { window.prompt('复制', value) })
      } else {
        window.prompt('复制', value)
      }
    }

    /** Per-type colour for the little file badge. */
    function ftTagBg(it) {
      const ext = it.kind === 'text'
        ? 'txt'
        : String(it.name || '').replace(/^.*\./, '').toLowerCase()
      if (/^(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(ext)) return 'linear-gradient(135deg,#2fd3a0,#1fa8ff)'
      if (/^(mp4|mov|mkv|webm|avi)$/.test(ext)) return 'linear-gradient(135deg,#ff7a9c,#b25cff)'
      if (/^(mp3|wav|m4a|flac|ogg)$/.test(ext)) return 'linear-gradient(135deg,#ffc24b,#ff8a3d)'
      if (ext === 'pdf') return 'linear-gradient(135deg,#ff5d6c,#ff8a5c)'
      if (ext === 'apk') return 'linear-gradient(135deg,#a78bfa,#6d5cff)'
      return 'linear-gradient(135deg,#4c8dff,#7c5cff)'
    }

    let ftMenuEl = null
    let ftMenuOff = null

    function closeFtMenu() {
      if (ftMenuEl) { ftMenuEl.remove(); ftMenuEl = null }
      if (ftMenuOff) { ftMenuOff(); ftMenuOff = null }
    }

    /** Right-click menu at the pointer (never a row button). */
    let ftEditorEl = null
    let ftEditorOff = null

    function closeFtEditor() {
      if (ftEditorEl) { ftEditorEl.remove(); ftEditorEl = null }
      if (ftEditorOff) { ftEditorOff(); ftEditorOff = null }
    }

    /** Text-ish files can be edited right here and written back to the bridge. */
    function ftEditable(it) {
      if (!it || it.kind !== 'file') return false
      const m = String(it.mime || '').toLowerCase()
      if (/^text\//.test(m)) return true
      return /\.(txt|md|markdown|json|csv|tsv|log|xml|yml|yaml|ini|conf|env|js|mjs|ts|css|html|htm|sql|sh|bat|ps1|py|java|kt|c|h|cpp|go|rs|rb|php|toml|srt|vtt)$/i
        .test(String(it.name || ''))
    }

    function openFtEditor(it, row) {
      closeFtEditor()
      const wrap = mk('div', 'position:fixed;inset:0;z-index:100001;display:flex;align-items:center;'
        + 'justify-content:center;padding:20px;background:rgba(6,10,20,.72)')
      const card = mk('div', 'width:min(780px,96vw);height:min(80vh,780px);display:flex;flex-direction:column;'
        + 'border-radius:18px;background:linear-gradient(165deg,#19233d,#0f1729);'
        + 'border:1px solid rgba(120,150,255,.36);box-shadow:0 26px 70px rgba(0,0,0,.62);overflow:hidden')

      const head = mk('div', 'display:flex;align-items:center;gap:9px;padding:11px 14px;'
        + 'border-bottom:1px solid rgba(120,150,255,.18)')
      const nameEl = mk('div', 'font-size:12.5px;font-weight:600;color:#eaf0ff;flex:1;min-width:0;'
        + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', it.kind === 'text' ? '文本消息' : (it.name || '文件'))
      head.appendChild(nameEl)
      const stateEl = mk('div', 'font-size:11px;color:#9fb0d6;white-space:nowrap', '读取中…')
      head.appendChild(stateEl)
      const saveBtn = mk('button', 'border:0;border-radius:10px;padding:7px 15px;font-size:12px;color:#fff;'
        + 'cursor:pointer;background:linear-gradient(135deg,#4c8dff,#7c5cff)', '保存')
      saveBtn.type = 'button'
      head.appendChild(saveBtn)
      const closeBtn = mk('button', 'border:1px solid rgba(130,155,215,.35);border-radius:10px;'
        + 'padding:7px 12px;font-size:12px;color:#c7d4f2;background:transparent;cursor:pointer', '关闭')
      closeBtn.type = 'button'
      head.appendChild(closeBtn)
      card.appendChild(head)

      const area = mk('textarea', 'flex:1;width:100%;box-sizing:border-box;resize:none;border:0;outline:none;'
        + 'padding:14px 16px;background:transparent;color:#e8eeff;'
        + 'font:12.5px/1.65 ui-monospace,Consolas,"Courier New",monospace;tab-size:2;')
      area.spellcheck = false
      area.disabled = true
      card.appendChild(area)

      const foot = mk('div', 'padding:8px 14px;font-size:11px;color:#8194ba;'
        + 'border-top:1px solid rgba(120,150,255,.14)', '')
      card.appendChild(foot)

      wrap.appendChild(card)
      document.body.appendChild(wrap)
      ftEditorEl = wrap

      const setState = (text, color) => {
        stateEl.textContent = text
        stateEl.style.color = color || '#9fb0d6'
      }
      const setFoot = (text) => { foot.textContent = text }

      closeBtn.addEventListener('click', () => closeFtEditor())
      document.addEventListener('keydown', onEditorKey, true)
      ftEditorOff = () => document.removeEventListener('keydown', onEditorKey, true)

      ftFetch('/__dshm/ft/read', { id: it.id }).then((r) => r.json()
        .catch(() => ({})).then((j) => {
          if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status))
          area.value = String(j.text == null ? '' : j.text)
          area.disabled = false
          const baseline = area.value
          setState('未修改 · ' + area.value.length + ' 字符')
          setFoot(it.kind === 'text'
            ? '保存后写入 bridge，手机端刷新列表即可看到改动'
            : '保存后写入电脑端 bridge，手机端打开同一文件即可看到改动')
          area.addEventListener('input', () => {
            const changed = area.value !== baseline
            setState((changed ? '已修改 · ' : '未修改 · ') + area.value.length + ' 字符',
              changed ? '#ffc24b' : '#9fb0d6')
          })
        })).catch((e) => {
          setState('读取失败', '#ff8d9a')
          setFoot(String(e && e.message ? e.message : e))
        })

      saveBtn.addEventListener('click', () => {
        if (area.disabled || saveBtn.disabled) return
        saveBtn.disabled = true
        setState('保存中…')
        ftFetch('/__dshm/ft/write', { id: it.id }, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: area.value, from: 'pc', full: true }),
        }).then((r) => r.json().catch(() => ({})).then((j) => {
          if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status))
          const item = j.item || {}
          setState('已保存 · ' + area.value.length + ' 字符', '#2fe0a6')
          setFoot(it.kind === 'text'
            ? '已保存到 bridge（' + area.value.length + ' 字）'
            : '已写入电脑端文件（' + ftSize(item.size || area.value.length) + '）')
          if (item.size) it.size = item.size
          if (it.kind === 'text') {
            it.text = area.value
            it.textLen = area.value.length
            it.textCut = false
          }
          it.editedAt = item.editedAt || Date.now()
          ftFlash(row, '已保存')
          saveBtn.disabled = false
          loadFt('newer')
        })).catch((e) => {
          setState('保存失败：' + (e && e.message ? e.message : e), '#ff8d9a')
          saveBtn.disabled = false
        })
      })
    }

    function onEditorKey(e) {
      if (e.key === 'Escape') closeFtEditor()
    }

    /**
     * Send the (possibly edited) message again as a fresh message — this is how
     * an edited file or text ends up at the phone as a new entry.
     */
    function resendFt(it, row) {
      const done = (msg) => { if (row && msg) ftFlash(row, msg) }
      const failed = (err) => done('重发失败：' + (err && err.message ? err.message : err))
      if (it.kind === 'text') {
        const push = (text) => {
          if (!String(text || '').trim()) { done('内容是空的'); return }
          ftFetch('/__dshm/ft/text', {}, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text,
              from: 'pc',
              clientId: 'pc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
            })
          }).then((r) => r.json()).then((j) => {
            if (!j || !j.ok) throw new Error((j && j.error) || '发送失败')
            done('已重新发送')
            loadFt('newer')
          }).catch(failed)
        }
        const body = String(it.text || '')
        const len = Number(it.textLen) || body.length
        if (!it.textCut && len <= body.length) { push(body); return }
        done('读取全文…')
        ftFetch('/__dshm/ft/text', { id: it.id }).then((r) => r.json()).then((j) => {
          if (!j || !j.ok) throw new Error((j && j.error) || '读取失败')
          push(String(j.text || ''))
        }).catch(failed)
        return
      }
      done('重新发送…')
      fetch(ftUrl('/__dshm/ft/download', { id: it.id }), { headers: { 'x-dshm-key': ftKey() } })
        .then((r) => {
          if (!r.ok) throw new Error('取回文件失败 ' + r.status)
          return r.blob()
        })
        .then((blob) => uploadOne(new File([blob], it.name || 'file',
          { type: it.mime || 'application/octet-stream' })))
        .then(() => { done('已重新发送'); loadFt('newer') })
        .catch(failed)
    }

    function openFtMenu(it, ev, row) {
      closeFtMenu()
      const menu = mk('div', 'position:fixed;z-index:99999;min-width:158px;padding:6px;'
        + 'border-radius:13px;background:linear-gradient(160deg,#1e2a4a,#141c30);'
        + 'border:1px solid rgba(110,140,220,.42);box-shadow:0 16px 40px rgba(0,0,0,.6);'
        + 'font-size:12.5px;color:#eaf0ff;user-select:none;')
      const item = (text, color, fn) => {
        const b = mk('div', 'padding:8px 11px;border-radius:9px;cursor:pointer;color:'
          + (color || '#eaf0ff'), text)
        b.addEventListener('mouseenter', () => { b.style.background = 'rgba(110,150,255,.2)' })
        b.addEventListener('mouseleave', () => { b.style.background = 'transparent' })
        b.addEventListener('click', () => { closeFtMenu(); fn() })
        menu.appendChild(b)
      }
      item(it.kind === 'text' ? '复制文本' : '复制文件', null, () => {
        if (it.kind === 'text') copyFtText(it, row)
        else copyFtFile(it, row)
      })
      if (it.kind === 'file') {
        const canView = ftPreviewable(it.mime, it.name)
        item(canView ? '打开文件' : '保存文件', '#a9c8ff', () => {
          window.open(ftUrl('/__dshm/ft/download', { id: it.id, inline: canView ? 1 : 0 }), '_blank')
        })
      }
      if (it.kind === 'text' || ftEditable(it)) {
        item(it.kind === 'text' ? '编辑文本' : '编辑内容', '#9ef0c8', () => { openFtEditor(it, row) })
      }
      item('重新发送', '#b7a7ff', () => { resendFt(it, row) })
      item('删除记录', '#ff9aa6', () => { removeFt(it) })
      document.body.appendChild(menu)
      const rect = menu.getBoundingClientRect()
      let x = ev.clientX
      let y = ev.clientY
      if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8
      if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8
      menu.style.left = Math.max(8, x) + 'px'
      menu.style.top = Math.max(8, y) + 'px'
      ftMenuEl = menu
      const onDown = (e) => { if (!menu.contains(e.target)) closeFtMenu() }
      const onKey = (e) => { if (e.key === 'Escape') closeFtMenu() }
      document.addEventListener('mousedown', onDown, true)
      document.addEventListener('keydown', onKey, true)
      ftMenuOff = () => {
        document.removeEventListener('mousedown', onDown, true)
        document.removeEventListener('keydown', onKey, true)
      }
    }

    function ftRow(it) {
      const row = mk('div', S.ftRow)
      const mime = String(it.mime || '').toLowerCase()
      if (it.kind === 'file' && /^image\//.test(mime)) {
        const img = document.createElement('img')
        img.style.cssText = S.ftThumb
        img.alt = ''
        img.src = ftUrl('/__dshm/ft/download', { id: it.id, inline: 1 })
        img.addEventListener('error', () => { img.style.visibility = 'hidden' })
        row.appendChild(img)
      } else {
        const tag = mk('div', S.ftTag + 'background:' + ftTagBg(it),
          it.kind === 'text' ? 'TXT' : ftExt(it.name))
        row.appendChild(tag)
      }
      const mid = mk('div', '')
      mid.style.cssText = 'flex:1;min-width:0'
      mid.appendChild(mk('div', S.ftName, ftDesc(it)))
      const bits = [it.from === 'pc' ? '电脑' : '手机']
      if (it.kind === 'file') bits.push(ftSize(it.size))
      bits.push(ftTime(it.ts))
      mid.appendChild(mk('div', S.ftMeta, bits.join(' · ')))
      row.appendChild(mid)
      const acts = mk('div', S.ftActs)
      if (it.kind === 'file') {
        const canView = ftPreviewable(it.mime, it.name)
        const a = document.createElement('a')
        a.textContent = canView ? '打开' : '保存'
        a.href = ftUrl('/__dshm/ft/download', { id: it.id, inline: canView ? 1 : 0 })
        a.target = '_blank'
        a.rel = 'noopener'
        a.style.cssText = S.ftMini + 'text-decoration:none;display:inline-block;line-height:1.35'
        acts.appendChild(a)
      }
      if (it.kind === 'text' || ftEditable(it)) {
        const ed = mk('button', S.ftMini, '✎')
        ed.type = 'button'
        ed.title = it.kind === 'text' ? '编辑文本' : '编辑内容'
        ed.addEventListener('click', (event) => {
          event.stopPropagation()
          openFtEditor(it, row)
        })
        acts.appendChild(ed)
      }
      const del = mk('button', S.ftMini, '✕')
      del.type = 'button'
      del.title = '删除这条记录'
      del.addEventListener('click', () => { removeFt(it) })
      acts.appendChild(del)
      row.appendChild(acts)
      const canEditIt = it.kind === 'text' || ftEditable(it)
      row.title = it.kind === 'text'
        ? '右键：复制 / ' + (canEditIt ? '编辑 / ' : '') + '删除'
        : '右键：复制文件 / 打开 / ' + (canEditIt ? '编辑 / ' : '') + '删除'
      row.addEventListener('mouseenter', () => {
        row.style.borderColor = 'rgba(132,160,255,.62)'
        row.style.boxShadow = '0 6px 20px rgba(60,90,200,.22)'
      })
      row.addEventListener('mouseleave', () => {
        row.style.borderColor = ''
        row.style.boxShadow = ''
      })
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openFtMenu(it, event, row)
      })
      return row
    }

    function renderFt() {
      if (!ftListEl) return
      ftListEl.textContent = ''
      if (!ftItems.length) {
        ftListEl.appendChild(mk('div', S.hint, ftLoading ? '正在读取记录…' : '还没有记录。选一个文件发过去，手机会立刻收到。'))
        return
      }
      for (let i = ftItems.length - 1; i >= 0; i--) ftListEl.appendChild(ftRow(ftItems[i]))
    }

    async function loadFt(page) {
      if (!ftListEl) return
      if (ftLoading) return
      ftLoading = true
      try {
        const params = { limit: 40 }
        if (page === 'older' && ftBefore) params.before = ftBefore
        const res = await ftFetch('/__dshm/ft/list', params)
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const data = await res.json()
        const items = Array.isArray(data.items) ? data.items : []
        let changed = true
        if (page === 'older') {
          ftItems = items.concat(ftItems)
        } else if (page === 'newer') {
          const known = {}
          ftItems.forEach((x) => { known[x.id] = true })
          const add = items.filter((x) => !known[x.id])
          changed = add.length > 0
          if (changed) ftItems = ftItems.concat(add)
        } else {
          ftItems = items
        }
        ftHasMore = !!data.hasMore
        ftBefore = Number(data.nextBefore) || 0
        if (changed || page !== 'newer') {
          const keepTop = ftListEl.scrollTop
          const oldH = ftListEl.scrollHeight
          renderFt()
          if (page === 'older') ftListEl.scrollTop = keepTop
          else if (page === 'newer' && keepTop > 0) ftListEl.scrollTop = keepTop + (ftListEl.scrollHeight - oldH)
          else ftListEl.scrollTop = 0
        }
        if (ftStatusEl) {
          ftStatusEl.textContent = page === 'newer' && !changed && ftItems.length
            ? '共 ' + ftItems.length + ' 条 · 已是最新'
            : '共 ' + ftItems.length + ' 条' + (ftHasMore ? ' · 向下滚动加载更早' : '')
        }
      } catch (err) {
        if (ftStatusEl) ftStatusEl.textContent = '桥接未就绪：' + (err && err.message ? err.message : err)
      } finally {
        ftLoading = false
      }
    }

    async function pullFt(loop) {
      if (!card || !ftListEl || tabId !== 'ft') {
        stopFtPoll()
        return
      }
      await loadFt('newer')
      if (loop) scheduleFtPoll()
    }

    function ftProgress(name) {
      const box = mk('div', S.ftProg)
      box.appendChild(mk('div', S.ftName, name))
      const bar = mk('div', S.ftBar)
      const fill = mk('div', S.ftBarOn)
      bar.appendChild(fill)
      box.appendChild(bar)
      const note = mk('div', S.ftMeta, '准备上传…')
      box.appendChild(note)
      if (ftListEl) ftListEl.insertBefore(box, ftListEl.firstChild)
      return { box: box, fill: fill, note: note }
    }

    function uploadOne(file) {
      const clientId = 'pc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      const ui = ftProgress(file.name)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', ftUrl('/__dshm/ft/upload', {
        name: file.name,
        mime: file.type || '',
        from: 'pc',
        size: file.size,
        clientId: clientId,
      }))
      xhr.setRequestHeader('x-dshm-key', ftKey())
      xhr.setRequestHeader('content-type', 'application/octet-stream')
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return
        const pct = Math.round((e.loaded / e.total) * 100)
        ui.fill.style.width = pct + '%'
        ui.note.textContent = pct < 100
          ? '上传中 ' + pct + '% · ' + ftSize(e.loaded) + ' / ' + ftSize(e.total)
          : '正在落盘…'
      }
      xhr.onload = () => {
        if (ui.box.parentNode) ui.box.remove()
        if (xhr.status >= 200 && xhr.status < 300) {
          pullFt(false)
          return
        }
        let msg = 'HTTP ' + xhr.status
        try {
          const j = JSON.parse(xhr.responseText)
          if (j && j.error) msg = j.error
        } catch { /* ignore */ }
        if (ftStatusEl) ftStatusEl.textContent = '上传失败：' + msg
      }
      xhr.onerror = () => {
        if (ui.box.parentNode) ui.box.remove()
        if (ftStatusEl) ftStatusEl.textContent = '上传失败：桥接不可达（检查 D:\\dsh-mobile\\bridge 是否在运行）'
      }
      xhr.send(file)
    }

    function uploadFiles(list) {
      if (!list || !list.length) return
      for (let i = 0; i < list.length; i++) uploadOne(list[i])
    }

    async function sendFtText() {
      if (!ftInputEl) return
      const raw = String(ftInputEl.value || '')
      if (!raw.trim()) return
      // keep inner newlines/indent, only trim the trailing whitespace
      const text = raw.replace(/\s+$/, '')
      ftInputEl.value = ''
      if (ftInputEl.tagName === 'TEXTAREA') ftInputEl.style.height = '34px'
      try {
        const res = await ftFetch('/__dshm/ft/text', null, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: text,
            from: 'pc',
            clientId: 'pc-t-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
          }),
        })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        await loadFt('newer')
      } catch (err) {
        if (ftStatusEl) ftStatusEl.textContent = '发送失败：' + (err && err.message ? err.message : err)
      }
    }

    async function removeFt(it) {
      const what = it.kind === 'text' ? String(it.text || '').slice(0, 18) : String(it.name || '')
      if (!window.confirm('删除「' + what + '」？电脑和手机两端都会移除。')) return
      try {
        const res = await ftFetch('/__dshm/ft/delete', null, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: it.id }),
        })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        ftItems = ftItems.filter((x) => x.id !== it.id)
        const keepTop = ftListEl ? ftListEl.scrollTop : 0
        renderFt()
        if (ftListEl) ftListEl.scrollTop = keepTop
        if (ftStatusEl) ftStatusEl.textContent = '共 ' + ftItems.length + ' 条'
      } catch (err) {
        if (ftStatusEl) ftStatusEl.textContent = '删除失败：' + (err && err.message ? err.message : err)
      }
    }

    function contentFt() {
      const wrap = mk('div', S.body)
      ftListEl = null
      ftInputEl = null
      ftStatusEl = null

      const drop = mk('div', S.ftDrop, '点击选择文件，或把文件直接拖到这里')
      const picker = document.createElement('input')
      picker.type = 'file'
      picker.multiple = true
      picker.style.display = 'none'
      picker.addEventListener('change', () => {
        uploadFiles(picker.files)
        picker.value = ''
      })
      drop.addEventListener('click', () => picker.click())
      drop.addEventListener('dragover', (e) => {
        e.preventDefault()
        drop.style.borderColor = 'rgba(109,140,255,.8)'
        drop.style.background = 'rgba(109,140,255,.08)'
      })
      drop.addEventListener('dragleave', () => {
        drop.style.borderColor = 'rgba(255,255,255,.18)'
        drop.style.background = 'rgba(255,255,255,.02)'
      })
      drop.addEventListener('drop', (e) => {
        e.preventDefault()
        drop.style.borderColor = 'rgba(255,255,255,.18)'
        drop.style.background = 'rgba(255,255,255,.02)'
        if (e.dataTransfer) uploadFiles(e.dataTransfer.files)
      })
      wrap.appendChild(drop)
      wrap.appendChild(picker)

      const status = mk('div', S.ftMeta, '正在读取记录…')
      status.style.cssText = 'margin:9px 2px 6px;color:#8d93a3'
      wrap.appendChild(status)
      ftStatusEl = status

      const list = mk('div', S.ftList)
      list.addEventListener('scroll', () => {
        const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24
        if (nearBottom && ftHasMore && !ftLoading) loadFt('older')
      })
      wrap.appendChild(list)
      ftListEl = list

      const composer = mk('div', S.row)
      composer.style.cssText = 'display:flex;gap:8px;align-items:flex-end;margin-top:10px'
      const input = document.createElement('textarea')
      input.rows = 1
      input.placeholder = '发一条文字消息…（Shift+Enter 换行）'
      input.style.cssText = 'flex:1;min-width:0;height:34px;max-height:132px;resize:none;overflow-y:auto;' +
        'border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:8px 10px;' +
        'background:rgba(255,255,255,.055);color:#eef1f7;font-size:13px;line-height:1.45;' +
        'font-family:inherit;outline:none;box-sizing:border-box'
      const autosize = () => {
        input.style.height = 'auto'
        input.style.height = Math.min(132, Math.max(34, input.scrollHeight)) + 'px'
      }
      input.addEventListener('input', autosize)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          sendFtText()
        }
      })
      composer.appendChild(input)
      ftInputEl = input
      composer.appendChild(btn('发送', sendFtText, true))
      wrap.appendChild(composer)

      if (!info) {
        wrap.appendChild(mk('div', S.hint, '桥接服务还没就绪。切到「配置」页重新连接后再回来。'))
        return wrap
      }
      loadFt('reset').then(() => { scheduleFtPoll() })
      return wrap
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    async function refresh() {
      if (!card) return
      paint(mk('div', S.loading, '正在唤醒桥接服务…'))
      let last
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const res = await fetch(BRIDGE + '/__dshm/info', { cache: 'no-store' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          info = await res.json()
          await loadFileDir()
          await loadSec()
          if (!modeId) modeId = readMode() || info.preferred || ''
          if (card) paintTab()
          return
        } catch (err) {
          last = err
          if (attempt < 7) {
            if (card) paint(mk('div', S.loading, attempt === 0
              ? '桥接服务未运行，正在自动拉起…'
              : '正在等待桥接服务启动…（watchdog 会自动拉起）'))
            await sleep(1200)
          }
        }
      }
      if (card) paint(errorBox(last))
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }

    function open() {
      tabId = 'cfg'
      stopFtPoll()
      if (overlay) {
        refresh()
        return
      }
      overlay = mk('div', S.overlay)
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
      card = mk('div', S.card)
      overlay.appendChild(card)
      document.body.appendChild(overlay)
      document.addEventListener('keydown', onKey, true)
      refresh()
    }

    function close() {
      if (!overlay) return
      stopFtPoll()
      closeFtMenu()
      closeFtEditor()
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      overlay = null
      card = null
      statusEl = null
      ftListEl = null
      ftInputEl = null
      ftStatusEl = null
    }

    function PhoneButton(props) {
      const wide = !props || props.wide !== false
      return h('button', {
        type: 'button',
        title: '手机工作台',
        onClick: open,
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: wide ? 'flex-start' : 'center',
          gap: '8px',
          width: '100%',
          minWidth: wide ? '0' : '32px',
          minHeight: '32px',
          padding: wide ? '4px 8px' : '4px',
          border: 0,
          borderRadius: '8px',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = 'rgba(255,255,255,.07)' },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
      },
        h('svg', {
          width: 17,
          height: 17,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
          h('rect', { x: 6, y: 2.5, width: 12, height: 19, rx: 2.6 }),
          h('path', { d: 'M10 18.5h4' }),
          h('path', { d: 'M9 6.5h6v6H9z' })
        ),
        wide ? h('span', { style: { fontSize: '13px' } }, '手机') : null
      )
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-mobile-qr',
        order: 60,
      }, PhoneButton))
    }

    return { inject: ['slots'], apply }
  }
})
