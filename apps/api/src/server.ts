import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { etoDia, somarDias, wm2ParaMJ } from '@irrigacao/core';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { aplicarSchema, esperarBanco, hoje, pool } from './db';
import { entrar as entrarAgsense, ErroAgsense } from './agsense';
import { entrar as entrarIricontrol, ErroIricontrol, iniciarAgendadorTelemetria, sincronizar as sincronizarTelemetria } from './irricontrol';
import { registrarCampo } from './rotas-campo';
import { registrarOperacao } from './rotas-operacao';
import { semear } from './seed';
import { conferirSenha, hashSenha } from './senha';
import { calcularFazenda } from './servico';
import { amostrar, cifrar, decifrar, ErroWeatherLink, iniciarAgendador, lerAgora, listarEstacoes, sincronizar } from './weatherlink';

type Usuario = { id: number; email: string; nome: string; papel: 'operador' | 'gestor' | 'admin' };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: Usuario;
    user: Usuario;
  }
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret && process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET obrigatório em produção');
await app.register(cors, { origin: true });
await app.register(jwt, { secret: jwtSecret ?? 'dev-somente-local', sign: { expiresIn: '12h' } });

async function autenticar(req: FastifyRequest, rep: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    return rep.code(401).send({ erro: 'Não autenticado' });
  }
}
const auth = { preHandler: autenticar };

/** RF-04: o usuário só enxerga as fazendas às quais tem acesso (admin vê todas). */
async function podeFazenda(u: Usuario, fazendaId: number): Promise<boolean> {
  if (u.papel === 'admin') return true;
  const r = await pool.query(`SELECT 1 FROM usuario_fazenda WHERE usuario_id = $1 AND fazenda_id = $2`, [u.id, fazendaId]);
  return r.rowCount === 1;
}
const idParam = z.object({ id: z.coerce.number().int().positive() });
const ehGestor = (u: Usuario) => u.papel === 'gestor' || u.papel === 'admin';

app.get('/api/saude', async () => ({ ok: true, data: hoje() }));

// ---------- autenticação ----------
app.post('/api/auth/login', async (req, rep) => {
  const corpo = z.object({ email: z.string().email(), senha: z.string().min(1) }).safeParse(req.body);
  if (!corpo.success) return rep.code(400).send({ erro: 'Dados inválidos' });
  const r = await pool.query(`SELECT id, nome, email, papel, senha_hash, ativo FROM usuario WHERE lower(email) = lower($1)`, [corpo.data.email]);
  const u = r.rows[0];
  if (!u || !u.ativo || !(await conferirSenha(corpo.data.senha, u.senha_hash))) {
    return rep.code(401).send({ erro: 'E-mail ou senha incorretos' });
  }
  const usuario: Usuario = { id: u.id, email: u.email, nome: u.nome, papel: u.papel };
  return { token: app.jwt.sign(usuario), usuario };
});

app.get('/api/auth/me', auth, async (req) => req.user);

// ---------- fazendas ----------
app.get('/api/fazendas', auth, async (req) => {
  const u = req.user;
  const r = await pool.query(
    `SELECT f.id, f.nome, f.cidade, f.uf, ST_Y(f.geom) AS lat, ST_X(f.geom) AS lon
       FROM fazenda f
      WHERE $1 = 'admin' OR f.id IN (SELECT fazenda_id FROM usuario_fazenda WHERE usuario_id = $2)
      ORDER BY f.nome`,
    [u.papel, u.id],
  );
  return r.rows;
});

// ---------- "Preciso irrigar?" / Analisar / Mapa ----------
app.get('/api/fazendas/:id/preciso-irrigar', auth, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const q = z.object({ comChuva: z.enum(['0', '1']).default('1') }).parse(req.query);
  const r = await calcularFazenda(id, { comChuva: q.comChuva === '1' });
  return r ?? rep.code(404).send({ erro: 'Fazenda não encontrada' });
});

app.post('/api/fazendas/:id/recalcular', auth, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const r = await calcularFazenda(id, { comChuva: true, persistir: true });
  return r ? { ok: true, parcelas: r.parcelas.length } : rep.code(404).send({ erro: 'Fazenda não encontrada' });
});

// ---------- cadastros (leitura na v0.1) ----------
app.get('/api/fazendas/:id/cadastros', auth, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const [pivos, parcelas, culturas, estacoes] = await Promise.all([
    pool.query(`SELECT id, nome, area_ha, vazao_m3h, lamina_volta_100_mm, horas_volta_100, eficiencia, ativo, parametros_confirmados FROM pivo WHERE fazenda_id = $1 ORDER BY nome`, [id]),
    pool.query(
      `SELECT p.id, p.nome, p.pivo_id, pv.nome AS pivo, p.cultura_id, c.nome AS cultura, p.safra, p.area_ha, p.data_plantio,
              p.cap_campo_mm, p.lamina_seguranca_mm, p.ad_mm_por_cm
         FROM parcela p JOIN pivo pv ON pv.id = p.pivo_id JOIN cultura c ON c.id = p.cultura_id
        WHERE pv.fazenda_id = $1 ORDER BY pv.nome, p.nome`,
      [id],
    ),
    pool.query(
      `SELECT c.id, c.nome, c.nome_cientifico, c.tipo, c.parametros_confirmados, c.prof_raiz_mm, c.fracao_agua_disponivel_p,
              coalesce(json_agg(json_build_object('fase', f.fase, 'kc', f.kc, 'dias', f.duracao_dias, 'kc_fim', f.kc_fim, 'raiz_mm', f.raiz_mm, 'raiz_fim_mm', f.raiz_fim_mm) ORDER BY f.ordem) FILTER (WHERE f.id IS NOT NULL), '[]') AS fases
         FROM cultura c LEFT JOIN cultura_fase f ON f.cultura_id = c.id GROUP BY c.id ORDER BY c.tipo, c.nome`,
    ),
    pool.query(`SELECT id, nome, tipo, online, ultima_leitura_em FROM estacao WHERE fazenda_id = $1 ORDER BY nome`, [id]),
  ]);
  return { pivos: pivos.rows, parcelas: parcelas.rows, culturas: culturas.rows, estacoes: estacoes.rows };
});

// ---------- camadas do mapa: limites, pastos de sequeiro (GeoJSON) ----------
app.get('/api/fazendas/:id/mapa-base', auth, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const colecao = (sql: string) =>
    pool.query(sql, [id]).then((r) => ({ type: 'FeatureCollection', features: r.rows.map((x) => ({ type: 'Feature', properties: x.props, geometry: x.geom })) }));
  const [limites, pastos] = await Promise.all([
    colecao(`SELECT json_build_object('nome', nome) AS props, ST_AsGeoJSON(geom)::json AS geom FROM limite_fazenda WHERE fazenda_id = $1`),
    colecao(
      `SELECT json_build_object('id', p.id, 'grupo', p.grupo, 'nome', p.nome, 'cultivar', c.nome, 'area_ha', p.area_ha) AS props, ST_AsGeoJSON(p.geom)::json AS geom
         FROM pasto p LEFT JOIN cultura c ON c.id = p.cultura_id WHERE p.fazenda_id = $1`,
    ),
  ]);
  return { limites, pastos };
});

// ---------- edição de cadastros (gestor/admin): cultivar, parcela, pivô ----------
const exigeGestor = async (req: FastifyRequest, rep: FastifyReply) => {
  await autenticar(req, rep);
  if (!rep.sent && !ehGestor(req.user)) return rep.code(403).send({ erro: 'Apenas gestor ou admin' });
};
const gestor = { preHandler: exigeGestor };

// Promove um pasto de sequeiro a pivô irrigado (1 pivô + 1 parcela com o mesmo polígono).
app.post('/api/pastos/:id/promover-pivo', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    const pasto = (await cx.query(`SELECT id, fazenda_id, grupo, nome, cultura_id, geom FROM pasto WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!pasto) {
      await cx.query('ROLLBACK');
      return rep.code(404).send({ erro: 'Pasto não encontrado' });
    }
    if (!(await podeFazenda(req.user, pasto.fazenda_id))) {
      await cx.query('ROLLBACK');
      return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
    }
    const base = /piv/i.test(pasto.nome) ? String(pasto.nome).toUpperCase() : `PIVÔ ${pasto.nome}`;
    const existe = async (n: string) => (await cx.query(`SELECT 1 FROM pivo WHERE fazenda_id = $1 AND nome = $2`, [pasto.fazenda_id, n])).rowCount! > 0;
    let nome = base;
    if (await existe(nome)) nome = `${base} (${pasto.grupo})`;
    for (let i = 2; await existe(nome); i++) nome = `${base} (${pasto.grupo}) ${i}`;

    const cult = (
      await cx.query(
        `SELECT id, prof_raiz_mm, fracao_agua_disponivel_p FROM cultura WHERE id = COALESCE($1, (SELECT id FROM cultura WHERE tipo = 'forrageira' ORDER BY id LIMIT 1))`,
        [pasto.cultura_id],
      )
    ).rows[0];
    if (!cult) {
      await cx.query('ROLLBACK');
      return rep.code(422).send({ erro: 'Cadastre uma cultivar antes de criar o pivô' });
    }
    const raiz = Number(cult.prof_raiz_mm);
    const cap = Math.round((raiz / 10) * 1.2 * 10) / 10;
    const limite = Math.round(cap * (1 - Number(cult.fracao_agua_disponivel_p)) * 10) / 10;
    const area = (await cx.query(`SELECT ROUND((ST_Area(geom::geography) / 10000)::numeric, 2) AS ha FROM pasto WHERE id = $1`, [id])).rows[0].ha;
    const pivo = (
      await cx.query(
        `INSERT INTO pivo (fazenda_id, nome, area_ha, lamina_volta_100_mm, horas_volta_100, eficiencia, parametros_confirmados, geom)
         VALUES ($1, $2, $3, 9, 18, 0.85, false, (SELECT ST_Multi(geom) FROM pasto WHERE id = $4)) RETURNING id`,
        [pasto.fazenda_id, nome, area, id],
      )
    ).rows[0];
    await cx.query(
      `INSERT INTO parcela (pivo_id, cultura_id, nome, area_ha, cap_campo_mm, lamina_seguranca_mm, data_inicial, lamina_inicial_mm, geom)
       VALUES ($1, $2, 'P01', $3, $4, $5, $6, $7, (SELECT ST_CollectionExtract(geom, 3) FROM pasto WHERE id = $8))`,
      [pivo.id, cult.id, area, cap, limite, hoje(), Math.round(cap * 0.8 * 10) / 10, id],
    );
    await cx.query(`DELETE FROM pasto WHERE id = $1`, [id]);
    await cx.query('COMMIT');
    return { ok: true, pivoId: pivo.id, nome };
  } catch (e) {
    await cx.query('ROLLBACK');
    throw e;
  } finally {
    cx.release();
  }
});

// ---------- telemetria dos pivôs (somente leitura) ----------
const erroTelemetria = (e: unknown, rep: FastifyReply) =>
  e instanceof ErroIricontrol || e instanceof ErroAgsense ? rep.code(422).send({ erro: e.message }) : rep.code(422).send({ erro: `Não foi possível falar com a plataforma: ${(e as Error).message}` });

const provedorParam = z.object({ id: z.coerce.number().int().positive(), provedor: z.enum(['irricontrol', 'agsense']) });
const entrarNaPlataforma = (provedor: 'irricontrol' | 'agsense', usuario: string, senha: string) =>
  provedor === 'agsense' ? entrarAgsense(usuario, senha) : entrarIricontrol(usuario, senha);

app.get('/api/fazendas/:id/telemetria', auth, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const contas = (await pool.query(
    `SELECT id, provedor, usuario, ativo, ultima_sincronizacao AS "ultimaSincronizacao", ultimo_erro AS "ultimoErro", farm_externo AS "fazendas"
       FROM telemetria_conta WHERE fazenda_id = $1 ORDER BY id`, [id])).rows;
  const pivos = contas.length
    ? (await pool.query(
        `SELECT tp.id, tc.provedor, tp.externo_id AS "externoId", tp.nome, tp.pivo_id AS "pivoId", pv.nome AS "pivoNome", tp.lat::float, tp.lon::float, tp.raio_m::float AS "raioM",
                tp.area_ha::float AS "areaHa", tp.vazao_m3h::float AS "vazaoM3h", tp.angulo::float, tp.destino_angulo::float AS "destinoAngulo", tp.status_cod AS "statusCod",
                tp.status_txt AS "statusTxt", tp.categoria, tp.direcao, tp.percentual::float, tp.tensao_v::float AS "tensaoV", tp.pressao_ponta::float AS "pressaoPonta",
                tp.bomba, tp.canhao, tp.horas_molhado::float AS "horasMolhado", tp.atualizado_em AS "atualizadoEm", tp.coletado_em AS "coletadoEm"
           FROM telemetria_pivo tp JOIN telemetria_conta tc ON tc.id = tp.conta_id LEFT JOIN pivo pv ON pv.id = tp.pivo_id
          WHERE tc.fazenda_id = $1 ORDER BY tp.nome`, [id])).rows
    : [];
  return { contas, pivos };
});

app.put('/api/fazendas/:id/telemetria/:provedor', gestor, async (req, rep) => {
  const p = provedorParam.safeParse(req.params);
  if (!p.success) return rep.code(400).send({ erro: 'Plataforma desconhecida' });
  const { id, provedor } = p.data;
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const c = z.object({ usuario: z.string().trim().min(2).max(200), senha: z.string().min(1).max(200) }).safeParse(req.body);
  if (!c.success) return rep.code(400).send({ erro: 'Informe usuário e senha' });
  let token: string;
  try {
    token = await entrarNaPlataforma(provedor, c.data.usuario, c.data.senha);
  } catch (e) {
    return erroTelemetria(e, rep);
  }
  const r = await pool.query(
    `INSERT INTO telemetria_conta (fazenda_id, provedor, usuario, senha_cifrada, token_cifrado, ativo) VALUES ($1, $5, $2, $3, $4, true)
     ON CONFLICT (fazenda_id, provedor) DO UPDATE SET usuario = EXCLUDED.usuario, senha_cifrada = EXCLUDED.senha_cifrada, token_cifrado = EXCLUDED.token_cifrado, ativo = true, ultimo_erro = NULL
     RETURNING id`,
    [id, c.data.usuario, cifrar(c.data.senha), cifrar(token), provedor],
  );
  try {
    return { ok: true, ...(await sincronizarTelemetria(r.rows[0].id)) };
  } catch (e) {
    return erroTelemetria(e, rep);
  }
});

app.post('/api/fazendas/:id/telemetria/sincronizar', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const contas = (await pool.query(`SELECT id, provedor FROM telemetria_conta WHERE fazenda_id = $1 ORDER BY id`, [id])).rows;
  if (!contas.length) return rep.code(404).send({ erro: 'Conecte uma plataforma de telemetria primeiro' });
  const falhas: string[] = [];
  let pivos = 0;
  let lancamentos = 0;
  for (const c of contas) {
    try {
      const r = await sincronizarTelemetria(c.id);
      pivos += r.pivos;
      lancamentos += r.lancamentos;
    } catch (e) {
      const msg = (e as Error).message;
      falhas.push(`${c.provedor}: ${msg}`);
      await pool.query(`UPDATE telemetria_conta SET ultimo_erro = $2 WHERE id = $1`, [c.id, msg.slice(0, 300)]);
    }
  }
  return falhas.length === contas.length ? rep.code(422).send({ erro: falhas.join(' | ') }) : { ok: true, pivos, lancamentos, falhas };
});

app.delete('/api/fazendas/:id/telemetria/:provedor', gestor, async (req, rep) => {
  const p = provedorParam.safeParse(req.params);
  if (!p.success) return rep.code(400).send({ erro: 'Plataforma desconhecida' });
  if (!(await podeFazenda(req.user, p.data.id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  await pool.query(`DELETE FROM telemetria_conta WHERE fazenda_id = $1 AND provedor = $2`, [p.data.id, p.data.provedor]);
  return { ok: true };
});

app.put('/api/telemetria/pivos/:id', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  const c = z.object({ pivoId: z.number().int().positive().nullable() }).safeParse(req.body);
  if (!c.success) return rep.code(400).send({ erro: 'Dados inválidos' });
  const r = await pool.query(`UPDATE telemetria_pivo SET pivo_id = $2 WHERE id = $1 RETURNING id`, [id, c.data.pivoId]);
  return r.rowCount ? { ok: true } : rep.code(404).send({ erro: 'Pivô de telemetria não encontrado' });
});

/** Cria o pivô no cadastro/mapa a partir da telemetria: círculo no centro real, hidráulica real, 1 parcela. */
app.post('/api/telemetria/pivos/:id/criar-pivo', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  const t = (await pool.query(
    `SELECT tp.*, c.fazenda_id FROM telemetria_pivo tp JOIN telemetria_conta c ON c.id = tp.conta_id WHERE tp.id = $1`, [id])).rows[0];
  if (!t) return rep.code(404).send({ erro: 'Pivô de telemetria não encontrado' });
  if (!(await podeFazenda(req.user, t.fazenda_id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  if (t.pivo_id) return rep.code(409).send({ erro: 'Este pivô já está vinculado ao mapa' });
  if (t.lat == null || t.lon == null || !t.area_ha) return rep.code(422).send({ erro: 'A telemetria não informa posição/área deste pivô' });

  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    const cult = (await cx.query(`SELECT id, prof_raiz_mm, fracao_agua_disponivel_p FROM cultura WHERE tipo = 'forrageira' ORDER BY id LIMIT 1`)).rows[0];
    if (!cult) {
      await cx.query('ROLLBACK');
      return rep.code(422).send({ erro: 'Cadastre uma cultivar antes de criar o pivô' });
    }
    let nome = String(t.nome);
    for (let i = 2; (await cx.query(`SELECT 1 FROM pivo WHERE fazenda_id = $1 AND nome = $2`, [t.fazenda_id, nome])).rowCount; i++) nome = `${t.nome} (${i})`;
    const raio = Math.max(Number(t.raio_m ?? 0), Math.sqrt((Number(t.area_ha) * 10_000) / Math.PI));
    const circ = `ST_Buffer(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)::geometry`;
    const horas = t.raio_m && t.velocidade_m_h ? (2 * Math.PI * Number(t.raio_m)) / Number(t.velocidade_m_h) : 18;
    const lamina = t.vazao_m3h ? (Number(t.vazao_m3h) * horas) / (Number(t.area_ha) * 10) : 9;
    const pivo = (await cx.query(
      `INSERT INTO pivo (fazenda_id, nome, area_ha, vazao_m3h, lamina_volta_100_mm, horas_volta_100, eficiencia, parametros_confirmados, geom)
       VALUES ($4, $5, $6, $7, $8, $9, 0.85, $10, ${circ}) RETURNING id`,
      [t.lon, t.lat, raio, t.fazenda_id, nome, t.area_ha, t.vazao_m3h, Math.round(lamina * 100) / 100, Math.round(horas * 100) / 100, Boolean(t.vazao_m3h && t.velocidade_m_h)],
    )).rows[0];
    const raizMm = Number(cult.prof_raiz_mm);
    const cap = Math.round((raizMm / 10) * 1.2 * 10) / 10;
    const limite = Math.round(cap * (1 - Number(cult.fracao_agua_disponivel_p)) * 10) / 10;
    await cx.query(
      `INSERT INTO parcela (pivo_id, cultura_id, nome, area_ha, cap_campo_mm, lamina_seguranca_mm, data_inicial, lamina_inicial_mm, geom)
       VALUES ($1, $2, 'P01', $3, $4, $5, $6, $7, (SELECT geom FROM pivo WHERE id = $1))`,
      [pivo.id, cult.id, t.area_ha, cap, limite, hoje(), Math.round(cap * 0.8 * 10) / 10],
    );
    await cx.query(`UPDATE telemetria_pivo SET pivo_id = $2 WHERE id = $1`, [id, pivo.id]);
    await cx.query('COMMIT');
    return { ok: true, pivoId: pivo.id, nome };
  } catch (e) {
    await cx.query('ROLLBACK');
    throw e;
  } finally {
    cx.release();
  }
});

// ---------- alertas ----------
app.get('/api/fazendas/:id/alertas', auth, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const cols = `id, tipo, severidade, pivo_nome AS "pivoNome", titulo, mensagem, criado_em AS "criadoEm", resolvido_em AS "resolvidoEm", dispensado, notificado_em AS "notificadoEm", erro_envio AS "erroEnvio"`;
  const [abertos, recentes, destinatarios] = await Promise.all([
    pool.query(`SELECT ${cols} FROM alerta WHERE fazenda_id = $1 AND resolvido_em IS NULL AND NOT dispensado
                 ORDER BY CASE severidade WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, criado_em DESC`, [id]),
    pool.query(`SELECT ${cols} FROM alerta WHERE fazenda_id = $1 AND (resolvido_em IS NOT NULL OR dispensado) AND criado_em > now() - interval '7 days'
                 ORDER BY criado_em DESC LIMIT 30`, [id]),
    ehGestor(req.user)
      ? pool.query(`SELECT id, nome, telefone, severidade_min AS "severidadeMin", ativo FROM alerta_destinatario WHERE fazenda_id = $1 ORDER BY nome`, [id])
      : Promise.resolve({ rows: [] }),
  ]);
  return { abertos: abertos.rows, recentes: recentes.rows, destinatarios: destinatarios.rows, envioAutomatico: Boolean(process.env.WHATSAPP_WEBHOOK_URL) };
});

app.post('/api/fazendas/:id/alertas/destinatarios', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const c = z.object({ nome: z.string().trim().min(2).max(80), telefone: z.string().trim().min(10).max(20), severidadeMin: z.enum(['alta', 'media', 'baixa']).default('media') }).safeParse(req.body);
  if (!c.success || c.data.telefone.replace(/\D/g, '').length < 10) return rep.code(400).send({ erro: 'Informe o nome e o telefone com DDD' });
  await pool.query(`INSERT INTO alerta_destinatario (fazenda_id, nome, telefone, severidade_min) VALUES ($1, $2, $3, $4)`, [id, c.data.nome, c.data.telefone, c.data.severidadeMin]);
  return rep.code(201).send({ ok: true });
});

app.delete('/api/alertas/destinatarios/:id', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  const r = await pool.query(`DELETE FROM alerta_destinatario WHERE id = $1 RETURNING fazenda_id`, [id]);
  return r.rowCount ? { ok: true } : rep.code(404).send({ erro: 'Destinatário não encontrado' });
});

/** Dispensa o alerta enquanto a condição durar; ele some da lista e não é reenviado. */
app.put('/api/alertas/:id/dispensar', auth, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  const a = (await pool.query(`SELECT fazenda_id FROM alerta WHERE id = $1`, [id])).rows[0];
  if (!a) return rep.code(404).send({ erro: 'Alerta não encontrado' });
  if (!(await podeFazenda(req.user, a.fazenda_id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  await pool.query(`UPDATE alerta SET dispensado = true WHERE id = $1`, [id]);
  return { ok: true };
});

// ---------- usuários (gestor/admin) ----------
const PAPEIS = ['operador', 'gestor', 'admin'] as const;
const corpoNovoUsuario = z.object({
  nome: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(160),
  senha: z.string().min(6).max(200),
  papel: z.enum(PAPEIS),
  fazendaIds: z.array(z.number().int().positive()).default([]),
});
const corpoEditaUsuario = z.object({
  nome: z.string().trim().min(2).max(120).optional(),
  papel: z.enum(PAPEIS).optional(),
  ativo: z.boolean().optional(),
  senha: z.string().min(6).max(200).optional(),
  fazendaIds: z.array(z.number().int().positive()).optional(),
});

async function definirFazendas(c: PoolClient, usuarioId: number, ids: number[]) {
  await c.query(`DELETE FROM usuario_fazenda WHERE usuario_id = $1`, [usuarioId]);
  if (ids.length) {
    await c.query(
      `INSERT INTO usuario_fazenda (usuario_id, fazenda_id) SELECT $1, id FROM fazenda WHERE id = ANY($2::int[])`,
      [usuarioId, ids],
    );
  }
}

app.get('/api/usuarios', gestor, async () => {
  const r = await pool.query(
    `SELECT u.id, u.nome, u.email, u.papel, u.ativo, u.criado_em AS "criadoEm",
            COALESCE(array_agg(uf.fazenda_id ORDER BY uf.fazenda_id) FILTER (WHERE uf.fazenda_id IS NOT NULL), '{}') AS "fazendaIds"
       FROM usuario u LEFT JOIN usuario_fazenda uf ON uf.usuario_id = u.id
      GROUP BY u.id ORDER BY u.ativo DESC, lower(u.nome)`,
  );
  return r.rows;
});

app.get('/api/usuarios/fazendas', gestor, async () => (await pool.query(`SELECT id, nome FROM fazenda ORDER BY nome`)).rows);

app.post('/api/usuarios', gestor, async (req, rep) => {
  const c = corpoNovoUsuario.safeParse(req.body);
  if (!c.success) return rep.code(400).send({ erro: 'Dados inválidos (nome, e-mail, senha com 6+ caracteres e papel)' });
  if (c.data.papel === 'admin' && req.user.papel !== 'admin') return rep.code(403).send({ erro: 'Só um admin cria outro admin' });
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    const dup = await cx.query(`SELECT 1 FROM usuario WHERE lower(email) = lower($1)`, [c.data.email]);
    if (dup.rowCount) {
      await cx.query('ROLLBACK');
      return rep.code(409).send({ erro: 'Já existe um usuário com esse e-mail' });
    }
    const r = await cx.query(
      `INSERT INTO usuario (nome, email, senha_hash, papel) VALUES ($1, lower($2), $3, $4) RETURNING id`,
      [c.data.nome, c.data.email, await hashSenha(c.data.senha), c.data.papel],
    );
    await definirFazendas(cx, r.rows[0].id, c.data.fazendaIds);
    await cx.query('COMMIT');
    return rep.code(201).send({ id: r.rows[0].id });
  } catch (e) {
    await cx.query('ROLLBACK');
    throw e;
  } finally {
    cx.release();
  }
});

app.put('/api/usuarios/:id', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  const c = corpoEditaUsuario.safeParse(req.body);
  if (!c.success) return rep.code(400).send({ erro: 'Dados inválidos' });
  const alvo = (await pool.query(`SELECT id, papel FROM usuario WHERE id = $1`, [id])).rows[0];
  if (!alvo) return rep.code(404).send({ erro: 'Usuário não encontrado' });
  const souAdmin = req.user.papel === 'admin';
  if ((alvo.papel === 'admin' || c.data.papel === 'admin') && !souAdmin) return rep.code(403).send({ erro: 'Só um admin altera administradores' });
  if (id === req.user.id && (c.data.ativo === false || (c.data.papel && c.data.papel !== req.user.papel))) {
    return rep.code(400).send({ erro: 'Você não pode desativar nem mudar o próprio papel' });
  }
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    await cx.query(
      `UPDATE usuario SET nome = COALESCE($2, nome), papel = COALESCE($3, papel), ativo = COALESCE($4, ativo),
              senha_hash = COALESCE($5, senha_hash) WHERE id = $1`,
      [id, c.data.nome ?? null, c.data.papel ?? null, c.data.ativo ?? null, c.data.senha ? await hashSenha(c.data.senha) : null],
    );
    if (c.data.fazendaIds) await definirFazendas(cx, id, c.data.fazendaIds);
    await cx.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await cx.query('ROLLBACK');
    throw e;
  } finally {
    cx.release();
  }
});

/** Recalcula capacidade e limite de segurança da parcela a partir da cultivar e do solo (doc 04, seção 4). */
async function recalcularSolo(where: string, params: unknown[]): Promise<number> {
  const r = await pool.query(
    `UPDATE parcela p SET
       cap_campo_mm = ROUND((c.prof_raiz_mm / 10 * p.ad_mm_por_cm)::numeric, 1),
       lamina_seguranca_mm = ROUND((c.prof_raiz_mm / 10 * p.ad_mm_por_cm * (1 - c.fracao_agua_disponivel_p))::numeric, 1)
     FROM cultura c WHERE c.id = p.cultura_id AND ${where}`,
    params,
  );
  return r.rowCount ?? 0;
}

async function fazendaDoPivo(pivoId: number): Promise<number | null> {
  return (await pool.query(`SELECT fazenda_id FROM pivo WHERE id = $1`, [pivoId])).rows[0]?.fazenda_id ?? null;
}

const parcelaPut = z.object({
  cultura_id: z.number().int().optional(),
  ad_mm_por_cm: z.number().min(0.3).max(3).optional(),
  data_plantio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  cap_campo_mm: z.number().positive().max(300).optional(),
  lamina_seguranca_mm: z.number().positive().max(300).optional(),
});

app.put('/api/parcelas/:id', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  const b = parcelaPut.parse(req.body);
  const fazId = await fazendaDaParcela(id);
  if (fazId == null) return rep.code(404).send({ erro: 'Parcela não encontrada' });
  if (!(await podeFazenda(req.user, fazId))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  await pool.query(
    `UPDATE parcela SET cultura_id = coalesce($2, cultura_id), ad_mm_por_cm = coalesce($3, ad_mm_por_cm),
       data_plantio = CASE WHEN $4::boolean THEN $5::date ELSE data_plantio END WHERE id = $1`,
    [id, b.cultura_id ?? null, b.ad_mm_por_cm ?? null, 'data_plantio' in b, b.data_plantio ?? null],
  );
  // cultivar ou solo mudaram → capacidade/limite acompanham, salvo se informados à mão
  if ((b.cultura_id != null || b.ad_mm_por_cm != null) && b.cap_campo_mm == null && b.lamina_seguranca_mm == null) await recalcularSolo('p.id = $1', [id]);
  if (b.cap_campo_mm != null || b.lamina_seguranca_mm != null) {
    await pool.query(`UPDATE parcela SET cap_campo_mm = coalesce($2, cap_campo_mm), lamina_seguranca_mm = coalesce($3, lamina_seguranca_mm) WHERE id = $1`, [id, b.cap_campo_mm ?? null, b.lamina_seguranca_mm ?? null]);
  }
  return { ok: true };
});

app.post('/api/pivos/:id/cultivar', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  const b = z.object({ cultura_id: z.number().int() }).parse(req.body);
  const fazId = await fazendaDoPivo(id);
  if (fazId == null) return rep.code(404).send({ erro: 'Pivô não encontrado' });
  if (!(await podeFazenda(req.user, fazId))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const r = await pool.query(`UPDATE parcela SET cultura_id = $2 WHERE pivo_id = $1`, [id, b.cultura_id]);
  await recalcularSolo('p.pivo_id = $1', [id]);
  return { ok: true, parcelas: r.rowCount };
});

const pivoPut = z.object({
  lamina_volta_100_mm: z.number().positive().max(100),
  horas_volta_100: z.number().positive().max(500),
  vazao_m3h: z.number().positive().nullable().optional(),
  eficiencia: z.number().min(0.3).max(1),
});

app.put('/api/pivos/:id', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  const b = pivoPut.parse(req.body);
  const fazId = await fazendaDoPivo(id);
  if (fazId == null) return rep.code(404).send({ erro: 'Pivô não encontrado' });
  if (!(await podeFazenda(req.user, fazId))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  await pool.query(
    `UPDATE pivo SET lamina_volta_100_mm = $2, horas_volta_100 = $3, vazao_m3h = $4, eficiencia = $5, parametros_confirmados = true WHERE id = $1`,
    [id, b.lamina_volta_100_mm, b.horas_volta_100, b.vazao_m3h ?? null, b.eficiencia],
  );
  return { ok: true };
});

const culturaCorpo = z.object({
  nome: z.string().trim().min(2).max(120),
  nome_cientifico: z.string().trim().max(160).nullable().optional(),
  prof_raiz_mm: z.number().min(50).max(3000),
  fracao_agua_disponivel_p: z.number().min(0.1).max(0.9),
  fases: z
    .array(
      z.object({
        fase: z.string().trim().min(1).max(40),
        kc: z.number().min(0.1).max(1.5),
        dias: z.number().int().min(1).max(3650),
        // curvas vindas do iCrop (Kc e profundidade em linha reta na fase); ausentes = constantes
        kc_fim: z.number().min(0.1).max(1.5).nullable().optional(),
        raiz_mm: z.number().min(50).max(3000).nullable().optional(),
        raiz_fim_mm: z.number().min(50).max(3000).nullable().optional(),
      }),
    )
    .min(1)
    .max(8),
});

async function gravarFases(cli: PoolClient, culturaId: number, fases: z.infer<typeof culturaCorpo>['fases']) {
  await cli.query(`DELETE FROM cultura_fase WHERE cultura_id = $1`, [culturaId]);
  for (const [i, f] of fases.entries()) {
    await cli.query(
      `INSERT INTO cultura_fase (cultura_id, ordem, fase, kc, duracao_dias, kc_fim, raiz_mm, raiz_fim_mm) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [culturaId, i + 1, f.fase, f.kc, f.dias, f.kc_fim ?? null, f.raiz_mm ?? null, f.raiz_fim_mm ?? null],
    );
  }
}

app.post('/api/culturas', gestor, async (req, rep) => {
  const b = culturaCorpo.parse(req.body);
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const r = await cli.query(
      `INSERT INTO cultura (nome, nome_cientifico, tipo, prof_raiz_mm, fracao_agua_disponivel_p, parametros_confirmados) VALUES ($1,$2,'forrageira',$3,$4,true) RETURNING id`,
      [b.nome, b.nome_cientifico ?? null, b.prof_raiz_mm, b.fracao_agua_disponivel_p],
    );
    await gravarFases(cli, r.rows[0].id, b.fases);
    await cli.query('COMMIT');
    return { ok: true, id: r.rows[0].id };
  } catch (e) {
    await cli.query('ROLLBACK');
    if ((e as { code?: string }).code === '23505') return rep.code(409).send({ erro: 'Já existe uma cultivar com esse nome' });
    throw e;
  } finally {
    cli.release();
  }
});

app.put('/api/culturas/:id', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  const b = culturaCorpo.parse(req.body);
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const r = await cli.query(
      `UPDATE cultura SET nome = $2, nome_cientifico = $3, prof_raiz_mm = $4, fracao_agua_disponivel_p = $5, parametros_confirmados = true WHERE id = $1`,
      [id, b.nome, b.nome_cientifico ?? null, b.prof_raiz_mm, b.fracao_agua_disponivel_p],
    );
    if (r.rowCount === 0) { await cli.query('ROLLBACK'); return rep.code(404).send({ erro: 'Cultivar não encontrada' }); }
    await gravarFases(cli, id, b.fases);
    await cli.query('COMMIT');
  } catch (e) {
    await cli.query('ROLLBACK');
    if ((e as { code?: string }).code === '23505') return rep.code(409).send({ erro: 'Já existe uma cultivar com esse nome' });
    throw e;
  } finally {
    cli.release();
  }
  // raiz ou fator p mudaram → capacidade e limite das parcelas que usam esta cultivar acompanham
  const n = await recalcularSolo('p.cultura_id = $1', [id]);
  return { ok: true, parcelas_recalculadas: n };
});

// ---------- integração WeatherLink (gestor/admin) ----------
const wlCorpo = z.object({
  api_key: z.string().trim().min(8).max(100),
  api_secret: z.string().trim().min(8).max(100).optional(),
  station_id: z.string().trim().max(40).nullable().optional(),
  altura_vento_m: z.number().min(1).max(30).default(2),
});

const mascara = (s: string) => `${s.slice(0, 4)}…${s.slice(-3)}`;

async function integracaoDaFazenda(fazId: number) {
  return (
    await pool.query(
      `SELECT i.estacao_id, i.api_key, i.api_secret_cifrado, i.station_id, i.altura_vento_m, i.ativo, i.ultima_sincronizacao, i.ultimo_erro, e.nome AS estacao
         FROM estacao_integracao i JOIN estacao e ON e.id = i.estacao_id WHERE e.fazenda_id = $1 ORDER BY i.estacao_id LIMIT 1`,
      [fazId],
    )
  ).rows[0];
}

app.get('/api/fazendas/:id/integracao/weatherlink', auth, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const i = await integracaoDaFazenda(id);
  if (!i) return { configurada: false };
  return { configurada: true, api_key: mascara(i.api_key), station_id: i.station_id, altura_vento_m: i.altura_vento_m, ativo: i.ativo, ultima_sincronizacao: i.ultima_sincronizacao, ultimo_erro: i.ultimo_erro, estacao: i.estacao };
});

/** Leitura ao vivo da estação ligada + acumulado parcial de hoje (não entra no balanço até o dia fechar). */
app.get('/api/fazendas/:id/clima-agora', auth, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const r = await pool.query(
    `WITH est AS (
       SELECT e.id, e.nome FROM estacao e JOIN estacao_integracao i ON i.estacao_id = e.id AND i.ativo
        WHERE e.fazenda_id = $1 ORDER BY e.id LIMIT 1),
     hoje AS (SELECT (now() AT TIME ZONE 'America/Campo_Grande')::date AS d)
     SELECT est.nome AS estacao,
            (SELECT row_to_json(a) FROM (SELECT ts, temp_c, umidade, vento_ms, radiacao_wm2, chuva_dia_mm FROM estacao_amostra WHERE estacao_id = est.id ORDER BY ts DESC LIMIT 1) a) AS ultima,
            (SELECT row_to_json(p) FROM (
               SELECT min(temp_c) AS tmin, max(temp_c) AS tmax, max(chuva_dia_mm) AS chuva_mm, count(*)::int AS amostras, min(ts) AS desde
                 FROM estacao_amostra, hoje WHERE estacao_id = est.id AND (ts AT TIME ZONE 'America/Campo_Grande')::date = hoje.d) p) AS hoje
       FROM est`,
    [id],
  );
  return r.rows[0] ?? { estacao: null };
});

app.post('/api/fazendas/:id/integracao/weatherlink/testar', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const b = z.object({ api_key: z.string().trim().min(8).max(100), api_secret: z.string().trim().min(8).max(100).optional(), station_id: z.string().trim().max(40).optional() }).parse(req.body);
  const salva = await integracaoDaFazenda(id);
  const secret = b.api_secret ?? (salva ? decifrar(salva.api_secret_cifrado) : undefined);
  if (!secret) return rep.code(400).send({ erro: 'Informe o API Secret' });
  try {
    const estacoes = await listarEstacoes(b.api_key, secret);
    const alvo = b.station_id ?? (estacoes.length === 1 ? String(estacoes[0].station_id) : undefined);
    const agora = alvo ? await lerAgora(b.api_key, secret, alvo).catch((e: Error) => ({ erro: e.message })) : null;
    return { ok: true, estacoes: estacoes.map((e) => ({ station_id: String(e.station_id), nome: e.station_name, latitude: e.latitude ?? null, longitude: e.longitude ?? null, elevacao_m: e.elevation ?? null })), leitura_atual: agora };
  } catch (e) {
    // 422 (e não 502): o Cloudflare substitui o corpo de respostas 502 vindas da origem
    if (e instanceof ErroWeatherLink) return rep.code(422).send({ erro: e.message });
    throw e;
  }
});

app.put('/api/fazendas/:id/integracao/weatherlink', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const b = wlCorpo.parse(req.body);
  const atual = await integracaoDaFazenda(id);
  if (!atual && !b.api_secret) return rep.code(400).send({ erro: 'Informe o API Secret' });
  const cifrado = b.api_secret ? cifrar(b.api_secret) : atual.api_secret_cifrado;
  let estacaoId: number = atual?.estacao_id;
  if (!estacaoId) {
    estacaoId = (await pool.query(`INSERT INTO estacao (fazenda_id, nome, tipo, identificador_externo, geom) SELECT $1, 'Estação WeatherLink', 'api', $2, geom FROM fazenda WHERE id = $1 RETURNING id`, [id, b.station_id ?? null])).rows[0].id;
  } else {
    await pool.query(`UPDATE estacao SET identificador_externo = $2 WHERE id = $1`, [estacaoId, b.station_id ?? null]);
  }
  await pool.query(
    `INSERT INTO estacao_integracao (estacao_id, api_key, api_secret_cifrado, station_id, altura_vento_m, ativo)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (estacao_id) DO UPDATE SET api_key = $2, api_secret_cifrado = $3, station_id = $4, altura_vento_m = $5, ativo = true, ultimo_erro = null`,
    [estacaoId, b.api_key, cifrado, b.station_id ?? null, b.altura_vento_m],
  );
  await amostrar(estacaoId).catch(() => undefined); // primeira leitura já agora; o agendador segue a cada 10 min
  return { ok: true };
});

app.post('/api/fazendas/:id/integracao/weatherlink/sincronizar', gestor, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const b = z.object({ dias: z.number().int().min(1).max(60).default(14) }).parse(req.body ?? {});
  const i = await integracaoDaFazenda(id);
  if (!i?.station_id) return rep.code(400).send({ erro: 'Escolha a estação e salve antes de sincronizar' });
  const [r] = await sincronizar(i.estacao_id, b.dias);
  return r?.erro ? rep.code(422).send({ erro: r.erro }) : { ok: true, gravados: r?.gravados ?? 0, fonte: r?.fonte ?? 'nenhuma', sem_dados: r?.semDados ?? [] };
});

// ---------- clima (entrada manual, RF-22) ----------
const climaCorpo = z.object({
  fazenda_id: z.number().int(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  temp_min: z.number(),
  temp_max: z.number(),
  umidade: z.number().min(0).max(100).optional(),
  chuva_mm: z.number().min(0).default(0),
  vento_ms: z.number().min(0).optional(),
  radiacao_wm2: z.number().min(0).optional(),
  radiacao_mj: z.number().min(0).optional(),
});

app.post('/api/clima', auth, async (req, rep) => {
  if (!ehGestor(req.user)) return rep.code(403).send({ erro: 'Apenas gestor ou admin' });
  const c = climaCorpo.safeParse(req.body);
  if (!c.success) return rep.code(400).send({ erro: 'Dados inválidos', detalhes: c.error.flatten() });
  const d = c.data;
  if (d.temp_max < d.temp_min) return rep.code(400).send({ erro: 'Temperatura máxima menor que a mínima' });
  if (!(await podeFazenda(req.user, d.fazenda_id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const est = (await pool.query(`SELECT e.id, coalesce(e.altitude_m, f.altitude_m) AS alt, ST_Y(f.geom) AS lat FROM estacao e JOIN fazenda f ON f.id = e.fazenda_id WHERE e.fazenda_id = $1 ORDER BY EXISTS (SELECT 1 FROM estacao_integracao i WHERE i.estacao_id = e.id AND i.ativo) DESC, e.id LIMIT 1`, [d.fazenda_id])).rows[0];
  if (!est) return rep.code(400).send({ erro: 'A fazenda não tem estação cadastrada' });
  const rad = d.radiacao_mj ?? (d.radiacao_wm2 != null ? wm2ParaMJ(d.radiacao_wm2) : undefined);
  const { eto, metodo } = etoDia(
    { tmin: d.temp_min, tmax: d.temp_max, umidMed: d.umidade, vento2: d.vento_ms, radiacaoMJ: rad },
    { latitudeGraus: est.lat ?? -20, altitudeM: est.alt ?? 0 },
    d.data,
  );
  await pool.query(
    `INSERT INTO leitura_clima (estacao_id, data, temp_min, temp_med, temp_max, umidade, chuva_mm, vento_ms, radiacao_mj, eto_mm, metodo_eto, origem)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual')
     ON CONFLICT (estacao_id, data) DO UPDATE SET temp_min = EXCLUDED.temp_min, temp_med = EXCLUDED.temp_med, temp_max = EXCLUDED.temp_max,
       umidade = EXCLUDED.umidade, chuva_mm = EXCLUDED.chuva_mm, vento_ms = EXCLUDED.vento_ms, radiacao_mj = EXCLUDED.radiacao_mj,
       eto_mm = EXCLUDED.eto_mm, metodo_eto = EXCLUDED.metodo_eto, origem = 'manual'`,
    [est.id, d.data, d.temp_min, (d.temp_min + d.temp_max) / 2, d.temp_max, d.umidade ?? null, d.chuva_mm, d.vento_ms ?? null, rad ?? null, eto.toFixed(2), metodo],
  );
  return { ok: true, eto_mm: Number(eto.toFixed(2)), metodo };
});

app.get('/api/fazendas/:id/clima', auth, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const r = await pool.query(
    `SELECT l.data, l.temp_min, l.temp_max, l.umidade, l.chuva_mm, l.vento_ms, l.radiacao_mj, l.eto_mm, l.metodo_eto, l.origem
       FROM leitura_clima l JOIN estacao e ON e.id = l.estacao_id
      WHERE e.fazenda_id = $1 AND l.data >= $2 ORDER BY l.data DESC`,
    [id, somarDias(hoje(), -20)],
  );
  return r.rows;
});

// ---------- lançamento de irrigação (RF-40, RF-43) ----------
const lancCorpo = z
  .object({
    parcela_id: z.number().int(),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lamina_mm: z.number().positive().max(200).optional(),
    tempo_min: z.number().positive().max(60 * 200).optional(),
  })
  .refine((v) => v.lamina_mm != null || v.tempo_min != null, 'Informe a lâmina (mm) ou o tempo (min)');

async function fazendaDaParcela(parcelaId: number): Promise<number | null> {
  const r = await pool.query(`SELECT pv.fazenda_id FROM parcela p JOIN pivo pv ON pv.id = p.pivo_id WHERE p.id = $1`, [parcelaId]);
  return r.rows[0]?.fazenda_id ?? null;
}

app.post('/api/lancamentos', auth, async (req, rep) => {
  const c = lancCorpo.safeParse(req.body);
  if (!c.success) return rep.code(400).send({ erro: c.error.issues[0]?.message ?? 'Dados inválidos' });
  const fazId = await fazendaDaParcela(c.data.parcela_id);
  if (fazId == null) return rep.code(404).send({ erro: 'Parcela não encontrada' });
  if (!(await podeFazenda(req.user, fazId))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  if (c.data.data > hoje()) return rep.code(400).send({ erro: 'Data no futuro' });
  const r = await pool.query(
    `INSERT INTO lancamento_irrigacao (parcela_id, data, lamina_mm, tempo_min, usuario_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [c.data.parcela_id, c.data.data, c.data.lamina_mm ?? null, c.data.tempo_min ?? null, req.user.id],
  );
  return { ok: true, id: r.rows[0].id };
});

app.get('/api/fazendas/:id/lancamentos', auth, async (req, rep) => {
  const { id } = idParam.parse(req.params);
  if (!(await podeFazenda(req.user, id))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  const r = await pool.query(
    `SELECT l.id, l.data, l.lamina_mm, l.tempo_min, l.origem, p.nome AS parcela, pv.nome AS pivo, u.nome AS usuario
       FROM lancamento_irrigacao l JOIN parcela p ON p.id = l.parcela_id JOIN pivo pv ON pv.id = p.pivo_id
       LEFT JOIN usuario u ON u.id = l.usuario_id
      WHERE pv.fazenda_id = $1 AND l.data >= $2 ORDER BY l.data DESC, l.id DESC LIMIT 200`,
    [id, somarDias(hoje(), -14)],
  );
  return r.rows;
});

app.delete('/api/lancamentos/:id', auth, async (req, rep) => {
  if (!ehGestor(req.user)) return rep.code(403).send({ erro: 'Apenas gestor ou admin' });
  const { id } = idParam.parse(req.params);
  const r = await pool.query(`SELECT parcela_id FROM lancamento_irrigacao WHERE id = $1`, [id]);
  if (!r.rows[0]) return rep.code(404).send({ erro: 'Lançamento não encontrado' });
  const fazId = await fazendaDaParcela(r.rows[0].parcela_id);
  if (fazId == null || !(await podeFazenda(req.user, fazId))) return rep.code(403).send({ erro: 'Sem acesso à fazenda' });
  await pool.query(`DELETE FROM lancamento_irrigacao WHERE id = $1`, [id]);
  return { ok: true };
});

registrarOperacao(app, { auth, gestor, podeFazenda });
registrarCampo(app, { auth, gestor, podeFazenda });

app.setErrorHandler((err: Error & { statusCode?: number }, _req, rep) => {
  if (err instanceof z.ZodError) return rep.code(400).send({ erro: 'Requisição inválida', detalhes: err.flatten() });
  app.log.error(err);
  return rep.code(err.statusCode ?? 500).send({ erro: err.statusCode && err.statusCode < 500 ? err.message : 'Erro interno' });
});

await esperarBanco();
await aplicarSchema();
await semear();
const porta = Number(process.env.PORT ?? 3000);
await app.listen({ port: porta, host: '0.0.0.0' });
iniciarAgendador(app.log);
iniciarAgendadorTelemetria(app.log);
