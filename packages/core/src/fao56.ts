/**
 * Evapotranspiração de referência (ETo) — FAO Irrigation and Drainage Paper 56
 * (Allen et al., 1998). Implementação própria, passo a passo, com as equações da FAO.
 * Unidades: °C, %, m/s (a 2 m), MJ/m²/dia, kPa, mm/dia.
 */
import { diaDoAno } from './datas';

export interface ClimaDia {
  tmin: number;
  tmax: number;
  tmed?: number;
  umidMax?: number; // %
  umidMin?: number; // %
  umidMed?: number; // %
  vento2?: number; // m/s a 2 m
  radiacaoMJ?: number; // MJ/m²/dia
}

export interface Local {
  latitudeGraus: number;
  altitudeM: number;
}

export type MetodoEto = 'penman-monteith' | 'hargreaves';

/** Pressão de vapor de saturação (kPa) a T °C — eq. 11 */
export const pressaoSaturacao = (t: number) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3));

/** Inclinação da curva de pressão de vapor (kPa/°C) — eq. 13 */
export const inclinacaoCurvaVapor = (t: number) => (4098 * pressaoSaturacao(t)) / Math.pow(t + 237.3, 2);

/** Pressão atmosférica (kPa) na altitude z — eq. 7 */
export const pressaoAtmosferica = (z: number) => 101.3 * Math.pow((293 - 0.0065 * z) / 293, 5.26);

/** Constante psicrométrica (kPa/°C) — eq. 8 */
export const constantePsicrometrica = (z: number) => 0.000665 * pressaoAtmosferica(z);

/** Radiação extraterrestre diária Ra (MJ/m²/dia) — eqs. 21–25 */
export function radiacaoExtraterrestre(latitudeGraus: number, doy: number): number {
  const phi = (latitudeGraus * Math.PI) / 180;
  const dr = 1 + 0.033 * Math.cos(((2 * Math.PI) / 365) * doy);
  const delta = 0.409 * Math.sin(((2 * Math.PI) / 365) * doy - 1.39);
  const x = Math.min(1, Math.max(-1, -Math.tan(phi) * Math.tan(delta)));
  const ws = Math.acos(x);
  return (
    ((24 * 60) / Math.PI) *
    0.082 *
    dr *
    (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws))
  );
}

/** Pressão real de vapor ea (kPa) com o melhor dado de umidade disponível — eqs. 17–19 */
export function pressaoRealVapor(c: ClimaDia): number {
  if (c.umidMax != null && c.umidMin != null) {
    return (pressaoSaturacao(c.tmin) * (c.umidMax / 100) + pressaoSaturacao(c.tmax) * (c.umidMin / 100)) / 2;
  }
  if (c.umidMed != null) {
    const es = (pressaoSaturacao(c.tmax) + pressaoSaturacao(c.tmin)) / 2;
    return (c.umidMed / 100) * es;
  }
  // sem umidade: assume ponto de orvalho ≈ Tmin (eq. 48)
  return pressaoSaturacao(c.tmin);
}

/** Converte vento medido a uma altura z (m) para 2 m — eq. 47 */
export const vento2m = (u: number, alturaM: number) => (u * 4.87) / Math.log(67.8 * alturaM - 5.42);

/** ETo por Penman-Monteith FAO-56 (mm/dia) — eq. 6. Precisa de radiação e vento. */
export function etoPenmanMonteith(c: ClimaDia, local: Local, data: string): number {
  if (c.radiacaoMJ == null || c.vento2 == null) throw new Error('Penman-Monteith exige radiação e vento');
  const tmed = c.tmed ?? (c.tmax + c.tmin) / 2;
  const es = (pressaoSaturacao(c.tmax) + pressaoSaturacao(c.tmin)) / 2;
  const ea = pressaoRealVapor(c);
  const delta = inclinacaoCurvaVapor(tmed);
  const gama = constantePsicrometrica(local.altitudeM);

  const ra = radiacaoExtraterrestre(local.latitudeGraus, diaDoAno(data));
  const rso = (0.75 + 2e-5 * local.altitudeM) * ra;
  const rns = (1 - 0.23) * c.radiacaoMJ;
  const rel = Math.min(c.radiacaoMJ / rso, 1);
  const sigma = 4.903e-9;
  const rnl =
    sigma *
    ((Math.pow(c.tmax + 273.16, 4) + Math.pow(c.tmin + 273.16, 4)) / 2) *
    (0.34 - 0.14 * Math.sqrt(ea)) *
    (1.35 * rel - 0.35);
  const rn = rns - rnl;
  const g = 0; // fluxo de calor no solo, passo diário

  const num = 0.408 * delta * (rn - g) + gama * (900 / (tmed + 273)) * c.vento2 * (es - ea);
  const den = delta + gama * (1 + 0.34 * c.vento2);
  return Math.max(0, num / den);
}

/** ETo por Hargreaves-Samani (mm/dia) — só precisa de temperatura (fallback). */
export function etoHargreaves(c: ClimaDia, local: Local, data: string): number {
  const tmed = c.tmed ?? (c.tmax + c.tmin) / 2;
  const ra = radiacaoExtraterrestre(local.latitudeGraus, diaDoAno(data));
  return Math.max(0, 0.0023 * (tmed + 17.8) * Math.sqrt(Math.max(c.tmax - c.tmin, 0)) * 0.408 * ra);
}

/** Escolhe o método: Penman-Monteith quando há dados completos; senão Hargreaves (estimada). */
export function etoDia(c: ClimaDia, local: Local, data: string): { eto: number; metodo: MetodoEto } {
  if (c.radiacaoMJ != null && c.vento2 != null) {
    return { eto: etoPenmanMonteith(c, local, data), metodo: 'penman-monteith' };
  }
  return { eto: etoHargreaves(c, local, data), metodo: 'hargreaves' };
}

/** W/m² (média diária) → MJ/m²/dia */
export const wm2ParaMJ = (w: number) => w * 0.0864;
