/** Datas são strings 'YYYY-MM-DD' (dia civil, sem fuso). */

export function paraUTC(data: string): number {
  const [a, m, d] = data.split('-').map(Number);
  return Date.UTC(a, m - 1, d);
}

export function somarDias(data: string, dias: number): string {
  return new Date(paraUTC(data) + dias * 86_400_000).toISOString().slice(0, 10);
}

export function diferencaDias(a: string, b: string): number {
  return Math.round((paraUTC(a) - paraUTC(b)) / 86_400_000);
}

export function diaDoAno(data: string): number {
  const [a] = data.split('-').map(Number);
  return diferencaDias(data, `${a}-01-01`) + 1;
}

export function listarDias(inicio: string, fim: string): string[] {
  const out: string[] = [];
  for (let d = inicio; d <= fim; d = somarDias(d, 1)) out.push(d);
  return out;
}
