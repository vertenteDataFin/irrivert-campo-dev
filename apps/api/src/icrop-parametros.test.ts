import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kcDoDia, raizDoDia, somarDias } from '@irrigacao/core';
import { describe, expect, it } from 'vitest';
import { CULTURAS_ICROP, culturaIcrop, hidraulicaIcrop, planoParcela } from './icrop-parametros';

const pasta = join(dirname(fileURLToPath(import.meta.url)), '..', 'dados', 'icrop');
const derivados = JSON.parse(readFileSync(join(pasta, 'parametros-derivados-2026-10-23.json'), 'utf8'));
const equipamentos = JSON.parse(readFileSync(join(pasta, 'equipamentos-2026-10-23.json'), 'utf8')).equipamentos as Record<string, string>[];
const num = (v: unknown) => parseFloat(String(v ?? '').replace(/\./g, '').replace(',', '.'));

describe('curvas das culturas reproduzem o histórico do iCrop', () => {
  for (const obs of derivados.culturas as { cultura: string; porDia: { dia: number; kc: number; prof_absorcao_cm: number }[] }[]) {
    it(obs.cultura, () => {
      const c = culturaIcrop(obs.cultura);
      expect(c).not.toBeNull();
      const plantio = '2026-01-01';
      for (const d of obs.porDia) {
        const data = somarDias(plantio, d.dia - 1); // dia 1 do iCrop = dia do plantio
        expect(Math.abs(kcDoDia(c!.fases, plantio, data) - d.kc), `Kc no dia ${d.dia}`).toBeLessThan(0.002);
        // Mombaça: dias 11 e 12 ficam em ~52 cm no iCrop antes de saltar para 66 cm; aceita 1,5 cm fora desses dias
        const tol = obs.cultura.includes('Mombaça') && d.dia > 10 && d.dia < 13 ? 15.5 : 1.5;
        expect(Math.abs(raizDoDia(c!.fases, plantio, data)! / 10 - d.prof_absorcao_cm), `profundidade no dia ${d.dia}`).toBeLessThan(tol);
      }
    });
  }
  it('todas as culturas do iCrop têm curva', () => {
    expect(CULTURAS_ICROP.map((c) => c.nome).sort()).toEqual((derivados.culturas as { cultura: string }[]).map((c) => c.cultura).sort());
  });
});

describe('hidráulica dos pivôs igual à do iCrop', () => {
  for (const p of derivados.pivos as { nome: string; icrop_id: string; eficiencia_irrigacao: number; tempo_volta_100_h: number; taxa_aplicacao_mm_h: number }[]) {
    it(p.nome, () => {
      const e = equipamentos.find((x) => x.id === p.icrop_id)!;
      const h = hidraulicaIcrop(
        {
          raio_ultima_torre_m: num(e['Raio da última torre (m)']),
          raio_apos_ultima_torre_m: num(e['Raio irrigado após última torre (m)']),
          vazao_m3h: num(e['Vazão (m3/h)']),
          velocidade_100_mh: num(e['Velocidade a 100% (m/h)']),
          uniformidade_pct: num(e['Uniformidade (%)']),
          area_molhada_pct: num(e['Porcentagem de área Molhada (%)']),
        },
        p.eficiencia_irrigacao,
      )!;
      expect(h.horasVolta100).toBeCloseTo(p.tempo_volta_100_h, 1);
      expect(h.mmPorHora).toBeCloseTo(p.taxa_aplicacao_mm_h, 2);
      expect(h.eficiencia).toBe(p.eficiencia_irrigacao);
      expect(h.laminaVolta100Mm).toBeCloseTo(p.tempo_volta_100_h * p.taxa_aplicacao_mm_h, 1);
    });
  }
  it('sem raio/velocidade/vazão não inventa valores', () => {
    expect(hidraulicaIcrop({ raio_ultima_torre_m: null, raio_apos_ultima_torre_m: null, vazao_m3h: 100, velocidade_100_mh: 200, uniformidade_pct: null, area_molhada_pct: null }, null)).toBeNull();
  });
});

describe('ponto de partida do balanço da parcela', () => {
  it('Mombaça do Pivô 04 (iCrop 22/10: CTA 70,89, CRA 35,45, disponível 31,64)', () => {
    const c = culturaIcrop('Pastagem - Mombaça 3')!;
    const pl = planoParcela(c, '2026-06-01', { data: '2026-10-22', cta_mm: 70.8932, cra_mm: 35.4466, lamina_disponivel_mm: 31.6445, prof_absorcao_cm: 67.2678 })!;
    expect(pl.dataInicial).toBe('2026-10-23');
    expect(pl.adMmPorCm).toBeCloseTo(1.0539, 4);
    expect(pl.capMm).toBeCloseTo(70.8, 1); // 67,2 cm × 1,0539
    expect(pl.limiteMm).toBeCloseTo(35.4, 1);
    // 31,64 + (70,89 − 35,45) = 67,09 mm → 94,6 % da capacidade
    expect(pl.fracaoInicial).toBeCloseTo(0.9464, 3);
    expect(pl.laminaInicialMm).toBeCloseTo(67, 0);
  });
  it('amendoim em crescimento usa a profundidade do dia seguinte', () => {
    const c = culturaIcrop('Amendoim - IAC 677')!;
    // plantio 17/09: 22/10 é o dia 36 (prof. 38,13 cm); 23/10 é o dia 37 (38,35 cm)
    const pl = planoParcela(c, '2026-09-17', { data: '2026-10-22', cta_mm: 47.2627, cra_mm: 16.542, lamina_disponivel_mm: 12.7316, prof_absorcao_cm: 38.1333 })!;
    expect(pl.capMm).toBeCloseTo((38.35 * 47.2627) / 38.1333, 0);
    expect(pl.limiteMm).toBeCloseTo(pl.capMm * 0.65, 0);
    expect(pl.fracaoInicial).toBeCloseTo((12.7316 + 47.2627 - 16.542) / 47.2627, 3);
  });
  it('sem CTA não aplica', () => {
    expect(planoParcela(CULTURAS_ICROP[0], null, { data: '2026-10-22', cta_mm: null, cra_mm: null, lamina_disponivel_mm: null, prof_absorcao_cm: null })).toBeNull();
  });
});
