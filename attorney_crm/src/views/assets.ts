import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';

const STATIC_DIR = path.join(__dirname, '..', '..', 'static');
const cache = new Map<string, string>();

/**
 * `/static/<name>?v=<content hash>`: the hash changes whenever the file does, so
 * a browser or the Cloudflare edge that cached the previous version (we send
 * max-age=1d) fetches the new one on the first page load after a deploy.
 */
export function assetUrl(name: string): string {
  let url = cache.get(name);
  if (!url) {
    const hash = createHash('sha256').update(readFileSync(path.join(STATIC_DIR, name))).digest('hex').slice(0, 10);
    url = `/static/${name}?v=${hash}`;
    cache.set(name, url);
  }
  return url;
}
