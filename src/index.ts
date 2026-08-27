/**
 * ip-prism — multi-source IP geolocation edge service.
 *
 * Sources:
 *   - cz88   : offline qqwry.dat (loaded from R2), IPv4, China-strong
 *   - ipinfo : online, global coverage + ASN + coordinates
 *   - amap   : online, mainland-China refinement (province/city/adcode)
 *
 * Endpoints:
 *   GET  /v1/lookup?ip=1.2.3.4   single IP
 *   POST /v1/lookup {ips:[...]}  batch (≤ MAX_BATCH)
 *   GET  /healthz                liveness (no auth — version only)
 *   POST /v1/admin/refresh       re-pull dat from mirrors on demand
 *
 * All endpoints except /healthz require `X-API-Key`.
 *
 * @module index
 */

import type { Env } from './types';
import { verifyApiKey } from './auth';
import { handleBatch, handleSingle, json } from './router';
import { runUpdate } from './updater';

const VERSION = '0.1.0';

export default {
  /** HTTP entrypoint. */
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Liveness — no auth, leaks nothing but the version string
    if (path === '/healthz') {
      return json({ ok: true, version: VERSION });
    }

    // Everything else sits behind X-API-Key
    const authFailure = verifyApiKey(request, env.API_KEY ?? '');
    if (authFailure) return authFailure;

    try {
      if (path === '/v1/lookup' && request.method === 'GET') {
        return await handleSingle(url, env);
      }
      if (path === '/v1/lookup' && request.method === 'POST') {
        return await handleBatch(request, env);
      }
      if (path === '/v1/admin/refresh' && request.method === 'POST') {
        const status = await runUpdate(env);
        return json({ ok: status !== 'failed', status });
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error(`[fetch] ${path}: ${String(err)}`);
      return json({ error: 'internal error' }, 500);
    }
  },

  /** Cron entrypoint — daily data refresh. */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runUpdate(env).then((status) => console.log(`[cron] update: ${status}`)),
    );
  },
};
