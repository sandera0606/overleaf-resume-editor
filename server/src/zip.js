/**
 * Minimal ZIP reader for Overleaf's /download/zip response.
 *
 * Overleaf produces small, plain zips (stored or deflated, no encryption, no
 * zip64), so a full library would be overkill. We read the central directory
 * rather than scanning local headers, which is the only reliable way to get
 * accurate sizes.
 */

const zlib = require('node:zlib');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function findEocd(buf) {
  // EOCD is at the end, but a trailing comment can push it back up to 64KB.
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * @param {Buffer} buf raw zip bytes
 * @returns {Array<{name: string, content: Buffer}>}
 */
function readZip(buf) {
  const eocd = findEocd(buf);
  if (eocd === -1) throw new Error('Not a valid zip file (no end-of-central-directory record).');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // central directory offset
  const files = [];

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(ptr) !== CD_SIG) {
      throw new Error(`Corrupt zip: expected central directory entry ${i + 1}.`);
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry

    // The local header's extra field length can differ from the central one,
    // so re-read it here to locate the data correctly.
    if (buf.readUInt32LE(localOffset) !== LFH_SIG) {
      throw new Error(`Corrupt zip: bad local header for "${name}".`);
    }
    const lfhNameLen = buf.readUInt16LE(localOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let content;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported compression method ${method} for "${name}".`);

    files.push({ name, content });
  }

  return files;
}

/** Extract just the .tex files, as UTF-8 strings, sorted by path. */
function readTexFiles(buf) {
  return readZip(buf)
    .filter((f) => f.name.toLowerCase().endsWith('.tex'))
    .map((f) => ({ name: f.name, source: f.content.toString('utf8') }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { readZip, readTexFiles };
