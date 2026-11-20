/**
 * Benchmark of the graph neighbourhood query (LEXAI-2303): the iterative frontier walk of
 * services/graph/neighbourhood.ts against a recursive CTE with a path cycle guard, on given start
 * keys or on companies picked by degree (smallest to largest).
 *
 * Usage:
 *   node dist/scripts/bench-graph.js [--start KEY ...] [--pick 5] [--depths 2,3] [--fanout 50] [--runs 3] [--no-cte] [--no-hub-stop]
 *
 * Output: one JSON line per (start, depth, method) with the median latency and result size;
 * persons are reported by degree only.
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { neighbourhood } from '../services/graph/neighbourhood';

// the same result as the frontier walk (nodes and edge rows), so payload transfer is compared too
const CTE_SQL = `
WITH RECURSIVE walk(node, depth, path, edge) AS (
  SELECT $1::bigint, 0, ARRAY[$1::bigint], NULL::bigint
  UNION ALL
  SELECT x.other, w.depth + 1, w.path || x.other, x.eid
  FROM walk w
  JOIN graph.node n ON n.id = w.node
  CROSS JOIN LATERAL (
    (SELECT e.id AS eid, e.dst AS other FROM graph.edge e WHERE e.src = w.node ORDER BY e.id LIMIT $3)
    UNION ALL
    (SELECT e.id, e.src FROM graph.edge e WHERE e.dst = w.node ORDER BY e.id LIMIT $3)
  ) x
  WHERE w.depth < $2 AND (w.depth = 0 OR NOT n.hub OR NOT $4) AND x.other <> ALL (w.path)
), nn AS (SELECT DISTINCT node FROM walk), ne AS (SELECT DISTINCT edge FROM walk WHERE edge IS NOT NULL)
SELECT (SELECT count(*) FROM walk) AS paths,
       (SELECT json_agg(n) FROM graph.node n JOIN nn ON nn.node = n.id) AS nodes,
       (SELECT json_agg(e) FROM graph.edge e JOIN ne ON ne.edge = e.id) AS edges`;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const argv = process.argv.slice(2);
  const starts: string[] = [];
  let pick = 5, runs = 3, fanout = 50, cte = true, stopAtHubs = true;
  let depths = [2, 3];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') starts.push(argv[++i]);
    else if (a === '--pick') pick = Number(argv[++i]);
    else if (a === '--runs') runs = Number(argv[++i]);
    else if (a === '--fanout') fanout = Number(argv[++i]);
    else if (a === '--depths') depths = argv[++i].split(',').map(Number);
    else if (a === '--no-cte') cte = false;
    else if (a === '--no-hub-stop') stopAtHubs = false;
    else throw new Error(`unknown argument ${a}`);
  }
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5435'),
    user: process.env.POSTGRES_USER || 'openreyestr',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'openreyestr',
    max: 1,
    options: '-c statement_timeout=120s',
  });
  try {
    if (!starts.length) {
      // companies of different sizes: one per degree bucket
      const q = await pool.query(`
        SELECT DISTINCT ON (b) key, degree FROM (
          SELECT key, degree, width_bucket(degree, ARRAY[1, 3, 8, 20, 60, 300]) AS b
          FROM graph.node WHERE kind = 'company' AND degree > 0) x
        ORDER BY b, md5(key) LIMIT ${pick}`);
      for (const row of q.rows) starts.push(String(row.key));
    }
    for (const s of starts) {
      const n = (await pool.query(`SELECT id, degree, hub FROM graph.node WHERE (kind = 'company' AND key = $1) OR 'node:' || id = $1 LIMIT 1`, [s])).rows[0];
      for (const depth of depths) {
        const t: number[] = [];
        let size = { nodes: 0, edges: 0, hubsStopped: 0, fanoutCut: 0 };
        for (let i = 0; i < runs; i++) {
          const t0 = process.hrtime.bigint();
          const res = await neighbourhood(pool, s, { depth, maxFanout: fanout, maxNodes: 100000, stopAtHubs });
          t.push(Number(process.hrtime.bigint() - t0) / 1e6);
          size = { nodes: res.nodes.length, edges: res.edges.length, hubsStopped: res.truncated.hubs.length, fanoutCut: res.truncated.fanout.length };
        }
        console.log(JSON.stringify({ start: s, degree: n?.degree, hub: n?.hub, depth, method: 'frontier', ms: Math.round(median(t)), ...size }));
        if (cte && n) {
          const tc: number[] = [];
          let out: any = {};
          for (let i = 0; i < runs; i++) {
            const t0 = process.hrtime.bigint();
            try {
              out = (await pool.query(CTE_SQL, [n.id, depth, fanout, stopAtHubs])).rows[0];
            } catch (e) {
              out = { error: (e as Error).message };
              break;
            } finally {
              tc.push(Number(process.hrtime.bigint() - t0) / 1e6);
            }
          }
          console.log(JSON.stringify({ start: s, degree: n.degree, depth, method: 'recursive_cte', ms: Math.round(median(tc)), nodes: out.nodes?.length ?? 0, edges: out.edges?.length ?? 0, paths: Number(out.paths), error: out.error }));
        }
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('bench-graph failed:', err);
  process.exit(1);
});
