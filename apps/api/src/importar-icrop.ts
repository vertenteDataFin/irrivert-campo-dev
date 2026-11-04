/**
 * Importa para o banco os dados copiados do iCrop Vision em 23/10/2026 (apps/api/dados/icrop/*.json):
 * equipamentos (hidráulica), parcelas (cultura, solo, plantio, setor, polígono) e o balanço diário calculado
 * pelo iCrop (Kc, fase, raiz, CC, PMP, CTA, CRA, ETo, ETc, irrigação, chuva...). Grava nas tabelas icrop_*;
 * liga o equipamento ao pivô e a parcela ao piquete pela sobreposição das áreas (a numeração do iCrop não é a do mapa).
 *
 * Com --aplicar, depois de importar, leva os parâmetros para os cadastros do IRRIVERT (regras em icrop-parametros.ts):
 *  - cultivares do iCrop (Mombaça 3, Amendoim IAC 677/503, Preparo) com Kc e profundidade de manejo por fase;
 *  - pivôs ligados: vazão, volta a 100 %, lâmina da volta e eficiência do iCrop;
 *  - piquetes cobertos por uma parcela do iCrop: cultivar, plantio, água do solo, capacidade, limite e a lâmina
 *    do fim de 22/10 como ponto de partida do balanço (no lugar dos 80 % assumidos).
 * Cada mudança fica em icrop_aplicacao (antes/depois). Com --simular faz tudo, mostra o resumo e desfaz.
 * Uso: docker compose run --rm -T api npx tsx src/importar-icrop.ts [--simular | --aplicar]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aplicarSchema, pool } from './db';
import { culturaIcrop, CULTURAS_ICROP, hidraulicaIcrop, planoParcela, type DiaBalancoIcrop } from './icrop-parametros';

const simular = process.argv.includes('--simular');
const aplicar = simular || process.argv.includes('--aplicar');

const aqui = dirname(fileURLToPath(import.meta.url));
const pasta = join(aqui, '..', 'dados', 'icrop');
const ler = <T>(nome: string): T => JSON.parse(readFileSync(join(pasta, nome), 'utf8'));

/** "4,71" -> 4.71; "1.234,5" -> 1234.5; "" -> null */
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
/** "23/10/2026" -> "2026-10-23" */
const data = (v: unknown): string | null => {
  const m = String(v ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const numeroDoPivo = (nome: string): number | null => {
  const m = nome.match(/piv[oô]\s*0*(\d+)/i);
  return m ? Number(m[1]) : null;
};

interface Equip { id: string; [coluna: string]: string }
interface ArqEquip { capturadoEm: string; equipamentos: Equip[] }
interface ItemMapa { grupo: number; parc?: string; eqp?: string; faz?: string; titulo: string | null; lat: number | null; lng: number | null; parci?: string; parcf?: string; area?: string; [k: string]: unknown }
interface ArqMapa { capturadoEm: string; itens: ItemMapa[] }
interface ArqGeom { grupos: { grupo: number; parc: string | null; pontos: [number, number][] }[] }
interface ArqParcelas { capturadoEm: string; parcelas: { id: string; campos: Record<string, string>; marcador: { lat: number; lng: number } | null }[] }
interface ArqHist { equipamento: string; periodo: string; vars: string[]; parcelas: Record<string, { dias: (string | number | null)[][] }> }
interface ArqSnap { periodo: string; parcelas: { id: string; dias: Record<string, Record<string, number>> }[] }

await aplicarSchema();
const cli = await pool.connect();
try {
  await cli.query('BEGIN');

  // Pivôs do IRRIVERT por número, para ligar os equipamentos.
  const pivos = (await cli.query<{ id: number; nome: string }>('SELECT id, nome FROM pivo')).rows;
  const pivoPorNumero = new Map<number, number>();
  for (const p of pivos) {
    const n = numeroDoPivo(p.nome);
    if (n != null && !pivoPorNumero.has(n)) pivoPorNumero.set(n, p.id);
  }

  // 1) Equipamentos (Agua Clara = 2367, Pedra = 1833)
  let nEquip = 0;
  const arquivosEquip: [string, number][] = [
    ['equipamentos-2026-10-23.json', 2367],
    ['equipamentos-pedra-2026-10-23.json', 1833],
  ];
  for (const [arquivo, fazendaIcrop] of arquivosEquip) {
    if (!existsSync(join(pasta, arquivo))) continue;
    const arq = ler<ArqEquip>(arquivo);
    for (const e of arq.equipamentos) {
      const loc = (e['Localização'] ?? '').split(';');
      const numero = numeroDoPivo(e['Nome'] ?? '');
      await cli.query(
        `INSERT INTO icrop_equipamento (id, fazenda_icrop, nome, marca_modelo, raio_ultima_torre_m, raio_apos_ultima_torre_m, vazao_m3h,
           velocidade_100_mh, tempo_max_dia_h, uniformidade_pct, pressao_servico_mca, potencia_cv, area_molhada_pct, area_ha, lat, lng, campos, pivo_id, capturado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, marca_modelo = EXCLUDED.marca_modelo, raio_ultima_torre_m = EXCLUDED.raio_ultima_torre_m,
           raio_apos_ultima_torre_m = EXCLUDED.raio_apos_ultima_torre_m, vazao_m3h = EXCLUDED.vazao_m3h, velocidade_100_mh = EXCLUDED.velocidade_100_mh,
           tempo_max_dia_h = EXCLUDED.tempo_max_dia_h, uniformidade_pct = EXCLUDED.uniformidade_pct, pressao_servico_mca = EXCLUDED.pressao_servico_mca,
           potencia_cv = EXCLUDED.potencia_cv, area_molhada_pct = EXCLUDED.area_molhada_pct, area_ha = EXCLUDED.area_ha, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
           campos = EXCLUDED.campos, pivo_id = COALESCE(EXCLUDED.pivo_id, icrop_equipamento.pivo_id), capturado_em = EXCLUDED.capturado_em`,
        [
          Number(e.id), fazendaIcrop, e['Nome'], e['Marca/Modelo'] ?? null,
          num(e['Raio da última torre (m)']), num(e['Raio irrigado após última torre (m)']), num(e['Vazão (m3/h)']),
          num(e['Velocidade a 100% (m/h)']), num(e['Tempo Máx. de Operação/dia (h)']), num(e['Uniformidade (%)']),
          num(e['Pressão de Serviço (m.c.a)']), num(e['Potência Instalada (cv)']), num(e['Porcentagem de área Molhada (%)']), num(e['Área (ha)']),
          loc.length >= 2 ? Number(loc[0]) : null, loc.length >= 2 ? Number(loc[1]) : null,
          JSON.stringify(e), fazendaIcrop === 2367 && numero != null ? (pivoPorNumero.get(numero) ?? null) : null, arq.capturadoEm,
        ],
      );
      nEquip++;
    }
  }

  // Ligação pela área, não pelo número: a numeração do iCrop não é a do mapa (o "Pivô 30" do iCrop é o "PIVÔ 04"
  // do Pasto 6.0; 34, 35 e 36 são 05, 06 e 07). Cada equipamento vai para o pivô que mais cobre o seu círculo irrigado
  // (≥ 30 % do círculo); se dois caírem no mesmo pivô, fica o de maior sobreposição. Sem sobreposição = sem ligação.
  await cli.query(
    `WITH circ AS (
       SELECT e.id, ST_Buffer(ST_SetSRID(ST_MakePoint(e.lng::float8, e.lat::float8), 4326)::geography,
                              e.raio_ultima_torre_m::float8 + coalesce(e.raio_apos_ultima_torre_m, 0)::float8)::geometry AS g
         FROM icrop_equipamento e
        WHERE e.fazenda_icrop = 2367 AND e.lat IS NOT NULL AND e.lng IS NOT NULL AND e.raio_ultima_torre_m > 0),
     par AS (
       SELECT c.id AS eid, pv.id AS pid, ST_Area(ST_Intersection(c.g, ST_MakeValid(pv.geom))::geography) AS a, ST_Area(c.g::geography) AS ac
         FROM circ c JOIN pivo pv ON pv.geom IS NOT NULL AND ST_Intersects(c.g, pv.geom)),
     melhor AS (SELECT DISTINCT ON (eid) eid, pid, a FROM par WHERE a >= 0.3 * ac ORDER BY eid, a DESC),
     unico AS (SELECT DISTINCT ON (pid) eid, pid FROM melhor ORDER BY pid, a DESC)
     UPDATE icrop_equipamento e SET pivo_id = u.pid
       FROM (SELECT e2.id, unico.pid FROM icrop_equipamento e2 LEFT JOIN unico ON unico.eid = e2.id WHERE e2.fazenda_icrop = 2367) u
      WHERE e.id = u.id`,
  );

  // 2) Parcelas: ficha do cadastro + atributos do mapa (setor, área, equipamento) + polígono do mapa
  const mapa = ler<ArqMapa>('mapa-parcelas-2026-10-23.json');
  const geom = ler<ArqGeom>('mapa-geometrias-2026-10-23.json');
  const fichas = ler<ArqParcelas>('parcelas-cadastro-2026-10-23.json');
  const itemPorParc = new Map(mapa.itens.filter((i) => i.parc).map((i) => [String(i.parc), i]));
  const pontosPorParc = new Map(geom.grupos.filter((g) => g.parc).map((g) => [String(g.parc), g.pontos]));
  let nParc = 0;
  for (const f of fichas.parcelas) {
    const c = f.campos ?? {};
    const item = itemPorParc.get(f.id);
    const pontos = pontosPorParc.get(f.id);
    const anel = pontos && pontos.length >= 3 ? [...pontos, pontos[0]] : null;
    const geojson = anel ? JSON.stringify({ type: 'Polygon', coordinates: [anel.map(([lat, lng]) => [lng, lat])] }) : null;
    const lat = f.marcador?.lat ?? item?.lat ?? null;
    const lng = f.marcador?.lng ?? item?.lng ?? null;
    await cli.query(
      `INSERT INTO icrop_parcela (id, equipamento_id, nome, cultura, solo, data_plantio, inicio_manejo, fim_manejo, area_ha, angulo_inicio, angulo_fim,
         umidade_inicial, lat, lng, geom, campos, parcela_id, capturado_em)
       VALUES ($1, (SELECT id FROM icrop_equipamento WHERE id = $2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         CASE WHEN $15::text IS NULL THEN NULL ELSE ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($15::text), 4326)), 3) END,
         $16::jsonb,
         (SELECT p.id FROM parcela p WHERE $13::numeric IS NOT NULL AND p.geom IS NOT NULL
            AND ST_Contains(p.geom, ST_SetSRID(ST_MakePoint($14::numeric::float8, $13::numeric::float8), 4326)) ORDER BY p.id LIMIT 1),
         $17)
       ON CONFLICT (id) DO UPDATE SET equipamento_id = EXCLUDED.equipamento_id, nome = EXCLUDED.nome, cultura = EXCLUDED.cultura, solo = EXCLUDED.solo,
         data_plantio = EXCLUDED.data_plantio, inicio_manejo = EXCLUDED.inicio_manejo, fim_manejo = EXCLUDED.fim_manejo, area_ha = EXCLUDED.area_ha,
         angulo_inicio = EXCLUDED.angulo_inicio, angulo_fim = EXCLUDED.angulo_fim, umidade_inicial = EXCLUDED.umidade_inicial, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
         geom = COALESCE(EXCLUDED.geom, icrop_parcela.geom), campos = EXCLUDED.campos, parcela_id = COALESCE(EXCLUDED.parcela_id, icrop_parcela.parcela_id),
         capturado_em = EXCLUDED.capturado_em`,
      [
        Number(f.id), item?.eqp ? Number(item.eqp) : null, c['Nome'] ?? item?.titulo ?? `parcela ${f.id}`, c['Cultura'] ?? null, c['Solo'] ?? null,
        data(c['Data de plantio']), data(c['Data de início do Manejo']), data(c['Data final do Manejo']), num(c['Área (ha)'] ?? item?.area),
        num(c['Localização'] ?? item?.parci), num(c['Localização2'] ?? item?.parcf), c['Umidade do Solo Inicial (%)'] || null,
        lat, lng, geojson, JSON.stringify({ ficha: c, mapa: item ?? null }), fichas.capturadoEm,
      ],
    );
    nParc++;
  }
  // O marcador do iCrop fica no centro do pivô (cairia sempre na praça de alimentação): a ligação ao piquete
  // é pelo que o polígono da parcela mais cobre.
  await cli.query(
    `UPDATE icrop_parcela ip SET parcela_id = (
       SELECT p.id FROM parcela p
        WHERE p.geom IS NOT NULL AND ST_Intersects(ip.geom, p.geom)
        ORDER BY ST_Area(ST_Intersection(ip.geom, ST_MakeValid(p.geom))::geography) DESC LIMIT 1)
      WHERE ip.geom IS NOT NULL`,
  );

  // 3) Balanço diário: histórico por equipamento (séries do relatório) + instantâneo de 22/10
  const colunas: Record<string, string> = {
    o_fase_atual: 'fase', o_dias_passados: 'dias_passados', o_kc: 'kc', o_tamanho_da_raiz: 'raiz_cm', o_profundidade_absorcao: 'prof_absorcao_cm',
    o_cc: 'cc_pct', o_pm: 'pmp_pct', o_dg: 'densidade_g_cm3', o_cta: 'cta_mm', o_cra: 'cra_mm', o_umidade_seguranca: 'umidade_seguranca_pct',
    o_umidade: 'umidade_pct', o_eto: 'eto_mm', o_etc: 'etc_mm', o_precipitacao: 'chuva_mm', o_irrigacao: 'irrigacao_mm',
    o_lamina_disponivel: 'lamina_disponivel_mm', o_deficit: 'deficit_mm', o_deficit_previsto: 'deficit_previsto_mm', o_itn: 'itn_mm',
    o_tempo_de_irrigacao: 'tempo_irrigacao_h', o_percentimetro_recomendado: 'percentimetro_recomendado',
  };
  const parcelasConhecidas = new Set(fichas.parcelas.map((p) => Number(p.id)));
  let nDias = 0;
  const gravarDia = async (parcelaId: number, dia: string, vars: Record<string, number | null>) => {
    if (!parcelasConhecidas.has(parcelaId)) return;
    const iso = data(dia);
    if (!iso) return;
    const valores: Record<string, number | null> = {};
    for (const [v, col] of Object.entries(colunas)) valores[col] = vars[v] ?? null;
    // o relatório do iCrop mostra a chuva em cm; o mapa e a API usam mm
    if (valores.chuva_mm != null) valores.chuva_mm = Math.round(valores.chuva_mm * 10 * 100) / 100;
    const cols = Object.keys(valores);
    await cli.query(
      `INSERT INTO icrop_balanco_dia (parcela_icrop_id, data, ${cols.join(', ')}, variaveis)
       VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}, $${cols.length + 3})
       ON CONFLICT (parcela_icrop_id, data) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, variaveis = EXCLUDED.variaveis`,
      [parcelaId, iso, ...cols.map((c) => valores[c]), JSON.stringify(vars)],
    );
    nDias++;
  };
  const pastaHist = join(pasta, 'historico');
  if (existsSync(pastaHist)) {
    for (const arquivo of readdirSync(pastaHist).filter((a) => a.endsWith('.json')).sort()) {
      const h = JSON.parse(readFileSync(join(pastaHist, arquivo), 'utf8')) as ArqHist;
      for (const [id, p] of Object.entries(h.parcelas)) {
        for (const linha of p.dias) {
          const vars: Record<string, number | null> = {};
          h.vars.forEach((v, i) => (vars[v] = linha[i + 1] == null ? null : Number(linha[i + 1])));
          await gravarDia(Number(id), String(linha[0]), vars);
        }
      }
    }
  }
  const snap = join(pasta, 'balanco-diario-2026-10-22_23.json');
  if (existsSync(snap)) {
    const s = JSON.parse(readFileSync(snap, 'utf8')) as ArqSnap;
    for (const p of s.parcelas) for (const [dia, vars] of Object.entries(p.dias)) await gravarDia(Number(p.id), dia, vars);
  }

  console.log(`iCrop importado: ${nEquip} equipamentos, ${nParc} parcelas, ${nDias} dias de balanço.`);
  const lig = await cli.query(
    `SELECT count(*) FILTER (WHERE pivo_id IS NOT NULL) AS eq, (SELECT count(*) FROM icrop_parcela WHERE parcela_id IS NOT NULL) AS parc FROM icrop_equipamento`,
  );
  console.log(`Ligados ao IRRIVERT: ${lig.rows[0].eq} equipamentos a pivôs, ${lig.rows[0].parc} parcelas a piquetes.`);

  if (aplicar) await aplicarNosCadastros();

  if (simular) {
    await cli.query('ROLLBACK');
    console.log('SIMULAÇÃO: nada foi gravado (rode com --aplicar para gravar).');
  } else {
    await cli.query('COMMIT');
  }
} catch (e) {
  await cli.query('ROLLBACK');
  throw e;
} finally {
  cli.release();
  await pool.end();
}

/** Leva os parâmetros do iCrop para cultura/cultura_fase, pivo e parcela (mesma transação da importação). */
async function aplicarNosCadastros() {
  const lote = new Date().toISOString();
  const registrar = (tabela: string, id: number, origem: string, antes: unknown, depois: unknown) =>
    cli.query(`INSERT INTO icrop_aplicacao (lote, tabela, registro_id, origem, antes, depois) VALUES ($1,$2,$3,$4,$5,$6)`, [
      lote,
      tabela,
      id,
      origem,
      antes == null ? null : JSON.stringify(antes),
      JSON.stringify(depois),
    ]);
  const f2 = (x: unknown, casas = 2) => (x == null ? '—' : Number(x).toFixed(casas).replace('.', ','));

  // a) Cultivares com as curvas do iCrop (Kc e profundidade de manejo por fase)
  const culturaId = new Map<string, number>();
  for (const c of CULTURAS_ICROP) {
    const antes = (
      await cli.query(
        `SELECT c.id, c.nome, c.tipo, c.prof_raiz_mm, c.fracao_agua_disponivel_p, c.parametros_confirmados,
                coalesce(json_agg(f ORDER BY f.ordem) FILTER (WHERE f.id IS NOT NULL), '[]') AS fases
           FROM cultura c LEFT JOIN cultura_fase f ON f.cultura_id = c.id WHERE c.nome = $1 GROUP BY c.id`,
        [c.nome],
      )
    ).rows[0];
    const id: number = (
      await cli.query(
        `INSERT INTO cultura (nome, nome_cientifico, tipo, prof_raiz_mm, fracao_agua_disponivel_p, parametros_confirmados)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (nome) DO UPDATE SET nome_cientifico = EXCLUDED.nome_cientifico, tipo = EXCLUDED.tipo, prof_raiz_mm = EXCLUDED.prof_raiz_mm,
           fracao_agua_disponivel_p = EXCLUDED.fracao_agua_disponivel_p, parametros_confirmados = EXCLUDED.parametros_confirmados
         RETURNING id`,
        [c.nome, c.nomeCientifico, c.tipo, c.profRaizMm, c.p, c.confirmados],
      )
    ).rows[0].id;
    await cli.query(`DELETE FROM cultura_fase WHERE cultura_id = $1`, [id]);
    for (const [i, f] of c.fases.entries()) {
      await cli.query(
        `INSERT INTO cultura_fase (cultura_id, ordem, fase, kc, duracao_dias, kc_fim, raiz_mm, raiz_fim_mm) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, i + 1, f.fase, f.kc, f.duracaoDias, f.kcFim ?? null, f.raizMm ?? null, f.raizFimMm ?? null],
      );
    }
    await registrar('cultura', id, c.nome, antes ?? null, c);
    culturaId.set(c.nome, id);
    const fases = c.fases.map((f) => `${f.fase} Kc ${f2(f.kc)}${f.kcFim != null && f.kcFim !== f.kc ? '→' + f2(f.kcFim) : ''} (${f.duracaoDias} d)`);
    console.log(`  cultivar ${c.nome}: p ${f2(c.p)}, ${fases.join(', ')}${c.confirmados ? '' : ' — a confirmar'}`);
  }

  // b) Hidráulica dos pivôs ligados (eficiência do balanço mais recente do equipamento no iCrop)
  const equipamentos = (
    await cli.query(
      `SELECT e.*, pv.nome AS pivo_nome, pv.vazao_m3h AS pv_vazao, pv.lamina_volta_100_mm AS pv_lamina, pv.horas_volta_100 AS pv_horas,
              pv.eficiencia AS pv_eficiencia, pv.parametros_confirmados AS pv_confirmados,
              (SELECT NULLIF(b.variaveis->>'o_eficiencia_de_irrigacao', '')::numeric
                 FROM icrop_balanco_dia b JOIN icrop_parcela ip ON ip.id = b.parcela_icrop_id
                WHERE ip.equipamento_id = e.id AND b.variaveis ? 'o_eficiencia_de_irrigacao'
                ORDER BY b.data DESC LIMIT 1) AS ef_obs
         FROM icrop_equipamento e JOIN pivo pv ON pv.id = e.pivo_id
        WHERE e.fazenda_icrop = 2367 ORDER BY pv.nome, e.id`,
    )
  ).rows;
  const pivosFeitos = new Set<number>();
  let nPivos = 0;
  for (const e of equipamentos) {
    if (pivosFeitos.has(e.pivo_id)) {
      console.log(`  AVISO: ${e.nome} (iCrop ${e.id}) cai no mesmo pivô ${e.pivo_nome} de outro equipamento; ignorado.`);
      continue;
    }
    const h = hidraulicaIcrop(e, e.ef_obs == null ? null : Number(e.ef_obs));
    if (!h) {
      console.log(`  AVISO: ${e.nome} sem raio, velocidade ou vazão no iCrop; ${e.pivo_nome} mantido.`);
      continue;
    }
    pivosFeitos.add(e.pivo_id);
    const antes = {
      vazao_m3h: e.pv_vazao,
      lamina_volta_100_mm: e.pv_lamina,
      horas_volta_100: e.pv_horas,
      eficiencia: e.pv_eficiencia,
      parametros_confirmados: e.pv_confirmados,
    };
    const depois = {
      vazao_m3h: h.vazaoM3h,
      lamina_volta_100_mm: h.laminaVolta100Mm,
      horas_volta_100: h.horasVolta100,
      eficiencia: h.eficiencia,
      parametros_confirmados: true,
    };
    await cli.query(
      `UPDATE pivo SET vazao_m3h = $2, lamina_volta_100_mm = $3, horas_volta_100 = $4, eficiencia = $5, parametros_confirmados = true WHERE id = $1`,
      [e.pivo_id, h.vazaoM3h, h.laminaVolta100Mm, h.horasVolta100, h.eficiencia],
    );
    await registrar('pivo', e.pivo_id, `icrop_equipamento ${e.id} (${e.nome})`, antes, depois);
    nPivos++;
    console.log(
      `  ${e.pivo_nome} ← ${e.nome}: volta ${f2(e.pv_lamina)} mm em ${f2(e.pv_horas, 1)} h → ${f2(h.laminaVolta100Mm)} mm em ${f2(h.horasVolta100, 1)} h; eficiência ${f2(e.pv_eficiencia)} → ${f2(h.eficiencia, 3)}`,
    );
  }

  // c) Piquetes: a cultura do iCrop que cobre a maior parte do piquete (≥ 30 % da área); dela, a parcela que mais o
  // cobre dá o solo e a lâmina. Um piquete grande (pivô inteiro criado pela telemetria) pega a cultura dominante.
  const piquetes = (
    await cli.query(
      `WITH inter AS (
         SELECT p.id AS pid, ip.id AS iid, ip.cultura,
                ST_Area(ST_Intersection(ip.geom, ST_MakeValid(p.geom))::geography) AS a, ST_Area(p.geom::geography) AS ap
           FROM parcela p JOIN icrop_parcela ip ON ip.geom IS NOT NULL AND p.geom IS NOT NULL AND ST_Intersects(ip.geom, p.geom)
          WHERE p.ativo),
       por_cultura AS (SELECT pid, cultura, sum(a) AS a, max(ap) AS ap FROM inter GROUP BY pid, cultura),
       dominante AS (SELECT DISTINCT ON (pid) pid, cultura, a / NULLIF(ap, 0) AS fracao FROM por_cultura ORDER BY pid, a DESC),
       escolha AS (
         SELECT DISTINCT ON (i.pid) i.pid, i.iid, d.fracao
           FROM inter i JOIN dominante d ON d.pid = i.pid AND d.cultura IS NOT DISTINCT FROM i.cultura
          WHERE d.fracao >= 0.3 ORDER BY i.pid, i.a DESC)
       SELECT p.id, p.nome, pv.nome AS pivo, c.nome AS cultura_atual, p.cultura_id, p.data_plantio, p.ad_mm_por_cm, p.cap_campo_mm,
              p.lamina_seguranca_mm, p.data_inicial, p.lamina_inicial_mm, e.iid AS icrop_id, e.fracao
         FROM parcela p JOIN pivo pv ON pv.id = p.pivo_id JOIN cultura c ON c.id = p.cultura_id
         LEFT JOIN escolha e ON e.pid = p.id
        WHERE p.ativo AND pv.ativo
        ORDER BY pv.nome, p.nome`,
    )
  ).rows;
  const icrop = new Map<number, DiaBalancoIcrop & { id: number; nome: string; cultura: string | null; data_plantio: string | null }>(
    (
      await cli.query(
        `SELECT ip.id, ip.nome, ip.cultura, ip.data_plantio, d.data, d.cta_mm, d.cra_mm, d.lamina_disponivel_mm, d.prof_absorcao_cm
           FROM icrop_parcela ip
           LEFT JOIN LATERAL (
             SELECT b.data, b.cta_mm, b.cra_mm, b.lamina_disponivel_mm, b.prof_absorcao_cm FROM icrop_balanco_dia b
              WHERE b.parcela_icrop_id = ip.id AND b.cta_mm IS NOT NULL ORDER BY b.data DESC LIMIT 1) d ON true`,
      )
    ).rows.map((r) => [r.id as number, r]),
  );
  let nParcelas = 0;
  const semIcrop = new Map<string, number>();
  const porCultura = new Map<string, number>();
  for (const q of piquetes) {
    const ip = q.icrop_id != null ? icrop.get(q.icrop_id) : undefined;
    const cult = culturaIcrop(ip?.cultura);
    const plano = ip && cult && ip.data ? planoParcela(cult, ip.data_plantio, ip) : null;
    if (!ip || !cult || !plano) {
      semIcrop.set(q.pivo, (semIcrop.get(q.pivo) ?? 0) + 1);
      continue;
    }
    const antes = {
      cultura_id: q.cultura_id,
      cultura: q.cultura_atual,
      data_plantio: q.data_plantio,
      ad_mm_por_cm: q.ad_mm_por_cm,
      cap_campo_mm: q.cap_campo_mm,
      lamina_seguranca_mm: q.lamina_seguranca_mm,
      data_inicial: q.data_inicial,
      lamina_inicial_mm: q.lamina_inicial_mm,
    };
    const depois = {
      cultura_id: culturaId.get(cult.nome)!,
      cultura: cult.nome,
      data_plantio: ip.data_plantio,
      ad_mm_por_cm: plano.adMmPorCm,
      cap_campo_mm: plano.capMm,
      lamina_seguranca_mm: plano.limiteMm,
      data_inicial: plano.dataInicial,
      lamina_inicial_mm: plano.laminaInicialMm,
    };
    await cli.query(
      `UPDATE parcela SET cultura_id = $2, data_plantio = $3, ad_mm_por_cm = $4, cap_campo_mm = $5, lamina_seguranca_mm = $6,
              data_inicial = $7, lamina_inicial_mm = $8 WHERE id = $1`,
      [q.id, depois.cultura_id, depois.data_plantio, depois.ad_mm_por_cm, depois.cap_campo_mm, depois.lamina_seguranca_mm, depois.data_inicial, depois.lamina_inicial_mm],
    );
    const cobre = `${cult.nome} cobre ${Math.round(Number(q.fracao) * 100)} % do piquete`;
    await registrar('parcela', q.id, `icrop_parcela ${ip.id} (${ip.nome}, ${cobre})`, antes, depois);
    nParcelas++;
    porCultura.set(cult.nome, (porCultura.get(cult.nome) ?? 0) + 1);
  }
  const resumoCultura = [...porCultura].map(([c, n]) => `${c}: ${n}`).join('; ');
  console.log(`  piquetes atualizados: ${nParcelas} de ${piquetes.length} (${resumoCultura})`);
  if (semIcrop.size) console.log(`  sem parcela do iCrop (mantidos como estão): ${[...semIcrop].map(([p, n]) => `${p} ${n}`).join(', ')}`);
  console.log(`Aplicado (lote ${lote}): ${CULTURAS_ICROP.length} cultivares, ${nPivos} pivôs, ${nParcelas} piquetes. Antes/depois em icrop_aplicacao.`);
}
