/**
 * Comandos aos pivôs (Irricontrol / AgSense) a partir do app.
 *
 * Toda a segurança fica aqui, antes de qualquer chamada à plataforma — o app (e quem aperta o botão) não decide
 * sentido nem ângulo: o servidor recalcula a partir de onde estão os animais. Cada tentativa, inclusive as
 * bloqueadas, fica registrada em comando_pivo.
 *
 * As chamadas de comando das plataformas ainda NÃO estão mapeadas (os conectores atuais são só de leitura e as
 * plataformas não publicam API). Enquanto o driver da plataforma não for preenchido, `enviar` falha com 501 depois
 * de passar por todas as travas — nada é enviado ao equipamento. Ver docs/COMANDOS.md.
 */
import { permitidoAgora, janelasDaFazenda, planoDoPivo } from './operacao';
import { pool } from './db';

export class ErroComando extends Error {
  constructor(public status: number, mensagem: string) { super(mensagem); }
}

export interface PedidoComando {
  acao: 'iniciar' | 'parar';
  /** só para 'iniciar': velocidade (% do relógio) */
  percentual?: number;
}

export interface ComandoCalculado {
  acao: 'iniciar' | 'parar';
  sentido: 0 | 1 | null;
  anguloParada: number | null;
  percentual: number | null;
  avisos: string[];
}

/** Driver de uma plataforma. Devem lançar ErroComando se a plataforma recusar. */
export interface DriverComando {
  executar(conta: { id: number; usuario: string }, pivoExterno: string, c: ComandoCalculado): Promise<void>;
}

const naoMapeado = (plataforma: string): DriverComando => ({
  async executar() {
    throw new ErroComando(501, `Comando para ${plataforma} ainda não configurado neste servidor (falta mapear a chamada da plataforma — veja docs/COMANDOS.md). Nada foi enviado ao pivô.`);
  },
});

export const drivers: Record<string, DriverComando> = {
  irricontrol: naoMapeado('Irricontrol'),
  agsense: naoMapeado('AgSense'),
};

async function registrar(telId: number, usuarioId: number, acao: string, parametros: unknown, estado: 'enviado' | 'bloqueado' | 'erro', detalhe: string | null) {
  await pool.query(`INSERT INTO comando_pivo (telemetria_pivo_id, usuario_id, acao, parametros, estado, detalhe) VALUES ($1,$2,$3,$4,$5,$6)`,
    [telId, usuarioId, acao, JSON.stringify(parametros), estado, detalhe]);
}

/** Calcula o que seria enviado e aplica as travas, sem enviar nada (usado também para pré-visualizar no app). */
export async function prepararComando(telId: number, pedido: PedidoComando) {
  const t = (await pool.query(
    `SELECT tp.id, tp.externo_id, tp.nome, tp.pivo_id, tp.angulo::float AS angulo, tp.categoria, tp.status_txt, tc.id AS conta_id, tc.usuario, tc.provedor, tc.fazenda_id
       FROM telemetria_pivo tp JOIN telemetria_conta tc ON tc.id = tp.conta_id WHERE tp.id = $1`, [telId])).rows[0];
  if (!t) throw new ErroComando(404, 'Pivô de telemetria não encontrado');

  const bloqueios: string[] = [];
  const calc: ComandoCalculado = { acao: pedido.acao, sentido: null, anguloParada: null, percentual: null, avisos: [] };

  if (pedido.acao === 'iniciar') {
    if (t.categoria === 'alarme') bloqueios.push(`O pivô está em alarme (${t.status_txt}).`);
    if (t.categoria === 'sem_sinal') bloqueios.push('O pivô está sem comunicação.');
    if (t.categoria === 'irrigando') bloqueios.push('O pivô já está irrigando.');

    const janelas = await janelasDaFazenda(t.fazenda_id);
    if (!permitidoAgora(janelas)) bloqueios.push('Fora do horário de irrigação permitido (custo de energia).');

    if (t.pivo_id != null) {
      const plano = await planoDoPivo(t.pivo_id, t.fazenda_id, t.angulo);
      calc.sentido = plano.sentido;
      calc.anguloParada = plano.anguloParada;
      calc.avisos = plano.avisos;
      if (plano.situacao === 'bloqueado') bloqueios.push('Todos os piquetes do pivô têm animais.');
      if (plano.avisos.some((a) => /sobre área ocupada/.test(a))) bloqueios.push('O pivô está parado sobre um piquete com animais: mova a seco para a área livre primeiro.');
      const ord = (await pool.query(`SELECT percentual::float AS p FROM ordem_irrigacao WHERE pivo_id = $1 AND data = (now() AT TIME ZONE $2)::date AND status IN ('planejada','enviada') ORDER BY id DESC LIMIT 1`, [t.pivo_id, process.env.TZ ?? 'America/Campo_Grande'])).rows[0];
      calc.percentual = pedido.percentual ?? ord?.p ?? null;
    } else {
      bloqueios.push('Este pivô ainda não está vinculado ao mapa: não dá para saber onde estão os animais.');
    }
    if (calc.percentual != null && (calc.percentual < 1 || calc.percentual > 100)) bloqueios.push('Percentual de velocidade inválido.');
  }
  return { t, calc, bloqueios };
}

export async function enviarComando(telId: number, pedido: PedidoComando, usuarioId: number) {
  const { t, calc, bloqueios } = await prepararComando(telId, pedido);
  if (bloqueios.length) {
    await registrar(telId, usuarioId, pedido.acao, calc, 'bloqueado', bloqueios.join(' '));
    throw new ErroComando(409, bloqueios.join(' '));
  }
  const driver = drivers[t.provedor];
  try {
    await driver.executar({ id: t.conta_id, usuario: t.usuario }, t.externo_id, calc);
  } catch (e) {
    await registrar(telId, usuarioId, pedido.acao, calc, 'erro', (e as Error).message);
    throw e;
  }
  await registrar(telId, usuarioId, pedido.acao, calc, 'enviado', null);
  if (pedido.acao === 'iniciar' && t.pivo_id != null) {
    await pool.query(`UPDATE ordem_irrigacao SET status = 'enviada' WHERE pivo_id = $1 AND data = (now() AT TIME ZONE $2)::date AND status = 'planejada'`, [t.pivo_id, process.env.TZ ?? 'America/Campo_Grande']);
  }
  return { ok: true, comando: calc };
}
