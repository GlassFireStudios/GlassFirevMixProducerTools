// Atomic file write: write to a temp file, then rename over the target.
//
// rename() is atomic on POSIX and (via libuv's MOVEFILE_REPLACE_EXISTING) on
// Windows too — but on Windows antivirus/indexers can briefly lock the freshly
// written temp file, making the rename fail with EPERM/EACCES/EBUSY. Retry a few
// times so a transient lock doesn't lose a write.

import { promises as fs } from 'fs';

export async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) break;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => {});
  throw lastErr;
}
