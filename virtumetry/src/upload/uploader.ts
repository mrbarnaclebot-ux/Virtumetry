// R2 PUT adapter: expo-file-system File.upload (background URLSession by default). Never apiFetch: no cookie to R2 (T-04-26).
import { File } from 'expo-file-system';

import type { Uploader } from '@/upload/reconcile';

/** Session-format allowlist: server-supplied paths are checked before any file is opened (T-04-27). */
const SESSION_PATH = /^frames\/\d{6}\.jpg$|^frames\.jsonl$|^session\.json$/;

function sessionFile(dir: string, path: string): File {
  if (!SESSION_PATH.test(path)) throw new Error('upload path not allowed');
  return new File(dir, path);
}

export const uploader: Uploader = {
  async size(scan, path) {
    const f = sessionFile(scan.dir, path);
    if (!f.exists) throw new Error(`missing session file ${path}`);
    return f.size;
  },
  // File.upload RESOLVES on non-2xx: the caller checks the returned status.
  async put(scan, signed, onProgress) {
    const result = await sessionFile(scan.dir, signed.path).upload(signed.url, {
      httpMethod: 'PUT',
      headers: signed.headers,
      onProgress,
    });
    return result.status;
  },
};
