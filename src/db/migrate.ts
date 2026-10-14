import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from './pool.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Aplica, em ordem, os arquivos .sql ainda não registrados em schema_migrations. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274)'); // evita migrações concorrentes
    const exists = await client.query(`SELECT to_regclass('public.schema_migrations') AS t`);
    const done = new Set<string>();
    if (exists.rows[0].t) {
      const r = await client.query('SELECT version FROM schema_migrations');
      r.rows.forEach((row) => done.add(row.version));
    }
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migração ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { createPool } = await import('./pool.js');
  const db = createPool(process.env.DATABASE_URL!);
  const applied = await migrate(db);
  console.log(applied.length ? `Migrações aplicadas: ${applied.join(', ')}` : 'Banco já atualizado.');
  await db.end();
}
