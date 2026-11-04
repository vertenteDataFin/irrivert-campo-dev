/** Verificação sem rede/banco das regras de alerta: npx tsx src/verificar-alertas.ts */
import assert from 'node:assert/strict';
import { decidir, telefoneWa, type AguaPivo, type TelAlerta } from './alertas';

const t = (o: Partial<TelAlerta> & { id: number }): TelAlerta => ({ pivoId: null, nome: `Pivô ${o.id}`, categoria: 'parado', statusTxt: 'Parado', atualizadoEm: '2026-10-22T18:00:00Z', ...o });
const agua = (irrigar: boolean): AguaPivo => ({ pivoNome: 'PIVÔ 14', laminaMm: 20, limiteMm: 25, irrigar });

// parado + precisa irrigar = alerta alto
let r = decidir([t({ id: 1, pivoId: 14 })], new Map([[14, agua(true)]]));
assert.equal(r.length, 1);
assert.equal(r[0].tipo, 'parado_precisa');
assert.equal(r[0].severidade, 'alta');
assert.equal(r[0].chave, 'parado_precisa:14');
assert.match(r[0].mensagem, /precisa irrigar/);

// parado mas a lâmina está em dia: nada
assert.equal(decidir([t({ id: 1, pivoId: 14 })], new Map([[14, agua(false)]])).length, 0);
// irrigando e precisando: é o esperado, nada
assert.equal(decidir([t({ id: 1, pivoId: 14, categoria: 'irrigando' })], new Map([[14, agua(true)]])).length, 0);
// aguardando pressão/ligando: ainda não é problema
assert.equal(decidir([t({ id: 1, pivoId: 14, categoria: 'aguardando' })], new Map([[14, agua(true)]])).length, 0);
// pivô sem vínculo com o mapa não gera "precisa irrigar"
assert.equal(decidir([t({ id: 1 })], new Map([[14, agua(true)]])).length, 0);
// desligado + precisa irrigar também alerta
assert.equal(decidir([t({ id: 1, pivoId: 14, categoria: 'desligado' })], new Map([[14, agua(true)]]))[0].tipo, 'parado_precisa');

// alarme e sem sinal
r = decidir([t({ id: 2, categoria: 'alarme', statusTxt: 'Queda de energia' }), t({ id: 3, categoria: 'sem_sinal', statusTxt: 'Sem comunicação' })], new Map());
assert.deepEqual(r.map((x) => [x.tipo, x.severidade]), [['alarme', 'alta'], ['sem_sinal', 'media']]);
assert.match(r[0].mensagem, /Queda de energia/);

// a chave não muda entre rodadas (é o que evita mensagem repetida)
assert.equal(decidir([t({ id: 2, categoria: 'alarme' })], new Map())[0].chave, decidir([t({ id: 2, categoria: 'alarme', statusTxt: 'outro texto' })], new Map())[0].chave);

assert.equal(telefoneWa('(67) 99999-1234'), '5567999991234');
assert.equal(telefoneWa('+55 67 99999-1234'), '5567999991234');

console.log('alertas: tudo certo');
