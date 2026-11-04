import {
  etc,
  etoHargreaves,
  kcDoDia,
  listarDias,
  mmPorHora,
  passoBalanco,
  projetar,
  raizDoDia,
  recomendar,
  somarDias,
  situacaoIrrigacao,
  type DiaProjecao,
  type FaseCultura,
  type ParamsParcela,
  type Recomendacao,
  type StatusHidrico,
} from '@irrigacao/core';
import { hoje, pool } from './db';

export interface ParcelaCalculada {
  id: number;
  nome: string;
  pivoId: number;
  pivoNome: string;
  cultura: string;
  safra: string | null;
  areaHa: number;
  kc: number;
  capMm: number;
  limiteMm: number;
  laminaMm: number; // fim de ontem = situação ao amanhecer
  etcHojeMm: number;
  /** hidráulica do pivô, para a tela agrupar por pivô com a mesma regra de recomendar() */
  hidraulica: { mmPorHora: number; eficiencia: number; laminaVoltaMm: number };
  status: StatusHidrico; // situação do dia: irrigar = reposição hoje; atenção = amanhã; ok
  abaixoLimite: boolean; // risco de estresse: lâmina abaixo do limite de segurança
  recomendacao: Recomendacao;
  ultimaIrrigacao: string | null;
  geom: unknown;
  projecao: DiaProjecao[];
  historico: { data: string; chuvaMm: number; irrigacaoMm: number; etcMm: number; laminaMm: number }[];
  estimados: number; // nº de dias do histórico sem leitura de clima (usou média recente)
}

export interface ResultadoFazenda {
  fazenda: { id: number; nome: string };
  data: string;
  comChuva: boolean;
  estacao: { id: number; nome: string } | null;
  climaHoje: { etoMm: number; chuvaMm: number; tmax: number | null; tmin: number | null; origem: string } | null;
  previsao: { data: string; chuvaMm: number; chuvaProb: number | null; tmin: number | null; tmax: number | null; etoMm: number }[];
  parcelas: ParcelaCalculada[];
  resumo: { total: number; irrigar: number; atencao: number; ok: number; areaIrrigarHa: number; abaixoLimite: number };
}

const media = (xs: number[], padrao: number) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : padrao);

export async function calcularFazenda(
  fazendaId: number,
  opts: { comChuva: boolean; persistir?: boolean },
  dataHoje: string = hoje(),
): Promise<ResultadoFazenda | null> {
  const faz = (
    await pool.query(
      `SELECT id, nome, altitude_m, ST_Y(geom) AS lat FROM fazenda WHERE id = $1`,
      [fazendaId],
    )
  ).rows[0];
  if (!faz) return null;

  const estacao = (
    await pool.query(
      `SELECT e.id, e.nome FROM estacao e WHERE e.fazenda_id = $1
        ORDER BY EXISTS (SELECT 1 FROM estacao_integracao i WHERE i.estacao_id = e.id AND i.ativo) DESC, e.id LIMIT 1`,
      [fazendaId],
    )
  ).rows[0] as { id: number; nome: string } | undefined;

  const parcelasRows = (
    await pool.query(
      `SELECT p.id, p.nome, p.safra, p.area_ha, p.data_plantio, p.cap_campo_mm, p.lamina_seguranca_mm,
              p.data_inicial, p.lamina_inicial_mm, p.ad_mm_por_cm, ST_AsGeoJSON(p.geom)::json AS geom,
              pv.id AS pivo_id, pv.nome AS pivo_nome, pv.eficiencia, pv.lamina_volta_100_mm, pv.horas_volta_100,
              c.id AS cultura_id, c.nome AS cultura, c.fracao_agua_disponivel_p AS p_cultura
         FROM parcela p
         JOIN pivo pv ON pv.id = p.pivo_id
         JOIN cultura c ON c.id = p.cultura_id
        WHERE pv.fazenda_id = $1 AND p.ativo AND pv.ativo
        ORDER BY pv.nome, p.nome`,
      [fazendaId],
    )
  ).rows;

  const menorData = parcelasRows.reduce((m: string, p) => (p.data_inicial < m ? p.data_inicial : m), dataHoje);

  const leituras = estacao
    ? (
        await pool.query(
          `SELECT data, chuva_mm, eto_mm, temp_min, temp_max, origem FROM leitura_clima
            WHERE estacao_id = $1 AND data >= $2 ORDER BY data`,
          [estacao.id, somarDias(menorData, -8)],
        )
      ).rows
    : [];
  const leituraPorData = new Map<string, any>(leituras.map((l: any) => [l.data, l]));

  const previsoes = (
    await pool.query(
      `SELECT data, chuva_mm, chuva_prob, temp_min, temp_max, eto_mm FROM previsao_dia
        WHERE fazenda_id = $1 AND data >= $2 AND data <= $3 ORDER BY data`,
      [fazendaId, dataHoje, somarDias(dataHoje, 6)],
    )
  ).rows;
  const previsaoPorData = new Map<string, any>(previsoes.map((p: any) => [p.data, p]));

  const fasesRows = (
    await pool.query(
      `SELECT cultura_id, fase, kc, duracao_dias, kc_fim, raiz_mm, raiz_fim_mm FROM cultura_fase
        WHERE cultura_id = ANY($1::int[]) ORDER BY cultura_id, ordem`,
      [[...new Set(parcelasRows.map((p) => p.cultura_id))]],
    )
  ).rows;
  const fasesPorCultura = new Map<number, FaseCultura[]>();
  for (const f of fasesRows) {
    const l = fasesPorCultura.get(f.cultura_id) ?? [];
    l.push({ fase: f.fase, kc: f.kc, duracaoDias: f.duracao_dias, kcFim: f.kc_fim, raizMm: f.raiz_mm, raizFimMm: f.raiz_fim_mm });
    fasesPorCultura.set(f.cultura_id, l);
  }

  const lancs = (
    await pool.query(
      `SELECT parcela_id, data, lamina_mm, tempo_min FROM lancamento_irrigacao
        WHERE parcela_id = ANY($1::int[]) AND data >= $2 AND data < $3`,
      [parcelasRows.map((p) => p.id), menorData, dataHoje],
    )
  ).rows;

  // ETo estimada por dia sem leitura: média das últimas leituras disponíveis (RF-82).
  const etoRecente = (ate: string) => {
    const xs = leituras.filter((l: any) => l.data < ate && l.eto_mm != null).slice(-7).map((l: any) => Number(l.eto_mm));
    return media(xs, 5);
  };

  // Previsão normalizada para os 7 dias (hoje..hoje+6).
  const diasPrev = listarDias(dataHoje, somarDias(dataHoje, 6)).map((data) => {
    const p = previsaoPorData.get(data);
    let etoMm = etoRecente(dataHoje);
    if (p) {
      if (p.eto_mm != null) etoMm = Number(p.eto_mm);
      else if (p.temp_min != null && p.temp_max != null)
        etoMm = etoHargreaves({ tmin: p.temp_min, tmax: p.temp_max }, { latitudeGraus: faz.lat ?? -20, altitudeM: faz.altitude_m }, data);
    }
    return {
      data,
      chuvaMm: p ? Number(p.chuva_mm) : 0,
      chuvaProb: p?.chuva_prob ?? null,
      tmin: p?.temp_min ?? null,
      tmax: p?.temp_max ?? null,
      etoMm,
    };
  });

  const parcelas: ParcelaCalculada[] = [];
  for (const p of parcelasRows) {
    const fases = fasesPorCultura.get(p.cultura_id) ?? [];
    // Cultura com curva de raiz por fase (parâmetros do iCrop): a capacidade acompanha a raiz dia a dia
    // (raiz × água do solo) e o limite é capacidade × (1 − p). Sem curva, vale o que está gravado na parcela.
    const capDoDia = (data: string): { cap: number; limite: number } => {
      const raiz = raizDoDia(fases, p.data_plantio, data);
      if (raiz == null) return { cap: p.cap_campo_mm, limite: p.lamina_seguranca_mm };
      const cap = Math.round((raiz / 10) * Number(p.ad_mm_por_cm) * 10) / 10;
      return { cap, limite: Math.round(cap * (1 - Number(p.p_cultura)) * 10) / 10 };
    };
    const solo0 = capDoDia(p.data_inicial);
    const params: ParamsParcela = {
      capUtilMm: solo0.cap,
      limiteSegurancaMm: solo0.limite,
      eficiencia: p.eficiencia,
      mmPorHora: mmPorHora(p.lamina_volta_100_mm, p.horas_volta_100),
      laminaVoltaMm: p.lamina_volta_100_mm,
    };
    const lancsParcela = lancs.filter((l: any) => l.parcela_id === p.id);

    let lamina = Math.min(p.lamina_inicial_mm, params.capUtilMm);
    let estimados = 0;
    let ultima: string | null = null;
    const historico: ParcelaCalculada['historico'] = [];
    const ate = somarDias(dataHoje, -1);
    if (p.data_inicial <= ate) {
      for (const data of listarDias(p.data_inicial, ate)) {
        // raiz mais funda: a camada nova entra sem déficit (FAO-56 mantém a depleção), então a lâmina sobe junto
        const solo = capDoDia(data);
        if (solo.cap > params.capUtilMm) lamina += solo.cap - params.capUtilMm;
        params.capUtilMm = solo.cap;
        params.limiteSegurancaMm = solo.limite;
        const l = leituraPorData.get(data);
        const eto = l?.eto_mm != null ? Number(l.eto_mm) : etoRecente(data);
        if (l?.eto_mm == null) estimados++;
        const chuva = l ? Number(l.chuva_mm) : 0;
        const brutoDia = lancsParcela
          .filter((x: any) => x.data === data)
          .reduce((s: number, x: any) => s + (x.lamina_mm ?? (x.tempo_min / 60) * params.mmPorHora), 0);
        if (brutoDia > 0) ultima = data;
        const irrig = brutoDia * params.eficiencia;
        const etcMm = etc(eto, kcDoDia(fases, p.data_plantio, data));
        lamina = passoBalanco(lamina, chuva, irrig, etcMm, params.capUtilMm).laminaMm;
        historico.push({ data, chuvaMm: chuva, irrigacaoMm: irrig, etcMm, laminaMm: lamina });
      }
    }

    const soloHoje = capDoDia(dataHoje);
    if (soloHoje.cap > params.capUtilMm) lamina += soloHoje.cap - params.capUtilMm;
    params.capUtilMm = soloHoje.cap;
    params.limiteSegurancaMm = soloHoje.limite;
    lamina = Math.min(lamina, params.capUtilMm);
    const kc = kcDoDia(fases, p.data_plantio, dataHoje);
    const etcHoje = etc(diasPrev[0].etoMm, kc);
    const projecao = projetar(lamina, diasPrev, kc, params, opts.comChuva);
    parcelas.push({
      id: p.id,
      nome: p.nome,
      pivoId: p.pivo_id,
      pivoNome: p.pivo_nome,
      cultura: p.cultura,
      safra: p.safra,
      areaHa: p.area_ha,
      kc,
      capMm: params.capUtilMm,
      limiteMm: params.limiteSegurancaMm,
      laminaMm: lamina,
      etcHojeMm: etcHoje,
      hidraulica: { mmPorHora: params.mmPorHora, eficiencia: params.eficiencia, laminaVoltaMm: params.laminaVoltaMm },
      status: situacaoIrrigacao(recomendar(lamina, params, etcHoje), projecao[0]?.recomendacao),
      abaixoLimite: lamina < params.limiteSegurancaMm,
      recomendacao: recomendar(lamina, params, etcHoje),
      ultimaIrrigacao: ultima,
      geom: p.geom,
      projecao,
      historico,
      estimados,
    });
  }

  if (opts.persistir) await persistirBalanco(parcelas, dataHoje);

  const climaHojeRow = leituraPorData.get(dataHoje) ?? leituraPorData.get(somarDias(dataHoje, -1));
  return {
    fazenda: { id: faz.id, nome: faz.nome },
    data: dataHoje,
    comChuva: opts.comChuva,
    estacao: estacao ?? null,
    climaHoje: climaHojeRow
      ? {
          etoMm: Number(climaHojeRow.eto_mm ?? 0),
          chuvaMm: Number(climaHojeRow.chuva_mm ?? 0),
          tmax: climaHojeRow.temp_max,
          tmin: climaHojeRow.temp_min,
          origem: climaHojeRow.origem,
        }
      : null,
    previsao: diasPrev.map(({ data, chuvaMm, chuvaProb, tmin, tmax, etoMm }) => ({ data, chuvaMm, chuvaProb, tmin, tmax, etoMm })),
    parcelas,
    resumo: {
      total: parcelas.length,
      irrigar: parcelas.filter((x) => x.status === 'irrigar').length,
      atencao: parcelas.filter((x) => x.status === 'atencao').length,
      ok: parcelas.filter((x) => x.status === 'ok').length,
      areaIrrigarHa: parcelas.filter((x) => x.status === 'irrigar').reduce((s, x) => s + x.areaHa, 0),
      abaixoLimite: parcelas.filter((x) => x.abaixoLimite).length,
    },
  };
}

/** Grava o histórico e a projeção em balanco_hidrico_dia (a tela lê direto, doc 03). */
export async function persistirBalanco(parcelas: ParcelaCalculada[], dataHoje: string): Promise<void> {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    for (const p of parcelas) {
      await cli.query(`DELETE FROM balanco_hidrico_dia WHERE parcela_id = $1 AND (tipo = 'projecao' OR data < $2)`, [p.id, dataHoje]);
      for (const h of p.historico) {
        await cli.query(
          `INSERT INTO balanco_hidrico_dia
             (parcela_id, data, tipo, chuva_mm, irrigacao_mm, etc_mm, lamina_disponivel_mm, itn_mm, tempo_recomendado_min, recomenda_irrigar)
           VALUES ($1,$2,'historico',$3,$4,$5,$6,0,0,false)`,
          [p.id, h.data, h.chuvaMm, h.irrigacaoMm, h.etcMm, h.laminaMm],
        );
      }
      for (const d of p.projecao) {
        await cli.query(
          `INSERT INTO balanco_hidrico_dia
             (parcela_id, data, tipo, chuva_mm, irrigacao_mm, etc_mm, lamina_disponivel_mm, itn_mm, tempo_recomendado_min, recomenda_irrigar)
           VALUES ($1,$2,'projecao',$3,0,$4,$5,$6,$7,$8)`,
          [p.id, d.data, d.chuvaMm, d.etcMm, d.laminaMm, d.recomendacao.itnMm, d.recomendacao.tempoMin, d.recomendacao.recomendaIrrigar],
        );
      }
    }
    await cli.query('COMMIT');
  } catch (e) {
    await cli.query('ROLLBACK');
    throw e;
  } finally {
    cli.release();
  }
}
