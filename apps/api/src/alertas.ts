/**
 * Alertas operacionais: cruza a telemetria dos pivôs com o balanço hídrico.
 *
 *  - alarme:           o pivô reporta falha (queda de energia, pressão, desalinhado…)
 *  - sem_sinal:        o pivô está "ligado" mas parou de reportar
 *  - parado_precisa:   o balanço diz "irrigar" e o pivô está parado/desligado
 *  - fora_horario:     o pivô está irrigando fora das janelas de energia permitidas
 *  - irrigando_ocupado: o pivô está irrigando sobre um piquete com animais
 *
 * Um alerta fica aberto enquanto a condição durar e se resolve sozinho quando ela some (sem repetir mensagem).
 * Envio por WhatsApp: se WHATSAPP_WEBHOOK_URL estiver configurada, cada alerta novo é enviado (POST JSON
 * {telefone, mensagem, ...}) para os destinatários — serve para Z-API, Evolution, n8n, etc. Sem ela, o alerta
 * aparece no app e o gestor envia com um toque (link wa.me).
 */
import { estaEmArco, janelasDaFazenda, arcosOcupadosPorPivo, permitidoAgora } from './operacao';
import type { Arco } from '@irrigacao/core';
import { pool } from './db';
import { calcularFazenda } from './servico';

export type Severidade = 'alta' | 'media' | 'baixa';
const PESO: Record<Severidade, number> = { alta: 3, media: 2, baixa: 1 };

export interface TelAlerta {
  id: number; pivoId: number | null; nome: string; categoria: string; statusTxt: string; atualizadoEm: string | null; angulo?: number | null;
}
export interface AguaPivo { pivoNome: string; laminaMm: number; limiteMm: number; irrigar: boolean }
export interface Desejado { tipo: string; chave: string; severidade: Severidade; pivoNome: string; titulo: string; mensagem: string }

const hora = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Campo_Grande', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'sem data');

/** Regras puras: o que deveria estar alertado agora. */
export function decidir(tels: TelAlerta[], agua: Map<number, AguaPivo>, ctx: { horarioPermitido?: boolean; ocupados?: Map<number, Arco[]> } = {}): Desejado[] {
  const out: Desejado[] = [];
  for (const t of tels) {
    if (t.categoria === 'irrigando' && ctx.horarioPermitido === false) {
      out.push({ tipo: 'fora_horario', chave: `fora_horario:${t.id}`, severidade: 'alta', pivoNome: t.nome, titulo: `${t.nome} irrigando fora do horário permitido`,
        mensagem: `⚡ ${t.nome} está irrigando fora da janela de horário permitida (custo de energia). Última leitura ${hora(t.atualizadoEm)}.` });
    }
    const oc = t.pivoId != null ? ctx.ocupados?.get(t.pivoId) : undefined;
    if (t.categoria === 'irrigando' && oc && t.angulo != null && estaEmArco(t.angulo, oc)) {
      out.push({ tipo: 'irrigando_ocupado', chave: `irrigando_ocupado:${t.id}`, severidade: 'alta', pivoNome: t.nome, titulo: `${t.nome} irrigando sobre piquete com animais`,
        mensagem: `🐄 ${t.nome} está irrigando em ${Math.round(t.angulo)}°, sobre um piquete com animais. Pare o pivô ou inverta o sentido.` });
    }
    if (t.categoria === 'alarme') {
      out.push({ tipo: 'alarme', chave: `alarme:${t.id}`, severidade: 'alta', pivoNome: t.nome, titulo: `${t.nome}: ${t.statusTxt}`,
        mensagem: `⚠️ ${t.nome} em alarme: ${t.statusTxt}. Última leitura ${hora(t.atualizadoEm)}.` });
    } else if (t.categoria === 'sem_sinal') {
      out.push({ tipo: 'sem_sinal', chave: `sem_sinal:${t.id}`, severidade: 'media', pivoNome: t.nome, titulo: `${t.nome} sem comunicação`,
        mensagem: `📡 ${t.nome} está sem comunicação. Última leitura ${hora(t.atualizadoEm)}.` });
    }
    const a = t.pivoId != null ? agua.get(t.pivoId) : undefined;
    if (a?.irrigar && (t.categoria === 'parado' || t.categoria === 'desligado')) {
      out.push({ tipo: 'parado_precisa', chave: `parado_precisa:${t.pivoId}`, severidade: 'alta', pivoNome: a.pivoNome,
        titulo: `${a.pivoNome} precisa irrigar e está parado`,
        mensagem: `💧 ${a.pivoNome} precisa irrigar (lâmina ${a.laminaMm.toFixed(0)} mm, limite ${a.limiteMm.toFixed(0)} mm) e está "${t.statusTxt.toLowerCase()}" desde ${hora(t.atualizadoEm)}.` });
    }
  }
  return out;
}

/** Lâmina média ponderada pela área: o pivô é irrigado inteiro (mesma regra da tela "Preciso irrigar?"). */
async function aguaPorPivo(fazendaId: number): Promise<Map<number, AguaPivo>> {
  const r = await calcularFazenda(fazendaId, { comChuva: true });
  const grupos = new Map<number, { nome: string; area: number; lam: number; lim: number }>();
  for (const p of r?.parcelas ?? []) {
    const g = grupos.get(p.pivoId) ?? { nome: p.pivoNome, area: 0, lam: 0, lim: 0 };
    g.area += p.areaHa; g.lam += p.laminaMm * p.areaHa; g.lim += p.limiteMm * p.areaHa;
    grupos.set(p.pivoId, g);
  }
  return new Map([...grupos].map(([id, g]) => {
    const laminaMm = g.lam / (g.area || 1);
    const limiteMm = g.lim / (g.area || 1);
    return [id, { pivoNome: g.nome, laminaMm, limiteMm, irrigar: laminaMm < limiteMm }];
  }));
}

export const telefoneWa = (t: string) => {
  const d = t.replace(/\D/g, '');
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
};

async function enviar(fazendaId: number, a: { id: number; severidade: Severidade; titulo: string; mensagem: string }, log: { error: (m: string) => void }) {
  const url = process.env.WHATSAPP_WEBHOOK_URL;
  if (!url) return;
  const dest = (await pool.query(`SELECT nome, telefone, severidade_min FROM alerta_destinatario WHERE fazenda_id = $1 AND ativo`, [fazendaId])).rows
    .filter((d) => PESO[a.severidade] >= PESO[d.severidade_min as Severidade]);
  if (!dest.length) return;
  const falhas: string[] = [];
  for (const d of dest) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(process.env.WHATSAPP_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.WHATSAPP_WEBHOOK_TOKEN}` } : {}) },
        body: JSON.stringify({ telefone: telefoneWa(d.telefone), nome: d.nome, mensagem: a.mensagem, titulo: a.titulo, severidade: a.severidade }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) falhas.push(`${d.nome}: HTTP ${r.status}`);
    } catch (e) {
      falhas.push(`${d.nome}: ${(e as Error).message}`);
    }
  }
  await pool.query(`UPDATE alerta SET notificado_em = now(), erro_envio = $2 WHERE id = $1`, [a.id, falhas.length ? falhas.join('; ').slice(0, 300) : null]);
  if (falhas.length) log.error(`[alertas] envio: ${falhas.join('; ')}`);
}

/** Compara o que deveria estar alertado com o que está aberto: abre os novos, resolve os que sumiram. */
export async function avaliarAlertas(fazendaId: number, log: { info: (m: string) => void; error: (m: string) => void }) {
  const tels: TelAlerta[] = (await pool.query(
    `SELECT tp.id, tp.pivo_id AS "pivoId", tp.nome, tp.categoria, tp.status_txt AS "statusTxt", tp.atualizado_em AS "atualizadoEm", tp.angulo::float AS angulo
       FROM telemetria_pivo tp JOIN telemetria_conta tc ON tc.id = tp.conta_id WHERE tc.fazenda_id = $1 AND tc.ativo`, [fazendaId])).rows;
  if (!tels.length) return;
  const precisaAgua = tels.some((t) => t.pivoId != null && (t.categoria === 'parado' || t.categoria === 'desligado'));
  const irrigando = tels.some((t) => t.categoria === 'irrigando');
  const horarioPermitido = irrigando ? permitidoAgora(await janelasDaFazenda(fazendaId)) : true;
  const ocupados = irrigando ? await arcosOcupadosPorPivo(fazendaId) : new Map<number, Arco[]>();
  const desejados = decidir(tels, precisaAgua ? await aguaPorPivo(fazendaId) : new Map(), { horarioPermitido, ocupados });

  const chaves = desejados.map((d) => d.chave);
  await pool.query(`UPDATE alerta SET resolvido_em = now() WHERE fazenda_id = $1 AND resolvido_em IS NULL AND NOT (chave = ANY($2::text[]))`, [fazendaId, chaves]);
  for (const d of desejados) {
    const r = await pool.query(
      `INSERT INTO alerta (fazenda_id, tipo, chave, severidade, pivo_nome, titulo, mensagem) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (fazenda_id, chave) WHERE resolvido_em IS NULL DO NOTHING RETURNING id`,
      [fazendaId, d.tipo, d.chave, d.severidade, d.pivoNome, d.titulo, d.mensagem],
    );
    if (r.rowCount) {
      log.info(`[alertas] novo: ${d.titulo}`);
      await enviar(fazendaId, { id: r.rows[0].id, severidade: d.severidade, titulo: d.titulo, mensagem: d.mensagem }, log);
    }
  }
}
