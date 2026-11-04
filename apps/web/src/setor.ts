// Setor livre do pivô quando há animais em piquetes: mesma regra de `planejarSetor` no núcleo (packages/core/src/operacao.ts),
// copiada aqui porque o app de campo precisa calcular sem servidor. Ângulos em graus a partir do norte, sentido horário.
export interface Arco { de: number; ate: number }

export const norm = (a: number) => ((a % 360) + 360) % 360;
export const noArco = (ang: number, a: Arco) => norm(ang - a.de) <= norm(a.ate - a.de);

export interface PlanoSetor {
  situacao: 'livre' | 'parcial' | 'bloqueado';
  sentido: 'horario' | 'anti_horario' | null;
  setor: Arco | null;
  livres: Arco[];
  avisos: string[];
}

/** Decide o setor a irrigar e o sentido para contornar os arcos ocupados. `margemGraus` alarga cada área ocupada. */
export function planejarSetor(anguloAtual: number | null, ocupados: Arco[], margemGraus = 2): PlanoSetor {
  if (!ocupados.length) return { situacao: 'livre', sentido: null, setor: null, livres: [{ de: 0, ate: 359.99 }], avisos: [] };

  const bloq = new Array<boolean>(360).fill(false);
  for (const o of ocupados) {
    const ini = Math.floor(norm(o.de - margemGraus));
    const n = Math.min(360, Math.ceil(norm(o.ate - o.de) + 2 * margemGraus) + 1);
    for (let i = 0; i < n; i++) bloq[(ini + i) % 360] = true;
  }
  if (bloq.every(Boolean)) return { situacao: 'bloqueado', sentido: null, setor: null, livres: [], avisos: ['Todos os piquetes do pivô estão com animais.'] };

  const livres: Arco[] = [];
  const inicio = bloq.findIndex((b) => b);
  let ini: number | null = null;
  for (let k = 1; k <= 360; k++) {
    const i = (inicio + k) % 360;
    if (!bloq[i] && ini == null) ini = i;
    if (bloq[i] && ini != null) { livres.push({ de: ini, ate: (i + 359) % 360 }); ini = null; }
  }

  const avisos: string[] = [];
  let arco: Arco | undefined;
  let dentro = false;
  if (anguloAtual != null) { arco = livres.find((a) => noArco(anguloAtual, a)); dentro = arco != null; }
  if (!arco) {
    if (anguloAtual == null) {
      arco = [...livres].sort((a, b) => norm(b.ate - b.de) - norm(a.ate - a.de))[0];
    } else {
      const dist = (a: Arco) => Math.min(norm(a.de - anguloAtual), norm(anguloAtual - a.de), norm(a.ate - anguloAtual), norm(anguloAtual - a.ate));
      arco = [...livres].sort((a, b) => dist(a) - dist(b))[0];
      avisos.push(`O pivô está em ${Math.round(anguloAtual)}°, sobre piquete com animais: mova a seco até a área livre antes de irrigar.`);
    }
  }

  let sentido: 'horario' | 'anti_horario';
  if (dentro && anguloAtual != null) {
    const adiante = norm(arco.ate - anguloAtual);
    const atras = norm(anguloAtual - arco.de);
    sentido = adiante >= atras ? 'horario' : 'anti_horario';
    if (Math.min(adiante, atras) > 5) avisos.push(`Restam ${Math.round(Math.min(adiante, atras))}° livres do outro lado; ficam para uma segunda passada.`);
  } else if (anguloAtual != null && norm(arco.de - anguloAtual) <= norm(anguloAtual - arco.ate)) {
    sentido = 'horario';
  } else if (anguloAtual != null) {
    sentido = 'anti_horario';
  } else {
    sentido = 'horario';
  }
  return { situacao: 'parcial', sentido, setor: { de: Math.round(arco.de), ate: Math.round(arco.ate) }, livres, avisos };
}

/** Ponto na borda de um círculo para um azimute (0° = norte, horário), em coordenadas de SVG. */
export const pontoAzimute = (cx: number, cy: number, r: number, graus: number) => {
  const t = ((graus - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
};

/** Caminho SVG de uma fatia (cunha) entre dois azimutes, no sentido horário. */
export function cunha(cx: number, cy: number, r: number, de: number, ate: number): string {
  const amp = norm(ate - de) || 360;
  if (amp >= 359.9) return `M${cx - r},${cy} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0`;
  const a = pontoAzimute(cx, cy, r, de);
  const b = pontoAzimute(cx, cy, r, de + amp);
  return `M${cx},${cy} L${a.x.toFixed(1)},${a.y.toFixed(1)} A${r},${r} 0 ${amp > 180 ? 1 : 0},1 ${b.x.toFixed(1)},${b.y.toFixed(1)} Z`;
}

/** Caminho SVG de um arco (só a borda) entre dois azimutes, no sentido horário. */
export function arcoSvg(cx: number, cy: number, r: number, de: number, ate: number): string {
  const amp = norm(ate - de) || 360;
  const a = pontoAzimute(cx, cy, r, de);
  const b = pontoAzimute(cx, cy, r, de + Math.min(amp, 359.9));
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} A${r},${r} 0 ${amp > 180 ? 1 : 0},1 ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}
