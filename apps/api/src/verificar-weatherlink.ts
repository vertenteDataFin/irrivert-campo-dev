/** Verificação rápida do conversor WeatherLink: npx tsx src/verificar-weatherlink.ts (sem rede, sem banco). */
import assert from 'node:assert/strict';
import { agregarAmostras, agregarDia, cifrar, decifrar, extrairAmostra } from './weatherlink';

// Dois registros de arquivo (unidades imperiais, como a API v2 devolve)
const dia = agregarDia('2026-10-20', [
  { ts: 1, temp_hi: 95, temp_lo: 70, hum_last: 40, wind_speed_avg: 4, rainfall_mm: 0, solar_rad_avg: 600 },
  { ts: 2, temp_hi: 86, temp_lo: 64.4, hum_last: 80, wind_speed_avg: 8, rainfall_mm: 2.5, solar_rad_avg: 0 },
]);
assert.ok(dia);
assert.ok(Math.abs(dia.tmax - 35) < 1e-9, 'máx: 95 °F = 35 °C');
assert.ok(Math.abs(dia.tmin - 18) < 1e-9, 'mín: 64,4 °F = 18 °C');
assert.equal(dia.umidade, 60);
assert.ok(Math.abs(dia.ventoMs! - 6 * 0.44704) < 1e-9, 'vento médio 6 mph em m/s');
assert.equal(dia.chuvaMm, 2.5);
assert.ok(Math.abs(dia.radiacaoMJ! - 300 * 0.0864) < 1e-9, 'radiação média 300 W/m² → MJ/m²/dia');

// chuva em polegadas quando não há milímetros
assert.equal(agregarDia('2026-10-20', [{ ts: 1, temp_hi: 80, temp_lo: 60, rainfall_in: 0.1 }])!.chuvaMm, 2.5);
// sem temperatura não há leitura
assert.equal(agregarDia('2026-10-20', [{ ts: 1, hum_last: 50 }]), null);

// modo Basic: amostra da leitura atual (WeatherLink Live, unidades imperiais)
const am = extrairAmostra({ sensors: [{ data: [{ ts: 10, temp: 77, hum: 55, wind_speed_last: 10, solar_rad: 800, rainfall_daily_mm: 1.2 }] }, { data: [{ ts: 10, temp_in: 80, hum_in: 40 }] }] });
assert.ok(Math.abs(am.tempC! - 25) < 1e-9, '77 °F = 25 °C (ignora temp_in do sensor interno)');
assert.equal(am.umidade, 55);
assert.ok(Math.abs(am.ventoMs! - 4.4704) < 1e-9);
assert.equal(am.radiacaoWm2, 800);
assert.equal(am.chuvaDiaMm, 1.2);

// resumo do dia a partir das amostras: extremos, médias e chuva = maior acumulado do dia
const amostras = Array.from({ length: 20 }, (_, i) => ({ tempC: 20 + i, umidade: 60, ventoMs: 2, radiacaoWm2: i < 10 ? 0 : 400, chuvaDiaMm: i < 15 ? 0 : 3 }));
assert.equal(agregarAmostras('2026-10-20', amostras), null, 'cobertura insuficiente: não fecha o dia');
const rs = agregarAmostras('2026-10-20', amostras, 12)!;
assert.equal(rs.tmin, 20);
assert.equal(rs.tmax, 39);
assert.equal(rs.chuvaMm, 3);
assert.ok(Math.abs(rs.radiacaoMJ! - 200 * 0.0864) < 1e-9);
assert.equal(agregarAmostras('2026-10-20', amostras.slice(0, 5), 12), null, 'poucas amostras: sem resumo');

// o segredo é cifrado e volta idêntico
const c = cifrar('segredo-de-teste');
assert.notEqual(c, 'segredo-de-teste');
assert.equal(decifrar(c), 'segredo-de-teste');

console.log('weatherlink: tudo certo');
