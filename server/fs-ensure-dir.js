/**
 * mkdir -p without { recursive: true } (feature 058).
 *
 * Node's recursive mkdir spins forever on some pseudo filesystems (seen with a
 * path under /proc), and a boot or an upload must fail with an error, not hang.
 * Creates missing parents one level at a time with the given mode.
 */
const fs = require('node:fs');
const path = require('node:path');

function ensureDir(dir, mode = 0o750) {
  try {
    fs.mkdirSync(dir, { mode });
  } catch (err) {
    if (err.code === 'EEXIST') {
      if (!fs.statSync(dir).isDirectory()) {
        const e = new Error(`ENOTDIR: not a directory, mkdir '${dir}'`);
        e.code = 'ENOTDIR';
        throw e;
      }
      return;
    }
    if (err.code !== 'ENOENT' || path.dirname(dir) === dir) throw err;
    ensureDir(path.dirname(dir), mode);
    try {
      fs.mkdirSync(dir, { mode });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

module.exports = { ensureDir };
