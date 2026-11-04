import { describe, expect, it } from 'vitest';
import { agendar, aplicacaoNaVolta, arcoMinimo, permitido, planejarSetor, type Janela } from './index';

describe('arcoMinimo', () => {
  it('cobre o arco que atravessa o norte', () => {
    expect(arcoMinimo([350, 10, 20, 355])).toEqual({ de: 350, ate: 20 });
  });
});

describe('planejarSetor', () => {
  it('sem animais: nada a fazer', () => {
    expect(planejarSetor(100, []).situacao).toBe('livre');
  });
  it('pivô inteiro ocupado', () => {
    expect(planejarSetor(100, [{ de: 0, ate: 359.99 }]).situacao).toBe('bloqueado');
  });
  it('animais de 90° a 180°, pivô em 200°: vai em frente até 88° (margem), pois há mais área adiante', () => {
    const p = planejarSetor(200, [{ de: 90, ate: 180 }], 2);
    expect(p.situacao).toBe('parcial');
    expect(p.sentido).toBe(0);
    expect(p.anguloParada).toBe(87);
  });
  it('animais de 90° a 180°, pivô em 100°: está sobre a área ocupada e avisa', () => {
    const p = planejarSetor(100, [{ de: 90, ate: 180 }]);
    expect(p.avisos[0]).toMatch(/sobre área ocupada/);
  });
  it('perto do fim da área livre, vai em reverso', () => {
    const p = planejarSetor(85, [{ de: 90, ate: 180 }], 2);
    expect(p.sentido).toBe(1);
  });
});

describe('janelas de energia', () => {
  const noite: Janela[] = [{ inicio: '21:00', fim: '06:00', dias: [0, 1, 2, 3, 4, 5, 6] }];
  it('atravessa a meia-noite', () => {
    expect(permitido(noite, 2, 22 * 60)).toBe(true);
    expect(permitido(noite, 2, 3 * 60)).toBe(true);
    expect(permitido(noite, 2, 12 * 60)).toBe(false);
  });
  it('sem janelas = sempre permitido', () => expect(permitido([], 3, 700)).toBe(true));
  it('agenda dentro da janela e parte o que não cabe', () => {
    const seg = agendar([{ id: 1, duracaoMin: 600 }], noite, { diaSemanaBase: 1, minutoInicial: 8 * 60, simultaneos: 1 });
    expect(seg[0].inicioMin).toBe(21 * 60);
    expect(seg[0].fimMin).toBe(30 * 60);
    expect(seg[0].parcial).toBe(true);
    expect(seg[1].inicioMin).toBe(45 * 60);
  });
});

describe('aplicacaoNaVolta', () => {
  it('lâmina maior que a da volta: pivô mais devagar e volta mais longa (caso do iCrop: 4,71 mm com volta de 4,59 mm → 97 %)', () => {
    const a = aplicacaoNaVolta(4.71, 4.59, 9.14);
    expect(a.percentual).toBeCloseTo(97.45, 1);
    expect(a.duracaoMin).toBeCloseTo((9.14 * 60 * 4.71) / 4.59, 0);
    expect(a.laminaAplicadaMm).toBeCloseTo(4.71, 2);
  });
  it('lâmina menor que a da volta: fica em 100 % e aplica a lâmina da volta', () => {
    const a = aplicacaoNaVolta(2, 3.24, 6.84);
    expect(a.percentual).toBe(100);
    expect(a.duracaoMin).toBeCloseTo(6.84 * 60, 5);
    expect(a.laminaAplicadaMm).toBeCloseTo(3.24, 5);
  });
  it('sem hidráulica não calcula', () => {
    expect(aplicacaoNaVolta(5, 0, 10).duracaoMin).toBe(0);
  });
});
