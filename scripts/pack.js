// scripts/pack.js — Bundle a publishable .zip of this framework.
//
// Usage:   node scripts/pack.js <rootDir> <outputZip>
// Example: node scripts/pack.js . novel-tts-reader.zip
//
// Missing files are SKIPPED with a warning (not an error). This is so the
// same script works for both:
//   - The public framework build (no site-specific adapters)
//   - A private build that drops in additional adapters like adapter-sudugu.js
//
// Zip format: STORE (no compression). Just enough to produce a Chrome
// "Load unpacked"-compatible archive.

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '.');
const out = path.resolve(process.argv[3] || './out.zip');

const include = [
  'manifest.json',
  'content.js',
  'background.js',
  'popup.html',
  'popup.js',
  'lib/Readability.js',
  'extractors/_utils.js',
  'extractors/adapter-default.js',
  'extractors/adapter-sudugu.js',   // optional — only present in private builds
  'extractors/adapter-template.js',
  'extractors/index.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'README.md',
  'LICENSE',
  '.gitignore',
];

function crc32(buf) {
  let c;
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crc32.table[n] = c >>> 0;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

const localHeaders = [];
const fileBuffers = [];
let offset = 0;

for (const rel of include) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    console.warn('SKIP (not found):', rel);
    continue;
  }
  const data = fs.readFileSync(abs);
  const name = Buffer.from(rel.replace(/\\/g, '/'), 'utf8');
  const crc = crc32(data);
  const size = data.length;

  const lh = Buffer.alloc(30 + name.length);
  lh.writeUInt32LE(0x04034b50, 0);     // local file header signature
  lh.writeUInt16LE(20, 4);              // version needed
  lh.writeUInt16LE(0, 6);               // flags
  lh.writeUInt16LE(0, 8);               // method = stored
  lh.writeUInt16LE(0, 10);              // mod time
  lh.writeUInt16LE(0x21, 12);           // mod date
  lh.writeUInt32LE(crc, 14);            // crc
  lh.writeUInt32LE(size, 18);           // compressed size
  lh.writeUInt32LE(size, 22);           // uncompressed size
  lh.writeUInt16LE(name.length, 26);    // filename length
  lh.writeUInt16LE(0, 28);              // extra length
  name.copy(lh, 30);
  fileBuffers.push(lh, data);
  localHeaders.push({ name: rel, crc, size, offset });
  offset += lh.length + data.length;
  console.log('  +', rel, size, 'bytes');
}

let cdSize = 0;
for (const f of localHeaders) {
  const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
  const ch = Buffer.alloc(46 + name.length);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8);
  ch.writeUInt16LE(0, 10);
  ch.writeUInt16LE(0, 12);
  ch.writeUInt16LE(0x21, 14);
  ch.writeUInt32LE(f.crc, 16);
  ch.writeUInt32LE(f.size, 20);
  ch.writeUInt32LE(f.size, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt16LE(0, 30);
  ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34);
  ch.writeUInt16LE(0, 36);
  ch.writeUInt32LE(0, 38);
  ch.writeUInt32LE(f.offset, 42);
  name.copy(ch, 46);
  fileBuffers.push(ch);
  cdSize += ch.length;
}

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(localHeaders.length, 8);
eocd.writeUInt16LE(localHeaders.length, 10);
eocd.writeUInt32LE(cdSize, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);
fileBuffers.push(eocd);

fs.writeFileSync(out, Buffer.concat(fileBuffers));
console.log('OK:', out, fs.statSync(out).size, 'bytes');
