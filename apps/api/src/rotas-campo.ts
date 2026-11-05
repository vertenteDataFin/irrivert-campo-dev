/** Rotas do módulo de campo: plano do dia, roteiro, vistorias (com fotos), ativos compartilhados e falhas. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ativosDaFazenda, planoDeCampo, salvarRoteiro, salvarVistoria, TIPOS_ATIVO, vistoriasDoDia } from './campo';
import { hoje, pool } from './db';

type Usuario = { id: number; email: string; nome: string; papel: 'operador' | 'gestor' | 'admin' };
interface Ajudas {
  auth: { preHandler: (req: FastifyRequest, rep: FastifyReply) => Promise<unknown> };
  gestor: { preHandler: (req: FastifyRequest, rep: FastifyReply) => Promise<unknown> };
  podeFazenda: (u: Usuario, fazendaId: number) => Promise<boolean>;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const dataIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dataUrl = z.string().max(4_500_000).regex(/^data:image\/(jpeg|png|webp);base64,/);

const vistoriaCorpo = z.object({
  clientUuid: z.string().uuid(),
  pivoId: z.number().int().positive(),
  ordemId: z.number().int().positive().nullish(),
  data: dataIso,
  tipo: z.enum(['rapida', 'completa']),
  iniciadaEm: z.string().datetime({ offset: true }),
  concluidaEm: z.string().datetime({ offset: true }).nullish(),
  suspeita: z.string().trim().max(200).nullish(),
  passoEntrada: z.number().int().min(1).max(6).nullish(),
  integridade: z.object({
    pneus: z.boolean().nullish(), bicos: z.boolean().nullish(), estrutura: z.boolean().nullish(), caminho: z.boolean().nullish(),
    posicaoGraus: z.number().min(0).max(360).nullish(), gadoPiquetes: z.array(z.number().int()).max(40).nullish(), observacao: z.string().trim().max(1000).nullish(),
  }).default({}),
  leituras: z.object({
    pressaoBar: z.number().min(0).max(30).nullish(), fonteEnergia: z.enum(['rede', 'usina', 'gerador']).nullish(),
    tensaoV: z.number().min(0).max(1000).nullish(), painelRespondeu: z.boolean().nullish(),
  }).default({}),
  configPainel: z.object({
    modelo: z.string().trim().max(60).nullish(), sentido: z.enum(['horario', 'anti_horario']).nullish(),
    percentimetro: z.number().min(1).max(100).nullish(), laminaMm: z.number().min(0).max(100).nullish(),
    agua: z.enum(['com_agua', 'a_seco']).nullish(), setorDe: z.number().min(0).max(360).nullish(), setorAte: z.number().min(0).max(360).nullish(),
    partidaEm: z.string().datetime({ offset: true }).nullish(),
  }).nullish(),
  falha: z.object({
    passo: z.number().int().min(1).max(6).nullish(),
    origem: z.enum(['pivo', ...TIPOS_ATIVO]),
    ativoId: z.number().int().positive().nullish(),
    local: z.string().trim().max(120).nullish(), descricao: z.string().trim().max(1000).nullish(), previsao: z.string().trim().max(120).nullish(),
  }).nullish(),
  resolvidoLocal: z.boolean().nullish(),
  resultado: z.enum(['operando', 'partida_local', 'nao_iniciou']),
  observacao: z.string().trim().max(2000).nullish(),
  fotos: z.array(z.object({ tipo: z.enum(['painel', 'ultima_torre', 'quadro', 'outro']), dados: dataUrl })).max(4).default([]),
});

const ativoCorpo = z.object({
  tipo: z.enum(TIPOS_ATIVO),
  nome: z.string().trim().min(1).max(80),
  observacao: z.string().trim().max(500).nullish(),
  pivos: z.array(z.number().int().positive()).max(100).default([]),
});

export function registrarCampo(app: FastifyInstance, { auth, gestor, podeFazenda }: Ajudas) {
  const acesso = async (req: FastifyRequest, rep: FastifyReply, fazendaId: number) => {
    if (await podeFazenda(req.user as Usuario, fazendaId)) return true;
    rep.code(403).send({ erro: 'Sem acesso à fazenda' });
    return false;
  };
  const fazendaDoPivo = async (pivoId: number) => (await pool.query(`SELECT fazenda_id FROM pivo WHERE id = $1`, [pivoId])).rows[0]?.fazenda_id as number | undefined;
  const fazendaDoAtivo = async (ativoId: number) => (await pool.query(`SELECT fazenda_id FROM ativo_compartilhado WHERE id = $1`, [ativoId])).rows[0]?.fazenda_id as number | undefined;

  // ---------- plano do dia (ordem + pivôs + ativos + roteiro) ----------
  app.get('/api/fazendas/:id/campo', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    const q = z.object({ data: dataIso.optional() }).parse(req.query);
    return planoDeCampo(id, q.data ?? hoje());
  });

  // ---------- roteiro editável ----------
  app.put('/api/fazendas/:id/campo/roteiro', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    const c = z.object({
      data: dataIso.optional(),
      saida: hhmm.nullish(),
      paradas: z.array(z.object({ tipo: z.enum(['pivo', 'ativo']), id: z.number().int().positive(), nota: z.string().trim().max(200).nullish() })).max(200),
    }).safeParse(req.body);
    if (!c.success) return rep.code(400).send({ erro: 'Roteiro inválido', detalhes: c.error.flatten() });
    return salvarRoteiro(id, c.data.data ?? hoje(), c.data.saida ?? null, c.data.paradas, (req.user as Usuario).id);
  });

  // ---------- vistorias ----------
  // Fotos em JSON (data URL reduzida no app), como nos movimentos de animais: funciona na fila offline.
  app.post('/api/vistorias', { ...auth, bodyLimit: 20 * 1024 * 1024 }, async (req, rep) => {
    const c = vistoriaCorpo.safeParse(req.body);
    if (!c.success) return rep.code(400).send({ erro: 'Vistoria inválida', detalhes: c.error.flatten() });
    const faz = await fazendaDoPivo(c.data.pivoId);
    if (faz == null) return rep.code(404).send({ erro: 'Pivô não encontrado' });
    if (!(await acesso(req, rep, faz))) return;
    if (c.data.falha?.ativoId != null && (await fazendaDoAtivo(c.data.falha.ativoId)) !== faz) return rep.code(400).send({ erro: 'Ativo de outra fazenda' });
    const r = await salvarVistoria(c.data, (req.user as Usuario).id);
    return { ok: true, ...r };
  });

  app.get('/api/fazendas/:id/campo/vistorias', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    const q = z.object({ data: dataIso.optional() }).parse(req.query);
    return { data: q.data ?? hoje(), vistorias: await vistoriasDoDia(id, q.data ?? hoje()) };
  });

  app.get('/api/vistorias/fotos/:id', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const f = (await pool.query(`SELECT f.foto, f.foto_tipo, pv.fazenda_id FROM vistoria_foto f JOIN vistoria v ON v.id = f.vistoria_id JOIN pivo pv ON pv.id = v.pivo_id WHERE f.id = $1`, [id])).rows[0];
    if (!f) return rep.code(404).send({ erro: 'Sem foto' });
    if (!(await acesso(req, rep, f.fazenda_id))) return;
    return rep.header('Content-Type', f.foto_tipo).header('Cache-Control', 'private, max-age=86400').send(f.foto);
  });

  // ---------- ativos compartilhados (casa de bomba, transformador, rede…) ----------
  app.get('/api/fazendas/:id/ativos', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    return ativosDaFazenda(id);
  });

  app.post('/api/fazendas/:id/ativos', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    const c = ativoCorpo.safeParse(req.body);
    if (!c.success) return rep.code(400).send({ erro: 'Ativo inválido', detalhes: c.error.flatten() });
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      const a = await cli.query(`INSERT INTO ativo_compartilhado (fazenda_id, tipo, nome, observacao) VALUES ($1,$2,$3,$4) ON CONFLICT (fazenda_id, nome) DO NOTHING RETURNING id`, [id, c.data.tipo, c.data.nome, c.data.observacao ?? null]);
      if (a.rowCount === 0) { await cli.query('ROLLBACK'); return rep.code(409).send({ erro: 'Já existe um ativo com esse nome' }); }
      for (const p of new Set(c.data.pivos)) await cli.query(`INSERT INTO ativo_pivo (ativo_id, pivo_id) SELECT $1, id FROM pivo WHERE id = $2 AND fazenda_id = $3 ON CONFLICT DO NOTHING`, [a.rows[0].id, p, id]);
      await cli.query('COMMIT');
    } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
    return ativosDaFazenda(id);
  });

  app.put('/api/ativos/:id', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const faz = await fazendaDoAtivo(id);
    if (faz == null) return rep.code(404).send({ erro: 'Ativo não encontrado' });
    if (!(await acesso(req, rep, faz))) return;
    const c = ativoCorpo.extend({ ativo: z.boolean().optional() }).safeParse(req.body);
    if (!c.success) return rep.code(400).send({ erro: 'Ativo inválido', detalhes: c.error.flatten() });
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      await cli.query(`UPDATE ativo_compartilhado SET tipo = $2, nome = $3, observacao = $4, ativo = COALESCE($5, ativo) WHERE id = $1`, [id, c.data.tipo, c.data.nome, c.data.observacao ?? null, c.data.ativo ?? null]);
      await cli.query(`DELETE FROM ativo_pivo WHERE ativo_id = $1`, [id]);
      for (const p of new Set(c.data.pivos)) await cli.query(`INSERT INTO ativo_pivo (ativo_id, pivo_id) SELECT $1, id FROM pivo WHERE id = $2 AND fazenda_id = $3 ON CONFLICT DO NOTHING`, [id, p, faz]);
      await cli.query('COMMIT');
    } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
    return ativosDaFazenda(faz);
  });

  app.delete('/api/ativos/:id', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const faz = await fazendaDoAtivo(id);
    if (faz == null) return rep.code(404).send({ erro: 'Ativo não encontrado' });
    if (!(await acesso(req, rep, faz))) return;
    await pool.query(`DELETE FROM ativo_compartilhado WHERE id = $1`, [id]);
    return { ok: true };
  });

  // ---------- falhas em ativos (abrir fora da vistoria, encerrar quando regulariza) ----------
  app.post('/api/ativos/:id/falhas', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const faz = await fazendaDoAtivo(id);
    if (faz == null) return rep.code(404).send({ erro: 'Ativo não encontrado' });
    if (!(await acesso(req, rep, faz))) return;
    const c = z.object({ descricao: z.string().trim().min(1).max(1000), previsao: z.string().trim().max(120).nullish() }).safeParse(req.body);
    if (!c.success) return rep.code(400).send({ erro: 'Falha inválida' });
    const aberta = (await pool.query(`SELECT id FROM falha_ativo WHERE ativo_id = $1 AND encerrada_em IS NULL`, [id])).rows[0];
    if (aberta) return rep.code(409).send({ erro: 'Este ativo já tem uma falha aberta' });
    await pool.query(`INSERT INTO falha_ativo (ativo_id, descricao, previsao, usuario_id) VALUES ($1,$2,$3,$4)`, [id, c.data.descricao, c.data.previsao ?? null, (req.user as Usuario).id]);
    return ativosDaFazenda(faz);
  });

  app.put('/api/falhas-ativo/:id/encerrar', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const f = (await pool.query(`SELECT a.fazenda_id FROM falha_ativo f JOIN ativo_compartilhado a ON a.id = f.ativo_id WHERE f.id = $1`, [id])).rows[0];
    if (!f) return rep.code(404).send({ erro: 'Falha não encontrada' });
    if (!(await acesso(req, rep, f.fazenda_id))) return;
    await pool.query(`UPDATE falha_ativo SET encerrada_em = now() WHERE id = $1 AND encerrada_em IS NULL`, [id]);
    return ativosDaFazenda(f.fazenda_id);
  });

  // ---------- situação do pivô (inoperante com necessidade) e modelo do painel ----------
  app.put('/api/pivos/:id/situacao', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const faz = await fazendaDoPivo(id);
    if (faz == null) return rep.code(404).send({ erro: 'Pivô não encontrado' });
    if (!(await acesso(req, rep, faz))) return;
    const c = z.object({
      inoperanteDesde: dataIso.nullish(), inoperanteMotivo: z.string().trim().max(300).nullish(), reparoPrevisto: dataIso.nullish(),
      painelModelo: z.string().trim().max(60).nullish(),
    }).safeParse(req.body);
    if (!c.success) return rep.code(400).send({ erro: 'Dados inválidos' });
    const d = c.data;
    await pool.query(`UPDATE pivo SET inoperante_desde = $2, inoperante_motivo = $3, reparo_previsto = $4, painel_modelo = COALESCE($5, painel_modelo) WHERE id = $1`,
      [id, d.inoperanteDesde ?? null, d.inoperanteDesde ? d.inoperanteMotivo ?? null : null, d.inoperanteDesde ? d.reparoPrevisto ?? null : null, d.painelModelo ?? null]);
    return { ok: true };
  });

  // ---------- orientação de manejo: tirar da ordem com motivo (o déficit fica registrado como intencional) ----------
  app.put('/api/ordem/:id/manejo', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const c = z.object({ motivo: z.string().trim().min(1).max(300) }).safeParse(req.body);
    if (!c.success) return rep.code(400).send({ erro: 'Informe o motivo' });
    const o = (await pool.query(`SELECT fazenda_id, status FROM ordem_irrigacao WHERE id = $1`, [id])).rows[0];
    if (!o) return rep.code(404).send({ erro: 'Ordem não encontrada' });
    if (!(await acesso(req, rep, o.fazenda_id))) return;
    if (o.status === 'concluida') return rep.code(409).send({ erro: 'Ordem já concluída' });
    await pool.query(`UPDATE ordem_irrigacao SET status = 'cancelada', motivo = $2 WHERE id = $1`, [id, c.data.motivo]);
    return { ok: true };
  });
}
