/**
 * Sync Runner — executes data source syncs via HTTP calls to backend/openreyestr.
 *
 * Backend sources: triggers start_import via /api/tools/start_import
 * OpenReyestr sources: triggers registry sync via /api/admin/sync-registry/:name
 * ECHR sources: triggers ECHR sync via /api/admin/sync-echr
 * Script sources: runs source.command as a child process of this container
 */

import { spawn } from 'child_process';
import http from 'http';
import https from 'https';
import { DataSourceSchedule, ServiceConfig } from './config.js';

export interface SyncResult {
  source: string;
  success: boolean;
  message: string;
  durationMs: number;
  startedAt: string;
}

const syncHistory: SyncResult[] = [];
const MAX_HISTORY = 500;

export function getSyncHistory(): SyncResult[] {
  return syncHistory;
}

export function getLastSync(sourceName: string): SyncResult | undefined {
  for (let i = syncHistory.length - 1; i >= 0; i--) {
    if (syncHistory[i].source === sourceName) return syncHistory[i];
  }
  return undefined;
}

function httpRequest(
  url: string,
  method: string,
  body: string | null,
  headers: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const proto = parsed.protocol === 'https:' ? https : http;
    const req = proto.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Trigger a backend import via the import task system.
 * Calls POST /api/tools/start_import with source_name.
 */
async function triggerBackendImport(
  config: ServiceConfig,
  source: DataSourceSchedule,
): Promise<SyncResult> {
  const start = Date.now();
  const startedAt = new Date().toISOString();

  try {
    // First check if there's already a running import for this source
    const statusRes = await httpRequest(
      `${config.backendUrl}/api/tools/get_import_status`,
      'POST',
      JSON.stringify({ name: 'get_import_status', arguments: { status: 'running' } }),
      { Authorization: `Bearer ${config.backendApiKey}` },
    );

    if (statusRes.statusCode === 200) {
      try {
        const statusData = JSON.parse(statusRes.body);
        const content = statusData?.content?.[0]?.text || statusData?.result || '';
        if (typeof content === 'string' && content.includes(source.sourceName)) {
          return {
            source: source.name,
            success: true,
            message: `Пропущено: імпорт ${source.sourceName} вже виконується`,
            durationMs: Date.now() - start,
            startedAt,
          };
        }
      } catch {
        // Status check failed, proceed with import anyway
      }
    }

    // Trigger the import
    const res = await httpRequest(
      `${config.backendUrl}/api/tools/start_import`,
      'POST',
      JSON.stringify({
        name: 'start_import',
        arguments: { source_name: source.sourceName },
      }),
      { Authorization: `Bearer ${config.backendApiKey}` },
      60_000, // 60s timeout for import trigger
    );

    const success = res.statusCode >= 200 && res.statusCode < 300;
    let message: string;
    try {
      const data = JSON.parse(res.body);
      const raw = data?.content?.[0]?.text || data?.result || data?.message || `HTTP ${res.statusCode}`;
      message = typeof raw === 'string' ? raw : JSON.stringify(raw);
    } catch {
      message = `HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`;
    }

    return {
      source: source.name,
      success,
      message: success ? `Запущено: ${message.slice(0, 200)}` : `Помилка: ${message.slice(0, 200)}`,
      durationMs: Date.now() - start,
      startedAt,
    };
  } catch (error: any) {
    return {
      source: source.name,
      success: false,
      message: `Помилка з'єднання: ${error.message}`,
      durationMs: Date.now() - start,
      startedAt,
    };
  }
}

/**
 * Trigger an OpenReyestr NAIS registry sync.
 * Calls POST /api/admin/sync-registry with registry name.
 * Falls back to POST /api/tools/sync_nais_registries if admin endpoint not available.
 */
async function triggerOpenreyestrSync(
  config: ServiceConfig,
  source: DataSourceSchedule,
): Promise<SyncResult> {
  const start = Date.now();
  const startedAt = new Date().toISOString();

  try {
    // Try the admin sync endpoint
    const res = await httpRequest(
      `${config.openreyestrUrl}/api/admin/sync-registry`,
      'POST',
      JSON.stringify({ registry: source.sourceName }),
      { Authorization: `Bearer ${config.openreyestrApiKey}` },
      300_000, // 5 min timeout — NAIS syncs can be slow
    );

    if (res.statusCode === 404) {
      // Admin endpoint doesn't exist, try MCP tool endpoint
      const toolRes = await httpRequest(
        `${config.openreyestrUrl}/api/tools/sync_nais_registries`,
        'POST',
        JSON.stringify({
          name: 'sync_nais_registries',
          arguments: { registries: source.sourceName },
        }),
        { Authorization: `Bearer ${config.openreyestrApiKey}` },
        300_000,
      );

      const success = toolRes.statusCode >= 200 && toolRes.statusCode < 300;
      return {
        source: source.name,
        success,
        message: success
          ? `NAIS sync triggered via tool: ${source.sourceName}`
          : `HTTP ${toolRes.statusCode}: ${String(toolRes.body).slice(0, 200)}`,
        durationMs: Date.now() - start,
        startedAt,
      };
    }

    const success = res.statusCode >= 200 && res.statusCode < 300;
    return {
      source: source.name,
      success,
      message: success
        ? `NAIS sync OK: ${source.sourceName}`
        : `HTTP ${res.statusCode}: ${String(res.body).slice(0, 200)}`,
      durationMs: Date.now() - start,
      startedAt,
    };
  } catch (error: any) {
    return {
      source: source.name,
      success: false,
      message: `Помилка з'єднання з openreyestr: ${error.message}`,
      durationMs: Date.now() - start,
      startedAt,
    };
  }
}

/**
 * Trigger an ECHR (HUDOC) sync for a specific country.
 * Calls POST /api/admin/sync-echr with country code.
 * This only triggers the sync — it doesn't wait for completion.
 */
async function triggerEchrSync(
  config: ServiceConfig,
  source: DataSourceSchedule,
): Promise<SyncResult> {
  const start = Date.now();
  const startedAt = new Date().toISOString();

  try {
    const res = await httpRequest(
      `${config.backendUrl}/api/admin/sync-echr`,
      'POST',
      JSON.stringify({ country: source.sourceName }),
      { Authorization: `Bearer ${config.backendApiKey}` },
      60_000, // 60s — just triggers, doesn't wait for completion
    );

    const success = res.statusCode >= 200 && res.statusCode < 300;
    let message: string;
    try {
      const data = JSON.parse(res.body);
      const raw = data?.content?.[0]?.text || data?.result || data?.message || `HTTP ${res.statusCode}`;
      message = typeof raw === 'string' ? raw : JSON.stringify(raw);
    } catch {
      message = `HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`;
    }

    return {
      source: source.name,
      success,
      message: success
        ? `ECHR sync запущено: ${source.sourceName} — ${message.slice(0, 200)}`
        : `Помилка ECHR sync: ${message.slice(0, 200)}`,
      durationMs: Date.now() - start,
      startedAt,
    };
  } catch (error: any) {
    return {
      source: source.name,
      success: false,
      message: `Помилка з'єднання з backend (ECHR): ${error.message}`,
      durationMs: Date.now() - start,
      startedAt,
    };
  }
}

const runningScripts = new Set<string>();

/**
 * Run a script source (e.g. a Python loader baked into the image) and wait for it.
 * stdout/stderr go to the container log; the last output line becomes the result message.
 * A run that is still going when the next cron tick fires is not started twice.
 */
async function runScript(source: DataSourceSchedule): Promise<SyncResult> {
  const start = Date.now();
  const startedAt = new Date().toISOString();
  const finish = (success: boolean, message: string): SyncResult => ({
    source: source.name, success, message, durationMs: Date.now() - start, startedAt,
  });

  if (!source.command?.length) return finish(false, 'Не задано command для script-джерела');
  if (runningScripts.has(source.name)) return finish(false, 'Попередній запуск ще триває, пропущено');
  runningScripts.add(source.name);

  try {
    return await new Promise<SyncResult>((resolve) => {
      const [cmd, ...args] = source.command!;
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let lastLine = '';
      const forward = (chunk: Buffer, stream: NodeJS.WriteStream) => {
        const text = chunk.toString();
        stream.write(text.replace(/^(?=.)/gm, `[${source.name}] `));
        const lines = text.trim().split('\n');
        if (lines[lines.length - 1]) lastLine = lines[lines.length - 1];
      };
      child.stdout.on('data', (c: Buffer) => forward(c, process.stdout));
      child.stderr.on('data', (c: Buffer) => forward(c, process.stderr));
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        lastLine = `таймаут ${Math.round((source.timeoutMs ?? 0) / 60000)} хв, процес зупинено`;
      }, source.timeoutMs ?? 4 * 60 * 60 * 1000);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve(finish(false, `Не вдалося запустити ${cmd}: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(finish(code === 0, code === 0
          ? `Скрипт завершено: ${lastLine.slice(0, 200)}`
          : `Скрипт завершився з кодом ${code}: ${lastLine.slice(0, 200)}`));
      });
    });
  } finally {
    runningScripts.delete(source.name);
  }
}

/**
 * Run a single source sync.
 */
export async function runSync(
  config: ServiceConfig,
  source: DataSourceSchedule,
): Promise<SyncResult> {
  console.log(`[SYNC] Запуск: ${source.title} (${source.name})`);

  let result: SyncResult;
  if (source.target === 'backend') {
    result = await triggerBackendImport(config, source);
  } else if (source.target === 'echr') {
    result = await triggerEchrSync(config, source);
  } else if (source.target === 'script') {
    result = await runScript(source);
  } else {
    result = await triggerOpenreyestrSync(config, source);
  }

  // Store in history
  syncHistory.push(result);
  if (syncHistory.length > MAX_HISTORY) {
    syncHistory.splice(0, syncHistory.length - MAX_HISTORY);
  }

  const status = result.success ? 'OK' : 'FAIL';
  console.log(
    `[SYNC] ${status}: ${source.title} — ${result.message} (${result.durationMs}ms)`,
  );

  return result;
}

/**
 * Run all enabled sources (for --run-once mode).
 */
export async function runAllOnce(
  config: ServiceConfig,
  sources: DataSourceSchedule[],
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  // Group by target to avoid overwhelming a single service
  const backendSources = sources.filter((s) => s.target === 'backend' && s.enabled);
  const openreyestrSources = sources.filter((s) => s.target === 'openreyestr' && s.enabled);
  const echrSources = sources.filter((s) => s.target === 'echr' && s.enabled);
  const scriptSources = sources.filter((s) => s.target === 'script' && s.enabled);

  console.log(
    `[SYNC] Разовий запуск: ${backendSources.length} backend + ${openreyestrSources.length} openreyestr + ${echrSources.length} echr джерел`,
  );

  // Run backend sources sequentially (they create background tasks anyway)
  for (const source of backendSources) {
    const result = await runSync(config, source);
    results.push(result);
    // Small delay between triggers
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Run openreyestr sources sequentially (they are resource-heavy)
  for (const source of openreyestrSources) {
    const result = await runSync(config, source);
    results.push(result);
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Run ECHR sources sequentially with longer delay (HUDOC rate limiting)
  for (const source of echrSources) {
    const result = await runSync(config, source);
    results.push(result);
    await new Promise((r) => setTimeout(r, 10_000));
  }

  for (const source of scriptSources) {
    results.push(await runSync(config, source));
  }

  return results;
}
