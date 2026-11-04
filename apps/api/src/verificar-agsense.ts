/** Verificação sem rede/banco do conector AgSense: npx tsx src/verificar-agsense.ts */
import assert from 'node:assert/strict';
import { nomeDoPivo, normalizar } from './agsense';

const T = 1792695298; // 22/10/2026 ~17:54 UTC
const agora = (T + 10 * 60) * 1000; // 10 min depois da leitura

// P03 (formato real de GetLastReading, reduzido)
const cfg = { pivot_length: 1594, endgun_length: 0, estflow: 1642.3, min_app_depth: 0.204, pivot_runtime: 618, center: { lat: -19.62616, lng: -53.21845 } };
const leitura = (r: object) => ({ device: { cfg, pnl_cfg: { wethrs: 2023.3 }, reading: [{ time: T, angle: 99.6, direction: 'REV', power: 'IDLE', water: 'OFF', speed: 60, pnl_volts: 375, endgun1: 'OFF', SIS: 1, SISAngle: 100, faults: [{ fault: 'Command', fault_num: 4 }], ...r }] } });

assert.equal(nomeDoPivo('P03 FAZ VERTENTE '), 'Pivô 03');
assert.equal(nomeDoPivo('P13 FAZ VERTENTE'), 'Pivô 13');
assert.equal(nomeDoPivo('Bomba principal'), 'Bomba principal');

const p = normalizar('230310', 'P03 FAZ VERTENTE', leitura({}), agora)!;
assert.equal(p.nome, 'Pivô 03');
assert.equal(p.categoria, 'parado', 'IDLE = parado; a falha "Command" não é alarme');
assert.equal(p.direcao, 1);
assert.equal(p.percentual, 60);
assert.equal(p.tensaoV, 375);
assert.equal(p.destinoAngulo, 100);
assert.equal(p.horasMolhado, 2023.3);
assert.ok(Math.abs(p.raioM! - 485.87) < 0.1, '1594 ft = 485,9 m');
assert.ok(Math.abs(p.areaHa! - 74.16) < 0.1, 'área do círculo');
assert.ok(Math.abs(p.vazaoM3h! - 373.0) < 0.2, '1642,3 gpm = 373 m³/h');
assert.ok(Math.abs(p.lamina100Mm! - 5.18) < 0.01, '0,204 pol = 5,18 mm');
assert.ok(Math.abs(p.horasVolta100! - 10.3) < 1e-9, '618 min = 10,3 h');
assert.equal(p.atualizadoEm, new Date(T * 1000).toISOString());

// motivos de parada normais não são alarme; mostram por que parou
const sis = normalizar('1', 'P04', leitura({ faults: [{ fault: 'SIS', fault_num: 5 }] }), agora)!;
assert.equal(sis.categoria, 'parado');
assert.equal(sis.statusTxt, 'Parado no ângulo programado');
assert.equal(p.statusTxt, 'Parado por comando');
// "Safety" (circuito de segurança) é falha de verdade
assert.equal(normalizar('1', 'P11', leitura({ power: 'OFF', faults: [{ fault: 'Safety', fault_num: 2 }] }), agora)!.categoria, 'alarme');

// ligado com água, leitura recente = irrigando
assert.equal(normalizar('1', 'P01', leitura({ power: 'ON', water: 'ON', endgun1: 'ON' }), agora)!.categoria, 'irrigando');
assert.equal(normalizar('1', 'P01', leitura({ power: 'ON', water: 'ON', endgun1: 'ON' }), agora)!.canhao, true);
// ligado sem água = movendo a seco
assert.equal(normalizar('1', 'P01', leitura({ power: 'ON', water: 'OFF' }), agora)!.categoria, 'movendo');
// "ligado" mas leitura de 2 dias atrás: não dá para confiar
assert.equal(normalizar('1', 'P01', leitura({ power: 'ON', water: 'ON' }), agora + 2 * 86_400_000)!.categoria, 'sem_sinal');
// desligado
assert.equal(normalizar('1', 'P01', leitura({ power: 'OFF' }), agora)!.categoria, 'desligado');
// falha real vira alarme
const f = normalizar('1', 'P01', leitura({ faults: [{ fault: 'Low Pressure', fault_num: 9 }] }), agora)!;
assert.equal(f.categoria, 'alarme');
assert.equal(f.statusTxt, 'Falha: Low Pressure');
// sem leitura = nada
assert.equal(normalizar('1', 'P01', { device: { cfg } }, agora), null);
// tensão zero = sem leitura
assert.equal(normalizar('1', 'P01', leitura({ pnl_volts: 0 }), agora)!.tensaoV, null);

console.log('agsense: tudo certo');
