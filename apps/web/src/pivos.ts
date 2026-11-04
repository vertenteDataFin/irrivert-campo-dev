import { statusDoDia } from './cores';
import type { Parcela, Recomendacao, Status } from './tipos';

/**
 * Mesma regra de recomendar() em packages/core (a do iCrop): irrigar quando o déficit até a capacidade passa da ETc
 * do dia, repondo esse déficit; abaixo do limite sempre. Aqui aplicada à média do pivô, que gira inteiro.
 */
function recomendarPivo(laminaMm: number, capMm: number, limiteMm: number, etcDiaMm: number, h: NonNullable<Parcela['hidraulica']>): Recomendacao {
  const deficit = Math.max(0, capMm - laminaMm);
  if (laminaMm >= limiteMm && deficit - Math.max(0, etcDiaMm) <= 0.05) return { recomendaIrrigar: false, itnMm: 0, itnBrutaMm: 0, percentualVolta: 0, tempoMin: 0 };
  const itnBrutaMm = deficit / (h.eficiencia || 1);
  return {
    recomendaIrrigar: true,
    itnMm: deficit,
    itnBrutaMm,
    percentualVolta: h.laminaVoltaMm > 0 ? (itnBrutaMm / h.laminaVoltaMm) * 100 : 0,
    tempoMin: h.mmPorHora > 0 ? (itnBrutaMm / h.mmPorHora) * 60 : 0,
  };
}

export interface DiaPivo { data: string; laminaMm: number; etcMm: number; chuvaMm: number }
/**
 * Mesma conta de aplicacaoNaVolta() em packages/core: percentímetro e duração para aplicar uma lâmina bruta numa volta.
 * Abaixo da lâmina de uma volta a 100 % o pivô não anda mais rápido: fica em 100 % e aplica a lâmina da volta.
 */
export function aplicacaoNaVolta(laminaBrutaMm: number, laminaVoltaMm: number, horasVolta: number) {
  if (!(laminaVoltaMm > 0) || !(horasVolta > 0)) return { percentual: 100, duracaoMin: 0, laminaAplicadaMm: 0 };
  const percentual = Math.min(100, Math.max(1, (100 * laminaVoltaMm) / Math.max(laminaBrutaMm, 0.1)));
  return { percentual, duracaoMin: (horasVolta * 60 * 100) / percentual, laminaAplicadaMm: (laminaVoltaMm * 100) / percentual };
}

export interface Pivo {
  pivoId: number;
  nome: string;
  parcelas: Parcela[];
  areaHa: number;
  culturas: string[];
  laminaMm: number;
  capMm: number;
  limiteMm: number;
  /** situação do dia, como no iCrop: irrigar = reposição hoje; atenção = amanhã; ok = nem amanhã */
  status: Status;
  /** reposição por dia: 0 = hoje; k = fim do k-ésimo dia da projeção, sem irrigar */
  repor: boolean[];
  /** em quantos dias precisa de reposição (0 = hoje); null = não precisa na projeção */
  diasAteRepor: number | null;
  /** risco de estresse: lâmina média abaixo do limite de segurança */
  abaixoLimite: boolean;
  parcelasAbaixo: number;
  parcelasIrrigar: number;
  recomendaIrrigar: boolean;
  itnMm: number;
  itnBrutaMm: number;
  percentualVolta: number;
  /** hidráulica do pivô (null em respostas antigas da API) */
  hidraulica: { laminaVoltaMm: number; horasVolta: number; eficiencia: number } | null;
  tempoMin: number;
  projecao: DiaPivo[];
  ultimaIrrigacao: string | null;
}

/** Média ponderada pela área: o pivô é irrigado como um todo, então a decisão usa a lâmina média dele. */
export function agruparPorPivo(parcelas: Parcela[]): Pivo[] {
  const grupos = new Map<string, Parcela[]>();
  for (const p of parcelas) grupos.set(p.pivoNome, [...(grupos.get(p.pivoNome) ?? []), p]);

  return [...grupos.entries()].map(([nome, ps]) => {
    const area = ps.reduce((s, p) => s + p.areaHa, 0) || 1;
    const ponderado = (f: (p: Parcela) => number) => ps.reduce((s, p) => s + f(p) * p.areaHa, 0) / area;
    const laminaMm = ponderado((p) => p.laminaMm);
    const capMm = ponderado((p) => p.capMm);
    const limiteMm = ponderado((p) => p.limiteMm);
    const porCultura = new Map<string, number>();
    for (const p of ps) porCultura.set(p.cultura, (porCultura.get(p.cultura) ?? 0) + p.areaHa);
    const dias = ps[0].projecao.length;
    const ultimas = ps.map((p) => p.ultimaIrrigacao).filter((d): d is string => d != null).sort();
    const h = ps.find((p) => p.hidraulica)?.hidraulica;
    const rec: Recomendacao = h
      ? recomendarPivo(laminaMm, capMm, limiteMm, ponderado((p) => p.etcHojeMm), h)
      : {
          // API antiga, sem a hidráulica: média das recomendações das parcelas
          recomendaIrrigar: ps.some((p) => p.recomendacao.recomendaIrrigar),
          itnMm: ponderado((p) => p.recomendacao.itnMm),
          itnBrutaMm: ponderado((p) => p.recomendacao.itnBrutaMm),
          percentualVolta: ponderado((p) => p.recomendacao.percentualVolta),
          tempoMin: ponderado((p) => p.recomendacao.tempoMin),
        };
    const projecao = Array.from({ length: dias }, (_, i) => ({
      data: ps[0].projecao[i].data,
      laminaMm: ponderado((p) => p.projecao[i]?.laminaMm ?? p.laminaMm),
      etcMm: ponderado((p) => p.projecao[i]?.etcMm ?? 0),
      chuvaMm: ps[0].projecao[i].chuvaMm,
    }));
    // reposição em cada dia (0 = hoje; k = fim do k-ésimo dia sem irrigar), na média do pivô
    const repor = [
      rec.recomendaIrrigar,
      ...projecao.map((d, i) => (h ? recomendarPivo(d.laminaMm, capMm, limiteMm, d.etcMm, h).recomendaIrrigar : ps.some((p) => p.projecao[i]?.recomendacao.recomendaIrrigar))),
    ];
    const k = repor.findIndex((r) => r);
    return {
      pivoId: ps[0].pivoId,
      nome,
      parcelas: ps,
      areaHa: area,
      culturas: [...porCultura.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c),
      laminaMm,
      capMm,
      limiteMm,
      status: statusDoDia(repor, 0),
      repor,
      diasAteRepor: k < 0 ? null : k,
      abaixoLimite: laminaMm < limiteMm,
      parcelasAbaixo: ps.filter((p) => p.abaixoLimite ?? p.laminaMm < p.limiteMm).length,
      parcelasIrrigar: ps.filter((p) => p.status === 'irrigar').length,
      recomendaIrrigar: rec.recomendaIrrigar,
      itnMm: rec.itnMm,
      itnBrutaMm: rec.itnBrutaMm,
      hidraulica: h ? { laminaVoltaMm: h.laminaVoltaMm, horasVolta: h.mmPorHora > 0 ? h.laminaVoltaMm / h.mmPorHora : 0, eficiencia: h.eficiencia } : null,
      percentualVolta: rec.percentualVolta,
      tempoMin: rec.tempoMin,
      projecao,
      ultimaIrrigacao: ultimas.length ? ultimas[ultimas.length - 1] : null,
    };
  }).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
}
