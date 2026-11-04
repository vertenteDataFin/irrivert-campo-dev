/** Relatório gerencial do período: lâmina aplicada, clima, situação hídrica, ordem do dia, pastejo, energia e comandos. */
import { recomendar, situacaoIrrigacao } from '@irrigacao/core';
import { hoje, pool } from './db';
import { lerOrdem } from './operacao';
import { calcularFazenda } from './servico';

const arred = (n: number, c = 1) => Math.round(n * 10 ** c) / 10 ** c;

export async function relatorio(fazendaId: number, de: string, ate: string) {
  // lâmina bruta por pivô: média das parcelas ponderada pela área
  const irrigacao = (await pool.query(
    `WITH por_parcela AS (
       SELECT p.id, p.pivo_id, p.area_ha, COALESCE(SUM(COALESCE(l.lamina_mm, 0)), 0) AS mm, COALESCE(SUM(l.tempo_min), 0) AS min,
              COUNT(DISTINCT l.data) AS dias, COALESCE(SUM(CASE WHEN l.origem = 'telemetria' THEN l.lamina_mm END), 0) AS mm_tel
         FROM parcela p JOIN pivo pv ON pv.id = p.pivo_id
         LEFT JOIN lancamento_irrigacao l ON l.parcela_id = p.id AND l.data BETWEEN $2 AND $3
        WHERE pv.fazenda_id = $1 AND p.ativo GROUP BY p.id)
     SELECT pv.nome AS "pivoNome", SUM(pp.mm * pp.area_ha) / NULLIF(SUM(pp.area_ha), 0) AS "laminaMm",
            SUM(pp.mm_tel * pp.area_ha) / NULLIF(SUM(pp.area_ha), 0) AS "laminaTelemetriaMm",
            MAX(pp.dias) AS "diasIrrigados", SUM(pp.area_ha) AS "areaHa"
       FROM por_parcela pp JOIN pivo pv ON pv.id = pp.pivo_id GROUP BY pv.id, pv.nome ORDER BY pv.nome`, [fazendaId, de, ate])).rows
    .map((r) => ({ pivoNome: r.pivoNome, laminaMm: arred(Number(r.laminaMm ?? 0)), laminaTelemetriaMm: arred(Number(r.laminaTelemetriaMm ?? 0)), diasIrrigados: Number(r.diasIrrigados), areaHa: arred(Number(r.areaHa)) }))
    .sort((a, b) => a.pivoNome.localeCompare(b.pivoNome, 'pt-BR', { numeric: true }));

  const clima = (await pool.query(
    `SELECT l.data, l.chuva_mm::float AS "chuvaMm", l.eto_mm::float AS "etoMm"
       FROM leitura_clima l WHERE l.estacao_id = (
         SELECT e.id FROM estacao e WHERE e.fazenda_id = $1
          ORDER BY EXISTS (SELECT 1 FROM estacao_integracao i WHERE i.estacao_id = e.id AND i.ativo) DESC, e.id LIMIT 1)
        AND l.data BETWEEN $2 AND $3 ORDER BY l.data`, [fazendaId, de, ate])).rows;

  const irrDia = new Map<string, number>((await pool.query(
    `SELECT l.data, SUM(COALESCE(l.lamina_mm, 0) * p.area_ha) / NULLIF((SELECT SUM(p2.area_ha) FROM parcela p2 JOIN pivo v2 ON v2.id = p2.pivo_id WHERE v2.fazenda_id = $1 AND p2.ativo), 0) AS mm
       FROM lancamento_irrigacao l JOIN parcela p ON p.id = l.parcela_id JOIN pivo pv ON pv.id = p.pivo_id
      WHERE pv.fazenda_id = $1 AND p.ativo AND l.data BETWEEN $2 AND $3 GROUP BY l.data`, [fazendaId, de, ate])).rows.map((r) => [r.data as string, Number(r.mm ?? 0)]));
  const climaDia = new Map(clima.map((c) => [c.data as string, c]));
  const dias: { data: string; chuvaMm: number; etoMm: number; irrigacaoMm: number }[] = [];
  for (let t = Date.parse(`${de}T12:00:00Z`); t <= Date.parse(`${ate}T12:00:00Z`) && dias.length < 92; t += 86_400_000) {
    const data = new Date(t).toISOString().slice(0, 10);
    const c = climaDia.get(data);
    dias.push({ data, chuvaMm: arred(c?.chuvaMm ?? 0), etoMm: arred(c?.etoMm ?? 0), irrigacaoMm: arred(irrDia.get(data) ?? 0, 2) });
  }

  const calc = await calcularFazenda(fazendaId, { comChuva: true });
  const grupos = new Map<number, NonNullable<typeof calc>['parcelas']>();
  for (const p of calc?.parcelas ?? []) grupos.set(p.pivoId, [...(grupos.get(p.pivoId) ?? []), p]);
  const situacao = [...grupos.values()].map((ps) => {
    const area = ps.reduce((s, p) => s + p.areaHa, 0) || 1;
    const pond = (f: (p: (typeof ps)[number]) => number) => ps.reduce((s, p) => s + f(p) * p.areaHa, 0) / area;
    const lamina = pond((p) => p.laminaMm);
    const limite = pond((p) => p.limiteMm);
    const cap = pond((p) => p.capMm);
    // situação do pivô inteiro, como no Preciso irrigar: reposição hoje (irrigar), só amanhã (atenção) ou nenhuma (ok)
    const prm = { capUtilMm: cap, limiteSegurancaMm: limite, eficiencia: ps[0].hidraulica.eficiencia, mmPorHora: ps[0].hidraulica.mmPorHora, laminaVoltaMm: ps[0].hidraulica.laminaVoltaMm };
    const status = situacaoIrrigacao(
      recomendar(lamina, prm, pond((p) => p.etcHojeMm)),
      recomendar(pond((p) => p.projecao[0]?.laminaMm ?? p.laminaMm), prm, pond((p) => p.projecao[0]?.etcMm ?? 0)),
    );
    return { pivoNome: ps[0].pivoNome, laminaMm: arred(lamina), limiteMm: arred(limite), capMm: arred(cap), status, irrigar: status === 'irrigar', abaixoLimite: lamina < limite, culturas: [...new Set(ps.map((p) => p.cultura))].join(', ') };
  }).sort((a, b) => a.pivoNome.localeCompare(b.pivoNome, 'pt-BR', { numeric: true }));

  // pastejo: dias de ocupação no período e notas
  const movs = (await pool.query(
    `SELECT m.id, m.parcela_id AS "parcelaId", p.nome AS piquete, pv.nome AS "pivoNome", m.tipo, m.ocorrido_em AS "em", m.nota, m.cabecas, m.lote, m.observacao, (m.foto IS NOT NULL) AS "temFoto"
       FROM movimento_animal m JOIN parcela p ON p.id = m.parcela_id JOIN pivo pv ON pv.id = p.pivo_id
      WHERE pv.fazenda_id = $1 ORDER BY m.parcela_id, m.ocorrido_em, m.id`, [fazendaId])).rows;
  const iniMs = Date.parse(`${de}T00:00:00Z`);
  const fimMs = Math.min(Date.parse(`${ate}T23:59:59Z`), Date.now());
  const porPiquete = new Map<number, { piquete: string; pivoNome: string; entradas: number; saidas: number; ms: number; notasE: number[]; notasS: number[] }>();
  const abertas = new Map<number, number>();
  const noPeriodo = (t: number) => t >= iniMs && t <= Date.parse(`${ate}T23:59:59Z`);
  for (const m of movs) {
    const g = porPiquete.get(m.parcelaId) ?? { piquete: m.piquete, pivoNome: m.pivoNome, entradas: 0, saidas: 0, ms: 0, notasE: [] as number[], notasS: [] as number[] };
    const t = new Date(m.em).getTime();
    if (m.tipo === 'entrada') {
      if (!abertas.has(m.parcelaId)) abertas.set(m.parcelaId, t);
      if (noPeriodo(t)) { g.entradas++; if (m.nota) g.notasE.push(m.nota); }
    } else {
      const ini = abertas.get(m.parcelaId);
      if (ini != null) { g.ms += Math.max(0, Math.min(t, fimMs) - Math.max(ini, iniMs)); abertas.delete(m.parcelaId); }
      if (noPeriodo(t)) { g.saidas++; if (m.nota) g.notasS.push(m.nota); }
    }
    porPiquete.set(m.parcelaId, g);
  }
  for (const [pid, ini] of abertas) { const g = porPiquete.get(pid)!; g.ms += Math.max(0, fimMs - Math.max(ini, iniMs)); }
  const media = (xs: number[]) => (xs.length ? arred(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const pastejo = [...porPiquete.values()]
    .map((g) => ({ piquete: g.piquete, pivoNome: g.pivoNome, entradas: g.entradas, saidas: g.saidas, diasOcupado: arred(g.ms / 86_400_000), notaEntrada: media(g.notasE), notaSaida: media(g.notasS) }))
    .filter((g) => g.entradas || g.saidas || g.diasOcupado > 0)
    .sort((a, b) => a.pivoNome.localeCompare(b.pivoNome, 'pt-BR', { numeric: true }) || a.piquete.localeCompare(b.piquete, 'pt-BR', { numeric: true }));
  const movimentos = movs.filter((m) => noPeriodo(new Date(m.em).getTime())).reverse().slice(0, 100)
    .map((m) => ({ id: m.id, piquete: m.piquete, pivoNome: m.pivoNome, tipo: m.tipo, em: new Date(m.em).toISOString(), nota: m.nota, cabecas: m.cabecas, lote: m.lote, observacao: m.observacao, temFoto: m.temFoto }));

  const alertas = (await pool.query(
    `SELECT tipo, COUNT(*)::int AS n FROM alerta WHERE fazenda_id = $1 AND criado_em >= $2::date AND criado_em < ($3::date + 1) GROUP BY tipo ORDER BY n DESC`, [fazendaId, de, ate])).rows;
  const comandos = (await pool.query(
    `SELECT c.id, c.criado_em AS "em", tp.nome AS "pivoNome", c.acao, c.estado, c.detalhe, u.nome AS usuario
       FROM comando_pivo c JOIN telemetria_pivo tp ON tp.id = c.telemetria_pivo_id JOIN telemetria_conta tc ON tc.id = tp.conta_id LEFT JOIN usuario u ON u.id = c.usuario_id
      WHERE tc.fazenda_id = $1 AND c.criado_em >= $2::date AND c.criado_em < ($3::date + 1) ORDER BY c.criado_em DESC LIMIT 100`, [fazendaId, de, ate])).rows;

  const chuvaTotal = clima.reduce((s, c) => s + (c.chuvaMm ?? 0), 0);
  const etoTotal = clima.reduce((s, c) => s + (c.etoMm ?? 0), 0);
  const areaTotal = irrigacao.reduce((s, i) => s + i.areaHa, 0) || 1;
  const laminaMedia = irrigacao.reduce((s, i) => s + i.laminaMm * i.areaHa, 0) / areaTotal;

  return {
    periodo: { de, ate, hoje: hoje() },
    resumo: {
      laminaMediaMm: arred(laminaMedia), chuvaMm: arred(chuvaTotal), etoMm: arred(etoTotal),
      pivosIrrigar: situacao.filter((s) => s.irrigar).length, pivos: situacao.length,
      piquetesOcupados: [...abertas.keys()].length,
    },
    irrigacao, clima, dias, situacao, ordem: await lerOrdem(fazendaId, hoje()), pastejo, movimentos, alertas, comandos,
  };
}
