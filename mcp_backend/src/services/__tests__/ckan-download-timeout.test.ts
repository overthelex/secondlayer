/**
 * LEXAI-2183 follow-up: НАЗК's getAllData sends its first byte after ~163 s, the importer
 * gave up after 60 s of silence. source_config.download_timeout_ms makes that per source.
 * The slow-server tests go through the real httpGetStream against a local HTTP server.
 */
import http from 'http';
import { AddressInfo } from 'net';
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_TIMEOUT_MS, resolveDownloadTimeoutMs,
} from '../ckan-multifile-import';
import { ImportTaskService } from '../import-task-service';

describe('resolveDownloadTimeoutMs', () => {
  it('keeps the 60 s default when the source does not set it', () => {
    expect(resolveDownloadTimeoutMs(undefined)).toBe(60_000);
    expect(resolveDownloadTimeoutMs(null)).toBe(DEFAULT_DOWNLOAD_TIMEOUT_MS);
  });

  it('accepts whole milliseconds in range, also as a numeric string', () => {
    expect(resolveDownloadTimeoutMs(600_000)).toBe(600_000);
    expect(resolveDownloadTimeoutMs('600000')).toBe(600_000);
    expect(resolveDownloadTimeoutMs(MAX_DOWNLOAD_TIMEOUT_MS)).toBe(30 * 60_000);
  });

  it('rejects values that are not a sane timeout', () => {
    for (const bad of [0, 999, -5, 1.5, MAX_DOWNLOAD_TIMEOUT_MS + 1, '10m', '', NaN, {}, true]) {
      expect(() => resolveDownloadTimeoutMs(bad)).toThrow(/download_timeout_ms/);
    }
  });
});

// ---------------------------------------------------------------------------------------

class FakeDb {
  txQueries: string[] = [];
  staging = 0;
  async query(sql: string, params: any[] = []) {
    const m = sql.match(/^INSERT INTO \S+__staging_\d+ \(([^)]*)\) VALUES/);
    if (m) { this.staging += params.length / m[1].split(',').length; return { rows: [], rowCount: 0 }; }
    if (/SELECT count\(\*\) AS n FROM \S+__staging/.test(sql)) return { rows: [{ n: String(this.staging) }] };
    if (/SELECT count\(\*\) AS n FROM opendata_/.test(sql)) return { rows: [{ n: '2' }] };
    if (/max\(started_at\)/.test(sql)) return { rows: [{ at: null }] };
    return { rows: [], rowCount: 0 };
  }
  async transaction(cb: (c: any) => Promise<any>) {
    return cb({ query: async (sql: string) => { this.txQueries.push(sql); return /count\(/.test(sql) ? this.query(sql) : { rows: [], rowCount: 1 }; } });
  }
}

const records = JSON.stringify([
  { id: 568240, punishmentType: { name: 'Указ' }, indLastNameOnOffenseMoment: 'Замотін' },
  { id: 80969, punishmentType: { name: 'Судове рішення' }, indLastNameOnOffenseMoment: 'Горечий' },
]);

/** Answers like corruptinfo.nazk.gov.ua: headers and body only after `delayMs`. */
function slowServer(delayMs: number): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((_req, res) => {
    hits++;
    const t = setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(records); }, delayMs);
    timers.add(t);
    res.on('close', () => clearTimeout(t));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    resolve({
      url: `http://127.0.0.1:${port}/ep/1.0/corrupt/getAllData`,
      hits: () => hits,
      close: () => new Promise<void>(r => { timers.forEach(clearTimeout); server.closeAllConnections?.(); server.close(() => r()); }),
    });
  }));
}

function nazkSource(apiUrl: string, extra: Record<string, any> = {}) {
  return {
    id: 7, name: 'nazk_corruption_offenders', title: 'НАЗК', source_type: 'json_array', source_url: 'https://data.gov.ua/dataset/560e',
    target_table: 'opendata_corruption_offenders', upsert_sql: null, default_threads_per_ip: 1, rate_limit_ms: 0, enabled: true,
    source_config: {
      format: 'json', ckan_package: '560e', resource_format: 'API', resource_pattern: '^getAllData$', min_files: 1,
      replace: true, min_rows_ratio: 0.9, skip_unchanged: false,
      mapping: { source_id: 'id', punishment_type: 'punishmentType.name', last_name: 'indLastNameOnOffenseMoment' },
      ...extra,
    },
    _apiUrl: apiUrl,
  };
}

function service(db: FakeDb, apiUrl: string) {
  const svc = new ImportTaskService(db as any) as any;
  svc.fetchJson = jest.fn(async () => ({ success: true, result: { resources: [
    { id: 'api', name: 'Відкритий API (getAllData)', format: 'API', last_modified: null, created: '2021-05-06T11:16:48', url: apiUrl },
  ] } }));
  svc.sleep = jest.fn(async () => {});
  return svc;
}

describe('download timeout per source (real HTTP, slow first byte)', () => {
  jest.setTimeout(30_000);

  it('a source with download_timeout_ms longer than the silence loads', async () => {
    const srv = await slowServer(1_500);
    try {
      const db = new FakeDb();
      const svc = service(db, srv.url);
      const stream = jest.spyOn(svc, 'httpGetStream');
      await svc.runCkanMultiFileImport(1, nazkSource(srv.url, { download_timeout_ms: 5_000 }), new AbortController().signal);
      expect(stream.mock.calls[0][2]).toBe(5_000);
      expect(srv.hits()).toBe(1);
      expect(db.staging).toBe(2);
      expect(db.txQueries.some(q => /^DELETE FROM opendata_corruption_offenders$/.test(q))).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('the same silence beyond the timeout fails each attempt with a clear message, table untouched', async () => {
    const srv = await slowServer(2_500);
    try {
      const db = new FakeDb();
      const svc = service(db, srv.url);
      await expect(svc.runCkanMultiFileImport(1, nazkSource(srv.url, { download_timeout_ms: 1_000 }), new AbortController().signal))
        .rejects.toThrow('Відкритий API (getAllData): Request timeout (no data for 1 s)');
      expect(srv.hits()).toBe(3); // retried, as for any network failure
      expect(db.txQueries).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it('without the setting the 60 s default is used', async () => {
    const db = new FakeDb();
    const svc = service(db, 'https://corruptinfo.nazk.gov.ua/ep/1.0/corrupt/getAllData');
    const { Readable } = await import('stream');
    svc.httpGetStream = jest.fn(async () => Readable.from([Buffer.from(records)]));
    await svc.runCkanMultiFileImport(1, nazkSource(''), new AbortController().signal);
    expect(svc.httpGetStream.mock.calls[0][2]).toBe(60_000);
  });

  it('an invalid setting fails before package_show or any download', async () => {
    const db = new FakeDb();
    const svc = service(db, 'https://corruptinfo.nazk.gov.ua/ep/1.0/corrupt/getAllData');
    svc.httpGetStream = jest.fn();
    await expect(svc.runCkanMultiFileImport(1, nazkSource('', { download_timeout_ms: '10m' }), new AbortController().signal))
      .rejects.toThrow(/download_timeout_ms/);
    expect(svc.fetchJson).not.toHaveBeenCalled();
    expect(svc.httpGetStream).not.toHaveBeenCalled();
  });
});
