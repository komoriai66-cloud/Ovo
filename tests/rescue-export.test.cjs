const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'rescue-export.js'), 'utf8');
const testSource = source.replace(
  /  init\(\)\.catch\(error => \{[\s\S]*?\n  \}\);\n\}\)\(\);\s*$/,
  '  globalThis.rescueTest = { zipPart, jsonTokens, envelope, sourceTokens, sha256, crc32 };\n})();'
);
assert.notEqual(testSource, source, 'test utility extraction must match the source');

function loadUtilities(compression) {
  const context = {
    TextEncoder, Blob, Response, Uint8Array, ArrayBuffer, DataView,
    CompressionStream: compression ? CompressionStream : undefined,
    crypto: webcrypto, btoa, File: globalThis.File || class File extends Blob {},
    document: {
      getElementById: () => ({ textContent: '', replaceChildren() {} }),
      createElement: () => ({ className: '', textContent: '' })
    }
  };
  vm.runInNewContext(testSource, context);
  return context.rescueTest;
}

async function collectTokens(iterable) {
  let result = '';
  for await (const token of iterable) result += token;
  return result;
}

async function checkZip(utilities, raw) {
  const blob = await utilities.zipPart(raw);
  const zip = Buffer.from(await blob.arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const method = zip.readUInt16LE(8);
  const crc = zip.readUInt32LE(14);
  const compressedSize = zip.readUInt32LE(18);
  const rawSize = zip.readUInt32LE(22);
  const nameLength = zip.readUInt16LE(26);
  const body = zip.subarray(30 + nameLength, 30 + nameLength + compressedSize);
  const restored = method === 8 ? zlib.inflateRawSync(body) : body;
  assert.deepEqual(restored, Buffer.from(raw));
  assert.equal(rawSize, raw.length);
  assert.equal(crc, utilities.crc32(raw));
  assert.equal(zip.readUInt32LE(30 + nameLength + compressedSize), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  if (process.platform === 'win32') {
    const filename = path.join(os.tmpdir(), `uwu-rescue-zip-test-${process.pid}-${method}.zip`);
    fs.writeFileSync(filename, zip);
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive=[System.IO.Compression.ZipFile]::OpenRead($env:RESCUE_TEST_ZIP); try { if ($archive.Entries.Count -ne 1 -or $archive.Entries[0].FullName -ne "payload.ndjson.fragment") { throw "invalid ZIP entry" } } finally { $archive.Dispose() }'
      ], { env: { ...process.env, RESCUE_TEST_ZIP: filename }, stdio: 'pipe' });
    } finally { fs.unlinkSync(filename); }
  }
  return method;
}

(async () => {
  const compressed = loadUtilities(true);
  const plain = loadUtilities(false);
  assert.equal(await checkZip(compressed, new TextEncoder().encode('聊天记录🎉'.repeat(10000))), 8);
  assert.equal(await checkZip(plain, webcrypto.getRandomValues(new Uint8Array(1024))), 0);

  const huge = '🧡'.repeat(10000) + 'A'.repeat(200000);
  const value = { id: '角色', history: [{ content: huge }], nested: [null, true, 123] };
  const json = await collectTokens(compressed.jsonTokens(value));
  assert.deepEqual(JSON.parse(json), value);
  const row = await collectTokens(compressed.envelope('row', 'characters', '角色', value, undefined, 1));
  assert.equal(JSON.parse(row).historyLength, 1);
  assert.deepEqual(JSON.parse(row).value, value);

  const character = { id: 'c1', name: '测试', history: [{ content: '你好' }, { content: '🧡'.repeat(3000) }] };
  const fakeRequest = result => {
    const request = { result };
    queueMicrotask(() => request.onsuccess());
    return request;
  };
  const fakeDb = {
    objectStoreNames: ['characters'],
    transaction: () => ({ objectStore: () => ({
      getAllKeys: () => fakeRequest(['c1']),
      get: () => fakeRequest(character)
    }) })
  };
  const localStorage = { length: 0, key: () => null, getItem: () => null };
  const sourceContext = {
    TextEncoder, Blob, Response, Uint8Array, ArrayBuffer, DataView,
    CompressionStream, crypto: webcrypto, btoa,
    File: globalThis.File || class File extends Blob {}, localStorage,
    document: {
      getElementById: () => ({ textContent: '', replaceChildren() {} }),
      createElement: () => ({ className: '', textContent: '' })
    },
    setTimeout
  };
  vm.runInNewContext(testSource, sourceContext);
  const stats = { store: '', rows: 0, messages: 0, localKeys: 0, totalRows: 1 };
  const session = { includeSecrets: false, parts: [] };
  const lines = (await collectTokens(sourceContext.rescueTest.sourceTokens(fakeDb, session, stats))).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].kind, 'row');
  assert.equal(lines[0].historyLength, 2);
  assert.equal(lines[0].value.name, '测试');
  assert.equal(lines[1].kind, 'history');
  assert.equal(lines[2].value.content, character.history[1].content);
  assert.equal(stats.messages, 2);
  console.log('rescue export ZIP and chunked JSON checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
