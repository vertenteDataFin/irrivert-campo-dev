/**
 * Logo da Agropecuária Vertente reconstruído em SVG (o "V" em faixas e os textos), em cor única (currentColor):
 * escuro no fundo claro, claro no modo escuro, e imprime limpo. Se a empresa fornecer o arquivo oficial,
 * basta trocar este componente por um <img src="/logo-vertente.svg">.
 */
import type { SVGProps } from 'react';

const COR = '#1d3330';

/** Faixas do "V": bandas horizontais entre as bordas inclinadas das duas pernas. */
function faixas(): string[] {
  const out: string[] = [];
  const topo = 130, fundo = 410, n = 14, passo = (fundo - topo) / n, alt = passo * 0.78;
  const cx = 398;
  const xoL = (y: number) => 250 + ((y - topo) / (fundo - topo)) * 85; // borda externa esquerda
  const xiL = (y: number) => 345 + ((y - topo) / (372 - topo)) * 53; // borda interna esquerda (encontra o centro em y=372)
  const esp = (x: number) => 2 * cx - x; // espelha para a perna direita
  for (let k = 0; k < n; k++) {
    const y0 = topo + k * passo, y1 = y0 + alt;
    if (y1 <= 372) {
      out.push(`M${xoL(y0)},${y0} L${xiL(y0)},${y0} L${xiL(y1)},${y1} L${xoL(y1)},${y1} Z`);
      out.push(`M${esp(xoL(y0))},${y0} L${esp(xiL(y0))},${y0} L${esp(xiL(y1))},${y1} L${esp(xoL(y1))},${y1} Z`);
    } else if (k < n - 1) {
      out.push(`M${xoL(y0)},${y0} L${esp(xoL(y0))},${y0} L${esp(xoL(y1))},${y1} L${xoL(y1)},${y1} Z`);
    } else {
      // última faixa: a ponta do V, com o entalhe no centro
      out.push(`M${xoL(y0)},${y0} L${cx - 7},${y0} L${cx},${y0 + 6} L${cx + 7},${y0} L${esp(xoL(y0))},${y0} L${esp(xoL(y1))},${y1} L${xoL(y1)},${y1} Z`);
    }
  }
  return out;
}
const FAIXAS = faixas();
const FONTE = "'Montserrat', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

/** Só o "V" (para cabeçalho e ícone). */
export function MarcaVertente({ cor = 'currentColor', ...p }: SVGProps<SVGSVGElement> & { cor?: string }) {
  return (
    <svg viewBox="230 120 336 300" fill={cor} role="img" aria-label="Agropecuária Vertente" {...p}>
      {FAIXAS.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/** Logo completo: o "V" com "Agropecuária Vertente" embaixo. */
export function LogoVertente({ cor = 'currentColor', ...p }: SVGProps<SVGSVGElement> & { cor?: string }) {
  return (
    <svg viewBox="110 110 576 520" fill={cor} role="img" aria-label="Agropecuária Vertente" {...p}>
      {FAIXAS.map((d, i) => <path key={i} d={d} />)}
      <text x="398" y="530" textAnchor="middle" fontFamily={FONTE} fontWeight="600" fontSize="27" letterSpacing="7">AGROPECUÁRIA</text>
      <text x="398" y="607" textAnchor="middle" fontFamily={FONTE} fontWeight="700" fontSize="66" letterSpacing="9">VERTENTE</text>
    </svg>
  );
}

export const COR_MARCA = COR;
