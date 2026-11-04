/**
 * Conector WeatherLink (Davis) — API v2: https://weatherlink.github.io/v2-api/
 * Autenticação: api-key na query + segredo no cabeçalho X-Api-Secret. Dados em unidades imperiais.
 *
 * Dois modos, escolhidos sozinhos:
 *  - Pro/Pro+: lê o histórico (/historic) e agrega cada dia.
 *  - Basic (sem histórico): coleta a leitura atual (/current) a cada 10 min e monta o resumo do dia.
 * Cada dia fechado vira UMA leitura em leitura_clima; a ETo é calculada pelo nosso motor FAO-56.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { etoDia, listarDias, somarDias, vento2m } from '@irrigacao/core';
import { hoje, pool } from './db';

const BASE = 'https://api.weatherlink.com/v2';

// ---------- cifra do segredo ----------
const chave = () => createHash('sha256').update(process.env.INTEGRACAO_KEY ?? process.env.JWT_SECRET ?? 'dev-somente-local').digest();

export function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chave(), iv);
  const enc = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decifrar(valor: string): string {
  const [iv, tag, enc] = valor.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', chave(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---------- cliente HTTP ----------
export class ErroWeatherLink extends Error {
  constructor(public status: number, mensagem: string) { super(mensagem); }
}

async function chamar<T>(caminho: string, apiKey: string, apiSecret: string, params: Record<string, string | number> = {}): Promise<T> {
  const qs = new URLSearchParams({ 'api-key': apiKey, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const r = await fetch(`${BASE}${caminho}?${qs}`, { headers: { 'X-Api-Secret': apiSecret }, signal: AbortSignal.timeout(20_000) });
  const corpo = (await r.json().catch(() => ({}))) as { message?: string };
  if (!r.ok) {
    const dica = r.status === 401 || r.status === 403 ? ' (confira a chave/segredo e o plano da estação)' : r.status === 429 ? ' (limite de requisições)' : '';
    throw new ErroWeatherLink(r.status, `WeatherLink ${r.status}: ${corpo.message ?? 'erro'}${dica}`);
  }
  return corpo as T;
}

export interface EstacaoWL { station_id: number; station_id_uuid?: string; station_name: string; latitude?: number; longitude?: number; elevation?: number; time_zone?: string }

export async function listarEstacoes(apiKey: string, apiSecret: string): Promise<EstacaoWL[]> {
  const r = await chamar<{ stations: EstacaoWL[] }>('/stations', apiKey, apiSecret);
  return r.stations ?? [];
}

type Registro = Record<string, number | string | null>;
interface RespostaDados { sensors?: { sensor_type?: number; data_structure_type?: number; data?: Registro[] }[] }

/** Junta os registros de todos os sensores por timestamp (temp/umidade/vento/chuva/radiação podem vir em sensores distintos). */
function registrosPorTs(r: RespostaDados): Registro[] {
  const mapa = new Map<number, Registro>();
  for (const s of r.sensors ?? []) {
    for (const d of s.data ?? []) {
      const ts = Number(d.ts);
      if (!ts) continue;
      const atual = mapa.get(ts) ?? { ts };
      for (const [k, v] of Object.entries(d)) if (v != null && atual[k] == null) atual[k] = v;
      mapa.set(ts, atual);
    }
  }
  return [...mapa.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
}

// ---------- conversões (WeatherLink v2 devolve unidades imperiais) ----------
const fParaC = (f: number) => ((f - 32) * 5) / 9;
const mphParaMs = (m: number) => m * 0.44704;
const nums = (rs: Registro[], ...campos: string[]) => {
  for (const c of campos) {
    const v = rs.map((r) => r[c]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    if (v.length) return v;
  }
  return [] as number[];
};
const media = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

export interface DiaEstacao { data: string; tmin: number; tmax: number; umidade: number | null; umidMax: number | null; umidMin: number | null; ventoMs: number | null; radiacaoMJ: number | null; chuvaMm: number; registros: number }

/** Agrega os registros de histórico de um dia civil. Retorna null se não há temperatura. */
export function agregarDia(data: string, rs: Registro[]): DiaEstacao | null {
  const tHi = nums(rs, 'temp_hi', 'temp_out_hi', 'temp_last', 'temp_avg', 'temp');
  const tLo = nums(rs, 'temp_lo', 'temp_out_lo', 'temp_last', 'temp_avg', 'temp');
  if (!tHi.length || !tLo.length) return null;
  const hum = nums(rs, 'hum_last', 'hum_avg', 'hum', 'hum_out');
  const humHi = nums(rs, 'hum_hi');
  const humLo = nums(rs, 'hum_lo');
  const vento = nums(rs, 'wind_speed_avg', 'wind_speed_avg_last_10_min', 'wind_speed_last');
  const rad = nums(rs, 'solar_rad_avg', 'solar_rad', 'solar_rad_last');
  let chuva = 0;
  const mm = nums(rs, 'rainfall_mm', 'rain_mm');
  if (mm.length) chuva = mm.reduce((a, b) => a + b, 0);
  else {
    const pol = nums(rs, 'rainfall_in', 'rain_in');
    if (pol.length) chuva = pol.reduce((a, b) => a + b, 0) * 25.4;
  }
  return {
    data,
    tmin: fParaC(Math.min(...tLo)),
    tmax: fParaC(Math.max(...tHi)),
    umidade: hum.length ? media(hum) : null,
    umidMax: humHi.length ? Math.max(...humHi) : null,
    umidMin: humLo.length ? Math.min(...humLo) : null,
    ventoMs: vento.length ? mphParaMs(media(vento)) : null,
    radiacaoMJ: rad.length ? media(rad) * 0.0864 : null, // W/m² médio → MJ/m²/dia
    chuvaMm: Math.round(chuva * 10) / 10,
    registros: rs.length,
  };
}

// ---------- modo Basic: amostras da leitura atual ----------
export interface Amostra { tempC: number | null; umidade: number | null; ventoMs: number | null; radiacaoWm2: number | null; chuvaDiaMm: number | null }

/** Último valor não nulo de um campo, do registro mais recente para o mais antigo. */
const ultimo = (rs: Registro[], ...campos: string[]): number | null => {
  for (let i = rs.length - 1; i >= 0; i--) for (const c of campos) { const v = rs[i][c]; if (typeof v === 'number' && Number.isFinite(v)) return v; }
  return null;
};

/** Extrai uma amostra da resposta de /current (WeatherLink Live/Console: temp °F, vento mph, solar W/m², chuva do dia). */
export function extrairAmostra(r: RespostaDados): Amostra & { campos: string[] } {
  const rs = registrosPorTs(r);
  const t = ultimo(rs, 'temp', 'temp_out', 'temp_last');
  const v = ultimo(rs, 'wind_speed_last', 'wind_speed_avg_last_1_min', 'wind_speed_avg_last_10_min', 'wind_speed');
  const chuvaMm = ultimo(rs, 'rainfall_daily_mm', 'rain_day_mm');
  const chuvaIn = chuvaMm == null ? ultimo(rs, 'rainfall_daily_in', 'rain_day_in') : null;
  return {
    tempC: t != null ? fParaC(t) : null,
    umidade: ultimo(rs, 'hum', 'hum_out', 'hum_last'),
    ventoMs: v != null ? mphParaMs(v) : null,
    radiacaoWm2: ultimo(rs, 'solar_rad', 'solar_rad_last'),
    chuvaDiaMm: chuvaMm ?? (chuvaIn != null ? chuvaIn * 25.4 : null),
    campos: [...new Set(rs.flatMap((x) => Object.keys(x)))].slice(0, 60),
  };
}

/** Resumo do dia a partir das amostras (intervalo regular ⇒ médias simples). Exige amostras mínimas. */
export function agregarAmostras(data: string, am: Amostra[], minimo = 100): DiaEstacao | null {
  // ~100 amostras de 10 min ≈ 16 h: com menos, faltaria o período de sol (máxima, radiação) e a ETo sairia errada.
  const temps = am.map((a) => a.tempC).filter((x): x is number => x != null);
  if (am.length < minimo || !temps.length) return null;
  const pega = (f: (a: Amostra) => number | null) => am.map(f).filter((x): x is number => x != null);
  const hum = pega((a) => a.umidade);
  const vento = pega((a) => a.ventoMs);
  const rad = pega((a) => a.radiacaoWm2);
  const chuva = pega((a) => a.chuvaDiaMm);
  return {
    data,
    tmin: Math.min(...temps),
    tmax: Math.max(...temps),
    umidade: hum.length ? media(hum) : null,
    umidMax: hum.length ? Math.max(...hum) : null,
    umidMin: hum.length ? Math.min(...hum) : null,
    ventoMs: vento.length ? media(vento) : null,
    radiacaoMJ: rad.length ? media(rad) * 0.0864 : null,
    chuvaMm: chuva.length ? Math.round(Math.max(...chuva) * 10) / 10 : 0, // acumulado do dia: o maior valor
    registros: am.length,
  };
}

/** Início e fim (timestamps Unix) do dia civil no fuso configurado. */
function limitesDoDia(data: string): { ini: number; fim: number } {
  const tz = process.env.TZ ?? 'America/Campo_Grande';
  const ref = new Date(`${data}T12:00:00Z`);
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(ref);
  const off = partes.find((p) => p.type === 'timeZoneName')?.value.match(/GMT([+-]\d+)(?::(\d+))?/);
  const horas = off ? Number(off[1]) + (off[2] ? (Math.sign(Number(off[1])) * Number(off[2])) / 60 : 0) : 0;
  const ini = Math.floor(Date.parse(`${data}T00:00:00Z`) / 1000 - horas * 3600);
  return { ini, fim: ini + 86_400 - 1 };
}

export async function lerDia(apiKey: string, apiSecret: string, stationId: string, data: string): Promise<DiaEstacao | null> {
  const { ini, fim } = limitesDoDia(data);
  const r = await chamar<RespostaDados>(`/historic/${stationId}`, apiKey, apiSecret, { 'start-timestamp': ini, 'end-timestamp': fim });
  return agregarDia(data, registrosPorTs(r));
}

/** Leitura instantânea (teste de conexão e coleta de amostras). */
export async function lerAgora(apiKey: string, apiSecret: string, stationId: string) {
  const r = await chamar<RespostaDados>(`/current/${stationId}`, apiKey, apiSecret);
  const a = extrairAmostra(r);
  return { temperaturaC: a.tempC != null ? Math.round(a.tempC * 10) / 10 : null, umidade: a.umidade, amostra: a, campos: a.campos };
}

// ---------- sincronização ----------
interface Integ { estacao_id: number; api_key: string; api_secret_cifrado: string; station_id: string | null; altura_vento_m: number; historico_ok: boolean | null; fazenda_id: number; lat: number | null; alt: number | null }

async function carregar(estacaoId?: number): Promise<Integ[]> {
  const r = await pool.query(
    `SELECT i.estacao_id, i.api_key, i.api_secret_cifrado, i.station_id, i.altura_vento_m, i.historico_ok, e.fazenda_id,
            ST_Y(f.geom) AS lat, coalesce(e.altitude_m, f.altitude_m) AS alt
       FROM estacao_integracao i JOIN estacao e ON e.id = i.estacao_id JOIN fazenda f ON f.id = e.fazenda_id
      WHERE i.ativo AND i.station_id IS NOT NULL AND ($1::int IS NULL OR i.estacao_id = $1)`,
    [estacaoId ?? null],
  );
  return r.rows;
}

async function gravarLeitura(it: Integ, d: DiaEstacao, qualidade: string): Promise<void> {
  const vento = d.ventoMs != null ? vento2m(d.ventoMs, Number(it.altura_vento_m)) : undefined;
  const { eto, metodo } = etoDia(
    { tmin: d.tmin, tmax: d.tmax, umidMax: d.umidMax ?? undefined, umidMin: d.umidMin ?? undefined, umidMed: d.umidMax == null || d.umidMin == null ? d.umidade ?? undefined : undefined, vento2: vento, radiacaoMJ: d.radiacaoMJ ?? undefined },
    { latitudeGraus: it.lat ?? -20, altitudeM: Number(it.alt ?? 0) },
    d.data,
  );
  await pool.query(
    `INSERT INTO leitura_clima (estacao_id, data, temp_min, temp_med, temp_max, umidade, chuva_mm, vento_ms, radiacao_mj, eto_mm, metodo_eto, origem, qualidade)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'estacao',$12)
     ON CONFLICT (estacao_id, data) DO UPDATE SET temp_min = EXCLUDED.temp_min, temp_med = EXCLUDED.temp_med, temp_max = EXCLUDED.temp_max,
       umidade = EXCLUDED.umidade, chuva_mm = EXCLUDED.chuva_mm, vento_ms = EXCLUDED.vento_ms, radiacao_mj = EXCLUDED.radiacao_mj,
       eto_mm = EXCLUDED.eto_mm, metodo_eto = EXCLUDED.metodo_eto, origem = 'estacao', qualidade = EXCLUDED.qualidade`,
    [it.estacao_id, d.data, d.tmin.toFixed(1), ((d.tmin + d.tmax) / 2).toFixed(1), d.tmax.toFixed(1), d.umidade?.toFixed(0) ?? null, d.chuvaMm, vento?.toFixed(2) ?? null, d.radiacaoMJ?.toFixed(2) ?? null, eto.toFixed(2), metodo, qualidade],
  );
}

/** Coleta uma leitura atual de cada estação ligada (modo Basic). */
export async function amostrar(estacaoId?: number): Promise<{ estacao_id: number; ok: boolean; erro?: string }[]> {
  const saida = [];
  for (const it of await carregar(estacaoId)) {
    try {
      const { amostra } = await lerAgora(it.api_key, decifrar(it.api_secret_cifrado), it.station_id!);
      if (amostra.tempC != null) {
        await pool.query(
          `INSERT INTO estacao_amostra (estacao_id, ts, temp_c, umidade, vento_ms, radiacao_wm2, chuva_dia_mm) VALUES ($1, now(), $2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING`,
          [it.estacao_id, amostra.tempC, amostra.umidade, amostra.ventoMs, amostra.radiacaoWm2, amostra.chuvaDiaMm],
        );
      }
      await pool.query(`UPDATE estacao SET online = true, ultima_leitura_em = now() WHERE id = $1`, [it.estacao_id]);
      await pool.query(`UPDATE estacao_integracao SET ultimo_erro = null WHERE estacao_id = $1`, [it.estacao_id]);
      saida.push({ estacao_id: it.estacao_id, ok: true });
    } catch (e) {
      const erro = (e as Error).message;
      await pool.query(`UPDATE estacao SET online = false WHERE id = $1`, [it.estacao_id]);
      await pool.query(`UPDATE estacao_integracao SET ultimo_erro = $2 WHERE estacao_id = $1`, [it.estacao_id, erro]);
      saida.push({ estacao_id: it.estacao_id, ok: false, erro });
    }
  }
  return saida;
}

async function resumoDasAmostras(estacaoId: number, data: string): Promise<DiaEstacao | null> {
  const { ini, fim } = limitesDoDia(data);
  const r = await pool.query(
    `SELECT temp_c, umidade, vento_ms, radiacao_wm2, chuva_dia_mm FROM estacao_amostra
      WHERE estacao_id = $1 AND ts >= to_timestamp($2) AND ts <= to_timestamp($3) ORDER BY ts`,
    [estacaoId, ini, fim],
  );
  return agregarAmostras(data, r.rows.map((x) => ({ tempC: x.temp_c, umidade: x.umidade, ventoMs: x.vento_ms, radiacaoWm2: x.radiacao_wm2, chuvaDiaMm: x.chuva_dia_mm })));
}

/**
 * Fecha os últimos `dias` dias (até ontem). Pro/Pro+: histórico da API. Basic ou sem histórico: amostras coletadas.
 * Retorna quantos dias foram gravados e de qual fonte.
 */
export async function sincronizar(estacaoId: number | undefined, dias: number, incluirHoje = false): Promise<{ estacao_id: number; gravados: number; fonte: string; semDados: string[]; erro?: string }[]> {
  const fim = incluirHoje ? hoje() : somarDias(hoje(), -1);
  const datas = listarDias(somarDias(fim, -(dias - 1)), fim);
  const saida = [];
  for (const it of await carregar(estacaoId)) {
    let gravados = 0;
    const semDados: string[] = [];
    let erro: string | undefined;
    let usouHistorico = false;
    let usouAmostras = false;
    let historicoOk = it.historico_ok;
    try {
      const secret = decifrar(it.api_secret_cifrado);
      for (const data of datas) {
        let d: DiaEstacao | null = null;
        let qualidade = 'ok';
        if (historicoOk !== false) {
          try {
            d = await lerDia(it.api_key, secret, it.station_id!, data);
            if (d) { usouHistorico = true; historicoOk = true; }
          } catch (e) {
            if (e instanceof ErroWeatherLink && (e.status === 401 || e.status === 403)) {
              await lerAgora(it.api_key, secret, it.station_id!); // se a leitura atual funciona, a chave é válida: o plano não dá histórico
              historicoOk = false;
            } else throw e;
          }
        }
        if (!d) {
          d = await resumoDasAmostras(it.estacao_id, data);
          if (d) { usouAmostras = true; qualidade = d.registros >= 100 ? 'ok' : 'suspeito'; }
        }
        if (!d) { semDados.push(data); continue; }
        await gravarLeitura(it, d, qualidade);
        gravados++;
      }
    } catch (e) {
      erro = (e as Error).message;
    }
    if (historicoOk !== it.historico_ok) await pool.query(`UPDATE estacao_integracao SET historico_ok = $2 WHERE estacao_id = $1`, [it.estacao_id, historicoOk]);
    if (!erro) await pool.query(`UPDATE estacao_integracao SET ultima_sincronizacao = now(), ultimo_erro = null WHERE estacao_id = $1`, [it.estacao_id]);
    else await pool.query(`UPDATE estacao_integracao SET ultima_sincronizacao = now(), ultimo_erro = $2 WHERE estacao_id = $1`, [it.estacao_id, erro]);
    saida.push({ estacao_id: it.estacao_id, gravados, fonte: usouHistorico ? 'historico' : usouAmostras ? 'amostras' : 'nenhuma', semDados, erro });
  }
  return saida;
}

/** Agenda: a cada 10 min coleta a leitura atual e fecha os últimos 3 dias; limpa amostras com mais de 45 dias. */
export function iniciarAgendador(log: { info: (m: string) => void; error: (m: string) => void }) {
  let n = 0;
  const rodar = async () => {
    try {
      await amostrar();
      const r = await sincronizar(undefined, 3);
      if (n++ % 6 === 0 && r.length) log.info(`[weatherlink] ${JSON.stringify(r)}`);
      if (n % 144 === 1) await pool.query(`DELETE FROM estacao_amostra WHERE ts < now() - interval '45 days'`);
    } catch (e) {
      log.error(`[weatherlink] ${(e as Error).message}`);
    }
  };
  setTimeout(rodar, 30_000);
  setInterval(rodar, 10 * 60 * 1000).unref();
}
