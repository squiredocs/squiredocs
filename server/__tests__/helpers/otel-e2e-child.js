/**
 * Child-process fixture for the genuine HTTP→PG→Redis auto-instrumentation e2e
 * (feature 014, FR-002/003/023). Spawned by telemetry-traces.test.js.
 *
 * The jest worker pre-loads `http`/`pg` before a test module can run, which
 * defeats OTel's require-hook auto-instrumentation. This fixture reproduces the
 * REAL server boot order — telemetry.start() BEFORE any target module loads — so
 * the require-hooks patch http/express/pg/ioredis, then it drives one request
 * through PG + Redis and writes the resulting span summaries to the file path in
 * argv[2] for the parent test to assert on.
 *
 * Not a *.test.js file, so jest never runs it directly.
 */
const fs = require('fs');
const { InMemorySpanExporter } = require('@opentelemetry/sdk-trace-base');

const outPath = process.argv[2];
const exporter = new InMemorySpanExporter();

const telemetry = require('../../telemetry');
telemetry.start({ spanExporter: exporter });

// Required AFTER start() so the require-hook auto-instrumentation patches them.
const express = require('express');
const http = require('http');
const { Pool } = require('pg');
const Redis = require('ioredis');

function fail(err) {
  try {
    fs.writeFileSync(outPath, JSON.stringify({ error: String((err && err.stack) || err) }));
  } catch {
    /* ignore */
  }
  process.exit(1);
}

process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost' });
  const app = express();
  app.get('/api/docs/:docId', async (req, res) => {
    await pool.query('SELECT 1 AS ok');
    await redis.get(`otel-e2e:${req.params.docId}`);
    res.json({ ok: true });
  });

  const server = app.listen(0, () => {
    const port = server.address().port;
    http
      .get(`http://127.0.0.1:${port}/api/docs/doc-abc-123?secret=SENTINEL_QUERY`, (r) => {
        r.resume();
        r.on('end', async () => {
          await new Promise((res) => setTimeout(res, 100));
          const spans = exporter.getFinishedSpans().map((s) => ({
            name: s.name,
            kind: s.kind,
            traceId: s.spanContext().traceId,
            attributes: s.attributes,
          }));
          fs.writeFileSync(outPath, JSON.stringify({ spans }));
          try {
            await server.close();
            await pool.end();
            await redis.quit();
            await telemetry.shutdown();
          } catch {
            /* ignore */
          }
          process.exit(0);
        });
      })
      .on('error', fail);
  });
})().catch(fail);
