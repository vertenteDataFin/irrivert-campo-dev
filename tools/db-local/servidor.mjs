// Postgres local para desenvolvimento sem Docker.
// PGlite + PostGIS, servindo o protocolo do Postgres em 127.0.0.1:5433.
// Os dados ficam em tools/db-local/dados (ignorado pelo git). Para começar do zero, apague a pasta.
//
//   npm start --prefix tools/db-local
//   DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const porta = Number(process.env.DB_PORT ?? 5433);
const dados = process.env.DB_DIR ?? join(aqui, 'dados');

const db = await PGlite.create({ dataDir: dados, extensions: { postgis } });
await db.exec('CREATE EXTENSION IF NOT EXISTS postgis;');
const v = await db.query('SELECT postgis_version() AS v');
console.log(`PGlite pronto em ${dados} · PostGIS ${v.rows[0].v}`);

// maxConnections > 1: o pool da API abre várias conexões ao mesmo tempo (o servidor multiplexa sobre a conexão única do PGlite)
const servidor = new PGLiteSocketServer({ db, port: porta, host: '127.0.0.1', maxConnections: 10 });
await servidor.start();
console.log(`Postgres local ouvindo em postgres://postgres@127.0.0.1:${porta}/postgres`);

const parar = async () => {
  await servidor.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', parar);
process.on('SIGTERM', parar);
