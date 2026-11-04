/**
 * Conector AgSense 365 (Valley/Valmont) — SOMENTE LEITURA. Não envia comandos aos pivôs.
 *
 * Sem API pública: usa as mesmas chamadas do painel web (https://api.agsense365.com/index.php).
 * Login = usuário + MD5 da senha (como o site faz); o token volta no JSON e é renovado quando a API devolve
 * "Token Invalid" (código 7). Unidades em polegadas/pés/gpm são convertidas para mm, m e m³/h.
 */
import { createHash } from 'node:crypto';
import { pool } from './db';
import type { Categoria, PivoTel } from './irricontrol';
import { cifrar, decifrar } from './weatherlink';

const BASE = 'https://api.agsense365.com/index.php';
const FT = 0.3048;
const GPM_M3H = 0.2271247;
const POL_MM = 25.4;
/** Leitura "ligado" mais velha que isso não é confiável: o pivô pode ter parado sem avisar. */
const MAX_IDADE_ON_MIN = 90;

export class ErroAgsense extends Error {
  constructor(public status: number, mensagem: string) { super(mensagem); }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const MOTIVOS_PARADA: Record<string, string> = { command: 'Parado por comando', sis: 'Parado no ângulo programado' };

/** "P03 FAZ VERTENTE " → "Pivô 03"; outros nomes ficam como estão. */
export function nomeDoPivo(alias: string): string {
  const m = alias.trim().match(/^P\s*0*(\d+)\b/i);
  return m ? `Pivô ${m[1].padStart(2, '0')}` : alias.trim();
}

/** Converte a resposta de GetLastReading no nosso formato. `agora` é injetável para teste. */
export function normalizar(serial: string, alias: string, j: any, agora = Date.now()): PivoTel | null {
  const d = j?.device;
  const r = d?.reading?.[0];
  if (!d || !r) return null;
  const cfg = d.cfg ?? {};
  const raioM = num(cfg.pivot_length) != null ? (num(cfg.pivot_length)! + (num(cfg.endgun_length) ?? 0)) * FT : null;
  const areaHa = raioM != null ? (Math.PI * raioM * raioM) / 10_000 : null;
  const t = num(r.time);
  const idadeMin = t != null ? (agora - t * 1000) / 60_000 : null;

  // Em pivô parado, "faults" traz o MOTIVO da última parada: Command (comando) e SIS (ângulo programado) são normais.
  const todas: string[] = (r.faults ?? []).map((f: any) => String(f.fault ?? '')).filter(Boolean);
  const falhas = todas.filter((f) => !(f.toLowerCase() in MOTIVOS_PARADA));
  const motivo = todas.map((f) => MOTIVOS_PARADA[f.toLowerCase()]).find(Boolean);
  let categoria: Categoria;
  let statusTxt: string;
  if (falhas.length) {
    categoria = 'alarme';
    statusTxt = `Falha: ${falhas[0]}`;
  } else if (r.power === 'ON') {
    if (idadeMin != null && idadeMin > MAX_IDADE_ON_MIN) {
      categoria = 'sem_sinal';
      statusTxt = 'Sem comunicação';
    } else if (r.water === 'ON') {
      categoria = 'irrigando';
      statusTxt = 'Irrigando';
    } else {
      categoria = 'movendo';
      statusTxt = 'Movendo a seco';
    }
  } else if (r.power === 'OFF') {
    categoria = 'desligado';
    statusTxt = 'Desligado';
  } else {
    categoria = 'parado';
    statusTxt = motivo ?? 'Parado';
  }

  const volts = num(r.pnl_volts);
  return {
    externoId: serial,
    nome: nomeDoPivo(alias),
    lat: num(cfg.center?.lat),
    lon: num(cfg.center?.lng),
    raioM,
    areaHa,
    vazaoM3h: num(cfg.estflow) != null ? num(cfg.estflow)! * GPM_M3H : null,
    velocidadeMh: null,
    lamina100Mm: num(cfg.min_app_depth) != null ? num(cfg.min_app_depth)! * POL_MM : null,
    horasVolta100: num(cfg.pivot_runtime) != null ? num(cfg.pivot_runtime)! / 60 : null,
    angulo: num(r.angle),
    destinoAngulo: r.SIS === 1 ? num(r.SISAngle) : null,
    statusCod: null,
    statusTxt,
    categoria,
    direcao: r.direction === 'REV' ? 1 : r.direction === 'FWD' ? 0 : null,
    percentual: num(r.speed),
    tensaoV: volts != null && volts > 0 ? volts : null,
    pressaoPonta: null,
    bomba: r.water === 'ON',
    canhao: r.endgun1 === 'ON',
    horasMolhado: num(d.pnl_cfg?.wethrs),
    atualizadoEm: t != null ? new Date(t * 1000).toISOString() : null,
  };
}

// ---------- cliente HTTP ----------
async function chamar<T>(caminho: string, params: Record<string, string>, extra: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params);
  const r = await fetch(`${BASE}/${caminho}?${qs}`, { headers: { accessfrom: 'V365', ...extra }, signal: AbortSignal.timeout(25_000) });
  const corpo = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new ErroAgsense(r.status, corpo?.message ? `AgSense: ${corpo.message}` : `AgSense ${r.status}`);
  const e = corpo?.error;
  if (e && e.code && e.code !== 0) throw new ErroAgsense(e.code, e.code === 7 ? 'TOKEN' : `AgSense: ${e.txt ?? 'erro'}`);
  return corpo as T;
}

export async function entrar(usuario: string, senha: string): Promise<string> {
  const md5 = createHash('md5').update(senha).digest('hex');
  let r: any;
  try {
    r = await chamar<any>('Login/', { username: usuario, p: md5 });
  } catch (e) {
    if (e instanceof ErroAgsense && e.status !== 7) throw new ErroAgsense(e.status, /senha|password|credential|login/i.test(e.message) ? 'AgSense: usuário ou senha incorretos' : e.message);
    throw e;
  }
  if (r?.locked === 1) throw new ErroAgsense(423, 'AgSense: conta bloqueada (muitas tentativas). Aguarde ou desbloqueie no site');
  if (!r?.token) throw new ErroAgsense(401, `AgSense: ${r?.msg || 'usuário ou senha incorretos'}`);
  return String(r.token);
}

async function lerUnidade(usuario: string, token: string, serial: string, alias: string): Promise<PivoTel | null> {
  const j = await chamar<any>('GetLastReading/', {
    username: usuario, token, serial, tank_num: '0', sharedWith: '1', bin_num: '0', t: String(Math.floor(Date.now() / 1000)), isAgsenseDevice: '1',
  });
  return normalizar(serial, alias, j);
}

/** Lê todos os pivôs da conta; no "Token Invalid" entra de novo com a senha guardada e tenta uma vez mais. */
export async function lerConta(contaId: number): Promise<{ pivos: PivoTel[]; fazendas: string[] }> {
  const c = (await pool.query(`SELECT usuario, senha_cifrada, token_cifrado FROM telemetria_conta WHERE id = $1`, [contaId])).rows[0];
  if (!c) throw new Error('Conta de telemetria não encontrada');
  let token: string | null = c.token_cifrado ? decifrar(c.token_cifrado) : null;
  const renovar = async () => {
    token = await entrar(c.usuario, decifrar(c.senha_cifrada));
    await pool.query(`UPDATE telemetria_conta SET token_cifrado = $2 WHERE id = $1`, [contaId, cifrar(token)]);
  };
  const executar = async () => {
    const g = await chamar<any>('GetGroups/', { username: c.usuario, token: token!, platform: 'Web', application: 'V365', v365: '1' });
    const unidades: { serial: string; alias: string }[] = [];
    const nomes: string[] = [];
    for (const grupo of g.groups ?? []) {
      nomes.push(String(grupo.name ?? '').trim());
      for (const u of grupo.units ?? []) if (u.device_category_id === 1 || /icon/i.test(String(u.type ?? ''))) unidades.push({ serial: String(u.serial), alias: String(u.alias ?? u.serial) });
    }
    const pivos: PivoTel[] = [];
    for (let i = 0; i < unidades.length; i += 4) {
      const lote = await Promise.all(unidades.slice(i, i + 4).map((u) => lerUnidade(c.usuario, token!, u.serial, u.alias).catch((e) => {
        if (e instanceof ErroAgsense && e.status === 7) throw e;
        return null; // uma unidade sem resposta não derruba as outras
      })));
      for (const p of lote) if (p) pivos.push(p);
    }
    return { pivos, fazendas: nomes.filter(Boolean) };
  };
  if (!token) await renovar();
  try {
    return await executar();
  } catch (e) {
    if (e instanceof ErroAgsense && e.status === 7) {
      await renovar();
      return executar();
    }
    throw e;
  }
}
