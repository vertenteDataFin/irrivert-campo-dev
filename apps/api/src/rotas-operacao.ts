/** Rotas de relatórios, pastejo (animais), janelas de energia, ordem de irrigação e comandos aos pivôs. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { enviarComando, ErroComando, prepararComando } from './comandos';
import { hoje, pool } from './db';
import { gerarOrdem, janelasDaFazenda, lerOrdem, piquetesDaFazenda } from './operacao';
import { relatorio } from './relatorio';

type Usuario = { id: number; email: string; nome: string; papel: 'operador' | 'gestor' | 'admin' };
interface Ajudas {
  auth: { preHandler: (req: FastifyRequest, rep: FastifyReply) => Promise<unknown> };
  gestor: { preHandler: (req: FastifyRequest, rep: FastifyReply) => Promise<unknown> };
  podeFazenda: (u: Usuario, fazendaId: number) => Promise<boolean>;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const dataIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export function registrarOperacao(app: FastifyInstance, { auth, gestor, podeFazenda }: Ajudas) {
  const acesso = async (req: FastifyRequest, rep: FastifyReply, fazendaId: number) => {
    if (await podeFazenda(req.user as Usuario, fazendaId)) return true;
    rep.code(403).send({ erro: 'Sem acesso à fazenda' });
    return false;
  };

  // ---------- relatórios ----------
  app.get('/api/fazendas/:id/relatorio', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    const q = z.object({ de: dataIso.optional(), ate: dataIso.optional() }).parse(req.query);
    const ate = q.ate ?? hoje();
    const de = q.de ?? new Date(Date.parse(`${ate}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    if (de > ate) return rep.code(400).send({ erro: 'A data inicial é depois da final' });
    if (Date.parse(ate) - Date.parse(de) > 92 * 86_400_000) return rep.code(400).send({ erro: 'Período máximo: 92 dias' });
    return relatorio(id, de, ate);
  });

  // ---------- pastejo: piquetes e movimentos ----------
  app.get('/api/fazendas/:id/pastejo', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    const recentes = (await pool.query(
      `SELECT m.id, p.id AS "parcelaId", p.nome AS piquete, pv.nome AS "pivoNome", m.tipo, m.ocorrido_em AS "em", m.nota, m.cabecas, m.lote, m.observacao,
              (m.foto IS NOT NULL) AS "temFoto", u.nome AS usuario
         FROM movimento_animal m JOIN parcela p ON p.id = m.parcela_id JOIN pivo pv ON pv.id = p.pivo_id LEFT JOIN usuario u ON u.id = m.usuario_id
        WHERE pv.fazenda_id = $1 ORDER BY m.ocorrido_em DESC, m.id DESC LIMIT 60`, [id])).rows;
    return { piquetes: await piquetesDaFazenda(id), recentes };
  });

  // Foto em JSON (data URL já reduzida pelo app): evita dependência de multipart e funciona na fila offline.
  const movimentoCorpo = z.object({
    clientUuid: z.string().uuid(),
    parcelaId: z.number().int().positive(),
    tipo: z.enum(['entrada', 'saida']),
    ocorridoEm: z.string().datetime({ offset: true }),
    lote: z.string().trim().max(80).nullish(),
    cabecas: z.number().int().min(0).max(100_000).nullish(),
    nota: z.number().int().min(1).max(5).nullish(),
    observacao: z.string().trim().max(1000).nullish(),
    foto: z.string().max(4_500_000).regex(/^data:image\/(jpeg|png|webp);base64,/).nullish(),
  });

  app.post('/api/movimentos', { ...auth, bodyLimit: 6 * 1024 * 1024 }, async (req, rep) => {
    const c = movimentoCorpo.safeParse(req.body);
    if (!c.success) return rep.code(400).send({ erro: 'Dados inválidos', detalhes: c.error.flatten() });
    const b = c.data;
    const faz = (await pool.query(`SELECT pv.fazenda_id FROM parcela p JOIN pivo pv ON pv.id = p.pivo_id WHERE p.id = $1`, [b.parcelaId])).rows[0];
    if (!faz) return rep.code(404).send({ erro: 'Piquete não encontrado' });
    if (!(await acesso(req, rep, faz.fazenda_id))) return;
    let foto: Buffer | null = null;
    let fotoTipo: string | null = null;
    if (b.foto) {
      const m = b.foto.match(/^data:(image\/[a-z]+);base64,(.*)$/s)!;
      fotoTipo = m[1];
      foto = Buffer.from(m[2], 'base64');
    }
    const r = await pool.query(
      `INSERT INTO movimento_animal (client_uuid, parcela_id, tipo, ocorrido_em, lote, cabecas, nota, observacao, foto, foto_tipo, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (client_uuid) DO NOTHING RETURNING id`,
      [b.clientUuid, b.parcelaId, b.tipo, b.ocorridoEm, b.lote ?? null, b.cabecas ?? null, b.nota ?? null, b.observacao ?? null, foto, fotoTipo, (req.user as Usuario).id],
    );
    return { ok: true, duplicado: r.rowCount === 0 };
  });

  app.get('/api/movimentos/:id/foto', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const m = (await pool.query(`SELECT m.foto, m.foto_tipo, pv.fazenda_id FROM movimento_animal m JOIN parcela p ON p.id = m.parcela_id JOIN pivo pv ON pv.id = p.pivo_id WHERE m.id = $1`, [id])).rows[0];
    if (!m?.foto) return rep.code(404).send({ erro: 'Sem foto' });
    if (!(await acesso(req, rep, m.fazenda_id))) return;
    return rep.header('Content-Type', m.foto_tipo).header('Cache-Control', 'private, max-age=86400').send(m.foto);
  });

  app.delete('/api/movimentos/:id', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const m = (await pool.query(`SELECT pv.fazenda_id FROM movimento_animal m JOIN parcela p ON p.id = m.parcela_id JOIN pivo pv ON pv.id = p.pivo_id WHERE m.id = $1`, [id])).rows[0];
    if (!m) return rep.code(404).send({ erro: 'Movimento não encontrado' });
    if (!(await acesso(req, rep, m.fazenda_id))) return;
    await pool.query(`DELETE FROM movimento_animal WHERE id = $1`, [id]);
    return { ok: true };
  });

  // ---------- janelas de energia ----------
  app.get('/api/fazendas/:id/janelas', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    const f = (await pool.query(`SELECT max_pivos_simultaneos AS "maxSimultaneos" FROM fazenda WHERE id = $1`, [id])).rows[0];
    return { janelas: await janelasDaFazenda(id), maxSimultaneos: f?.maxSimultaneos ?? 1 };
  });

  app.put('/api/fazendas/:id/janelas', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    const c = z.object({
      janelas: z.array(z.object({ inicio: hhmm, fim: hhmm, dias: z.array(z.number().int().min(0).max(6)).min(1) })).max(10),
      maxSimultaneos: z.number().int().min(1).max(20).default(1),
    }).safeParse(req.body);
    if (!c.success) return rep.code(400).send({ erro: 'Janelas inválidas' });
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      await cli.query(`DELETE FROM janela_irrigacao WHERE fazenda_id = $1`, [id]);
      for (const j of c.data.janelas) await cli.query(`INSERT INTO janela_irrigacao (fazenda_id, inicio, fim, dias) VALUES ($1,$2,$3,$4)`, [id, j.inicio, j.fim, [...new Set(j.dias)].sort()]);
      await cli.query(`UPDATE fazenda SET max_pivos_simultaneos = $2 WHERE id = $1`, [id, c.data.maxSimultaneos]);
      await cli.query('COMMIT');
    } catch (e) {
      await cli.query('ROLLBACK');
      throw e;
    } finally {
      cli.release();
    }
    return { janelas: await janelasDaFazenda(id), maxSimultaneos: c.data.maxSimultaneos };
  });

  // ---------- ordem de irrigação ----------
  app.get('/api/fazendas/:id/ordem', auth, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    return lerOrdem(id);
  });

  app.post('/api/fazendas/:id/ordem/gerar', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    return gerarOrdem(id);
  });

  // Seleção feita no Preciso irrigar: estes pivôs (com a lâmina definida pelo gestor) passam a ser a ordem planejada do dia.
  app.post('/api/fazendas/:id/ordem/montar', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    if (!(await acesso(req, rep, id))) return;
    const c = z
      .object({ itens: z.array(z.object({ pivoId: z.number().int().positive(), laminaMm: z.number().min(0.5).max(80).nullable().optional() })).max(100) })
      .safeParse(req.body);
    if (!c.success) return rep.code(400).send({ erro: 'Seleção inválida' });
    const r = await gerarOrdem(id, c.data.itens);
    if (!r) return rep.code(404).send({ erro: 'Fazenda não encontrada' });
    return r;
  });

  app.put('/api/ordem/:id/status', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const c = z.object({ status: z.enum(['planejada', 'concluida', 'cancelada']) }).safeParse(req.body);
    if (!c.success) return rep.code(400).send({ erro: 'Status inválido' });
    const o = (await pool.query(`SELECT fazenda_id FROM ordem_irrigacao WHERE id = $1`, [id])).rows[0];
    if (!o) return rep.code(404).send({ erro: 'Ordem não encontrada' });
    if (!(await acesso(req, rep, o.fazenda_id))) return;
    await pool.query(`UPDATE ordem_irrigacao SET status = $2 WHERE id = $1`, [id, c.data.status]);
    return { ok: true };
  });

  // ---------- comandos aos pivôs ----------
  const donoDoPivo = async (telId: number) => (await pool.query(`SELECT tc.fazenda_id FROM telemetria_pivo tp JOIN telemetria_conta tc ON tc.id = tp.conta_id WHERE tp.id = $1`, [telId])).rows[0]?.fazenda_id as number | undefined;
  const comandoCorpo = z.object({ acao: z.enum(['iniciar', 'parar']), percentual: z.number().min(1).max(100).optional() });

  // Mostra, sem enviar nada, o que o servidor mandaria (sentido, ângulo de parada) e o que o bloqueia.
  app.post('/api/telemetria/pivos/:id/comando/previa', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const c = comandoCorpo.safeParse(req.body);
    const fz = await donoDoPivo(id);
    if (!c.success || fz == null) return rep.code(400).send({ erro: 'Pedido inválido' });
    if (!(await acesso(req, rep, fz))) return;
    const { calc, bloqueios } = await prepararComando(id, c.data);
    return { comando: calc, bloqueios };
  });

  app.post('/api/telemetria/pivos/:id/comando', gestor, async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const c = comandoCorpo.safeParse(req.body);
    const fz = await donoDoPivo(id);
    if (!c.success || fz == null) return rep.code(400).send({ erro: 'Pedido inválido' });
    if (!(await acesso(req, rep, fz))) return;
    try {
      return await enviarComando(id, c.data, (req.user as Usuario).id);
    } catch (e) {
      if (e instanceof ErroComando) return rep.code(e.status).send({ erro: e.message });
      throw e;
    }
  });
}
