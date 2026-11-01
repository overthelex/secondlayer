/**
 * Runs a compiled import script as a child process for /api/admin/sync-registry
 * (ProZorro, ARMA). One job per name at a time.
 *
 * - The running flag is cleared on 'exit' (normal, or killed by a signal) and
 *   on 'error' (spawn failure, where no 'exit' follows). An 'error' event
 *   without a listener would crash the server.
 * - A missing script (e.g. dev:http runs src/*.ts through tsx) is logged with
 *   its path; the client gets a generic message.
 */
import * as fs from 'fs';
import { spawn as nodeSpawn, ChildProcess, SpawnOptions } from 'child_process';

export interface LaunchLogger {
  info(msg: string, meta?: any): void;
  warn(msg: string, meta?: any): void;
  error(msg: string, meta?: any): void;
}

export interface LaunchResult {
  status: number;
  body: Record<string, unknown>;
}

export interface LaunchSpec {
  /** Job key and log prefix, e.g. "arma". */
  name: string;
  /** Ukrainian display name for messages, e.g. "АРМА". */
  title: string;
  scriptPath: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export class ImportLauncher {
  private readonly running = new Map<string, ChildProcess>();

  constructor(
    private readonly logger: LaunchLogger,
    private readonly spawnFn: SpawnFn = nodeSpawn,
    private readonly exists: (p: string) => boolean = fs.existsSync,
  ) {}

  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  launch(spec: LaunchSpec, registry: string): LaunchResult {
    const current = this.running.get(spec.name);
    if (current) {
      return { status: 409, body: { error: `Імпорт ${spec.title} вже виконується`, pid: current.pid } };
    }
    if (!this.exists(spec.scriptPath)) {
      this.logger.error(`Import script not found for ${spec.name}`, { scriptPath: spec.scriptPath });
      return { status: 500, body: { error: `Імпорт ${spec.title} недоступний на цьому сервері` } };
    }

    let child: ChildProcess;
    try {
      child = this.spawnFn(process.execPath, [spec.scriptPath, ...(spec.args || [])], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spec.env || process.env,
      });
    } catch (err) {
      this.logger.error(`Import spawn failed for ${spec.name}`, { error: (err as Error).message });
      return { status: 500, body: { error: `Не вдалося запустити імпорт ${spec.title}` } };
    }

    this.running.set(spec.name, child);
    const clear = () => {
      if (this.running.get(spec.name) === child) this.running.delete(spec.name);
    };
    child.stdout?.on('data', (d: Buffer) => this.logger.info(`[${spec.name}] ${d.toString().trimEnd()}`));
    child.stderr?.on('data', (d: Buffer) => this.logger.warn(`[${spec.name}] ${d.toString().trimEnd()}`));
    child.on('error', (err) => {
      this.logger.error(`Import process error for ${spec.name}`, { error: err.message });
      clear();
    });
    child.on('exit', (code, signal) => {
      if (code === 0) this.logger.info(`Import finished for ${spec.name}`, { code, signal });
      else this.logger.warn(`Import failed for ${spec.name}`, { code, signal });
      clear();
    });
    return {
      status: 202,
      body: { status: 'accepted', message: `Імпорт ${spec.title} запущено`, registry, pid: child.pid },
    };
  }
}
