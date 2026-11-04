/** Verificação sem rede/banco do conector Irricontrol: npx tsx src/verificar-irricontrol.ts */
import assert from 'node:assert/strict';
import { cunhaWKT, hidraulica, laminaNoSetor, normalizar, setorPercorrido } from './irricontrol';

// Pivô em operação (formato real de /pivots/paginated/, reduzido)
const raw = {
  id: 3262,
  name: 'Pivô 32 - VII',
  controllerconfig: { content: { pivot_parameters: { speed: 264.7, flow_rate: 329.65, radius_last: 471.68, irrigated_area: 77.06 }, pivot_positions: { latitude_center: -19.557222, longitude_center: -53.255277 } } },
  controllerstream_gps: {
    current_angle: 343.6, updated: '2026-10-22T15:57:53-03:00',
    content: {
      irrigation_status: { irrigation_status: 4 }, voltage_measure: { voltage_measure: 499 }, end_tower_pressure: { end_tower_pressure: 10 },
      devices_current_status: { pump: 1, endgun: 1, motor: 1 }, operation_time: { wet_hour: 1674, wet_minute: 57 },
      current_irrigation_information: { direction: 1, irrigation_percent: 60, stop_mode: 0, stop_angle: 40 },
    },
  },
  controllerstream_panel: { current_angle: 340, updated: '2026-10-22T15:27:31-03:00', content: { irrigation_status: { irrigation_status: 38 } } },
};
const p = normalizar(raw);
assert.equal(p.categoria, 'irrigando', 'usa o fluxo mais recente (GPS), não o painel antigo');
assert.equal(p.statusTxt, 'Irrigando');
assert.equal(p.angulo, 343.6);
assert.equal(p.direcao, 1);
assert.equal(p.percentual, 60);
assert.equal(p.tensaoV, 499);
assert.equal(p.pressaoPonta, 10);
assert.equal(p.destinoAngulo, 40);
assert.ok(Math.abs(p.horasMolhado! - (1674 + 57 / 60)) < 1e-9);
assert.equal(p.bomba, true);

// pivô parado, só com fluxo de painel e sem configuração
const parado = normalizar({ id: 1, name: 'X', controllerstream_panel: { current_angle: 10, updated: '2026-10-01T10:00:00-03:00', content: { irrigation_status: { irrigation_status: 12 }, voltage_measure: { voltage_measure: 0 } } } });
assert.equal(parado.statusTxt, 'Parado via internet');
assert.equal(parado.tensaoV, null, 'tensão 0 = sem leitura');
assert.equal(parado.vazaoM3h, null);

// Pivô 14: ~11 h por volta e ~5,6 mm a 100%
const h = hidraulica({ vazaoM3h: 375.21, velocidadeMh: 262.8, raioM: 462.15, areaHa: 74.43 })!;
assert.ok(Math.abs(h.horasVolta100 - 11.05) < 0.02);
assert.ok(Math.abs(h.laminaVolta100 - 5.57) < 0.02);
assert.equal(hidraulica({ vazaoM3h: null, velocidadeMh: 1, raioM: 1, areaHa: 1 }), null);

// uma volta inteira aplica exatamente a lâmina da volta
assert.ok(Math.abs(laminaNoSetor(375.21, h.horasVolta100, 74.43, 360) - h.laminaVolta100) < 1e-9);

// fatia: sentido horário/anti-horário e virada pelo norte
assert.deepEqual(setorPercorrido(100, 102, 0), { de: 100, ate: 102, graus: 2 });
assert.deepEqual(setorPercorrido(102, 100, 1), { de: 100, ate: 102, graus: 2 });
const norte = setorPercorrido(359, 1, 0)!;
assert.ok(Math.abs(norte.graus - 2) < 1e-9);
assert.equal(setorPercorrido(100, 98, 0), null, 'andou no sentido contrário ao informado');
assert.equal(setorPercorrido(100, 100.1, 0), null, 'quase parado');
assert.equal(setorPercorrido(100, 200, 0), null, 'salto grande: leitura perdida');

// polígono da fatia: fechado, começa e termina no centro
const wkt = cunhaWKT(-19.55, -53.25, 400, 10, 14);
assert.ok(wkt.startsWith('POLYGON((-53.25 -19.55,') && wkt.endsWith(',-53.25 -19.55))'));

console.log('irricontrol: tudo certo');
