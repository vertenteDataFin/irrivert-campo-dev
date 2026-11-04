import { COR_STATUS, type Parcela, type Status } from './tipos';

/**
 * Situação do dia pelo "Preciso irrigar?" (como no iCrop): `repor[k]` diz se há reposição no dia k
 * (0 = hoje, ao amanhecer; k ≥ 1 = fim do k-ésimo dia da projeção). irrigar = reposição nesse dia;
 * atenção = só no dia seguinte; ok = nem no seguinte.
 */
export function statusDoDia(repor: boolean[], k: number): Status {
  if (repor[k]) return 'irrigar';
  return repor[k + 1] ? 'atencao' : 'ok';
}

/** Reposição por dia de uma parcela: hoje e cada dia da projeção (sem irrigar). */
export const reporDaParcela = (p: Parcela) => [p.recomendacao.recomendaIrrigar, ...p.projecao.map((d) => d.recomendacao.recomendaIrrigar)];

/** Situação da parcela no dia `d` do mapa (0 = hoje). */
export const statusParcelaNoDia = (p: Parcela, d: number): Status => (d <= 0 ? p.status : statusDoDia(reporDaParcela(p), Math.min(d, p.projecao.length)));

/** Risco de estresse pelo limite de segurança: abaixo do limite = irrigar; até 20 % acima = atenção. */
export function statusDe(lamina: number, limite: number, cap: number): Status {
  if (lamina < limite) return 'irrigar';
  return lamina < limite + 0.2 * (cap - limite) ? 'atencao' : 'ok';
}

/** Escala contínua vermelho → âmbar → verde conforme a folga acima do limite de segurança. */
export function corGradiente(lamina: number, limite: number, cap: number): string {
  const folga = cap > limite ? (lamina - limite) / (cap - limite) : 0;
  const t = Math.max(0, Math.min(1, folga / 0.6));
  const hue = t < 0.33 ? t * 3 * 40 : 40 + ((t - 0.33) / 0.67) * 110;
  return `hsl(${hue.toFixed(0)} 78% ${t < 0.33 ? 48 : 40}%)`;
}

/** Lâmina da parcela no dia `d`: 0 = amanhecer de hoje; k ≥ 1 = fim do k-ésimo dia da projeção (sem irrigar). */
export function laminaNoDia(p: Parcela, d: number): number {
  if (d <= 0) return p.laminaMm;
  const dia = p.projecao[Math.min(d, p.projecao.length) - 1];
  return dia ? dia.laminaMm : p.laminaMm;
}

export const corStatus = (s: Status) => COR_STATUS[s];
