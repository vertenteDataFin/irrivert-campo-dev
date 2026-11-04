/**
 * Balanço hídrico do solo por parcela e recomendação de irrigação (doc 04).
 * lâmina(hoje) = lâmina(ontem) + chuva + irrigação − ETc, limitada a [0, capacidade] (RN-02).
 */
import { diferencaDias } from './datas';

export interface FaseCultura {
  fase: string;
  kc: number; // Kc no 1º dia da fase
  duracaoDias: number;
  /** Kc no último dia da fase: entre os dois o Kc segue em linha reta (curva do iCrop). Ausente = constante. */
  kcFim?: number | null;
  /** Profundidade de manejo (mm) no 1º e no último dia da fase; ausente = usa a profundidade fixa da cultura. */
  raizMm?: number | null;
  raizFimMm?: number | null;
}

export interface ParamsParcela {
  capUtilMm: number; // água disponível total (AD), em mm
  limiteSegurancaMm: number; // abaixo disso recomenda irrigar
  eficiencia: number; // 0–1, converte lâmina líquida em bruta
  mmPorHora: number; // lâmina bruta aplicada por hora de pivô a 100%
  laminaVoltaMm: number; // lâmina bruta de uma volta completa a 100%
}

export interface Recomendacao {
  recomendaIrrigar: boolean;
  itnMm: number; // irrigação total necessária (líquida)
  itnBrutaMm: number; // ITN dividida pela eficiência
  percentualVolta: number; // % da lâmina de uma volta
  tempoMin: number; // minutos de pivô
}

/**
 * Fase em que a cultura está no dia e a posição dentro dela (0 = 1º dia da fase).
 * Sem data de plantio (perene), fica no 1º dia da fase 'médio'. Depois da última fase, fica no último dia dela.
 */
export function posicaoNaFase(fases: FaseCultura[], dataPlantio: string | null, data: string): { indice: number; dia: number } | null {
  if (!fases.length) return null;
  if (!dataPlantio) {
    const i = fases.findIndex((f) => /m[eé]d/i.test(f.fase));
    return { indice: i >= 0 ? i : Math.floor(fases.length / 2), dia: 0 };
  }
  const idade = Math.max(0, diferencaDias(data, dataPlantio));
  let inicio = 0;
  for (const [i, f] of fases.entries()) {
    if (idade < inicio + f.duracaoDias) return { indice: i, dia: idade - inicio };
    inicio += f.duracaoDias;
  }
  const ultima = fases.length - 1;
  return { indice: ultima, dia: Math.max(0, fases[ultima].duracaoDias - 1) };
}

/** Valor em linha reta entre o 1º (dia 0) e o último dia (duração − 1) da fase. */
const interpolar = (ini: number, fim: number | null | undefined, dia: number, duracao: number) =>
  fim == null || duracao <= 1 ? ini : ini + ((fim - ini) * Math.min(dia, duracao - 1)) / (duracao - 1);

/** Kc do dia pela idade da cultura. Sem data de plantio (perene), usa a fase 'médio'. */
export function kcDoDia(fases: FaseCultura[], dataPlantio: string | null, data: string): number {
  const pos = posicaoNaFase(fases, dataPlantio, data);
  if (!pos) return 1;
  const f = fases[pos.indice];
  return interpolar(Number(f.kc), f.kcFim == null ? null : Number(f.kcFim), pos.dia, f.duracaoDias);
}

/**
 * Profundidade de manejo do dia (mm) quando a cultura tem curva de raiz por fase; null = usar a profundidade fixa.
 * Fase sem raiz informada herda o fim da fase anterior (ou o início da seguinte).
 */
export function raizDoDia(fases: FaseCultura[], dataPlantio: string | null, data: string): number | null {
  if (!fases.some((f) => f.raizMm != null)) return null;
  const pos = posicaoNaFase(fases, dataPlantio, data);
  if (!pos) return null;
  const f = fases[pos.indice];
  if (f.raizMm != null) return interpolar(Number(f.raizMm), f.raizFimMm == null ? null : Number(f.raizFimMm), pos.dia, f.duracaoDias);
  for (let i = pos.indice - 1; i >= 0; i--) {
    const a = fases[i];
    if (a.raizMm != null) return Number(a.raizFimMm ?? a.raizMm);
  }
  return Number(fases.find((x) => x.raizMm != null)!.raizMm);
}

export const etc = (eto: number, kc: number) => eto * kc;

/** Um passo do balanço. Retorna a nova lâmina e o excesso (drenagem) perdido. */
export function passoBalanco(
  laminaMm: number,
  chuvaMm: number,
  irrigacaoLiquidaMm: number,
  etcMm: number,
  capUtilMm: number,
): { laminaMm: number; excessoMm: number } {
  const bruto = laminaMm + chuvaMm + irrigacaoLiquidaMm - etcMm;
  const laminaNova = Math.min(capUtilMm, Math.max(0, bruto));
  return { laminaMm: laminaNova, excessoMm: Math.max(0, bruto - capUtilMm) };
}

/**
 * Recomendação do dia, com a regra do iCrop (adotada em 23/10/2026): irrigar quando o déficit até a capacidade de
 * campo passa do consumo (ETc) de um dia, repondo esse déficit. Com o pivô girando quase todo dia, isso é repor o que
 * a cultura consumiu (4 a 10 mm), em vez de esperar o limite de segurança e encher o solo de uma vez. Abaixo do
 * limite sempre recomenda. Sem ETc informada (0), recomenda qualquer déficit acima de 0,05 mm.
 * O status (verde/amarelo/vermelho) continua medindo o risco de estresse pelo limite: ver statusHidrico.
 */
export function recomendar(laminaMm: number, p: ParamsParcela, etcDiaMm = 0): Recomendacao {
  const deficit = Math.max(0, p.capUtilMm - laminaMm);
  if (laminaMm >= p.limiteSegurancaMm && deficit - Math.max(0, etcDiaMm) <= 0.05) {
    return { recomendaIrrigar: false, itnMm: 0, itnBrutaMm: 0, percentualVolta: 0, tempoMin: 0 };
  }
  const itnMm = deficit;
  const itnBrutaMm = itnMm / p.eficiencia;
  return {
    recomendaIrrigar: true,
    itnMm,
    itnBrutaMm,
    percentualVolta: p.laminaVoltaMm > 0 ? (itnBrutaMm / p.laminaVoltaMm) * 100 : 0,
    tempoMin: p.mmPorHora > 0 ? (itnBrutaMm / p.mmPorHora) * 60 : 0,
  };
}

export type StatusHidrico = 'irrigar' | 'atencao' | 'ok';

/**
 * Situação do "Preciso irrigar?" (como no iCrop, adotada em 26/10/2026): a pergunta é se há reposição hoje.
 * irrigar = há reposição hoje (recomendar() do dia); atenção = hoje não, mas amanhã sim, se não chover;
 * ok = nem hoje nem amanhã. O risco de estresse (abaixo do limite) é informado à parte.
 */
export function situacaoIrrigacao(hoje: Recomendacao, amanha?: Recomendacao | null): StatusHidrico {
  if (hoje.recomendaIrrigar) return 'irrigar';
  return amanha?.recomendaIrrigar ? 'atencao' : 'ok';
}

/** Risco de estresse pelo limite de segurança: 'irrigar' = abaixo do limite; 'atencao' = até 20 % da faixa útil acima dele. */
export function statusHidrico(laminaMm: number, p: ParamsParcela): StatusHidrico {
  if (laminaMm < p.limiteSegurancaMm) return 'irrigar';
  const faixa = p.capUtilMm - p.limiteSegurancaMm;
  return laminaMm < p.limiteSegurancaMm + 0.2 * faixa ? 'atencao' : 'ok';
}

export interface DiaProjecao {
  data: string;
  chuvaMm: number;
  etoMm: number;
  etcMm: number;
  laminaMm: number; // ao fim do dia
  recomendacao: Recomendacao; // calculada sobre a lâmina ao fim do dia
}

/** Projeção de N dias, sem irrigação planejada. `comChuva` soma a chuva prevista. */
export function projetar(
  laminaInicialMm: number,
  dias: { data: string; chuvaMm: number; etoMm: number }[],
  kc: number,
  p: ParamsParcela,
  comChuva: boolean,
): DiaProjecao[] {
  let lamina = laminaInicialMm;
  return dias.map((d) => {
    const chuva = comChuva ? d.chuvaMm : 0;
    const etcMm = etc(d.etoMm, kc);
    lamina = passoBalanco(lamina, chuva, 0, etcMm, p.capUtilMm).laminaMm;
    return { data: d.data, chuvaMm: chuva, etoMm: d.etoMm, etcMm, laminaMm: lamina, recomendacao: recomendar(lamina, p, etcMm) };
  });
}

/** Lâmina bruta por hora do pivô a 100% (mm/h) = lâmina da volta / horas da volta. */
export const mmPorHora = (laminaVoltaMm: number, horasVolta: number) => (horasVolta > 0 ? laminaVoltaMm / horasVolta : 0);

export function formatarHHMM(minutos: number): string {
  const total = Math.round(minutos);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
