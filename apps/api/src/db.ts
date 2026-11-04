import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// DATE do Postgres como string 'YYYY-MM-DD' (sem fuso) e NUMERIC como number.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => (v == null ? v : parseFloat(v)));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://irrigacao:irrigacao@localhost:5432/irrigacao',
});

export async function esperarBanco(tentativas = 40): Promise<void> {
  for (let i = 0; i < tentativas; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error('Banco de dados indisponível');
}

export async function aplicarSchema(): Promise<void> {
  const aqui = dirname(fileURLToPath(import.meta.url));
  await pool.query(readFileSync(join(aqui, 'schema.sql'), 'utf8'));
}

/** Data de hoje no fuso da fazenda (YYYY-MM-DD). */
export function hoje(): string {
  const tz = process.env.TZ ?? 'America/Campo_Grande';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}
