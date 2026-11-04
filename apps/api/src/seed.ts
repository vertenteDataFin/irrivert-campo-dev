/**
 * Dados de EXEMPLO (fictícios) para validar o sistema. Roda só quando o banco está vazio.
 * A migração dos dados reais da Vertente vem na Fase 5.
 */
import {
  etc,
  etoDia,
  kcDoDia,
  listarDias,
  mmPorHora,
  passoBalanco,
  recomendar,
  somarDias,
  type FaseCultura,
  type ParamsParcela,
} from '@irrigacao/core';
import { hoje, pool } from './db';
import { hashSenha } from './senha';

const LAT = -20.45;
const LON = -54.6;
const ALT = 550;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mParaLat = (m: number) => m / 111_320;
const mParaLon = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));

/** Polígono (GeoJSON) de um setor de círculo; setor completo = círculo. */
function setor(cx: number, cy: number, raioM: number, a0: number, a1: number) {
  const pts: [number, number][] = [];
  const completo = a1 - a0 >= 360;
  if (!completo) pts.push([cx, cy]);
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const ang = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    pts.push([cx + mParaLon(raioM * Math.cos(ang)), cy + mParaLat(raioM * Math.sin(ang))]);
  }
  if (!completo) pts.push([cx, cy]);
  else pts[pts.length - 1] = pts[0];
  return { type: 'Polygon', coordinates: [pts] };
}

export async function semear(): Promise<void> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM usuario');
  if (rows[0].n > 0) return;

  const dataHoje = hoje();
  const rnd = mulberry32(2026);
  console.log('[seed] banco vazio — criando dados de exemplo…');

  const org = (await pool.query(`INSERT INTO organizacao (nome) VALUES ('Agropecuária Vertente') RETURNING id`)).rows[0].id;
  const fazId = (
    await pool.query(
      `INSERT INTO fazenda (organizacao_id, nome, cidade, uf, responsavel, altitude_m, geom)
       VALUES ($1, 'Fazenda Vertente (exemplo)', 'Campo Grande', 'MS', 'Gestor de exemplo', $2, ST_SetSRID(ST_MakePoint($3, $4), 4326))
       RETURNING id`,
      [org, ALT, LON, LAT],
    )
  ).rows[0].id;
  const estId = (
    await pool.query(
      `INSERT INTO estacao (fazenda_id, nome, tipo, altitude_m, geom, online, ultima_leitura_em)
       VALUES ($1, 'Estação Sede', 'propria', $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), true, now()) RETURNING id`,
      [fazId, ALT, LON, LAT],
    )
  ).rows[0].id;

  // Culturas e Kc por fase (valores de referência FAO-56 / ajustáveis na tela de cadastro).
  const culturas: Record<string, { p: number; raiz: number; cap: number; fases: FaseCultura[] }> = {
    Pastagem: {
      p: 0.4, raiz: 400, cap: 40,
      fases: [
        { fase: 'inicial', kc: 0.5, duracaoDias: 15 },
        { fase: 'desenvolvimento', kc: 0.75, duracaoDias: 25 },
        { fase: 'médio', kc: 0.95, duracaoDias: 365 },
        { fase: 'final', kc: 0.85, duracaoDias: 30 },
      ],
    },
    Amendoim: {
      p: 0.45, raiz: 500, cap: 40,
      fases: [
        { fase: 'inicial', kc: 0.4, duracaoDias: 25 },
        { fase: 'desenvolvimento', kc: 0.8, duracaoDias: 35 },
        { fase: 'médio', kc: 1.15, duracaoDias: 45 },
        { fase: 'final', kc: 0.6, duracaoDias: 25 },
      ],
    },
    'Em preparo': { p: 0.5, raiz: 300, cap: 35, fases: [{ fase: 'médio', kc: 0.3, duracaoDias: 365 }] },
  };
  const culturaId: Record<string, number> = {};
  for (const [nome, c] of Object.entries(culturas)) {
    culturaId[nome] = (
      await pool.query(`INSERT INTO cultura (nome, prof_raiz_mm, fracao_agua_disponivel_p, tipo) VALUES ($1,$2,$3,$4) RETURNING id`, [nome, c.raiz, c.p, nome === 'Pastagem' ? 'forrageira' : 'cultura'])
    ).rows[0].id;
    for (const [i, f] of c.fases.entries()) {
      await pool.query(`INSERT INTO cultura_fase (cultura_id, ordem, fase, kc, duracao_dias) VALUES ($1,$2,$3,$4,$5)`, [culturaId[nome], i + 1, f.fase, f.kc, f.duracaoDias]);
    }
  }

  // Pivôs em grade 4×2; os pares recebem 2 parcelas (setores).
  const areas = [120, 95, 140, 110, 75, 160, 90, 130];
  const dataInicial = somarDias(dataHoje, -30);
  type P = { id: number; params: ParamsParcela; cultura: string; plantio: string | null; atrasoDias: number };
  const parcelas: P[] = [];
  for (const [i, area] of areas.entries()) {
    const raio = Math.sqrt((area * 10_000) / Math.PI);
    const col = i % 4;
    const lin = Math.floor(i / 4);
    const cx = LON + mParaLon((col - 1.5) * 1500);
    const cy = LAT + mParaLat((0.5 - lin) * 1500);
    const lamina100 = 9 + i * 0.5;
    const horas100 = 16 + (i % 4) * 2;
    const mmh = mmPorHora(lamina100, horas100);
    const pivoId = (
      await pool.query(
        `INSERT INTO pivo (fazenda_id, nome, area_ha, vazao_m3h, lamina_volta_100_mm, horas_volta_100, eficiencia, geom)
         VALUES ($1,$2,$3,$4,$5,$6,0.85, ST_SetSRID(ST_GeomFromGeoJSON($7),4326)) RETURNING id`,
        [fazId, `Pivô ${String(i + 1).padStart(2, '0')}`, area, Math.round(area * 10 * mmh), lamina100, horas100, JSON.stringify(setor(cx, cy, raio, 0, 360))],
      )
    ).rows[0].id;

    const partes = i % 2 === 0
      ? [{ nome: 'Piquete A', a0: 0, a1: 180, frac: 0.5 }, { nome: 'Piquete B', a0: 180, a1: 360, frac: 0.5 }]
      : [{ nome: 'Piquete A', a0: 0, a1: 360, frac: 1 }];
    for (const [k, parte] of partes.entries()) {
      const cultura = i === 2 || i === 5 ? 'Amendoim' : i === 7 && k === 1 ? 'Em preparo' : 'Pastagem';
      const c = culturas[cultura];
      const plantio = cultura === 'Amendoim' ? somarDias(dataHoje, -70) : null;
      const limite = Math.round(c.cap * (1 - c.p) * 10) / 10;
      const id = (
        await pool.query(
          `INSERT INTO parcela (pivo_id, cultura_id, nome, safra, area_ha, data_plantio, cap_campo_mm, lamina_seguranca_mm,
                                data_inicial, lamina_inicial_mm, geom)
           VALUES ($1,$2,$3,'2026/2027',$4,$5,$6,$7,$8,$9, ST_SetSRID(ST_GeomFromGeoJSON($10),4326)) RETURNING id`,
          [pivoId, culturaId[cultura], parte.nome, Math.round(area * parte.frac * 10) / 10, plantio, c.cap, limite, dataInicial, c.cap * 0.9, JSON.stringify(setor(cx, cy, raio, parte.a0, parte.a1))],
        )
      ).rows[0].id;
      parcelas.push({
        id,
        cultura,
        plantio,
        atrasoDias: [0, 7, 0, 4, 9, 0, 6, 0, 5, 0, 8, 0][parcelas.length % 12],
        params: { capUtilMm: c.cap, limiteSegurancaMm: limite, eficiencia: 0.85, mmPorHora: mmh, laminaVoltaMm: lamina100 },
      });
    }
  }

  // Clima: 38 dias até ontem (primavera no cerrado: quente, algumas chuvas).
  const local = { latitudeGraus: LAT, altitudeM: ALT };
  const etoPorDia = new Map<string, { eto: number; chuva: number }>();
  for (const data of listarDias(somarDias(dataHoje, -38), somarDias(dataHoje, -1))) {
    const tmax = 29 + rnd() * 7;
    const tmin = 17 + rnd() * 6;
    const umid = 45 + rnd() * 30;
    const vento = 1.5 + rnd() * 1.7;
    const rad = 17 + rnd() * 9;
    const chuva = rnd() < 0.2 ? Math.round((2 + rnd() * 23) * 10) / 10 : 0;
    const { eto, metodo } = etoDia({ tmax, tmin, umidMed: umid, vento2: vento, radiacaoMJ: rad }, local, data);
    etoPorDia.set(data, { eto, chuva });
    await pool.query(
      `INSERT INTO leitura_clima (estacao_id, data, temp_min, temp_med, temp_max, umidade, chuva_mm, vento_ms, radiacao_mj, eto_mm, metodo_eto, origem)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'estacao')`,
      [estId, data, tmin.toFixed(1), ((tmin + tmax) / 2).toFixed(1), tmax.toFixed(1), umid.toFixed(0), chuva, vento.toFixed(1), rad.toFixed(1), eto.toFixed(2), metodo],
    );
  }

  const chuvaPrev = [0, 0, 8, 14, 2, 0, 0];
  const probPrev = [5, 10, 60, 80, 30, 10, 5];
  for (const [i, data] of listarDias(dataHoje, somarDias(dataHoje, 6)).entries()) {
    await pool.query(
      `INSERT INTO previsao_dia (fazenda_id, data, chuva_mm, chuva_prob, temp_min, temp_max, vento_ms, fonte)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'exemplo')`,
      [fazId, data, chuvaPrev[i], probPrev[i], 19 + (i % 3), 32 - (i === 3 ? 4 : 0), 2.2],
    );
  }

  // Irrigação simulada: repõe o déficit quando passa de um dia de consumo (regra do iCrop); algumas parcelas "atrasam" nos últimos dias.
  for (const p of parcelas) {
    const fases = culturas[p.cultura].fases;
    let lamina = p.params.capUtilMm * 0.9;
    for (const data of listarDias(dataInicial, somarDias(dataHoje, -1))) {
      const d = etoPorDia.get(data) ?? { eto: 5, chuva: 0 };
      const etcDia = etc(d.eto, kcDoDia(fases, p.plantio, data));
      lamina = passoBalanco(lamina, d.chuva, 0, etcDia, p.params.capUtilMm).laminaMm;
      const atrasa = p.atrasoDias > 0 && data >= somarDias(dataHoje, -p.atrasoDias);
      if (!atrasa) {
        const r = recomendar(lamina, p.params, etcDia);
        if (r.recomendaIrrigar) {
          await pool.query(`INSERT INTO lancamento_irrigacao (parcela_id, data, lamina_mm, origem) VALUES ($1,$2,$3,'manual')`, [p.id, data, r.itnBrutaMm.toFixed(1)]);
          lamina = passoBalanco(lamina, 0, r.itnBrutaMm * p.params.eficiencia, 0, p.params.capUtilMm).laminaMm;
        }
      }
    }
  }

  // Usuário administrador: senha vem do ambiente (ADMIN_PASSWORD) ou é gerada e mostrada UMA vez no log.
  const email = process.env.ADMIN_EMAIL ?? 'admin@vertente.local';
  let senha = process.env.ADMIN_PASSWORD;
  if (!senha) {
    senha = Array.from({ length: 14 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');
    console.log(`[seed] ADMIN_PASSWORD não definido — senha gerada para ${email}: ${senha}`);
  }
  const uid = (
    await pool.query(`INSERT INTO usuario (nome, email, senha_hash, papel) VALUES ('Administrador', $1, $2, 'admin') RETURNING id`, [email, await hashSenha(senha)])
  ).rows[0].id;
  await pool.query(`INSERT INTO usuario_fazenda (usuario_id, fazenda_id) VALUES ($1,$2)`, [uid, fazId]);
  console.log(`[seed] pronto: 1 fazenda, ${areas.length} pivôs, ${parcelas.length} parcelas. Login: ${email}`);
}
