import fs from 'node:fs';
import os from 'node:os';
import { restClient } from '../packages/guard/src/index';

// Reads CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN from the environment, or
// from the file named in CF_ENV_FILE (KEY=value lines). Never printed.
export function client() {
  const file = process.env.CF_ENV_FILE || `${os.homedir()}/.config/cloudflare/api.env`;
  const env: Record<string, string> = { ...process.env } as any;
  if (!env.CLOUDFLARE_API_TOKEN && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=["']?([^"'\n]*)["']?/);
      if (m) env[m[1]] = m[2];
    }
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN missing');
  return restClient(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
}
