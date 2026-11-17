'use strict';
/**
 * DSH Mobile — phone <-> PC file transfer channel.
 *
 * A WeChat-"file transfer assistant" style channel: both ends pull the same
 * chronological message list from the bridge, uploads land in
 *   <ftDir>/files/YYYY-MM/<id>-<name>
 * and the index lives in <ftDir>/index.json.
 *
 * Two listeners serve the same API:
 *   - the main bridge port (LAN / IPv6 / Cloudflare / Tailscale / ngrok)
 *   - cfg.usbPort bound to 127.0.0.1 only, reached from the phone through
 *     `adb reverse tcp:<usbPort> tcp:<usbPort>` (the fastest path, no tunnel)
 *
 * Every /__dshm/ft/* request must carry the bridge access key in the
 * `x-dshm-key` header (or ?k=). The USB listener accepts nothing else.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_LIMIT = 30;
const MAX_PAGE = 200;
// Text messages: full body is kept (up to TEXT_MAX chars); list only ships a
// preview so a page of long messages stays small. Clients pull the full body
// with GET /__dshm/ft/text?id=<id> when they need to copy it.
const TEXT_MAX = 200000;
const TEXT_PREVIEW = 1200;
/** Rolling copies of text bodies overwritten via /ft/write (see handleWrite). */
const BACKUP_KEEP = 40;

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
  '3gp': 'video/3gpp', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', amr: 'audio/amr',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8', json: 'application/json; charset=utf-8',
  js: 'text/javascript; charset=utf-8', ts: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  xml: 'application/xml; charset=utf-8', csv: 'text/csv; charset=utf-8',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip',
  apk: 'application/vnd.android.package-archive',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeOf(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function safeName(raw) {
  let name = path.basename(String(raw == null ? '' : raw).replace(/[\\/]+/g, '/'));
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim().slice(0, 180);
  if (!name || name === '.' || name === '..') name = 'file-' + Date.now();
  return name;
}

module.exports = function createFt(ctx) {
  const { cfg, ROOT, log, jsonOut } = ctx;
  const VERSION = ctx.VERSION || '0';

  function root() {
    const dir = cfg.ftDir ? path.resolve(String(cfg.ftDir)) : path.join(ROOT, 'ft');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  function indexFile() { return path.join(root(), 'index.json'); }
  function backupDir() { return path.join(root(), 'bak'); }
  /** Keep the newest BACKUP_KEEP bodies so an accidental overwrite is cheap. */
  function pruneBackups() {
    try {
      const dir = backupDir();
      fs.readdirSync(dir)
        .filter((f) => f.endsWith('.txt'))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
        .slice(BACKUP_KEEP)
        .forEach((x) => { try { fs.unlinkSync(path.join(dir, x.f)); } catch { /* ignore */ } });
    } catch { /* ignore */ }
  }
  function absOf(item) {
    const abs = path.resolve(root(), String(item.rel || ''));
    const base = root();
    if (abs !== base && !abs.startsWith(base + path.sep)) return '';
    return abs;
  }

  /* ---------------- index (append-only, debounced flush) ---------------- */

  let state = { seq: 0, items: [] };
  try {
    const data = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    if (data && Array.isArray(data.items)) {
      state.items = data.items.filter((x) => x && x.id);
      state.seq = Number(data.seq) || state.items.reduce((m, x) => Math.max(m, Number(x.seq) || 0), 0);
    }
  } catch { /* first run */ }

  /* diagnostics ring: the phone posts tiny beacons (merge applied etc.) so the
     PC can tell what the handset actually did without a screenshot */
  const appEvents = [];
  function noteEvent(ev) {
    appEvents.push(ev);
    while (appEvents.length > 12) appEvents.shift();
  }

  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 250);
    if (saveTimer.unref) saveTimer.unref();
  }
  function flush() {
    try {
      const tmp = indexFile() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, indexFile());
    } catch (e) { log('ft: index save failed:', e.message); }
  }
  process.on('exit', () => { try { flush(); } catch { /* ignore */ } });

  function findByClientId(clientId) {
    if (!clientId) return null;
    return state.items.find((x) => x.clientId === clientId) || null;
  }
  function byId(id) { return state.items.find((x) => x.id === id) || null; }

  function publicItem(item) {
    const full = String(item.text || '');
    return {
      id: item.id, seq: item.seq, kind: item.kind, name: item.name, size: item.size,
      mime: item.mime || mimeOf(item.name), sha: item.sha || '', ts: item.ts,
      from: item.from || 'phone',
      /* the phone keys its own sends by clientId, so the list has to carry it */
      clientId: item.clientId || '',
      text: full.length > TEXT_PREVIEW ? full.slice(0, TEXT_PREVIEW) : full,
      textLen: full.length,
      textCut: full.length > TEXT_PREVIEW,
      editedAt: Number(item.editedAt) || 0, edits: Number(item.edits) || 0,
      editedBy: item.editedBy || '',
    };
  }

  /* ---------------- handlers ---------------- */

  function handlePing(req, res) {
    jsonOut(res, 200, {
      ok: true, ft: 1, v: VERSION, host: os.hostname(),
      usb: usb.ready, port: Number(cfg.usbPort) || 8791, count: state.items.length,
    });
  }

  function handleList(req, res, u) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(u.searchParams.get('limit')) || DEFAULT_LIMIT));
    const before = Number(u.searchParams.get('before')) || 0;
    let end = state.items.length;
    if (before > 0) {
      /* the cursor is usually a seq, but older builds paged by millisecond ts */
      const byTs = before > 1e12;
      end = state.items.findIndex((x) => (byTs
        ? (Number(x.ts) || 0) >= before
        : (Number(x.seq) || 0) >= before));
      if (end < 0) end = 0;
    }
    const start = Math.max(0, end - limit);
    const page = state.items.slice(start, end).map(publicItem);
    jsonOut(res, 200, {
      ok: true, items: page, total: state.items.length,
      hasMore: start > 0, nextBefore: start > 0 ? Number(state.items[start].seq) || 0 : 0,
    });
  }

  function handleUpload(req, res, u) {
    const name = safeName(u.searchParams.get('name'));
    const from = u.searchParams.get('from') === 'pc' ? 'pc' : 'phone';
    const clientId = String(u.searchParams.get('clientId') || '').slice(0, 96);
    const declaredSize = Number(u.searchParams.get('size')) || 0;
    const declaredMime = String(u.searchParams.get('mime') || '').slice(0, 120);

    const dup = findByClientId(clientId);
    if (dup) {
      req.resume();
      jsonOut(res, 200, { ok: true, item: publicItem(dup), dup: true });
      return;
    }

    const seq = ++state.seq;
    const id = 'f' + seq.toString(36) + crypto.randomBytes(3).toString('hex');
    const month = new Date().toISOString().slice(0, 7);
    const dir = path.join(root(), 'files', month);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      jsonOut(res, 500, { ok: false, error: '无法创建保存目录：' + e.message });
      return;
    }
    const relPath = 'files/' + month + '/' + id + '-' + name;
    const dest = path.join(root(), relPath);
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    const hash = crypto.createHash('sha256');
    let size = 0;
    let tooLarge = false;
    let aborted = false;
    const startedAt = Date.now();

    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      hash.update(chunk);
      if (size > MAX_UPLOAD_BYTES) {
        tooLarge = true;
        try { req.unpipe(out); } catch { /* ignore */ }
        try { out.destroy(); } catch { /* ignore */ }
        try { fs.unlink(tmp, () => {}); } catch { /* ignore */ }
        try {
          res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: '文件超过 4 GB 上限' }));
        } catch { /* ignore */ }
        try { req.destroy(); } catch { /* ignore */ }
      }
    });
    req.on('aborted', () => { aborted = true; });
    out.on('error', (e) => {
      if (!res.headersSent) jsonOut(res, 500, { ok: false, error: '写入失败：' + e.message });
      try { fs.unlink(tmp, () => {}); } catch { /* ignore */ }
    });

    req.pipe(out);
    out.on('close', () => {
      if (tooLarge || aborted) return;
      if (declaredSize > 0 && size === 0) {
        jsonOut(res, 400, { ok: false, error: '空文件' });
        return;
      }
      let finalAbs = dest;
      try {
        fs.renameSync(tmp, dest);
      } catch (e) {
        jsonOut(res, 500, { ok: false, error: '保存失败：' + e.message });
        return;
      }
      const item = {
        id, seq, kind: 'file', name, size, mime: declaredMime || mimeOf(name),
        sha: hash.digest('hex'), rel: relPath, ts: Date.now(), from,
        clientId, durationMs: Date.now() - startedAt,
      };
      state.items.push(item);
      scheduleSave();
      log(`ft: ${from} -> pc ${name} (${size} B in ${item.durationMs} ms)`);
      jsonOut(res, 200, { ok: true, item: publicItem(item) });
    });
  }

  function handleText(req, res) {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4 * 1024 * 1024) { try { req.destroy(); } catch { /* ignore */ } }
    });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      const fullText = String(body.text || '');
      const text = fullText.length > TEXT_MAX ? fullText.slice(0, TEXT_MAX) : fullText;
      if (!text.trim()) { jsonOut(res, 400, { ok: false, error: '空消息' }); return; }
      const clientId = String(body.clientId || '').slice(0, 96);
      const dup = findByClientId(clientId);
      if (dup) { jsonOut(res, 200, { ok: true, item: publicItem(dup), dup: true }); return; }
      const seq = ++state.seq;
      const item = {
        id: 't' + seq.toString(36) + crypto.randomBytes(3).toString('hex'),
        seq, kind: 'text', name: '', size: Buffer.byteLength(text), mime: 'text/plain',
        sha: '', rel: '', ts: Date.now(), from: body.from === 'pc' ? 'pc' : 'phone',
        clientId, text,
      };
      state.items.push(item);
      scheduleSave();
      jsonOut(res, 200, {
        ok: true, item: publicItem(item), truncated: fullText.length > TEXT_MAX, textLen: text.length,
      });
    });
  }

  /** Full body of one text message (list only carries a preview). */
  function handleTextGet(req, res, u) {
    const item = byId(String(u.searchParams.get('id') || ''));
    if (!item || item.kind !== 'text') { jsonOut(res, 404, { ok: false, error: '没有这条记录' }); return; }
    const text = String(item.text || '');
    jsonOut(res, 200, { ok: true, item: publicItem(item), text, textLen: text.length });
  }

  function handleDownload(req, res, u) {
    const item = byId(String(u.searchParams.get('id') || ''));
    if (!item || item.kind !== 'file') { jsonOut(res, 404, { ok: false, error: '没有这条记录' }); return; }
    const abs = absOf(item);
    let stat = null;
    try { stat = fs.statSync(abs); } catch { /* missing */ }
    if (!abs || !stat) { jsonOut(res, 410, { ok: false, error: '文件已被移动或删除', gone: true }); return; }
    const type = item.mime || mimeOf(item.name);
    const inline = u.searchParams.get('inline') === '1';
    const headers = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name || 'file')}`,
      'x-dshm-name': encodeURIComponent(item.name || 'file'),
    };
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null && end === null) { /* fall through to full body */ } else {
          if (start === null) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
          if (end === null || end >= stat.size) end = stat.size - 1;
          if (start > end || start >= stat.size) {
            res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
            res.end();
            return;
          }
          headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
          headers['content-length'] = end - start + 1;
          res.writeHead(206, headers);
          if (req.method === 'HEAD') { res.end(); return; }
          fs.createReadStream(abs, { start, end }).pipe(res);
          return;
        }
      }
    }
    headers['content-length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(abs).pipe(res);
  }

  function handleDelete(req, res) {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) { try { req.destroy(); } catch { /* ignore */ } } });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const one = body.id ? [String(body.id)] : [];
      const targets = ids.concat(one);
      let removed = 0;
      for (const id of targets) {
        const idx = state.items.findIndex((x) => x.id === id);
        if (idx < 0) continue;
        const item = state.items[idx];
        state.items.splice(idx, 1);
        removed++;
        const abs = item.kind === 'file' ? absOf(item) : '';
        if (abs) { try { fs.unlinkSync(abs); } catch { /* ignore */ } }
      }
      scheduleSave();
      jsonOut(res, 200, { ok: true, removed });
    });
  }

  /* ---------------- inline editing (text-ish files + text messages) ---------------- */

  const EDIT_MAX = 2 * 1024 * 1024;
  const EDITABLE_EXT = new RegExp('^(txt|md|markdown|json|csv|tsv|log|xml|yml|yaml|ini|conf|env'
    + '|js|mjs|cjs|ts|tsx|jsx|css|scss|less|html|htm|sql|sh|bat|cmd|ps1|py|java|kt|c|h|cpp|hpp'
    + '|go|rs|rb|php|toml|srt|vtt|gitignore|properties)$', 'i');

  function editableOf(item) {
    if (!item || item.kind !== 'file') return false;
    if (item.mime && /^text\//i.test(String(item.mime))) return true;
    const ext = String(item.name || '').split('.').pop();
    return EDITABLE_EXT.test(String(ext || ''));
  }

  function handleRead(req, res, u) {
    const item = byId(String(u.searchParams.get('id') || ''));
    if (!item) { jsonOut(res, 404, { ok: false, error: '没有这条记录' }); return; }
    /* a text message has no file behind it: the body is the item itself */
    if (item.kind === 'text') {
      const text = String(item.text || '');
      jsonOut(res, 200, { ok: true, item: publicItem(item), text, size: Buffer.byteLength(text), editable: true });
      return;
    }
    if (!editableOf(item)) {
      jsonOut(res, 400, { ok: false, error: '这种文件不支持在线编辑', editable: false });
      return;
    }
    const abs = absOf(item);
    let st = null;
    try { st = fs.statSync(abs); } catch { /* gone */ }
    if (!st || !st.isFile()) {
      jsonOut(res, 410, { ok: false, error: '文件已被移动或删除', gone: true });
      return;
    }
    if (st.size > EDIT_MAX) {
      jsonOut(res, 413, { ok: false, error: '文件超过 2 MB，不能在线编辑' });
      return;
    }
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); }
    catch (e) { jsonOut(res, 500, { ok: false, error: '读取失败：' + e.message }); return; }
    jsonOut(res, 200, { ok: true, item: publicItem(item), text, size: st.size, editable: true });
  }

  function handleWrite(req, res, u) {
    const item = byId(String(u.searchParams.get('id') || ''));
    if (!item) { jsonOut(res, 404, { ok: false, error: '没有这条记录' }); return; }
    const isText = item.kind === 'text';
    if (!isText && !editableOf(item)) {
      jsonOut(res, 400, { ok: false, error: '这种文件不支持在线编辑' });
      return;
    }
    const abs = isText ? '' : absOf(item);
    let raw = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (c) => {
      raw += c;
      if (raw.length > EDIT_MAX) {
        tooBig = true;
        try { req.destroy(); } catch { /* ignore */ }
      }
    });
    req.on('end', () => {
      if (tooBig) { jsonOut(res, 413, { ok: false, error: '内容超过 2 MB' }); return; }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      if (typeof body.text !== 'string') {
        jsonOut(res, 400, { ok: false, error: '缺少 text' });
        return;
      }
      if (isText) {
        const prevLen = String(item.text || '').length;
        /* Clients that only saw the list preview must never write back: doing so
           truncated a 6008-char message to its 1198-char preview. `full:true` is
           the explicit "I loaded the whole body" contract (PC editor + 0.8.62+
           phone send it). */
        if (body.full !== true && prevLen > body.text.length && body.text.length <= TEXT_PREVIEW) {
          jsonOut(res, 409, {
            ok: false,
            error: '这条消息在客户端只加载了前 ' + TEXT_PREVIEW + ' 字的预览，直接保存会把后面的内容截掉；请先加载全文再编辑',
          });
          return;
        }
        if (prevLen > 200 && body.text !== item.text) {
          try {
            fs.mkdirSync(backupDir(), { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.writeFileSync(path.join(backupDir(), item.id + '-' + stamp + '.txt'),
              String(item.text || ''), 'utf8');
            pruneBackups();
          } catch (e) { log('WARN cannot back up ft text:', e.message); }
        }
        item.text = body.text.length > TEXT_MAX ? body.text.slice(0, TEXT_MAX) : body.text;
        item.size = Buffer.byteLength(item.text);
        item.sha = '';
      } else {
        const data = Buffer.from(body.text, 'utf8');
        try { fs.writeFileSync(abs, data); }
        catch (e) { jsonOut(res, 500, { ok: false, error: '保存失败：' + e.message }); return; }
        item.size = data.length;
        item.sha = crypto.createHash('sha256').update(data).digest('hex');
      }
      item.editedAt = Date.now();
      item.edits = (Number(item.edits) || 0) + 1;
      item.editedBy = body.from === 'phone' ? 'phone' : 'pc';
      scheduleSave();
      log(`ft: ${item.editedBy} edited ${item.name || '(text #' + item.seq + ')'} (${item.size} B)`);
      jsonOut(res, 200, { ok: true, item: publicItem(item) });
    });
  }

  function handleStatus(req, res) {
    jsonOut(res, 200, {
      ok: true,
      dir: root(),
      count: state.items.length,
      bytes: state.items.reduce((n, x) => n + (Number(x.size) || 0), 0),
      usb: { ready: usb.ready, port: usb.port, devices: usb.devices, adb: usb.adb, error: usb.error,
      webReady: usb.webReady, webPort: usb.webPort, webError: usb.webError },
      key: !!cfg.accessKey,
      events: appEvents.slice(-8),
    });
  }

  /* The handset posts {event, id, edits, v} here after it applies an in-place
     rewrite; the PC reads them back from /__dshm/ft/status to verify the phone
     really merged the change (a screenshot needs a11y/Shizuku, this does not). */
  function handleEvent(req, res) {
    let raw = '';
    let closed = false;
    req.setEncoding('utf8');
    req.on('data', (c) => { if (raw.length < 2048) raw += c; });
    req.on('error', () => { /* drains below */ });
    req.on('end', () => {
      if (closed) return;
      closed = true;
      let ev = {};
      try { ev = JSON.parse(raw || '{}'); } catch { ev = { raw: raw.slice(0, 160) }; }
      const rec = {
        at: Date.now(),
        event: String(ev.event || '?').slice(0, 40),
        id: String(ev.id || '').slice(0, 40),
        edits: Number(ev.edits) || 0,
        v: String(ev.v || req.headers['user-agent'] || '').slice(0, 60),
      };
      noteEvent(rec);
      log(`ft: app event ${rec.event} id=${rec.id || '-'} edits=${rec.edits} v=${rec.v || '-'}`);
      jsonOut(res, 200, { ok: true });
    });
  }

  /* ---------------- copy real files to the PC clipboard (CF_HDROP) ---------------- */

  function handleCopy(req, res) {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) { try { req.destroy(); } catch { /* ignore */ } } });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      const ids = (Array.isArray(body.ids) ? body.ids.map(String) : []).concat(body.id ? [String(body.id)] : []);
      const files = [];
      for (const id of ids) {
        const item = byId(id);
        if (!item || item.kind !== 'file') continue;
        const abs = absOf(item);
        if (!abs) continue;
        try { if (fs.statSync(abs).isFile()) files.push(abs); } catch { /* gone */ }
      }
      if (!files.length) {
        jsonOut(res, 404, { ok: false, error: '没有可复制的文件' });
        return;
      }
      if (process.platform !== 'win32') {
        jsonOut(res, 501, { ok: false, error: '只有 Windows 电脑能复制文件到剪贴板' });
        return;
      }
      /* Set-Clipboard -Path puts the files on the clipboard exactly like Explorer's
         Ctrl+C, so they can be pasted into WeChat / Explorer / any file target. */
      const quoted = files.map((f) => "'" + f.replace(/'/g, "''") + "'").join(',');
      const script = 'Set-Clipboard -Path @(' + quoted + ')';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
        { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
          if (err) {
            log('ft copy failed: ' + String(stderr || err.message).slice(0, 200));
            jsonOut(res, 500, { ok: false, error: '复制失败：' + String(stderr || err.message).slice(0, 200) });
            return;
          }
          jsonOut(res, 200, { ok: true, count: files.length, names: files.map((f) => path.basename(f)) });
        });
    });
  }

  function dispatch(req, res, u) {
    const action = u.pathname.slice('/__dshm/ft/'.length).replace(/\/+$/, '');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'x-dshm-key, content-type, range',
        'access-control-allow-methods': 'GET, POST, HEAD, DELETE, OPTIONS',
      });
      res.end();
      return;
    }
    if (action === 'ping') return handlePing(req, res);
    if (action === 'list') return handleList(req, res, u);
    if (action === 'upload') {
      if (req.method !== 'POST') return jsonOut(res, 405, { ok: false, error: 'POST only' });
      return handleUpload(req, res, u);
    }
    if (action === 'text') {
      if (req.method === 'POST') return handleText(req, res);
      if (req.method === 'GET' || req.method === 'HEAD') return handleTextGet(req, res, u);
      return jsonOut(res, 405, { ok: false, error: 'GET or POST' });
    }
    if (action === 'download') return handleDownload(req, res, u);
    if (action === 'read') return handleRead(req, res, u);
    if (action === 'write') {
      if (req.method !== 'POST') return jsonOut(res, 405, { ok: false, error: 'POST only' });
      return handleWrite(req, res, u);
    }
    if (action === 'delete') {
      if (req.method !== 'POST') return jsonOut(res, 405, { ok: false, error: 'POST only' });
      return handleDelete(req, res);
    }
    if (action === 'copy') {
      if (req.method !== 'POST') return jsonOut(res, 405, { ok: false, error: 'POST only' });
      return handleCopy(req, res);
    }
    if (action === 'status') return handleStatus(req, res);
    if (action === 'event') {
      if (req.method !== 'POST') return jsonOut(res, 405, { ok: false, error: 'POST only' });
      return handleEvent(req, res);
    }
    return jsonOut(res, 404, { ok: false, error: 'unknown ft action: ' + action });
  }

  /* ---------------- USB listener + adb reverse ---------------- */

  const usb = {
    ready: false, port: Number(cfg.usbPort) || 8791, devices: [], adb: '', error: '', server: null,
    webReady: false, webError: '', webPort: Number(cfg.port) || 8787,
  };

  function findAdb() {
    const cands = [];
    if (cfg.adbPath) cands.push(String(cfg.adbPath));
    if (process.env.ADB) cands.push(process.env.ADB);
    for (const k of ['ANDROID_SDK_ROOT', 'ANDROID_HOME', 'ANDROID_SDK']) {
      if (process.env[k]) {
        cands.push(path.join(process.env[k], 'platform-tools', 'adb.exe'));
        cands.push(path.join(process.env[k], 'platform-tools', 'adb'));
      }
    }
    const home = os.homedir();
    cands.push('D:\\Android\\sdk\\platform-tools\\adb.exe');
    cands.push(path.join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
    cands.push(path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
    cands.push('adb');
    for (const c of cands) {
      if (c === 'adb') return c;
      try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    return 'adb';
  }

  function runAdb(args, timeout) {
    return new Promise((resolve) => {
      execFile(usb.adb || findAdb(), args, { timeout: timeout || 8000, windowsHide: true }, (err, stdout) => {
        resolve({ ok: !err, out: String(stdout || '') });
      });
    });
  }

  let adbBusy = false;
  async function maintainUsb() {
    if (adbBusy) return;
    adbBusy = true;
    try {
      if (!usb.adb) usb.adb = findAdb();
      const list = await runAdb(['devices'], 6000);
      if (!list.ok) { usb.error = 'adb 不可用'; usb.devices = []; usb.ready = false; return; }
      const serials = list.out.split(/\r?\n/).slice(1)
        .map((line) => line.trim())
        .filter((line) => line && /\sdevice$/.test(line))
        .map((line) => line.split(/\s+/)[0]);
      usb.devices = serials;
      if (!serials.length) { usb.error = '没有已授权的 USB 设备'; usb.ready = false; return; }
      let okCount = 0;
      const webPort = Number(cfg.port) || 8787;
      for (const serial of serials) {
        const r = await runAdb(['-s', serial, 'reverse', 'tcp:' + usb.port, 'tcp:' + usb.port], 8000);
        if (r.ok) okCount++;
        else usb.error = r.out ? r.out.split(/\r?\n/)[0] : 'adb reverse 失败';
        // expose the whole workbench over the cable too: the phone's WebView can
        // then open http://127.0.0.1:<webPort> and skip tunnels/Wi-Fi entirely
        const w = await runAdb(['-s', serial, 'reverse', 'tcp:' + webPort, 'tcp:' + webPort], 8000);
        usb.webReady = !!w.ok;
        if (!w.ok) usb.webError = w.out ? w.out.split(/\r?\n/)[0] : 'adb reverse 失败';
      }
      usb.ready = okCount > 0;
      if (usb.ready) usb.error = '';
    } catch (e) {
      usb.error = e.message || String(e);
      usb.ready = false;
    } finally {
      adbBusy = false;
    }
  }

  function start() {
    try {
      usb.server = http.createServer((req, res) => {
        let u;
        try { u = new URL(req.url, 'http://usb.invalid'); } catch { res.writeHead(400); res.end(); return; }
        if (!u.pathname.startsWith('/__dshm/ft/')) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('only /__dshm/ft/* is served on the USB listener');
          return;
        }
        if (!ctx.keyMatches(req, u)) {
          jsonOut(res, 401, { ok: false, error: '需要访问密钥' });
          return;
        }
        try { dispatch(req, res, u); } catch (e) { jsonOut(res, 500, { ok: false, error: e.message }); }
      });
      usb.server.on('error', (e) => log('ft: usb listener error:', e.message));
      usb.server.listen(usb.port, '127.0.0.1', () => {
        log(`ft: usb listener on 127.0.0.1:${usb.port}`);
      });
    } catch (e) {
      log('ft: usb listener failed:', e.message);
    }
    if (process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin') {
      setTimeout(() => { maintainUsb().catch(() => {}); }, 1200);
      const t = setInterval(() => { maintainUsb().catch(() => {}); }, 15000);
      if (t.unref) t.unref();
    }
  }

  function stop() {
    try { if (usb.server) usb.server.close(); } catch { /* ignore */ }
    try { flush(); } catch { /* ignore */ }
  }

  return { dispatch, start, stop, root, status: () => usb, list: () => state.items.map(publicItem) };
};
