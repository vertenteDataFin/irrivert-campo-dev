/**
 * Tradução dos parâmetros copiados do iCrop Vision (23/10/2026) para o modelo do IRRIVERT.
 * Lógica pura (sem banco), usada por importar-icrop.ts --aplicar e testada em icrop-parametros.test.ts.
 *
 * Como o iCrop calcula (reconstruído do histórico diário 01/06–22/10/2026, ver docs/ICROP-MIGRACAO.md):
 *  - profundidade de manejo ("absorção") = raiz × 1,3; é ela que entra na CTA. No IRRIVERT a "raiz" da
 *    cultura e das fases guarda essa profundidade de manejo, porque capacidade = profundidade × água do solo;
 *  - CTA = profundidade × água do solo efetiva (mm/cm), que varia por parcela (camadas e fator do iCrop),
 *    por isso a água do solo de cada parcela vem de CTA ÷ profundidade do último dia;
 *  - CRA (reserva que pode ser consumida) = p × CTA: p = 0,50 na Mombaça 3 e 0,35 no amendoim (0,30 na fase 1)
 *    e no preparo. No IRRIVERT o limite de segurança = capacidade × (1 − p);
 *  - "lâmina disponível" do iCrop é a água acima do limite (0 a CRA), no fim do dia. No IRRIVERT a lâmina conta
 *    desde o ponto de murcha: lâmina = disponível iCrop + (CTA − CRA);
 *  - eficiência de irrigação por pivô vem do iCrop (o_eficiencia_de_irrigacao); volta a 100 % = 2π × raio da
 *    última torre ÷ velocidade a 100 %; lâmina bruta por hora = vazão ÷ área irrigada (raio total).
 */
import { raizDoDia, somarDias, type FaseCultura } from '@irrigacao/core';

export interface CulturaIcrop {
  nome: string; // mesmo nome do iCrop, vira a cultivar no IRRIVERT
  tipo: 'forrageira' | 'cultura' | 'preparo';
  nomeCientifico: string | null;
  p: number;
  profRaizMm: number; // profundidade de manejo de referência (fase "médio")
  confirmados: boolean; // false = parte da curva foi completada com a FAO-56 (não observada no iCrop)
  fases: FaseCultura[];
  nota: string;
}

/** Curvas reconstruídas do histórico do iCrop (parametros-derivados-2026-10-23.json). Dia 1 do iCrop = dia do plantio. */
export const CULTURAS_ICROP: CulturaIcrop[] = [
  {
    nome: 'Pastagem - Mombaça 3',
    tipo: 'forrageira',
    nomeCientifico: 'Megathyrsus maximus cv. Mombaça',
    p: 0.5,
    profRaizMm: 672,
    confirmados: true,
    fases: [
      // dia 1 Kc 0,60 / raiz 31 cm; dia 10 Kc 1,005 / raiz 40 cm (profundidade × 1,3)
      { fase: 'desenvolvimento', kc: 0.6, kcFim: 1.005, duracaoDias: 10, raizMm: 403, raizFimMm: 520 },
      // a partir do dia 11 Kc 1,05; profundidade 663–673 mm do dia 13 em diante (51,7 cm × 1,3 no dia 144)
      { fase: 'médio', kc: 1.05, duracaoDias: 3650, raizMm: 672 },
    ],
    nota: 'Curva completa observada no iCrop (dias 1 a 144).',
  },
  ...['IAC 677', 'IAC 503'].map(
    (cv): CulturaIcrop => ({
      nome: `Amendoim - ${cv}`,
      tipo: 'cultura',
      nomeCientifico: `Arachis hypogaea cv. ${cv}`,
      p: 0.35,
      profRaizMm: 403,
      confirmados: false,
      fases: [
        // iCrop: dias 1–10 Kc 0,55, raiz 16 → 25 cm
        { fase: 'inicial', kc: 0.55, kcFim: 0.55, duracaoDias: 10, raizMm: 208, raizFimMm: 325 },
        // iCrop: dia 11 Kc 0,5667 subindo 1/60 por dia (dia 37: 1,00) e raiz 25,17 → 29,5 cm (dia 37).
        // Mesma inclinação até o Kc médio da FAO-56 para amendoim (1,15) no dia 46.
        { fase: 'desenvolvimento', kc: 0.5667, kcFim: 1.15, duracaoDias: 36, raizMm: 327, raizFimMm: 403 },
        // Não observadas no iCrop (lavouras com no máximo 37 dias em 22/10): FAO-56, a confirmar com o agrônomo.
        { fase: 'médio', kc: 1.15, duracaoDias: 40, raizMm: 403 },
        { fase: 'final', kc: 1.15, kcFim: 0.6, duracaoDias: 25, raizMm: 403 },
      ],
      nota: 'Dias 1 a 37 iguais ao iCrop; fases médio e final pela FAO-56 (a confirmar).',
    }),
  ),
  {
    nome: 'Preparo - Preparo do solo',
    tipo: 'preparo',
    nomeCientifico: null,
    p: 0.35,
    profRaizMm: 260,
    confirmados: true,
    fases: [{ fase: 'médio', kc: 0.6, duracaoDias: 3650, raizMm: 260 }],
    nota: 'Kc 0,60 e raiz 20 cm fixos no iCrop.',
  },
];

export const culturaIcrop = (nome: string | null | undefined) => CULTURAS_ICROP.find((c) => c.nome === nome) ?? null;

// ---------------- pivô ----------------
export interface EquipamentoIcrop {
  raio_ultima_torre_m: number | null;
  raio_apos_ultima_torre_m: number | null;
  vazao_m3h: number | null;
  velocidade_100_mh: number | null;
  uniformidade_pct: number | null;
  area_molhada_pct: number | null;
}

export interface HidraulicaPivo {
  vazaoM3h: number;
  horasVolta100: number;
  laminaVolta100Mm: number;
  mmPorHora: number;
  eficiencia: number;
  areaIrrigadaHa: number;
}

const arred = (x: number, casas: number) => Math.round(x * 10 ** casas) / 10 ** casas;

/** Hidráulica do pivô como o iCrop usa. null se faltar raio, velocidade ou vazão. */
export function hidraulicaIcrop(e: EquipamentoIcrop, eficienciaObservada: number | null): HidraulicaPivo | null {
  const r = Number(e.raio_ultima_torre_m);
  const v = Number(e.velocidade_100_mh);
  const q = Number(e.vazao_m3h);
  if (!(r > 0 && v > 0 && q > 0)) return null;
  const horas = (2 * Math.PI * r) / v;
  const areaHa = (Math.PI * (r + Number(e.raio_apos_ultima_torre_m ?? 0)) ** 2) / 10_000;
  const mmH = q / (areaHa * 10);
  const efPadrao = e.uniformidade_pct && e.area_molhada_pct ? (Number(e.uniformidade_pct) * Number(e.area_molhada_pct)) / 10_000 : 0.85;
  const ef = eficienciaObservada && eficienciaObservada > 0.3 && eficienciaObservada <= 1 ? eficienciaObservada : efPadrao;
  return {
    vazaoM3h: arred(q, 2),
    horasVolta100: arred(horas, 2),
    laminaVolta100Mm: arred(mmH * horas, 2),
    mmPorHora: arred(mmH, 4),
    eficiencia: arred(ef, 4),
    areaIrrigadaHa: arred(areaHa, 2),
  };
}

// ---------------- parcela ----------------
/** Último dia do balanço do iCrop de uma parcela (icrop_balanco_dia). */
export interface DiaBalancoIcrop {
  data: string; // YYYY-MM-DD
  cta_mm: number | null;
  cra_mm: number | null;
  lamina_disponivel_mm: number | null;
  prof_absorcao_cm: number | null;
}

export interface PlanoParcela {
  adMmPorCm: number;
  dataInicial: string;
  capMm: number;
  limiteMm: number;
  laminaInicialMm: number;
  fracaoInicial: number; // lâmina ÷ capacidade no início do balanço
}

/**
 * Parâmetros da parcela do IRRIVERT a partir da parcela do iCrop que a cobre: água do solo efetiva, capacidade e
 * limite no dia seguinte ao último dia do iCrop e a lâmina com que o balanço do IRRIVERT recomeça.
 */
export function planoParcela(cultura: CulturaIcrop, dataPlantio: string | null, ultimo: DiaBalancoIcrop): PlanoParcela | null {
  const cta = Number(ultimo.cta_mm);
  const prof = Number(ultimo.prof_absorcao_cm);
  if (!(cta > 0 && prof > 0)) return null;
  const ad = arred(cta / prof, 4);
  const dataInicial = somarDias(ultimo.data, 1);
  const raiz = raizDoDia(cultura.fases, dataPlantio, dataInicial) ?? cultura.profRaizMm;
  const cap = arred((raiz / 10) * ad, 1);
  const limite = arred(cap * (1 - cultura.p), 1);
  const cra = ultimo.cra_mm != null ? Number(ultimo.cra_mm) : cta * cultura.p;
  const disp = Math.max(0, Number(ultimo.lamina_disponivel_mm ?? 0));
  const fracao = Math.min(1, Math.max(0, (disp + cta - cra) / cta));
  return { adMmPorCm: ad, dataInicial, capMm: cap, limiteMm: limite, laminaInicialMm: arred(fracao * cap, 1), fracaoInicial: arred(fracao, 4) };
}

/** "23/10/2026" → "2026-10-23" (as fichas do iCrop vêm no formato brasileiro). */
export const dataIso = (v: unknown): string | null => {
  const m = String(v ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
