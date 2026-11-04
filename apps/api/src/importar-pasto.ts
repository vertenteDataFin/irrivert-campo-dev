/**
 * Importa o mapa real da Fazenda Vertente (exportado do Pasto 6.0): limites, pivôs, parcelas (piquetes
 * dos pivôs), pastos de sequeiro e cultivares. Substitui os pivôs/parcelas de EXEMPLO; mantém usuários e clima.
 * Uso: docker compose run --rm -T api npx tsx src/importar-pasto.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aplicarSchema, hoje, pool } from './db';
import { fasesPadrao, padraoPorGenero, soloDaParcela } from './padroes';

interface Dados {
  fazenda: { nome: string; municipio: string; estado: string; proprietario: string };
  cultivares: { nome: string; cientifico: string | null }[];
  limites: { nome: string; geom: object }[];
  piquetes: { area: string; tipo: 'pivo' | 'sequeiro'; nome: string; especie: string | null; geom: object }[];
}

const aqui = dirname(fileURLToPath(import.meta.url));
const dados: Dados = JSON.parse(readFileSync(join(aqui, '..', 'dados', 'vertente-mapa.json'), 'utf8'));

await aplicarSchema();
const cli = await pool.connect();
try {
  await cli.query('BEGIN');
  const fazId: number = (await cli.query(`SELECT id FROM fazenda ORDER BY id LIMIT 1`)).rows[0].id;

  await cli.query(`DELETE FROM pivo WHERE fazenda_id = $1`, [fazId]); // cascata: parcelas, balanço, lançamentos
  await cli.query(`DELETE FROM pasto WHERE fazenda_id = $1`, [fazId]);
  await cli.query(`DELETE FROM limite_fazenda WHERE fazenda_id = $1`, [fazId]);

  // Polígonos vindos do Pasto podem ter autointerseção: repara e mantém só áreas (tipo 3).
  const geo = (g: object) =>
    `ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(g).replace(/'/g, "''")}'), 4326)), 3)`;

  for (const l of dados.limites) {
    await cli.query(`INSERT INTO limite_fazenda (fazenda_id, nome, geom) VALUES ($1, $2, ${geo(l.geom)})`, [fazId, l.nome]);
  }

  // Cultivares: não sobrescreve parâmetros já editados pelo agrônomo.
  const culturaPorNome = new Map<string, { id: number; raiz: number; p: number }>();
  let novas = 0;
  for (const c of dados.cultivares) {
    const pad = padraoPorGenero(c.cientifico, c.nome);
    const r = await cli.query(
      `INSERT INTO cultura (nome, nome_cientifico, tipo, prof_raiz_mm, fracao_agua_disponivel_p, parametros_confirmados)
       VALUES ($1, $2, 'forrageira', $3, $4, false)
       ON CONFLICT (nome) DO UPDATE SET nome_cientifico = EXCLUDED.nome_cientifico, tipo = 'forrageira'
       RETURNING id, prof_raiz_mm, fracao_agua_disponivel_p, (xmax = 0) AS nova`,
      [c.nome, c.cientifico, pad.raizMm, pad.p],
    );
    const row = r.rows[0];
    if (row.nova) {
      novas++;
      for (const [i, f] of fasesPadrao(pad.kcMedio).entries()) {
        await cli.query(`INSERT INTO cultura_fase (cultura_id, ordem, fase, kc, duracao_dias) VALUES ($1,$2,$3,$4,$5)`, [row.id, i + 1, f.fase, f.kc, f.duracao_dias]);
      }
    }
    culturaPorNome.set(c.nome, { id: row.id, raiz: Number(row.prof_raiz_mm), p: Number(row.fracao_agua_disponivel_p) });
  }

  // Pivôs e parcelas
  const hojeStr = hoje();
  const porPivo = new Map<string, Dados['piquetes']>();
  for (const q of dados.piquetes.filter((x) => x.tipo === 'pivo')) porPivo.set(q.area, [...(porPivo.get(q.area) ?? []), q]);
  let nParcelas = 0;
  for (const [nomePivo, piquetes] of [...porPivo.entries()].sort()) {
    const pivoId: number = (
      await cli.query(
        `INSERT INTO pivo (fazenda_id, nome, area_ha, lamina_volta_100_mm, horas_volta_100, eficiencia, parametros_confirmados)
         VALUES ($1, $2, 0, 9, 18, 0.85, false) RETURNING id`,
        [fazId, nomePivo],
      )
    ).rows[0].id;
    for (const q of piquetes) {
      const cult = (q.especie && culturaPorNome.get(q.especie)) || [...culturaPorNome.values()][0];
      const solo = soloDaParcela(cult.raiz, cult.p, 1.2);
      await cli.query(
        `INSERT INTO parcela (pivo_id, cultura_id, nome, area_ha, cap_campo_mm, lamina_seguranca_mm, data_inicial, lamina_inicial_mm, geom)
         VALUES ($1, $2, $3, ROUND((ST_Area(${geo(q.geom)}::geography) / 10000)::numeric, 2), $4, $5, $6, $7, ${geo(q.geom)})`,
        [pivoId, cult.id, q.nome, solo.cap, solo.limite, hojeStr, Math.round(solo.cap * 0.8 * 10) / 10],
      );
      nParcelas++;
    }
    await cli.query(
      `UPDATE pivo SET geom = (SELECT ST_Multi(ST_UnaryUnion(ST_Collect(geom))) FROM parcela WHERE pivo_id = $1),
                       area_ha = (SELECT sum(area_ha) FROM parcela WHERE pivo_id = $1) WHERE id = $1`,
      [pivoId],
    );
  }

  // Pastos de sequeiro (camada de mapa)
  let nPastos = 0;
  for (const q of dados.piquetes.filter((x) => x.tipo === 'sequeiro')) {
    const cult = q.especie ? culturaPorNome.get(q.especie) : undefined;
    await cli.query(
      `INSERT INTO pasto (fazenda_id, grupo, nome, cultura_id, area_ha, geom)
       VALUES ($1, $2, $3, $4, ROUND((ST_Area(${geo(q.geom)}::geography) / 10000)::numeric, 2), ${geo(q.geom)})`,
      [fazId, q.area, q.nome, cult?.id ?? null],
    );
    nPastos++;
  }

  // Fazenda: identificação e posição reais (centro dos limites); altitude estimada p/ Água Clara.
  await cli.query(
    `UPDATE fazenda SET nome = $2, cidade = 'Água Clara', uf = 'MS', responsavel = $3, altitude_m = 330,
            geom = (SELECT ST_Centroid(ST_Collect(geom)) FROM limite_fazenda WHERE fazenda_id = $1) WHERE id = $1`,
    [fazId, dados.fazenda.nome, dados.fazenda.proprietario],
  );
  await cli.query(`UPDATE estacao SET geom = (SELECT geom FROM fazenda WHERE id = $1), altitude_m = 330 WHERE fazenda_id = $1`, [fazId]);

  await cli.query('COMMIT');
  console.log(`[importar] ${dados.limites.length} limites, ${porPivo.size} pivôs, ${nParcelas} parcelas, ${nPastos} pastos, ${dados.cultivares.length} cultivares (${novas} novas)`);
} catch (e) {
  await cli.query('ROLLBACK');
  throw e;
} finally {
  cli.release();
  await pool.end();
}
