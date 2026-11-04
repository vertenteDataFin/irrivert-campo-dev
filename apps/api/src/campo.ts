/**
 * Módulo de campo: o que a equipe vê antes de sair (plano do dia e roteiro) e o que ela registra no pivô (vistoria).
 *
 * Regra da fazenda: todo pivô com ordem do dia recebe vistoria presencial; o comando remoto só encurta a vistoria.
 * Falha num ativo compartilhado (casa de bomba, transformador, rede…) vale para todos os pivôs que ele alimenta.
 */
import { hoje, pool } from './db';
import { arcosDasParcelas, lerOrdem, piquetesDaFazenda } from './operacao';

export const TIPOS_ATIVO = ['casa_bomba', 'transformador', 'rede', 'usina', 'captacao', 'reservatorio', 'adutora'] as const;
export type TipoAtivo = (typeof TIPOS_ATIVO)[number];

export interface Ativo {
  id: number; tipo: TipoAtivo; nome: string; observacao: string | null; ativo: boolean; pivos: number[];
  falha: { id: number; descricao: string; previsao: string | null; abertaEm: string } | null;
}

export async function ativosDaFazenda(fazendaId: number): Promise<Ativo[]> {
  const r = await pool.query(
    `SELECT a.id, a.tipo, a.nome, a.observacao, a.ativo,
            COALESCE(array_agg(ap.pivo_id ORDER BY ap.pivo_id) FILTER (WHERE ap.pivo_id IS NOT NULL), '{}') AS pivos,
            f.id AS "falhaId", f.descricao, f.previsao, f.aberta_em AS "abertaEm"
       FROM ativo_compartilhado a
       LEFT JOIN ativo_pivo ap ON ap.ativo_id = a.id
       LEFT JOIN LATERAL (SELECT id, descricao, previsao, aberta_em FROM falha_ativo WHERE ativo_id = a.id AND encerrada_em IS NULL ORDER BY aberta_em DESC LIMIT 1) f ON true
      WHERE a.fazenda_id = $1
      GROUP BY a.id, f.id, f.descricao, f.previsao, f.aberta_em
      ORDER BY a.tipo, a.nome`, [fazendaId]);
  return r.rows.map((x) => ({
    id: x.id, tipo: x.tipo, nome: x.nome, observacao: x.observacao, ativo: x.ativo, pivos: x.pivos as number[],
    falha: x.falhaId ? { id: x.falhaId, descricao: x.descricao, previsao: x.previsao, abertaEm: new Date(x.abertaEm).toISOString() } : null,
  }));
}

/** Pivô do ponto de vista de quem vai a campo: situação do equipamento, telemetria, gado nos piquetes e a vistoria de hoje. */
export interface PivoCampo {
  id: number; nome: string; culturas: string | null; painelModelo: string | null;
  inoperanteDesde: string | null; inoperanteMotivo: string | null; reparoPrevisto: string | null;
  telemetria: { id: number; provedor: string; categoria: string | null; statusTxt: string | null; angulo: number | null; atualizadoEm: string | null } | null;
  /** Piquetes de pastagem do pivô, com o arco que cada um ocupa (graus a partir do norte, sentido horário) e se há animais agora. */
  piquetes: { id: number; nome: string; de: number | null; ate: number | null; ocupado: boolean }[];
  gado: { piquete: string; de: number | null; ate: number | null }[];
  vistoriaHoje: { id: number; tipo: string; resultado: string; concluidaEm: string | null; usuario: string | null } | null;
}

export async function pivosDeCampo(fazendaId: number, data: string): Promise<PivoCampo[]> {
  const r = await pool.query(
    `SELECT pv.id, pv.nome, pv.painel_modelo AS "painelModelo", pv.inoperante_desde AS "inoperanteDesde", pv.inoperante_motivo AS "inoperanteMotivo", pv.reparo_previsto AS "reparoPrevisto",
            (SELECT string_agg(DISTINCT c.nome, ', ') FROM parcela p JOIN cultura c ON c.id = p.cultura_id WHERE p.pivo_id = pv.id AND p.ativo) AS culturas,
            tp.id AS "telId", tp.provedor, tp.categoria, tp.status_txt AS "statusTxt", tp.angulo::float AS angulo, tp.atualizado_em AS "atualizadoEm",
            v.id AS "visId", v.tipo AS "visTipo", v.resultado AS "visResultado", v.concluida_em AS "visConcluida", v.usuario AS "visUsuario"
       FROM pivo pv
       LEFT JOIN LATERAL (SELECT t.id, c.provedor, t.categoria, t.status_txt, t.angulo, t.atualizado_em FROM telemetria_pivo t JOIN telemetria_conta c ON c.id = t.conta_id WHERE t.pivo_id = pv.id ORDER BY t.id LIMIT 1) tp ON true
       LEFT JOIN LATERAL (SELECT v.id, v.tipo, v.resultado, v.concluida_em, u.nome AS usuario FROM vistoria v LEFT JOIN usuario u ON u.id = v.usuario_id WHERE v.pivo_id = pv.id AND v.data = $2 ORDER BY v.concluida_em DESC NULLS LAST, v.id DESC LIMIT 1) v ON true
      WHERE pv.fazenda_id = $1 AND pv.ativo`, [fazendaId, data]);

  // piquetes de pastagem de cada pivô, com o arco (graus a partir do norte) que cada um ocupa, e quais têm animais agora
  const todos = await piquetesDaFazenda(fazendaId);
  const piquetes = new Map<number, PivoCampo['piquetes']>();
  for (const pivoId of new Set(todos.map((p) => p.pivoId))) {
    const arcos = await arcosDasParcelas(pivoId);
    piquetes.set(pivoId, todos.filter((p) => p.pivoId === pivoId).map((p) => {
      const a = arcos.get(p.parcelaId);
      return { id: p.parcelaId, nome: p.nome, de: a ? Math.round(a.de) : null, ate: a ? Math.round(a.ate) : null, ocupado: p.ocupado };
    }));
  }

  const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
  return r.rows
    .map((x) => ({
      id: x.id, nome: x.nome, culturas: x.culturas, painelModelo: x.painelModelo,
      inoperanteDesde: x.inoperanteDesde, inoperanteMotivo: x.inoperanteMotivo, reparoPrevisto: x.reparoPrevisto,
      telemetria: x.telId ? { id: x.telId, provedor: x.provedor, categoria: x.categoria, statusTxt: x.statusTxt, angulo: x.angulo, atualizadoEm: iso(x.atualizadoEm) } : null,
      piquetes: piquetes.get(x.id) ?? [],
      gado: (piquetes.get(x.id) ?? []).filter((p) => p.ocupado).map((p) => ({ piquete: p.nome, de: p.de, ate: p.ate })),
      vistoriaHoje: x.visId ? { id: x.visId, tipo: x.visTipo, resultado: x.visResultado, concluidaEm: iso(x.visConcluida), usuario: x.visUsuario } : null,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
}

export interface Parada { tipo: 'pivo' | 'ativo'; id: number; nota?: string | null }

export async function lerRoteiro(fazendaId: number, data: string) {
  const r = (await pool.query(`SELECT saida, paradas, atualizado_em AS "atualizadoEm" FROM roteiro_dia WHERE fazenda_id = $1 AND data = $2`, [fazendaId, data])).rows[0];
  return r ? { saida: r.saida ? String(r.saida).slice(0, 5) : null, paradas: r.paradas as Parada[], atualizadoEm: new Date(r.atualizadoEm).toISOString() } : null;
}

export async function salvarRoteiro(fazendaId: number, data: string, saida: string | null, paradas: Parada[], usuarioId: number) {
  await pool.query(
    `INSERT INTO roteiro_dia (fazenda_id, data, saida, paradas, usuario_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (fazenda_id, data) DO UPDATE SET saida = EXCLUDED.saida, paradas = EXCLUDED.paradas, usuario_id = EXCLUDED.usuario_id, atualizado_em = now()`,
    [fazendaId, data, saida, JSON.stringify(paradas), usuarioId]);
  return lerRoteiro(fazendaId, data);
}

/** Tudo que o app de campo precisa para o dia: ordem, pivôs, ativos e roteiro. Guardado no aparelho para abrir sem internet. */
export async function planoDeCampo(fazendaId: number, data: string = hoje()) {
  const [ordem, pivos, ativos, roteiro] = await Promise.all([lerOrdem(fazendaId, data), pivosDeCampo(fazendaId, data), ativosDaFazenda(fazendaId), lerRoteiro(fazendaId, data)]);
  return { data, ordem, pivos, ativos, roteiro };
}

export interface FotoEntrada { tipo: 'painel' | 'ultima_torre' | 'quadro' | 'outro'; dados: string }

export interface VistoriaEntrada {
  clientUuid: string; pivoId: number; ordemId?: number | null; data: string; tipo: 'rapida' | 'completa';
  iniciadaEm: string; concluidaEm?: string | null; suspeita?: string | null; passoEntrada?: number | null;
  integridade: Record<string, unknown>; leituras: Record<string, unknown>;
  configPainel?: Record<string, unknown> | null;
  falha?: { passo?: number | null; origem: string; ativoId?: number | null; local?: string | null; descricao?: string | null; previsao?: string | null } | null;
  resolvidoLocal?: boolean | null; resultado: 'operando' | 'partida_local' | 'nao_iniciou'; observacao?: string | null;
  fotos: FotoEntrada[];
}

/** Grava a vistoria (idempotente pelo client_uuid), as fotos, a falha no ativo compartilhado e o avanço da ordem. */
export async function salvarVistoria(v: VistoriaEntrada, usuarioId: number): Promise<{ id: number | null; duplicado: boolean }> {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const ins = await cli.query(
      `INSERT INTO vistoria (client_uuid, pivo_id, ordem_id, data, tipo, iniciada_em, concluida_em, usuario_id, suspeita, passo_entrada, integridade, leituras, config_painel, falha, resolvido_local, resultado, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (client_uuid) DO NOTHING RETURNING id`,
      [v.clientUuid, v.pivoId, v.ordemId ?? null, v.data, v.tipo, v.iniciadaEm, v.concluidaEm ?? null, usuarioId, v.suspeita ?? null, v.passoEntrada ?? null,
        JSON.stringify(v.integridade ?? {}), JSON.stringify(v.leituras ?? {}), v.configPainel ? JSON.stringify(v.configPainel) : null, v.falha ? JSON.stringify(v.falha) : null,
        v.resolvidoLocal ?? null, v.resultado, v.observacao ?? null]);
    if (ins.rowCount === 0) { await cli.query('ROLLBACK'); return { id: null, duplicado: true }; }
    const id = ins.rows[0].id as number;

    for (const f of v.fotos ?? []) {
      const m = f.dados.match(/^data:(image\/[a-z]+);base64,(.*)$/s);
      if (!m) continue;
      await cli.query(`INSERT INTO vistoria_foto (vistoria_id, tipo, foto, foto_tipo) VALUES ($1,$2,$3,$4)`, [id, f.tipo, Buffer.from(m[2], 'base64'), m[1]]);
    }

    // falha num ativo compartilhado, não resolvida no local: abre uma vez e vale para todos os pivôs do ativo
    if (v.falha?.ativoId && !v.resolvidoLocal) {
      const aberta = (await cli.query(`SELECT id FROM falha_ativo WHERE ativo_id = $1 AND encerrada_em IS NULL`, [v.falha.ativoId])).rows[0];
      if (!aberta) {
        await cli.query(`INSERT INTO falha_ativo (ativo_id, descricao, previsao, usuario_id) VALUES ($1,$2,$3,$4)`,
          [v.falha.ativoId, v.falha.descricao || `${v.falha.origem}${v.falha.local ? ` · ${v.falha.local}` : ''}`, v.falha.previsao ?? null, usuarioId]);
      }
    }

    // pivô comprovadamente em operação (pelo remoto ou pela partida no painel): a ordem avança de planejada para enviada
    if (v.ordemId && v.resultado !== 'nao_iniciou') {
      await cli.query(`UPDATE ordem_irrigacao SET status = 'enviada' WHERE id = $1 AND status = 'planejada'`, [v.ordemId]);
    }
    await cli.query('COMMIT');
    return { id, duplicado: false };
  } catch (e) {
    await cli.query('ROLLBACK');
    throw e;
  } finally {
    cli.release();
  }
}

/** Vistorias do dia, para a aba Registros (sem as fotos; elas vêm por rota própria). */
export async function vistoriasDoDia(fazendaId: number, data: string) {
  const r = await pool.query(
    `SELECT v.id, v.client_uuid AS "clientUuid", v.pivo_id AS "pivoId", pv.nome AS "pivoNome", v.ordem_id AS "ordemId", v.tipo, v.iniciada_em AS "iniciadaEm", v.concluida_em AS "concluidaEm",
            u.nome AS usuario, v.suspeita, v.passo_entrada AS "passoEntrada", v.integridade, v.leituras, v.config_painel AS "configPainel", v.falha, v.resolvido_local AS "resolvidoLocal",
            v.resultado, v.observacao,
            COALESCE((SELECT json_agg(json_build_object('id', f.id, 'tipo', f.tipo) ORDER BY f.id) FROM vistoria_foto f WHERE f.vistoria_id = v.id), '[]'::json) AS fotos
       FROM vistoria v JOIN pivo pv ON pv.id = v.pivo_id LEFT JOIN usuario u ON u.id = v.usuario_id
      WHERE pv.fazenda_id = $1 AND v.data = $2
      ORDER BY COALESCE(v.concluida_em, v.iniciada_em) DESC, v.id DESC`, [fazendaId, data]);
  return r.rows.map((x) => ({ ...x, iniciadaEm: new Date(x.iniciadaEm).toISOString(), concluidaEm: x.concluidaEm ? new Date(x.concluidaEm).toISOString() : null }));
}
