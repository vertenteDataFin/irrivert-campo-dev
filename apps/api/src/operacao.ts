/**
 * Operação diária: onde estão os animais, que setores de cada pivô estão ocupados, janelas de energia e
 * a ordem de irrigação do dia (com sentido de rotação e ângulo de parada calculados a partir dos animais).
 */
import { agendar, aplicacaoNaVolta, arcoMinimo, mmPorHora, noArco, permitido, planejarSetor, recomendar, type Arco, type Janela, type PlanoSetor } from '@irrigacao/core';
import { hoje, pool } from './db';
import { calcularFazenda } from './servico';

const TZ = () => process.env.TZ ?? 'America/Campo_Grande';

// ---------- tempo local da fazenda ----------
export function agoraLocal(d = new Date()): { data: string; dia: number; minuto: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  const data = `${p.year}-${p.month}-${p.day}`;
  return { data, dia: new Date(`${data}T12:00:00Z`).getUTCDay(), minuto: Number(p.hour) * 60 + Number(p.minute) };
}

/** Instante UTC correspondente a "dia local + minutos desde 00:00". */
export function instanteLocal(data: string, minutos: number): Date {
  const chute = Date.parse(`${data}T00:00:00Z`) + minutos * 60_000;
  const local = agoraLocal(new Date(chute));
  const deriva = Date.parse(`${local.data}T00:00:00Z`) + local.minuto * 60_000 - chute;
  return new Date(chute - deriva);
}

export async function janelasDaFazenda(fazendaId: number): Promise<Janela[]> {
  const r = await pool.query(`SELECT to_char(inicio, 'HH24:MI') AS inicio, to_char(fim, 'HH24:MI') AS fim, dias FROM janela_irrigacao WHERE fazenda_id = $1 AND ativo ORDER BY inicio`, [fazendaId]);
  return r.rows.map((j) => ({ inicio: j.inicio, fim: j.fim, dias: j.dias as number[] }));
}

export const permitidoAgora = (janelas: Janela[], d = new Date()) => {
  const a = agoraLocal(d);
  return permitido(janelas, a.dia, a.minuto);
};

// ---------- piquetes e animais ----------
export interface Piquete {
  parcelaId: number; nome: string; pivoId: number; pivoNome: string; areaHa: number; cultura: string;
  ocupado: boolean; desde: string | null; ultimaSaida: string | null; cabecas: number | null; lote: string | null;
  notaEntrada: number | null; notaSaida: number | null; ultimoMovimentoId: number | null; diasNoPiquete: number | null; diasDescanso: number | null;
  geom: unknown | null;
}

/** Estado atual de cada piquete (parcela forrageira) a partir do último movimento registrado. */
export async function piquetesDaFazenda(fazendaId: number): Promise<Piquete[]> {
  const r = await pool.query(
    `SELECT p.id AS "parcelaId", p.nome, pv.id AS "pivoId", pv.nome AS "pivoNome", p.area_ha::float AS "areaHa", c.nome AS cultura,
            u.id AS "movId", u.tipo, u.ocorrido_em AS "ocorridoEm", u.cabecas, u.lote,
            (SELECT nota FROM movimento_animal WHERE parcela_id = p.id AND tipo = 'entrada' ORDER BY ocorrido_em DESC, id DESC LIMIT 1) AS "notaEntrada",
            (SELECT nota FROM movimento_animal WHERE parcela_id = p.id AND tipo = 'saida' ORDER BY ocorrido_em DESC, id DESC LIMIT 1) AS "notaSaida",
            (SELECT ocorrido_em FROM movimento_animal WHERE parcela_id = p.id AND tipo = 'saida' ORDER BY ocorrido_em DESC, id DESC LIMIT 1) AS "ultimaSaida",
            ST_AsGeoJSON(ST_SimplifyPreserveTopology(p.geom, 0.00003), 5)::json AS geom
       FROM parcela p
       JOIN pivo pv ON pv.id = p.pivo_id
       JOIN cultura c ON c.id = p.cultura_id AND c.tipo = 'forrageira'
       LEFT JOIN LATERAL (SELECT id, tipo, ocorrido_em, cabecas, lote FROM movimento_animal WHERE parcela_id = p.id ORDER BY ocorrido_em DESC, id DESC LIMIT 1) u ON true
      WHERE pv.fazenda_id = $1 AND p.ativo AND pv.ativo
      ORDER BY pv.nome, p.nome`, [fazendaId]);
  const agora = Date.now();
  const dias = (iso: string | Date | null) => (iso ? Math.max(0, Math.floor((agora - new Date(iso).getTime()) / 86_400_000)) : null);
  return r.rows.map((x) => {
    const ocupado = x.tipo === 'entrada';
    return {
      parcelaId: x.parcelaId, nome: x.nome, pivoId: x.pivoId, pivoNome: x.pivoNome, areaHa: x.areaHa, cultura: x.cultura,
      ocupado, desde: ocupado ? new Date(x.ocorridoEm).toISOString() : null,
      ultimaSaida: x.ultimaSaida ? new Date(x.ultimaSaida).toISOString() : null,
      cabecas: ocupado ? x.cabecas : null, lote: ocupado ? x.lote : null,
      notaEntrada: x.notaEntrada, notaSaida: x.notaSaida, ultimoMovimentoId: x.movId,
      diasNoPiquete: ocupado ? dias(x.ocorridoEm) : null, diasDescanso: !ocupado ? dias(x.ultimaSaida) : null,
      geom: x.geom ?? null,
    };
  });
}

// ---------- geometria: que ângulos do pivô cada piquete ocupa ----------
function vertices(g: any): [number, number][] {
  if (!g) return [];
  if (g.type === 'Polygon') return g.coordinates.flat();
  if (g.type === 'MultiPolygon') return g.coordinates.flat(2);
  return [];
}

const azimute = (c: { lat: number; lon: number }, [lon, lat]: [number, number]) =>
  (Math.atan2((lon - c.lon) * Math.cos((c.lat * Math.PI) / 180), lat - c.lat) * 180) / Math.PI;

const metrosAte = (c: { lat: number; lon: number }, [lon, lat]: [number, number]) =>
  Math.hypot((lon - c.lon) * 111_320 * Math.cos((c.lat * Math.PI) / 180), (lat - c.lat) * 111_320);

/** Arco (graus a partir do norte) que cada parcela do pivô ocupa, visto do centro. */
export async function arcosDasParcelas(pivoId: number): Promise<Map<number, Arco>> {
  const c = (await pool.query(
    `SELECT COALESCE(tp.lat, ST_Y(ST_Centroid(pv.geom))) AS lat, COALESCE(tp.lon, ST_X(ST_Centroid(pv.geom))) AS lon
       FROM pivo pv LEFT JOIN telemetria_pivo tp ON tp.pivo_id = pv.id WHERE pv.id = $1 ORDER BY tp.lat IS NULL LIMIT 1`, [pivoId])).rows[0];
  const out = new Map<number, Arco>();
  if (!c || c.lat == null) return out;
  const centro = { lat: Number(c.lat), lon: Number(c.lon) };
  const ps = (await pool.query(`SELECT id, ST_AsGeoJSON(geom)::json AS geom FROM parcela WHERE pivo_id = $1 AND ativo AND geom IS NOT NULL`, [pivoId])).rows;
  for (const p of ps) {
    const pts = vertices(p.geom).filter((v) => metrosAte(centro, v) > 15); // ignora a ponta da cunha, no centro
    const arco = arcoMinimo(pts.map((v) => azimute(centro, v)));
    if (arco) out.set(p.id, arco);
  }
  return out;
}

/** Arcos ocupados por animais em cada pivô (só piquetes com animais agora). */
export async function arcosOcupadosPorPivo(fazendaId: number): Promise<Map<number, Arco[]>> {
  const ocupados = (await piquetesDaFazenda(fazendaId)).filter((p) => p.ocupado);
  const out = new Map<number, Arco[]>();
  for (const pivoId of new Set(ocupados.map((p) => p.pivoId))) {
    const arcos = await arcosDasParcelas(pivoId);
    const lista = ocupados.filter((p) => p.pivoId === pivoId).map((p) => arcos.get(p.parcelaId)).filter((a): a is Arco => a != null);
    if (lista.length) out.set(pivoId, lista);
  }
  return out;
}

export const estaEmArco = (angulo: number, arcos: Arco[]) => arcos.some((a) => noArco(angulo, a));

export async function planoDoPivo(pivoId: number, fazendaId: number, anguloAtual: number | null): Promise<PlanoSetor & { ocupados: string[] }> {
  const ocup = (await piquetesDaFazenda(fazendaId)).filter((p) => p.ocupado && p.pivoId === pivoId);
  const arcos = await arcosDasParcelas(pivoId);
  const lista = ocup.map((p) => arcos.get(p.parcelaId)).filter((a): a is Arco => a != null);
  const plano = planejarSetor(anguloAtual, lista);
  // piquete com animais mas sem geometria utilizável: não dá para calcular o setor, então avisa
  const semGeom = ocup.filter((p) => !arcos.has(p.parcelaId));
  if (semGeom.length) plano.avisos.push(`Sem mapa para calcular o setor de: ${semGeom.map((p) => p.nome).join(', ')}.`);
  return { ...plano, ocupados: ocup.map((p) => p.nome) };
}

// ---------- ordem de irrigação do dia ----------
const arred = (n: number, c = 1) => Math.round(n * 10 ** c) / 10 ** c;

/** Pivô escolhido no Preciso irrigar para a ordem do dia; sem lâmina, usa a recomendada (ou uma volta a 100 %). */
export interface EscolhaPivo { pivoId: number; laminaMm?: number | null }

/**
 * Monta a ordem de irrigação do dia.
 * - Sem `escolhas`: entram os pivôs que o balanço pede (regra do iCrop), com a lâmina recomendada.
 * - Com `escolhas` (seleção feita no Preciso irrigar): entram exatamente esses pivôs, com a lâmina definida pelo
 *   usuário, mesmo os que o balanço não pede. A lista substitui a ordem planejada do dia; o que já foi enviado ou
 *   concluído fica como está.
 * Em ambos os casos: sentido e ângulo de parada pelos animais, do mais seco ao menos seco, encaixados nas janelas.
 */
export async function gerarOrdem(fazendaId: number, escolhas?: EscolhaPivo[]) {
  const data = hoje();
  const escolhidos = escolhas ? new Map(escolhas.map((e) => [e.pivoId, e.laminaMm ?? null])) : null;
  const calc = await calcularFazenda(fazendaId, { comChuva: true });
  if (!calc) return null;

  const hid = new Map((await pool.query(`SELECT id, lamina_volta_100_mm::float AS lam, horas_volta_100::float AS horas FROM pivo WHERE fazenda_id = $1`, [fazendaId])).rows.map((p) => [p.id as number, p]));
  const tel = new Map((await pool.query(
    `SELECT tp.pivo_id, tp.angulo::float AS angulo FROM telemetria_pivo tp JOIN telemetria_conta tc ON tc.id = tp.conta_id WHERE tc.fazenda_id = $1 AND tp.pivo_id IS NOT NULL`, [fazendaId])).rows.map((t) => [t.pivo_id as number, t.angulo as number | null]));

  const grupos = new Map<number, typeof calc.parcelas>();
  for (const p of calc.parcelas) grupos.set(p.pivoId, [...(grupos.get(p.pivoId) ?? []), p]);

  const feitos = new Set((await pool.query(`SELECT pivo_id FROM ordem_irrigacao WHERE fazenda_id = $1 AND data = $2 AND status IN ('enviada','concluida')`, [fazendaId, data])).rows.map((r) => r.pivo_id as number));

  interface Cand { pivoId: number; nome: string; urgencia: number; laminaMm: number; percentual: number; duracaoMin: number; plano: Awaited<ReturnType<typeof planoDoPivo>> }
  const candidatos: Cand[] = [];
  const adiados: { pivoId: number; nome: string; aviso: string }[] = [];

  for (const [pivoId, ps] of grupos) {
    if (feitos.has(pivoId)) continue;
    if (escolhidos && !escolhidos.has(pivoId)) continue;
    const area = ps.reduce((s, p) => s + p.areaHa, 0) || 1;
    const pond = (f: (p: (typeof ps)[number]) => number) => ps.reduce((s, p) => s + f(p) * p.areaHa, 0) / area;
    const lamina = pond((p) => p.laminaMm);
    const limite = pond((p) => p.limiteMm);
    const cap = pond((p) => p.capMm);
    const h = hid.get(pivoId);
    if (!h || !(h.lam > 0) || !(h.horas > 0)) continue;
    // O pivô gira inteiro: a regra do iCrop (déficit até a capacidade maior que a ETc do dia) vale na média do pivô.
    const rec = recomendar(
      lamina,
      { capUtilMm: cap, limiteSegurancaMm: limite, eficiencia: ps[0].hidraulica.eficiencia, mmPorHora: mmPorHora(h.lam, h.horas), laminaVoltaMm: h.lam },
      pond((p) => p.etcHojeMm),
    );
    if (!escolhidos && !rec.recomendaIrrigar) continue;

    // lâmina bruta: a do usuário; senão a recomendada; senão (escolhido sem precisar) uma volta a 100 %
    const definida = escolhidos?.get(pivoId) ?? null;
    const itnBruta = definida ?? (rec.recomendaIrrigar ? rec.itnBrutaMm : h.lam);
    const { percentual: velocidade, duracaoMin: volta } = aplicacaoNaVolta(itnBruta, h.lam, h.horas);
    const plano = await planoDoPivo(pivoId, fazendaId, tel.get(pivoId) ?? null);
    if (escolhidos && !rec.recomendaIrrigar) plano.avisos.push('Escolhido pelo gestor: o balanço não pede reposição hoje.');
    if (itnBruta < h.lam) plano.avisos.push(`Lâmina abaixo da de uma volta a 100 %: o pivô aplica ${arred(h.lam)} mm.`);
    if (plano.situacao === 'bloqueado') { adiados.push({ pivoId, nome: ps[0].pivoNome, aviso: 'Todos os piquetes do pivô têm animais: irrigação adiada.' }); continue; }
    const fracaoLivre = plano.situacao === 'livre' ? 1 : plano.livres.reduce((s, a) => s + ((((a.ate - a.de) % 360) + 360) % 360 + 1) / 360, 0);
    candidatos.push({
      // fração da água facilmente disponível já consumida (> 1 = abaixo do limite de segurança)
      pivoId, nome: ps[0].pivoNome, urgencia: (cap - lamina) / Math.max(cap - limite, 1),
      laminaMm: arred(itnBruta), percentual: arred(velocidade, 0), duracaoMin: Math.max(5, Math.round(volta * Math.min(1, fracaoLivre))), plano,
    });
  }
  candidatos.sort((a, b) => b.urgencia - a.urgencia);

  const agora = agoraLocal();
  const janelas = await janelasDaFazenda(fazendaId);
  const simult = (await pool.query(`SELECT max_pivos_simultaneos AS n FROM fazenda WHERE id = $1`, [fazendaId])).rows[0]?.n ?? 1;
  const inicioMin = Math.ceil(agora.minuto / 5) * 5;
  const segs = agendar(candidatos.map((c) => ({ id: c.pivoId, duracaoMin: c.duracaoMin })), janelas, { diaSemanaBase: agora.dia, minutoInicial: inicioMin, simultaneos: simult });

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query(`DELETE FROM ordem_irrigacao WHERE fazenda_id = $1 AND data = $2 AND status IN ('planejada','cancelada')`, [fazendaId, data]);
    let seq = 1;
    for (const c of candidatos) {
      const s = segs.filter((x) => x.id === c.pivoId);
      const avisos = [...c.plano.avisos];
      if (!s.length) avisos.push('Não há janela de energia livre nos próximos 7 dias.');
      if (s.length > 1) avisos.push('Não cabe numa janela só: continua na janela seguinte.');
      if (c.plano.ocupados.length) avisos.push(`Animais em: ${c.plano.ocupados.join(', ')}.`);
      await cli.query(
        `INSERT INTO ordem_irrigacao (fazenda_id, data, pivo_id, sequencia, inicio_previsto, fim_previsto, duracao_min, lamina_mm, sentido, angulo_parada, percentual, avisos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [fazendaId, data, c.pivoId, seq++, s.length ? instanteLocal(data, s[0].inicioMin) : null, s.length ? instanteLocal(data, s[s.length - 1].fimMin) : null,
          c.duracaoMin, c.laminaMm, c.plano.sentido, c.plano.anguloParada, c.percentual, avisos],
      );
    }
    for (const a of adiados) {
      await cli.query(`INSERT INTO ordem_irrigacao (fazenda_id, data, pivo_id, sequencia, duracao_min, status, avisos) VALUES ($1,$2,$3,$4,0,'cancelada',$5)`, [fazendaId, data, a.pivoId, seq++, [a.aviso]]);
    }
    await cli.query('COMMIT');
  } catch (e) {
    await cli.query('ROLLBACK');
    throw e;
  } finally {
    cli.release();
  }
  return lerOrdem(fazendaId, data);
}

export async function lerOrdem(fazendaId: number, data: string = hoje()) {
  const itens = (await pool.query(
    `SELECT o.id, o.pivo_id AS "pivoId", pv.nome AS "pivoNome", o.sequencia, o.inicio_previsto AS "inicio", o.fim_previsto AS "fim", o.duracao_min AS "duracaoMin",
            o.lamina_mm::float AS "laminaMm", o.sentido, o.angulo_parada::float AS "anguloParada", o.percentual::float AS percentual, o.avisos, o.status, o.motivo,
            tp.id AS "telemetriaId", tp.provedor_nome AS "provedor", tp.categoria, tp.angulo::float AS angulo
       FROM ordem_irrigacao o JOIN pivo pv ON pv.id = o.pivo_id
       LEFT JOIN LATERAL (SELECT t.id, t.categoria, t.angulo, c.provedor AS provedor_nome FROM telemetria_pivo t JOIN telemetria_conta c ON c.id = t.conta_id WHERE t.pivo_id = o.pivo_id ORDER BY t.id LIMIT 1) tp ON true
      WHERE o.fazenda_id = $1 AND o.data = $2 ORDER BY (o.status = 'cancelada'), o.sequencia`, [fazendaId, data])).rows;
  const janelas = await janelasDaFazenda(fazendaId);
  return { data, itens, janelas, permitidoAgora: permitidoAgora(janelas) };
}

