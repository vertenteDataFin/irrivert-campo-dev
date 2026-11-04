/**
 * Operação do pivô: setores ocupados por animais (sentido e ângulo de parada) e janelas de horário de energia.
 * Funções puras. Ângulos em graus a partir do norte, sentido horário; sentido 0 = frente (ângulo cresce), 1 = reverso.
 */

export interface Arco { de: number; ate: number } // do ângulo `de` ao `ate`, girando no sentido horário

const norm = (a: number) => ((a % 360) + 360) % 360;

export function noArco(ang: number, a: Arco): boolean {
  return norm(ang - a.de) <= norm(a.ate - a.de);
}

/** Menor arco que contém todos os azimutes (o complemento do maior vão). null se não houver pontos suficientes. */
export function arcoMinimo(azimutes: number[]): Arco | null {
  const xs = [...new Set(azimutes.map((a) => Math.round(norm(a) * 100) / 100))].sort((a, b) => a - b);
  if (xs.length < 2) return null;
  let melhor = -1;
  let vao = -1;
  for (let i = 0; i < xs.length; i++) {
    const prox = xs[(i + 1) % xs.length];
    const g = norm(prox - xs[i]) || 360;
    if (g > vao) { vao = g; melhor = i; }
  }
  if (360 - vao >= 359) return { de: 0, ate: 359.99 };
  return { de: xs[(melhor + 1) % xs.length], ate: xs[melhor] };
}

export interface PlanoSetor {
  /** livre = nada ocupado; parcial = há setor livre; bloqueado = pivô inteiro ocupado */
  situacao: 'livre' | 'parcial' | 'bloqueado';
  sentido: 0 | 1 | null;
  anguloParada: number | null;
  livres: Arco[];
  avisos: string[];
}

/**
 * Decide o sentido e o ângulo de parada para irrigar só o que está livre.
 * `margemGraus` alarga cada área ocupada (a parada do pivô não é exata).
 */
export function planejarSetor(anguloAtual: number | null, ocupados: Arco[], margemGraus = 2): PlanoSetor {
  if (!ocupados.length) return { situacao: 'livre', sentido: null, anguloParada: null, livres: [{ de: 0, ate: 359.99 }], avisos: [] };

  const bloq = new Array<boolean>(360).fill(false);
  for (const o of ocupados) {
    const ini = Math.floor(norm(o.de - margemGraus));
    const n = Math.min(360, Math.ceil(norm(o.ate - o.de) + 2 * margemGraus) + 1);
    for (let i = 0; i < n; i++) bloq[(ini + i) % 360] = true;
  }
  if (bloq.every(Boolean)) return { situacao: 'bloqueado', sentido: null, anguloParada: null, livres: [], avisos: ['Todos os setores do pivô estão ocupados por animais.'] };

  const livres: Arco[] = [];
  const inicio = bloq.findIndex((b) => b); // começa num grau ocupado: nenhuma faixa livre fica "cortada"
  let ini: number | null = null;
  for (let k = 1; k <= 360; k++) {
    const i = (inicio + k) % 360;
    if (!bloq[i] && ini == null) ini = i;
    if (bloq[i] && ini != null) { livres.push({ de: ini, ate: (i + 359) % 360 }); ini = null; }
  }

  const avisos: string[] = [];
  let arco: Arco | undefined;
  let dentro = false;
  if (anguloAtual != null) {
    arco = livres.find((a) => noArco(anguloAtual, a));
    dentro = arco != null;
  }
  if (!arco) {
    if (anguloAtual == null) {
      arco = [...livres].sort((a, b) => norm(b.ate - b.de) - norm(a.ate - a.de))[0];
    } else {
      const dist = (a: Arco) => Math.min(norm(a.de - anguloAtual), norm(anguloAtual - a.de), norm(a.ate - anguloAtual), norm(anguloAtual - a.ate));
      arco = [...livres].sort((a, b) => dist(a) - dist(b))[0];
      avisos.push(`O pivô está em ${Math.round(anguloAtual)}°, sobre área ocupada: mova a seco até a área livre antes de irrigar.`);
    }
  }

  let sentido: 0 | 1;
  let parada: number;
  if (dentro && anguloAtual != null) {
    // varre o lado com mais área livre à frente; o outro lado fica para a volta seguinte
    const adiante = norm(arco.ate - anguloAtual);
    const atras = norm(anguloAtual - arco.de);
    if (adiante >= atras) { sentido = 0; parada = arco.ate; } else { sentido = 1; parada = arco.de; }
    if (Math.min(adiante, atras) > 5) avisos.push(`Resta ${Math.round(Math.min(adiante, atras))}° livre do outro lado do pivô; será irrigado numa segunda passada.`);
  } else if (anguloAtual != null && norm(arco.de - anguloAtual) <= norm(anguloAtual - arco.ate)) {
    sentido = 0; parada = arco.ate; // entra pela ponta `de`
  } else if (anguloAtual != null) {
    sentido = 1; parada = arco.de; // entra pela ponta `ate`
  } else {
    sentido = 0; parada = arco.ate;
  }
  return { situacao: 'parcial', sentido, anguloParada: Math.round(parada), livres, avisos };
}

// ---------- janelas de horário (energia) ----------

export interface Janela {
  inicio: string; // 'HH:MM'
  fim: string; // 'HH:MM'; se menor que o início, atravessa a meia-noite
  dias: number[]; // 0 = domingo … 6 = sábado; dia em que a janela COMEÇA
}

export const minutosDe = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Sem janelas cadastradas, qualquer horário é permitido. */
export function permitido(janelas: Janela[], diaSemana: number, minuto: number): boolean {
  if (!janelas.length) return true;
  return janelas.some((j) => {
    const ini = minutosDe(j.inicio);
    const fim = minutosDe(j.fim);
    if (ini === fim) return j.dias.includes(diaSemana);
    if (ini < fim) return j.dias.includes(diaSemana) && minuto >= ini && minuto < fim;
    return (j.dias.includes(diaSemana) && minuto >= ini) || (j.dias.includes((diaSemana + 6) % 7) && minuto < fim);
  });
}

export interface ItemOrdem { id: number; duracaoMin: number }
export interface Segmento { id: number; inicioMin: number; fimMin: number; parcial: boolean }

/**
 * Distribui os pivôs, na ordem de prioridade, dentro das janelas permitidas.
 * Tempos em minutos desde 00:00 do dia-base. `simultaneos` = quantos pivôs a bomba/rede aguenta ao mesmo tempo.
 * Um pivô que não cabe de uma vez numa janela é partido em segmentos (parcial = true no que sobra para depois).
 */
export function agendar(itens: ItemOrdem[], janelas: Janela[], o: { diaSemanaBase: number; minutoInicial: number; simultaneos: number; horizonteDias?: number }): Segmento[] {
  const limite = (o.horizonteDias ?? 7) * 1440;
  const ok = (t: number) => permitido(janelas, (o.diaSemanaBase + Math.floor(t / 1440)) % 7, t % 1440);
  const faixas = new Array<number>(Math.max(1, o.simultaneos)).fill(o.minutoInicial);
  const saida: Segmento[] = [];
  for (const item of itens) {
    const f = faixas.indexOf(Math.min(...faixas));
    let t = faixas[f];
    let resta = Math.max(1, Math.round(item.duracaoMin));
    while (resta > 0 && t < limite) {
      while (t < limite && !ok(t)) t++;
      const ini = t;
      while (t < limite && resta > 0 && ok(t)) { t++; resta--; }
      if (t > ini) saida.push({ id: item.id, inicioMin: ini, fimMin: t, parcial: resta > 0 });
    }
    faixas[f] = t;
  }
  return saida;
}

/**
 * Como o pivô aplica uma lâmina bruta numa volta: percentímetro (velocidade, %) e duração da volta.
 * Lâmina maior que a de uma volta a 100 % → o pivô anda mais devagar (percentual < 100) e a volta demora mais.
 * Lâmina menor → não dá para andar mais rápido que 100 %: aplica a lâmina da volta a 100 % (`laminaAplicadaMm`).
 */
export function aplicacaoNaVolta(laminaBrutaMm: number, laminaVoltaMm: number, horasVolta: number): { percentual: number; duracaoMin: number; laminaAplicadaMm: number } {
  if (!(laminaVoltaMm > 0) || !(horasVolta > 0)) return { percentual: 100, duracaoMin: 0, laminaAplicadaMm: 0 };
  const percentual = Math.min(100, Math.max(1, (100 * laminaVoltaMm) / Math.max(laminaBrutaMm, 0.1)));
  return { percentual, duracaoMin: (horasVolta * 60 * 100) / percentual, laminaAplicadaMm: (laminaVoltaMm * 100) / percentual };
}
