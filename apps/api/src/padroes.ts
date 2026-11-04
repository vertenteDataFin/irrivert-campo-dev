/**
 * Parâmetros-padrão por gênero de forrageira (FAO-56, tabela 12 — pastagem sob pastejo rotacionado,
 * p ≈ 0,55–0,60). SÃO VALORES INICIAIS: a profundidade de raiz e o Kc de cada cultivar devem ser
 * confirmados pelo agrônomo e ajustados no cadastro de cultivares.
 */
export interface PadraoCultivar {
  raizMm: number;
  p: number;
  kcMedio: number;
}

export function padraoPorGenero(cientifico: string | null, nome: string): PadraoCultivar {
  const t = `${cientifico ?? ''} ${nome}`.toLowerCase();
  if (/pennisetum purpureum|capim-elefante|napier|kurumi|capiacu|cameroon/.test(t)) return { raizMm: 600, p: 0.55, kcMedio: 1.05 };
  if (/megathyrsus|panicum|mombaca|zuri|tamani|quenia|massai|tanzania|aruana/.test(t)) return { raizMm: 500, p: 0.55, kcMedio: 1.05 };
  if (/cynodon|digitaria|tifton|coastcross|estrela|pangola|pensacola|quicuio|clandestinum/.test(t)) return { raizMm: 300, p: 0.55, kcMedio: 0.9 };
  if (/medicago|alfafa|neonotonia|arachis|soja perene/.test(t)) return { raizMm: 600, p: 0.55, kcMedio: 1.0 };
  return { raizMm: 400, p: 0.55, kcMedio: 0.95 }; // Urochloa/Brachiaria e demais
}

/** Fases de pastagem perene: o Kc do dia usa a fase "médio" quando não há data de plantio. */
export function fasesPadrao(kcMedio: number) {
  return [
    { fase: 'inicial', kc: 0.5, duracao_dias: 15 },
    { fase: 'desenvolvimento', kc: 0.75, duracao_dias: 25 },
    { fase: 'médio', kc: kcMedio, duracao_dias: 365 },
    { fase: 'final', kc: 0.85, duracao_dias: 30 },
  ];
}

/** Capacidade útil (mm) e limite de segurança (mm) a partir da cultivar e do solo (doc 04, seção 4). */
export function soloDaParcela(raizMm: number, p: number, adMmPorCm: number) {
  const cap = Math.round((raizMm / 10) * adMmPorCm * 10) / 10;
  return { cap, limite: Math.round(cap * (1 - p) * 10) / 10 };
}
