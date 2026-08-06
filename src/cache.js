/**
 * HiveLogic Desktop — offline read cache.
 * Every successful GET to app/data hosts is written to disk.
 * When the network fails, the last good copy is served instead.
 */
const { createHash } = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_BODY_BYTES = 25 * 1024 * 1024; // don't cache bodies over 25 MB
const META_SUFFIX = '.meta.json';
const BODY_SUFFIX = '.body.bin';

class OfflineCache {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  _key(url) {
    return createHash('sha256').update(url).digest('hex');
  }

  async put(url, status, headers, bodyBuffer) {
    if (bodyBuffer.byteLength > MAX_BODY_BYTES) return;
    const key = this._key(url);
    const meta = {
      url,
      status,
      headers,
      storedAt: new Date().toISOString(),
      bytes: bodyBuffer.byteLength,
    };
    try {
      await fsp.writeFile(path.join(this.dir, key + BODY_SUFFIX), Buffer.from(bodyBuffer));
      await fsp.writeFile(path.join(this.dir, key + META_SUFFIX), JSON.stringify(meta));
    } catch (_) {
      // cache writes are best-effort; never break live traffic
    }
  }

  async get(url) {
    const key = this._key(url);
    try {
      const metaRaw = await fsp.readFile(path.join(this.dir, key + META_SUFFIX), 'utf8');
      const meta = JSON.parse(metaRaw);
      const body = await fsp.readFile(path.join(this.dir, key + BODY_SUFFIX));
      return { meta, body };
    } catch (_) {
      return null;
    }
  }

  /** Rough total size, for a future settings screen. */
  async stats() {
    let files = 0;
    let bytes = 0;
    try {
      for (const f of await fsp.readdir(this.dir)) {
        const st = await fsp.stat(path.join(this.dir, f));
        files++;
        bytes += st.size;
      }
    } catch (_) {}
    return { files, bytes };
  }
}

module.exports = { OfflineCache, MAX_BODY_BYTES };
