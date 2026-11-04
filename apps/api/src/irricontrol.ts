/**
 * Conector Irricontrol (Bauer) — SOMENTE LEITURA. Não envia comandos aos pivôs.
 *
 * A plataforma não publica API; usamos os mesmos pontos que o painel web usa (https://app.irricontrol.net/v3),
 * com o login do cliente (e-mail/usuário + senha, guardados cifrados). O token é renovado sozinho no 401.
 *
 * O que sai daqui: estado ao vivo de cada pivô (ângulo, status, % de velocidade, tensão, pressão, horas molhadas),
 * parâmetros hidráulicos reais (vazão, velocidade, raio, área) e a lâmina aplicada, repartida entre as parcelas
 * pela fatia (setor) que o pivô percorreu entre duas leituras.
 */
import { lerConta as lerContaAgsense } from './agsense';
import { avaliarAlertas } from './alertas';
import { hoje, pool } from './db';
import { cifrar, decifrar } from './weatherlink';

const BASE = 'https://app.irricontrol.net/v3';

export type Categoria = 'irrigando' | 'movendo' | 'aguardando' | 'parado' | 'desligado' | 'alarme' | 'sem_sinal';

/** Códigos de status do painel (tabela do próprio app da Irricontrol). */
export const STATUS: Record<number, [string, Categoria]> = {
  0: ['Parado pela web', 'parado'],
  1: ['Movendo para frente', 'movendo'],
  2: ['Movendo em reverso', 'movendo'],
  3: ['Aguardando pressão', 'aguardando'],
  4: ['Irrigando', 'irrigando'],
  5: ['Aguardando atraso de pressão', 'aguardando'],
  6: ['Movendo a seco', 'movendo'],
  7: ['Programado', 'aguardando'],
  8: ['Preparando para ligar', 'aguardando'],
  9: ['Parado por horário de pico', 'parado'],
  10: ['Irrigação finalizada', 'parado'],
  11: ['Parado em autorreversão', 'parado'],
  12: ['Parado via internet', 'parado'],
  13: ['Parado via painel', 'parado'],
  14: ['Painel energizado', 'parado'],
  15: ['Desalinhado', 'alarme'],
  16: ['Falha de pressão', 'alarme'],
  17: ['Direção de irrigação inválida', 'alarme'],
  18: ['Queda de energia', 'alarme'],
  19: ['Tensão fora da faixa', 'alarme'],
  20: ['Erro de parâmetro', 'alarme'],
  21: ['Erro desconhecido', 'alarme'],
  22: ['Painel desligado', 'desligado'],
  23: ['Tempo de bomba excedido', 'alarme'],
  24: ['Irrigação começou', 'irrigando'],
  25: ['Botão parar pressionado', 'parado'],
  32: ['Erro na bomba', 'alarme'],
  33: ['Movendo a seco pelo pluviômetro', 'movendo'],
  34: ['Parado pelo pluviômetro', 'parado'],
  35: ['Erro no relógio interno', 'alarme'],
  36: ['Fertirrigação ligada', 'irrigando'],
  37: ['Fertirrigação parada', 'parado'],
  38: ['Sem comunicação', 'sem_sinal'],
};

export interface PivoTel {
  externoId: string;
  nome: string;
  lat: number | null;
  lon: number | null;
  raioM: number | null;
  areaHa: number | null;
  vazaoM3h: number | null;
  velocidadeMh: number | null;
  angulo: number | null;
  destinoAngulo: number | null;
  statusCod: number | null;
  statusTxt: string;
  categoria: Categoria;
  direcao: number | null;
  percentual: number | null;
  tensaoV: number | null;
  pressaoPonta: number | null;
  bomba: boolean | null;
  canhao: boolean | null;
  horasMolhado: number | null;
  atualizadoEm: string | null;
  /** Hidráulica informada pelo fabricante (AgSense): lâmina e horas de uma volta a 100%. Se ausente, calcula-se. */
  lamina100Mm?: number | null;
  horasVolta100?: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Converte um registro de /pivots/paginated/ no nosso formato. Usa o fluxo (GPS ou painel) mais recente. */
export function normalizar(raw: any): PivoTel {
  const gps = raw.controllerstream_gps ?? null;
  const painel = raw.controllerstream_panel ?? null;
  const t = (s: any) => (s?.updated ? Date.parse(s.updated) : 0);
  const [fluxo, outro] = t(gps) >= t(painel) ? [gps, painel] : [painel, gps];
  const c = fluxo?.content ?? {};
  const o = outro?.content ?? {};
  const pega = <T,>(f: (x: any) => T | undefined): T | undefined => f(c) ?? f(o);
  const cfg = raw.controllerconfig?.content ?? {};
  const par = cfg.pivot_parameters ?? {};
  const pos = cfg.pivot_positions ?? {};

  const cod = num(c.irrigation_status?.irrigation_status);
  const [statusTxt, categoria] = cod != null && STATUS[cod] ? STATUS[cod] : ['Sem informação', 'sem_sinal' as Categoria];
  const info = pega((x) => x.current_irrigation_information) ?? {};
  const op = pega((x) => x.operation_time);
  const disp = pega((x) => x.devices_current_status);
  const tensao = num(pega((x) => x.voltage_measure?.voltage_measure));
  const ponta = num(pega((x) => x.end_tower_pressure?.end_tower_pressure));

  return {
    externoId: String(raw.id),
    nome: String(raw.name ?? `Pivô ${raw.id}`),
    lat: num(pos.latitude_center),
    lon: num(pos.longitude_center),
    raioM: num(par.radius_last),
    areaHa: num(par.irrigated_area),
    vazaoM3h: num(par.flow_rate),
    velocidadeMh: num(par.speed),
    angulo: num(fluxo?.current_angle),
    destinoAngulo: info.stop_mode === 0 || info.stop_mode == null ? num(info.stop_angle) : null,
    statusCod: cod,
    statusTxt,
    categoria,
    direcao: num(info.direction),
    percentual: num(info.irrigation_percent),
    tensaoV: tensao != null && tensao > 0 ? tensao : null,
    pressaoPonta: ponta != null && ponta >= 0 ? ponta : null,
    bomba: disp ? disp.pump === 1 : null,
    canhao: disp ? disp.endgun === 1 : null,
    horasMolhado: op && num(op.wet_hour) != null ? op.wet_hour + (num(op.wet_minute) ?? 0) / 60 : null,
    atualizadoEm: fluxo?.updated ?? null,
  };
}

// ---------- geometria e hidráulica (puras) ----------

/** Horas de uma volta completa a 100% (velocidade da última torre em m/h) e lâmina bruta dessa volta. */
export function hidraulica(p: Pick<PivoTel, 'vazaoM3h' | 'velocidadeMh' | 'raioM' | 'areaHa'>) {
  if (!p.vazaoM3h || !p.velocidadeMh || !p.raioM || !p.areaHa) return null;
  const horas = (2 * Math.PI * p.raioM) / p.velocidadeMh;
  return { horasVolta100: horas, laminaVolta100: (p.vazaoM3h * horas) / (p.areaHa * 10) };
}

/**
 * Fatia percorrida entre duas leituras (ângulo medido a partir do norte, no sentido horário).
 * direcao 0 = frente (ângulo cresce), 1 = reverso. Devolve null se o movimento não faz sentido
 * (sentido contrário, salto grande demais ou quase parado): nesse caso não se lança água.
 */
export function setorPercorrido(a0: number, a1: number, direcao: number | null, maxGraus = 45) {
  const d = ((((a1 - a0 + 540) % 360) + 360) % 360) - 180;
  const sentido = direcao === 1 ? -1 : 1;
  const graus = d * sentido;
  if (graus < 0.3 || graus > maxGraus) return null;
  return direcao === 1 ? { de: a1, ate: a0, graus } : { de: a0, ate: a1, graus };
}

/** Lâmina média (mm) sobre a fatia: volume bombeado ÷ área da fatia (área do pivô × graus/360). */
export const laminaNoSetor = (vazaoM3h: number, horas: number, areaHa: number, graus: number) =>
  (vazaoM3h * horas) / (((areaHa * graus) / 360) * 10);

/** Polígono (WKT, lon/lat) da fatia, aproximando pela projeção local — suficiente para 500 m. */
export function cunhaWKT(lat: number, lon: number, raioM: number, de: number, ate: number): string {
  const pts: string[] = [`${lon} ${lat}`];
  const n = Math.max(2, Math.ceil(ate - de));
  for (let i = 0; i <= n; i++) {
    const az = ((de + ((ate - de) * i) / n) * Math.PI) / 180;
    const dy = (raioM * Math.cos(az)) / 111_320;
    const dx = (raioM * Math.sin(az)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    pts.push(`${(lon + dx).toFixed(7)} ${(lat + dy).toFixed(7)}`);
  }
  pts.push(`${lon} ${lat}`);
  return `POLYGON((${pts.join(',')}))`;
}

// ---------- cliente HTTP ----------
export class ErroIricontrol extends Error {
  constructor(public status: number, mensagem: string) { super(mensagem); }
}

async function http<T>(caminho: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...resto } = init;
  const r = await fetch(`${BASE}${caminho}`, {
    ...resto,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(25_000),
  });
  const corpo = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) {
    const motivo = corpo?.error_message ?? corpo?.detail ?? corpo?.message ?? 'erro';
    throw new ErroIricontrol(r.status, motivo === 'INVALID_CREDENTIALS' ? 'Irricontrol: usuário ou senha incorretos' : `Irricontrol ${r.status}: ${motivo}`);
  }
  return corpo as T;
}

/** Mesmo login do site: e-mail (ou usuário) + senha. */
export async function entrar(usuario: string, senha: string): Promise<string> {
  const chave = usuario.includes('@') ? 'email' : 'username';
  const r = await http<{ token?: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ method: 'password', [chave]: usuario, password: senha }) });
  if (!r.token) throw new ErroIricontrol(401, 'Irricontrol: login sem token');
  return r.token;
}

const listarFazendas = (token: string) => http<{ id: number; name: string }[]>('/farms/', { token });

async function listarPivos(token: string, fazendaExterna: number): Promise<any[]> {
  const todos: any[] = [];
  for (let pg = 1; pg <= 10; pg++) {
    const r = await http<{ results: any[]; next: string | null }>(`/farms/${fazendaExterna}/pivots/paginated/?page=${pg}`, { token });
    todos.push(...r.results);
    if (!r.next) break;
  }
  return todos;
}

/** Lê todos os pivôs da conta; no 401 entra de novo com a senha guardada e tenta uma vez mais. */
export async function lerConta(contaId: number): Promise<{ pivos: PivoTel[]; fazendas: string[] }> {
  const prov = (await pool.query(`SELECT provedor FROM telemetria_conta WHERE id = $1`, [contaId])).rows[0]?.provedor;
  return prov === 'agsense' ? lerContaAgsense(contaId) : lerContaIricontrol(contaId);
}

async function lerContaIricontrol(contaId: number): Promise<{ pivos: PivoTel[]; fazendas: string[] }> {
  const c = (await pool.query(`SELECT usuario, senha_cifrada, token_cifrado FROM telemetria_conta WHERE id = $1`, [contaId])).rows[0];
  if (!c) throw new Error('Conta de telemetria não encontrada');
  let token: string | null = c.token_cifrado ? decifrar(c.token_cifrado) : null;
  const renovar = async () => {
    token = await entrar(c.usuario, decifrar(c.senha_cifrada));
    await pool.query(`UPDATE telemetria_conta SET token_cifrado = $2 WHERE id = $1`, [contaId, cifrar(token)]);
  };
  const executar = async () => {
    const fazendas = await listarFazendas(token!);
    const pivos: PivoTel[] = [];
    for (const f of fazendas) for (const raw of await listarPivos(token!, f.id)) pivos.push(normalizar(raw));
    return { pivos, fazendas: fazendas.map((f) => f.name) };
  };
  if (!token) await renovar();
  try {
    return await executar();
  } catch (e) {
    if (e instanceof ErroIricontrol && e.status === 401) {
      await renovar();
      return executar();
    }
    throw e;
  }
}

// ---------- sincronização ----------
export interface ResumoSync { pivos: number; casados: number; lancamentos: number; mmMax: number }

export async function sincronizar(contaId: number): Promise<ResumoSync> {
  const conta = (await pool.query(`SELECT fazenda_id FROM telemetria_conta WHERE id = $1`, [contaId])).rows[0];
  const { pivos, fazendas } = await lerConta(contaId);
  const resumo: ResumoSync = { pivos: pivos.length, casados: 0, lancamentos: 0, mmMax: 0 };

  for (const p of pivos) {
    const up = await pool.query(
      `INSERT INTO telemetria_pivo (conta_id, externo_id, nome, lat, lon, raio_m, area_ha, vazao_m3h, velocidade_m_h, angulo, destino_angulo, status_cod, status_txt, categoria,
                                    direcao, percentual, tensao_v, pressao_ponta, bomba, canhao, horas_molhado, atualizado_em, coletado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
       ON CONFLICT (conta_id, externo_id) DO UPDATE SET nome=EXCLUDED.nome, lat=EXCLUDED.lat, lon=EXCLUDED.lon, raio_m=EXCLUDED.raio_m, area_ha=EXCLUDED.area_ha,
         vazao_m3h=EXCLUDED.vazao_m3h, velocidade_m_h=EXCLUDED.velocidade_m_h, angulo=EXCLUDED.angulo, destino_angulo=EXCLUDED.destino_angulo,
         status_cod=EXCLUDED.status_cod, status_txt=EXCLUDED.status_txt, categoria=EXCLUDED.categoria, direcao=EXCLUDED.direcao, percentual=EXCLUDED.percentual,
         tensao_v=EXCLUDED.tensao_v, pressao_ponta=EXCLUDED.pressao_ponta, bomba=EXCLUDED.bomba, canhao=EXCLUDED.canhao, horas_molhado=EXCLUDED.horas_molhado,
         atualizado_em=EXCLUDED.atualizado_em, coletado_em=now()
       RETURNING id, pivo_id`,
      [contaId, p.externoId, p.nome, p.lat, p.lon, p.raioM, p.areaHa, p.vazaoM3h, p.velocidadeMh, p.angulo, p.destinoAngulo, p.statusCod, p.statusTxt, p.categoria,
       p.direcao, p.percentual, p.tensaoV, p.pressaoPonta, p.bomba, p.canhao, p.horasMolhado, p.atualizadoEm],
    );
    const telId: number = up.rows[0].id;
    let pivoId: number | null = up.rows[0].pivo_id;

    // casa com o pivô do mapa pela posição do centro (dentro do polígono, ou a até 150 m)
    if (pivoId == null && p.lat != null && p.lon != null) {
      const m = await pool.query(
        `SELECT pv.id FROM pivo pv, ST_SetSRID(ST_MakePoint($2, $3), 4326) AS pt
          WHERE pv.fazenda_id = $1 AND pv.geom IS NOT NULL
            AND (ST_Contains(pv.geom, pt) OR ST_Distance(pv.geom::geography, pt::geography) <= 150)
          ORDER BY ST_Contains(pv.geom, pt) DESC, ST_Distance(pv.geom::geography, pt::geography) LIMIT 1`,
        [conta.fazenda_id, p.lon, p.lat],
      );
      if (m.rowCount) {
        pivoId = m.rows[0].id;
        await pool.query(`UPDATE telemetria_pivo SET pivo_id = $2 WHERE id = $1`, [telId, pivoId]);
      }
    }
    if (pivoId != null) resumo.casados++;

    // hidráulica real no lugar dos valores-padrão "a confirmar"
    const calc = hidraulica(p);
    const h = p.lamina100Mm && p.horasVolta100 ? { laminaVolta100: p.lamina100Mm, horasVolta100: p.horasVolta100 } : calc;
    if (pivoId != null && h) {
      await pool.query(
        `UPDATE pivo SET vazao_m3h = $2, lamina_volta_100_mm = $3, horas_volta_100 = $4, parametros_confirmados = true
          WHERE id = $1 AND parametros_confirmados = false`,
        [pivoId, p.vazaoM3h, Math.round(h.laminaVolta100 * 100) / 100, Math.round(h.horasVolta100 * 100) / 100],
      );
    }

    // lâmina aplicada desde a leitura anterior, repartida pelas parcelas da fatia percorrida
    if (p.angulo != null && p.horasMolhado != null && p.atualizadoEm) {
      const prev = (await pool.query(
        `SELECT angulo, horas_molhado, ts FROM telemetria_leitura WHERE telemetria_pivo_id = $1 ORDER BY ts DESC LIMIT 1`, [telId],
      )).rows[0];
      const ts = new Date(p.atualizadoEm);
      let avancar = true;
      if (prev && ts > new Date(prev.ts)) {
        const dh = p.horasMolhado - Number(prev.horas_molhado);
        if (dh > 0 && dh < 3) {
          const setor = setorPercorrido(Number(prev.angulo), p.angulo, p.direcao);
          if (!setor && Math.abs(p.angulo - Number(prev.angulo)) < 0.3) {
            avancar = false; // ainda não andou o bastante: acumula para a próxima leitura
          } else if (setor && pivoId != null && p.lat != null && p.lon != null && p.vazaoM3h && p.areaHa) {
            const mm = laminaNoSetor(p.vazaoM3h, dh, p.areaHa, setor.graus);
            const raio = Math.max(p.raioM ?? 0, Math.sqrt((p.areaHa * 10_000) / Math.PI));
            const wkt = cunhaWKT(p.lat, p.lon, raio, setor.de, setor.ate);
            const ps = await pool.query(
              `SELECT pa.id, ST_Area(ST_Intersection(pa.geom, w.g)::geography) / NULLIF(ST_Area(pa.geom::geography), 0) AS fracao
                 FROM parcela pa, (SELECT ST_MakeValid(ST_SetSRID(ST_GeomFromText($2), 4326)) AS g) w
                WHERE pa.pivo_id = $1 AND pa.ativo AND ST_Intersects(pa.geom, w.g)`,
              [pivoId, wkt],
            );
            for (const r of ps.rows) {
              const lamina = mm * Number(r.fracao);
              if (!(lamina > 0)) continue;
              await pool.query(
                `INSERT INTO lancamento_irrigacao (parcela_id, data, lamina_mm, origem) VALUES ($1, $2, $3, 'telemetria')
                 ON CONFLICT (parcela_id, data) WHERE origem = 'telemetria' DO UPDATE SET lamina_mm = lancamento_irrigacao.lamina_mm + EXCLUDED.lamina_mm`,
                [r.id, hoje(), Math.round(lamina * 1000) / 1000],
              );
              resumo.lancamentos++;
              resumo.mmMax = Math.max(resumo.mmMax, lamina);
            }
          }
        }
      }
      if (avancar && (!prev || ts > new Date(prev.ts))) {
        await pool.query(
          `INSERT INTO telemetria_leitura (telemetria_pivo_id, ts, angulo, status_cod, percentual, horas_molhado) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [telId, ts, p.angulo, p.statusCod, p.percentual, p.horasMolhado],
        );
      }
    }
  }
  await pool.query(`UPDATE telemetria_conta SET ultima_sincronizacao = now(), ultimo_erro = NULL, farm_externo = $2 WHERE id = $1`, [contaId, fazendas.join(', ')]);
  return resumo;
}

/** A cada 2 min lê todos os pivôs; guarda o erro na conta (aparece no painel). Histórico é podado após 60 dias. */
export function iniciarAgendadorTelemetria(log: { info: (m: string) => void; error: (m: string) => void }) {
  let n = 0;
  let rodando = false;
  const rodar = async () => {
    if (rodando) return;
    rodando = true;
    try {
      const contas = (await pool.query(`SELECT id, fazenda_id FROM telemetria_conta WHERE ativo`)).rows;
      for (const c of contas) {
        try {
          const r = await sincronizar(c.id);
          if (n % 15 === 0) log.info(`[telemetria] conta ${c.id}: ${JSON.stringify(r)}`);
        } catch (e) {
          await pool.query(`UPDATE telemetria_conta SET ultimo_erro = $2 WHERE id = $1`, [c.id, (e as Error).message.slice(0, 300)]);
          log.error(`[telemetria] conta ${c.id}: ${(e as Error).message}`);
        }
      }
      for (const fid of new Set(contas.map((c) => c.fazenda_id as number))) {
        try {
          await avaliarAlertas(fid, log);
        } catch (e) {
          log.error(`[alertas] fazenda ${fid}: ${(e as Error).message}`);
        }
      }
      if (n++ % 720 === 0) await pool.query(`DELETE FROM telemetria_leitura WHERE ts < now() - interval '60 days'`);
    } finally {
      rodando = false;
    }
  };
  setTimeout(rodar, 45_000);
  setInterval(rodar, 2 * 60 * 1000).unref();
}
