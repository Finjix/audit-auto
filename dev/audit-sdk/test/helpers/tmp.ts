import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made: string[] = [];
process.on('exit', () => { for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use: left to the OS temp cleanup */ } } });

/** A fresh temporary directory that is removed when the test process ends, whether or not the test cleaned up itself. */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
