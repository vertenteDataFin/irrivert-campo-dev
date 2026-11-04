import { describe, expect, it } from 'vitest';
import {
  constantePsicrometrica,
  etoDia,
  etoHargreaves,
  etoPenmanMonteith,
  inclinacaoCurvaVapor,
  kcDoDia,
  raizDoDia,
  situacaoIrrigacao,
  mmPorHora,
  passoBalanco,
  pressaoSaturacao,
  projetar,
  radiacaoExtraterrestre,
  recomendar,
  statusHidrico,
  type ParamsParcela,
} from './index';

describe('FAO-56 — equações de apoio (Exemplos 2, 3, 8 do boletim)', () => {
  it('pressão de saturação a 24,5 °C ≈ 3,075 kPa', () => {
    expect(pressaoSaturacao(24.5)).toBeCloseTo(3.075, 2);
  });
  it('inclinação Δ a 16,9 °C ≈ 0,122 kPa/°C', () => {
    expect(inclinacaoCurvaVapor(16.9)).toBeCloseTo(0.122, 3);
  });
  it('constante psicrométrica a 1800 m ≈ 0,054 kPa/°C', () => {
    expect(constantePsicrometrica(1800)).toBeCloseTo(0.054, 3);
  });
  it('Ra a 20° S em 3 de setembro (doy 246) ≈ 32,2 MJ/m²/dia', () => {
    expect(radiacaoExtraterrestre(-20, 246)).toBeCloseTo(32.2, 0);
  });
});

describe('ETo Penman-Monteith — Exemplo 18 da FAO-56 (Uccle, 6 de julho)', () => {
  const clima = { tmax: 21.5, tmin: 12.3, umidMax: 84, umidMin: 63, vento2: 2.078, radiacaoMJ: 22.07 };
  const local = { latitudeGraus: 50.8, altitudeM: 100 };
  it('reproduz ≈ 3,9 mm/dia', () => {
    const eto = etoPenmanMonteith(clima, local, '2026-07-06');
    expect(eto).toBeGreaterThan(3.7);
    expect(eto).toBeLessThan(4.1);
  });
  it('sem radiação cai para Hargreaves e marca o método', () => {
    const r = etoDia({ tmax: 32, tmin: 20 }, { latitudeGraus: -20.5, altitudeM: 550 }, '2026-10-21');
    expect(r.metodo).toBe('hargreaves');
    expect(r.eto).toBeGreaterThan(4);
    expect(r.eto).toBeLessThan(8);
  });
  it('Hargreaves é próximo do PM em clima típico (±25%)', () => {
    const c = { tmax: 30, tmin: 18, umidMax: 85, umidMin: 45, vento2: 2, radiacaoMJ: 21 };
    const l = { latitudeGraus: -20.5, altitudeM: 550 };
    const pm = etoPenmanMonteith(c, l, '2026-10-21');
    const hg = etoHargreaves(c, l, '2026-10-21');
    expect(Math.abs(hg - pm) / pm).toBeLessThan(0.25);
  });
});

const params: ParamsParcela = {
  capUtilMm: 60,
  limiteSegurancaMm: 24, // p = 0,6
  eficiencia: 0.8,
  mmPorHora: mmPorHora(6, 20), // 0,3 mm/h
  laminaVoltaMm: 6,
};

describe('Balanço hídrico', () => {
  it('RN-02: nunca fica negativo nem passa da capacidade', () => {
    expect(passoBalanco(5, 0, 0, 30, 60).laminaMm).toBe(0);
    const r = passoBalanco(58, 20, 0, 2, 60);
    expect(r.laminaMm).toBe(60);
    expect(r.excessoMm).toBeCloseTo(16);
  });
  it('lâmina(hoje) = ontem + chuva + irrigação − ETc', () => {
    expect(passoBalanco(40, 5, 10, 7, 60).laminaMm).toBe(48);
  });
});

describe('Recomendação (regra do iCrop: déficit maior que a ETc do dia)', () => {
  it('recomenda quando falta mais que um dia de consumo até a capacidade', () => {
    expect(recomendar(55, params, 6).recomendaIrrigar).toBe(false); // falta 5 mm, consome 6
    expect(recomendar(54, params, 6).recomendaIrrigar).toBe(false); // falta exatamente 6
    expect(recomendar(53.9, params, 6).recomendaIrrigar).toBe(true);
    expect(recomendar(53.9, params, 6).itnMm).toBeCloseTo(6.1); // repõe só o que falta (o déficit do dia)
  });
  it('abaixo do limite sempre recomenda; cheio nunca', () => {
    expect(recomendar(23.99, params, 50).recomendaIrrigar).toBe(true);
    expect(recomendar(60, params).recomendaIrrigar).toBe(false);
    expect(recomendar(59.97, params).recomendaIrrigar).toBe(false); // déficit desprezível
  });
  it('caso do iCrop (Pivô 04, 21/10): falta 9,49 mm, ETc 4,75 → repõe 9,49 / 0,8888 = 10,68 mm', () => {
    const p = { capUtilMm: 70.89, limiteSegurancaMm: 35.45, eficiencia: 0.8888, mmPorHora: 0.4979, laminaVoltaMm: 5.22 };
    const r = recomendar(70.89 - 9.4927, p, 4.7463);
    expect(r.recomendaIrrigar).toBe(true);
    expect(r.itnBrutaMm).toBeCloseTo(10.68, 2);
    expect(recomendar(70.89 - 3.8021, p, 3.8021).recomendaIrrigar).toBe(false); // 22/10: déficit = ETc → não irriga
  });
  it('ITN repõe até o cheio e o tempo vem da lâmina do pivô', () => {
    const r = recomendar(20, params);
    expect(r.itnMm).toBe(40);
    expect(r.itnBrutaMm).toBeCloseTo(50); // 40 / 0,8
    expect(r.tempoMin).toBeCloseTo((50 / 0.3) * 60); // 50 mm a 0,3 mm/h
    expect(r.percentualVolta).toBeCloseTo((50 / 6) * 100);
  });
  it('status: irrigar / atenção / ok', () => {
    expect(statusHidrico(20, params)).toBe('irrigar');
    expect(statusHidrico(26, params)).toBe('atencao');
    expect(statusHidrico(50, params)).toBe('ok');
  });
});

describe('Kc por fase', () => {
  const fases = [
    { fase: 'inicial', kc: 0.4, duracaoDias: 25 },
    { fase: 'desenvolvimento', kc: 0.8, duracaoDias: 35 },
    { fase: 'medio', kc: 1.15, duracaoDias: 45 },
    { fase: 'final', kc: 0.6, duracaoDias: 25 },
  ];
  it('muda conforme a idade', () => {
    expect(kcDoDia(fases, '2026-01-01', '2026-01-10')).toBe(0.4);
    expect(kcDoDia(fases, '2026-01-01', '2026-02-10')).toBe(0.8);
    expect(kcDoDia(fases, '2026-01-01', '2026-04-01')).toBe(1.15);
    expect(kcDoDia(fases, '2026-01-01', '2027-01-01')).toBe(0.6);
  });
  it('perene (sem plantio) usa a fase médio', () => {
    expect(kcDoDia(fases, null, '2026-10-21')).toBe(1.15);
  });
});

describe('Curvas por fase (como o iCrop: Kc e raiz em linha reta)', () => {
  // Mombaça 3 no iCrop: dia 1 (plantio) Kc 0,60 e prof. 403 mm; dia 10 Kc 1,005 e 520 mm; depois Kc 1,05 e 672 mm
  const mombaca = [
    { fase: 'desenvolvimento', kc: 0.6, kcFim: 1.005, duracaoDias: 10, raizMm: 403, raizFimMm: 520 },
    { fase: 'médio', kc: 1.05, duracaoDias: 3650, raizMm: 672 },
  ];
  it('Kc sobe em linha reta e para no valor da fase seguinte', () => {
    expect(kcDoDia(mombaca, '2026-06-01', '2026-06-01')).toBeCloseTo(0.6, 4);
    expect(kcDoDia(mombaca, '2026-06-01', '2026-06-05')).toBeCloseTo(0.78, 4); // dia 5 do iCrop
    expect(kcDoDia(mombaca, '2026-06-01', '2026-06-10')).toBeCloseTo(1.005, 4);
    expect(kcDoDia(mombaca, '2026-06-01', '2026-06-11')).toBe(1.05);
    expect(kcDoDia(mombaca, '2026-06-01', '2040-01-01')).toBe(1.05);
  });
  it('profundidade de manejo acompanha a curva; sem curva devolve null', () => {
    expect(raizDoDia(mombaca, '2026-06-01', '2026-06-01')).toBeCloseTo(403, 4);
    expect(raizDoDia(mombaca, '2026-06-01', '2026-06-10')).toBeCloseTo(520, 4);
    expect(raizDoDia(mombaca, '2026-06-01', '2026-10-22')).toBe(672);
    expect(raizDoDia(mombaca, null, '2026-10-22')).toBe(672);
    expect(raizDoDia([{ fase: 'médio', kc: 1, duracaoDias: 30 }], '2026-06-01', '2026-06-10')).toBeNull();
  });
  it('fase sem raiz herda o fim da anterior; perene sem plantio usa o 1º dia da fase médio', () => {
    const f = [
      { fase: 'inicial', kc: 0.5, duracaoDias: 10, raizMm: 200, raizFimMm: 300 },
      { fase: 'médio', kc: 1.1, kcFim: 1.2, duracaoDias: 20 },
    ];
    expect(raizDoDia(f, '2026-01-01', '2026-01-20')).toBe(300);
    expect(kcDoDia(f, null, '2026-01-20')).toBe(1.1);
  });
});

describe('Situação do "Preciso irrigar?" (como no iCrop)', () => {
  it('irrigar = reposição hoje, mesmo longe do limite; atenção = só amanhã; ok = nem amanhã', () => {
    const hoje = recomendar(53.9, params, 6); // falta 6,1 mm, consome 6 → repõe hoje
    expect(hoje.recomendaIrrigar).toBe(true);
    expect(statusHidrico(53.9, params)).toBe('ok'); // longe do limite (24 mm)
    expect(situacaoIrrigacao(hoje)).toBe('irrigar');
    const semHoje = recomendar(57, params, 6); // falta 3 mm
    expect(situacaoIrrigacao(semHoje, recomendar(51, params, 6))).toBe('atencao'); // amanhã faltam 9 mm
    expect(situacaoIrrigacao(semHoje, recomendar(58, params, 6))).toBe('ok'); // amanhã faltam 2 mm, menos que a ETc
    expect(situacaoIrrigacao(semHoje, null)).toBe('ok');
  });
});

describe('Projeção e "E se chover?"', () => {
  const dias = [1, 2, 3].map((i) => ({ data: `2026-10-2${i}`, chuvaMm: i === 2 ? 30 : 0, etoMm: 6 }));
  it('sem chuva ignora a chuva prevista (pior caso)', () => {
    const p = projetar(40, dias, 1, params, false);
    expect(p.map((d) => d.laminaMm)).toEqual([34, 28, 22]);
    expect(p[2].recomendacao.recomendaIrrigar).toBe(true);
  });
  it('com chuva soma a chuva prevista', () => {
    const p = projetar(40, dias, 1, params, true);
    expect(p.map((d) => d.laminaMm)).toEqual([34, 58, 52]);
    expect(p[1].recomendacao.recomendaIrrigar).toBe(false); // a chuva quase encheu: falta 2 mm, menos que a ETc
    expect(p[2].recomendacao.recomendaIrrigar).toBe(true); // falta 8 mm, mais que os 6 do dia
  });
});
