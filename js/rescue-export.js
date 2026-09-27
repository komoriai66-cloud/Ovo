/* Standalone, read-only exporter. Keep this page independent from db.js and the main app. */
(() => {
  'use strict';

  const DB_NAME = '章鱼喷墨机DB_ee';
  const CHECKPOINT_KEY = 'uwu_rescue_export_checkpoint';
  const FORMAT = 'uwu-rescue-zip-parts';
  const encoder = new TextEncoder();
  const $ = id => document.getElementById(id);
  const state = { db: null, counts: null, session: null, running: false, manifest: null, files: new Map(), verified: new Set() };

  function setStatus(message) { $('status').textContent = message; }
  function setError(error) { $('error').textContent = error ? (error.message || String(error)) : ''; }
  function tick() { return new Promise(resolve => setTimeout(resolve, 0)); }
  function reqPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('数据库读取失败'));
    });
  }

  function openExistingDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      let missing = false;
      request.onupgradeneeded = () => {
        // Opening a missing database must not create an empty one and mislead the user.
        missing = true;
        request.transaction.abort();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(missing ? new Error('此网页或 PWA 中没有找到旧数据库，请从原来存有聊天记录的入口打开。') : (request.error || new Error('无法打开旧数据库')));
      request.onblocked = () => reject(new Error('数据库被另一页面占用，请关闭其他旧链接页面后重试。'));
    });
  }

  async function inspectDatabase(db) {
    const names = Array.from(db.objectStoreNames).sort();
    if (!names.length) throw new Error('数据库没有可导出的数据表。');
    const counts = {};
    for (const name of names) counts[name] = await reqPromise(db.transaction(name, 'readonly').objectStore(name).count());
    $('db-summary').textContent = `找到旧数据库，共 ${names.length} 个数据表、${Object.values(counts).reduce((a, b) => a + b, 0)} 条顶层记录。`;
    $('store-summary').replaceChildren(...names.map(name => {
      const span = document.createElement('span');
      span.className = 'metric';
      span.textContent = `${name}: ${counts[name]}`;
      return span;
    }));
    $('start-btn').disabled = false;
    return counts;
  }

  function savedCheckpoint() {
    try {
      const value = JSON.parse(localStorage.getItem(CHECKPOINT_KEY) || 'null');
      return value && value.format === FORMAT && Array.isArray(value.parts) ? value : null;
    } catch (_) { return null; }
  }
  function saveCheckpoint(session) {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(session));
  }
  function refreshResumeButton() {
    const checkpoint = savedCheckpoint();
    $('resume-btn').hidden = !checkpoint || checkpoint.complete;
    if (checkpoint && !checkpoint.complete) $('resume-btn').textContent = `继续上次备份（已保存 ${checkpoint.parts.length} 卷）`;
  }

  function* stringTokens(value) {
    yield '"';
    // Stringify short slices to avoid making a second copy of a huge base64 string.
    for (let i = 0; i < value.length; i += 4096) yield JSON.stringify(value.slice(i, i + 4096)).slice(1, -1);
    yield '"';
  }
  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  async function* binaryTokens(bytes, typeName, extra = '') {
    yield `{"__uwuRescueBinary__":${JSON.stringify(typeName)}${extra},"base64":"`;
    // 12288 is divisible by 3, so independently encoded slices concatenate safely.
    for (let i = 0; i < bytes.length; i += 12288) yield bytesToBase64(bytes.subarray(i, i + 12288));
    yield '"}';
  }
  async function* jsonTokens(value, active = new WeakSet()) {
    if (value === null || value === undefined) { yield 'null'; return; }
    const kind = typeof value;
    if (kind === 'string') { yield* stringTokens(value); return; }
    if (kind === 'number') { yield Number.isFinite(value) ? String(value) : 'null'; return; }
    if (kind === 'boolean') { yield value ? 'true' : 'false'; return; }
    if (kind === 'bigint') { yield `{"__uwuRescueBigInt__":${JSON.stringify(String(value))}}`; return; }
    if (kind !== 'object') { yield 'null'; return; }
    if (value instanceof Date) { yield `{"__uwuRescueDate__":${JSON.stringify(value.toISOString())}}`; return; }
    if (value instanceof RegExp) { yield `{"__uwuRescueRegExp__":${JSON.stringify(value.source)},"flags":${JSON.stringify(value.flags)}}`; return; }
    if (value instanceof Blob) {
      const extra = `,"mime":${JSON.stringify(value.type || '')}${value instanceof File ? `,"name":${JSON.stringify(value.name)},"lastModified":${value.lastModified}` : ''}`;
      yield `{"__uwuRescueBinary__":${JSON.stringify(value instanceof File ? 'File' : 'Blob')}${extra},"base64":"`;
      for (let i = 0; i < value.size; i += 12288) yield bytesToBase64(new Uint8Array(await value.slice(i, i + 12288).arrayBuffer()));
      yield '"}';
      return;
    }
    if (value instanceof ArrayBuffer) { yield* binaryTokens(new Uint8Array(value), 'ArrayBuffer'); return; }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      yield* binaryTokens(bytes, value.constructor.name);
      return;
    }
    if (active.has(value)) throw new Error('发现循环引用的数据记录，无法安全导出');
    active.add(value);
    try {
      if (value instanceof Map) {
        yield '{"__uwuRescueMap__":[';
        let first = true;
        for (const [key, item] of value) {
          if (!first) yield ',';
          first = false;
          yield '['; yield* jsonTokens(key, active); yield ','; yield* jsonTokens(item, active); yield ']';
        }
        yield ']}';
      } else if (value instanceof Set) {
        yield '{"__uwuRescueSet__":[';
        let first = true;
        for (const item of value) {
          if (!first) yield ',';
          first = false;
          yield* jsonTokens(item, active);
        }
        yield ']}';
      } else if (Array.isArray(value)) {
        yield '[';
        for (let i = 0; i < value.length; i++) {
          if (i) yield ',';
          yield* jsonTokens(value[i], active);
        }
        yield ']';
      } else {
        yield '{';
        let first = true;
        for (const key of Object.keys(value)) {
          if (value[key] === undefined || typeof value[key] === 'function' || typeof value[key] === 'symbol') continue;
          if (!first) yield ',';
          first = false;
          yield* stringTokens(key);
          yield ':';
          yield* jsonTokens(value[key], active);
        }
        yield '}';
      }
    } finally { active.delete(value); }
  }

  async function* envelope(kind, store, key, value, index, historyLength) {
    yield '{"kind":'; yield* stringTokens(kind);
    if (store !== undefined) { yield ',"store":'; yield* stringTokens(store); }
    yield ',"key":'; yield* jsonTokens(key);
    if (index !== undefined) yield `,"index":${index}`;
    if (historyLength !== undefined) yield `,"historyLength":${historyLength}`;
    yield ',"value":'; yield* jsonTokens(value);
    yield '}\n';
  }
  function sensitiveLocalKey(key) {
    return key === 'ephone_auth' || key === 'gh_config' || key === 'imgbb_api_key' || key.startsWith('minimax_') || key === 'vc_interrupt_data';
  }

  async function* sourceTokens(db, session, stats) {
    for (const storeName of Array.from(db.objectStoreNames).sort()) {
      stats.store = storeName;
      setStatus(`正在读取 ${storeName}…`);
      const keys = await reqPromise(db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys());
      for (const key of keys) {
        const value = await reqPromise(db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
        if (value === undefined) throw new Error(`${storeName} 中有记录在导出期间被修改，请关闭其他旧页面后重新开始。`);
        try {
          if ((storeName === 'characters' || storeName === 'groups') && value && Array.isArray(value.history)) {
            const metadata = { ...value };
            const history = value.history;
            delete metadata.history;
            yield* envelope('row', storeName, key, metadata, undefined, history.length);
            for (let i = 0; i < history.length; i++) {
              yield* envelope('history', storeName, key, history[i], i);
              stats.messages++;
            }
          } else {
            yield* envelope('row', storeName, key, value);
          }
        } catch (error) {
          throw new Error(`读取 ${storeName} / ${String(key)} 时失败：${error.message || error}`);
        }
        stats.rows++;
        renderMetrics(stats, session);
        await tick();
      }
    }
    const excluded = [];
    const localKeys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(Boolean).sort().filter(key => key !== CHECKPOINT_KEY);
    for (const key of localKeys) {
      if (!session.includeSecrets && sensitiveLocalKey(key)) { excluded.push(key); continue; }
      yield* envelope('localStorage', undefined, key, localStorage.getItem(key));
      stats.localKeys++;
    }
    session.excludedLocalStorageKeys = excluded;
  }

  function renderMetrics(stats, session) {
    $('metrics').replaceChildren(...[
      `已读取顶层记录 ${stats.rows}/${stats.totalRows}`,
      `聊天消息 ${stats.messages}`,
      `本地设置 ${stats.localKeys}`,
      `已保存分卷 ${session.parts.length}`
    ].map(label => {
      const span = document.createElement('span');
      span.className = 'metric';
      span.textContent = label;
      return span;
    }));
  }
  async function sha256(value) {
    const input = value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function makeHeader(size) { return new DataView(new ArrayBuffer(size)); }
  function headerBytes(header) { return new Uint8Array(header.buffer); }

  async function zipPart(raw) {
    const filename = encoder.encode('payload.ndjson.fragment');
    let body = raw;
    let method = 0;
    if (typeof CompressionStream !== 'undefined') {
      try {
        const wrapped = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
        // CompressionStream('deflate') emits zlib; ZIP stores the raw DEFLATE body.
        if (wrapped.length > 6 && wrapped.length - 6 < raw.length) {
          body = wrapped.subarray(2, wrapped.length - 4);
          method = 8;
        }
      } catch (_) { /* Store uncompressed if this browser cannot compress. */ }
    }
    const checksum = crc32(raw);
    const local = makeHeader(30);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true);
    local.setUint32(14, checksum, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, filename.length, true);
    const central = makeHeader(46);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, method, true);
    central.setUint32(16, checksum, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, raw.length, true);
    central.setUint16(28, filename.length, true);
    const end = makeHeader(22);
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, 1, true);
    end.setUint16(10, 1, true);
    end.setUint32(12, 46 + filename.length, true);
    end.setUint32(16, 30 + filename.length + body.length, true);
    return new Blob([headerBytes(local), filename, body, headerBytes(central), filename, headerBytes(end)], { type: 'application/zip' });
  }

  function awaitUserSave(blob, filename) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob);
      const link = $('download-link');
      const next = $('continue-btn');
      $('download-name').textContent = filename;
      link.href = url;
      link.download = filename;
      next.disabled = true;
      $('download-panel').style.display = 'block';
      $('download-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      link.onclick = () => { next.disabled = false; setStatus(`请确认 ${filename} 已保存到手机“文件”中。`); };
      next.onclick = () => {
        link.onclick = null;
        next.onclick = null;
        $('download-panel').style.display = 'none';
        URL.revokeObjectURL(url);
        resolve();
      };
    });
  }

  function buildManifest(session) {
    return {
      format: FORMAT,
      createdAt: session.createdAt,
      backupId: session.id,
      database: DB_NAME,
      entry: 'payload.ndjson.fragment',
      encoding: 'UTF-8 JSON Lines; concatenate fragment contents in part order',
      partBytes: session.partBytes,
      storeCounts: session.storeCounts,
      recordsRead: session.finalStats.rows,
      messagesRead: session.finalStats.messages,
      localKeysRead: session.finalStats.localKeys,
      excludedLocalStorageKeys: session.excludedLocalStorageKeys,
      parts: session.parts
    };
  }

  function showManifest(session) {
    const manifest = buildManifest(session);
    const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const manifestLink = $('manifest-link');
    if (manifestLink.dataset.blobUrl) URL.revokeObjectURL(manifestLink.dataset.blobUrl);
    const url = URL.createObjectURL(manifestBlob);
    manifestLink.href = url;
    manifestLink.dataset.blobUrl = url;
    manifestLink.download = `UWU-救援-${session.id}-清单.json`;
    $('manifest-panel').style.display = 'block';
    state.manifest = manifest;
    renderFileList();
  }

  async function runExport(session) {
    if (state.running) return;
    state.running = true;
    state.session = session;
    $('start-btn').disabled = true;
    $('resume-btn').disabled = true;
    $('part-size').disabled = true;
    $('include-secrets').disabled = true;
    setError(null);
    const stats = { store: '', rows: 0, messages: 0, localKeys: 0, totalRows: Object.values(session.storeCounts).reduce((a, b) => a + b, 0) };
    const savedParts = session.parts.slice();
    let partNumber = 0;
    let pieces = [];
    let held = 0;
    let bytesSincePaint = 0;
    try {
      async function flush() {
        if (!held) return;
        const raw = new Uint8Array(held);
        let position = 0;
        for (const piece of pieces) { raw.set(piece, position); position += piece.length; }
        pieces = [];
        held = 0;
        partNumber++;
        $('part-progress').value = 0;
        const rawHash = await sha256(raw);
        if (partNumber <= savedParts.length) {
          if (savedParts[partNumber - 1].rawSha256 !== rawHash) throw new Error(`旧数据与上次备份不一致（第 ${partNumber} 卷）。请开始新备份，不要混用两次的分卷。`);
          setStatus(`已核对上次的第 ${partNumber} 卷，继续读取…`);
          return;
        }
        setStatus(`正在压缩第 ${partNumber} 卷…`);
        await tick();
        const zip = await zipPart(raw);
        const filename = `UWU-救援-${session.id}-${String(partNumber).padStart(3, '0')}.zip`;
        const descriptor = { index: partNumber, filename, rawBytes: raw.length, zipBytes: zip.size, rawSha256: rawHash, sha256: await sha256(zip) };
        setStatus(`第 ${partNumber} 卷已生成，请保存。`);
        await awaitUserSave(zip, filename);
        session.parts.push(descriptor);
        saveCheckpoint(session);
        renderMetrics(stats, session);
      }
      for await (const token of sourceTokens(state.db, session, stats)) {
        const encoded = encoder.encode(token);
        for (let offset = 0; offset < encoded.length;) {
          const length = Math.min(encoded.length - offset, session.partBytes - held);
          pieces.push(encoded.subarray(offset, offset + length));
          held += length;
          offset += length;
          bytesSincePaint += length;
          $('part-progress').value = Math.round(held / session.partBytes * 100);
          if (held === session.partBytes) await flush();
          if (bytesSincePaint >= 262144) { bytesSincePaint = 0; await tick(); }
        }
      }
      await flush();
      if (partNumber !== session.parts.length) throw new Error('分卷数量不一致，备份没有完成。');
      session.finalStats = { rows: stats.rows, messages: stats.messages, localKeys: stats.localKeys };
      session.complete = true;
      saveCheckpoint(session);
      showManifest(session);
      setStatus(`已生成 ${session.parts.length} 卷。请保存清单并将文件选回页面校验。`);
      $('part-progress').value = 100;
      refreshResumeButton();
    } catch (error) {
      setError(error);
      setStatus('导出已停止；旧数据库未修改。');
      refreshResumeButton();
    } finally {
      state.running = false;
      $('start-btn').disabled = false;
      $('resume-btn').disabled = false;
      $('part-size').disabled = false;
      $('include-secrets').disabled = false;
    }
  }

  function renderFileList() {
    const list = $('file-list');
    list.replaceChildren();
    const manifest = state.manifest;
    if (!manifest) return;
    for (const part of manifest.parts) {
      const item = document.createElement('li');
      const status = state.verified.has(part.filename) ? '已校验' : state.files.has(part.filename) ? '等待校验' : '尚未选回';
      item.textContent = `${part.filename} · ${(part.zipBytes / 1048576).toFixed(1)} MiB · ${status}`;
      item.className = state.verified.has(part.filename) ? 'success' : 'warning';
      list.appendChild(item);
    }
    const complete = state.verified.size === manifest.parts.length && state.files.has('manifest');
    $('verify-status').textContent = complete
      ? `全部 ${manifest.parts.length} 卷和清单已核对。请保留这些文件，供新链接的导入功能使用。`
      : `已校验 ${state.verified.size}/${manifest.parts.length} 卷；${state.files.has('manifest') ? '清单已选择' : '还需选择清单'}。`;
    $('verify-status').className = complete ? 'success' : '';
  }

  async function verifySelectedFiles(files) {
    for (const file of files) {
      if (file.name.endsWith('.json')) {
        if (file.size > 1048576) throw new Error('清单文件过大，请选择救援导出生成的清单。');
        const parsed = JSON.parse(await file.text());
        if (parsed.format !== FORMAT || !Array.isArray(parsed.parts)) throw new Error(`${file.name} 不是救援导出清单。`);
        state.manifest = parsed;
        state.files.set('manifest', file);
        state.verified.clear();
      } else if (file.name.endsWith('.zip')) {
        state.files.set(file.name, file);
      }
    }
    const manifest = state.manifest;
    if (!manifest) { $('verify-status').textContent = '已选择分卷，请再选择清单文件。'; return; }
    for (const part of manifest.parts) {
      const file = state.files.get(part.filename);
      if (!file || state.verified.has(part.filename)) continue;
      $('verify-status').textContent = `正在检查 ${part.filename}…`;
      await tick();
      if (file.size !== part.zipBytes || await sha256(file) !== part.sha256) {
        state.files.delete(part.filename);
        throw new Error(`${part.filename} 大小或校验值不符，请重新保存这一卷。`);
      }
      state.verified.add(part.filename);
      renderFileList();
    }
    renderFileList();
  }

  async function init() {
    if (!crypto.subtle) throw new Error('当前环境没有 SHA-256 校验功能，请使用原网页的 HTTPS 地址。');
    state.db = await openExistingDatabase();
    state.db.onversionchange = () => {
      state.db.close();
      setError(new Error('数据库在导出时发生变化，请重新打开救援页。'));
    };
    const counts = await inspectDatabase(state.db);
    state.counts = counts;
    setStatus('检查完成，可以开始备份。');
    refreshResumeButton();
    const completedSession = savedCheckpoint();
    if (completedSession && completedSession.complete && completedSession.finalStats) {
      showManifest(completedSession);
      setStatus('上次备份的清单可重新保存；请检查所有 ZIP 分卷。');
    }
    $('start-btn').onclick = () => {
      if (savedCheckpoint() && !confirm('开始新备份会更换备份编号。请勿把之前保存的分卷与新分卷混用。确定继续吗？')) return;
      state.files.clear();
      state.verified.clear();
      state.manifest = null;
      $('manifest-panel').style.display = 'none';
      const session = {
        format: FORMAT,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        partBytes: Number($('part-size').value),
        includeSecrets: $('include-secrets').checked,
        storeCounts: counts,
        parts: [],
        complete: false,
        excludedLocalStorageKeys: []
      };
      saveCheckpoint(session);
      runExport(session);
    };
    $('resume-btn').onclick = () => {
      const session = savedCheckpoint();
      if (!session || session.complete) return;
      if (JSON.stringify(session.storeCounts) !== JSON.stringify(state.counts)) {
        setError(new Error('数据库记录数量已变化，请开始新备份，不要混用之前的分卷。'));
        return;
      }
      $('part-size').value = String(session.partBytes);
      $('include-secrets').checked = session.includeSecrets;
      runExport(session);
    };
    $('verify-files').onchange = async event => {
      setError(null);
      try { await verifySelectedFiles(Array.from(event.target.files || [])); }
      catch (error) { setError(error); renderFileList(); }
      event.target.value = '';
    };
  }
  init().catch(error => {
    $('db-summary').textContent = '未能读取旧数据库。';
    setStatus('救援页暂时无法开始。');
    setError(error);
  });
})();
