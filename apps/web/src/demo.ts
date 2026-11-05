/**
 * Modo demonstração do app de campo: simula a API do Irrivert dentro do navegador, com dados de exemplo.
 * Serve para avaliar as telas no celular (GitHub Pages) sem servidor. Nada é enviado a lugar nenhum:
 * o que a equipe registrar fica no armazenamento do próprio aparelho, até "Reiniciar demonstração".
 */
import type { Ativo, CategoriaTel, Fazenda, ItemOrdem, Ordem, PivoCampo, PlanoCampo, Roteiro, Usuario, VistoriaEnvio, VistoriaRegistro } from './tipos';

export const DEMO_FAZENDA: Fazenda = { id: 1, nome: 'Fazenda Vertente · demonstração', cidade: 'Água Clara', uf: 'MS', lat: -20.44, lon: -52.88 };
export const DEMO_USUARIO: Usuario = { id: 1, nome: 'Equipe de campo', email: 'campo@demonstracao', papel: 'gestor' };
const CHAVE = 'irrivert.demo.estado.v1';
const TZ = 'America/Campo_Grande';

const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const horaHoje = (hh: number, mm = 0) => { const d = new Date(); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
const haMin = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** Fatias iguais de um pivô, em graus a partir do norte. */
const fatias = (prefixo: string, n: number, base: number) => Array.from({ length: n }, (_, i) => ({ id: base + i, nome: `${prefixo}-${i + 1}`, de: Math.round((360 / n) * i), ate: Math.round((360 / n) * (i + 1)) % 360 || 360, ocupado: false }));

interface Situacao { inoperanteDesde: string | null; inoperanteMotivo: string | null; reparoPrevisto: string | null; painelModelo: string | null }
interface VistoriaGuardada extends Omit<VistoriaRegistro, 'fotos'> { fotos: { id: number; tipo: VistoriaRegistro['fotos'][number]['tipo']; dados: string }[] }
interface Estado {
  vistorias: VistoriaGuardada[];
  ordem: Record<number, { status: ItemOrdem['status']; motivo: string | null }>;
  roteiro: Roteiro | null;
  ativos: Ativo[];
  situacao: Record<number, Situacao>;
  gado: Record<number, boolean>;
  seq: number;
}

/** Foto de exemplo (SVG) para os registros já existentes. */
const fotoExemplo = (texto: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#1f2937"/><rect x="120" y="90" width="400" height="300" rx="14" fill="#374151" stroke="#9ca3af" stroke-width="4"/><circle cx="320" cy="200" r="46" fill="#111827" stroke="#22d3ee" stroke-width="6"/><rect x="200" y="290" width="240" height="40" rx="8" fill="#111827"/><text x="320" y="318" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="22" fill="#e5e7eb">${texto}</text></svg>`)}`;

function estadoInicial(): Estado {
  return {
    vistorias: [{
      id: 1, clientUuid: 'demo-1', pivoId: 1, pivoNome: 'Pivô 01', ordemId: 2, data: hoje(), tipo: 'rapida', usuario: 'Equipe de campo',
      iniciadaEm: haMin(95), concluidaEm: haMin(82), suspeita: null, passoEntrada: null,
      integridade: { pneus: true, bicos: true, estrutura: true, caminho: true, posicaoGraus: 95, gadoPiquetes: [103] },
      leituras: { pressaoBar: 3.1, fonteEnergia: 'rede', tensaoV: 380, painelRespondeu: true },
      configPainel: null, falha: null, resolvidoLocal: null, resultado: 'operando', observacao: 'Pneu da torre 4 um pouco murcho, calibrar.',
      fotos: [{ id: 1, tipo: 'ultima_torre', dados: fotoExemplo('última torre · Pivô 01') }],
    }],
    ordem: {},
    roteiro: null,
    ativos: [
      { id: 1, tipo: 'casa_bomba', nome: 'Casa de bombas 1', observacao: null, ativo: true, pivos: [1, 2, 3], falha: null },
      { id: 2, tipo: 'casa_bomba', nome: 'Casa de bombas 3', observacao: null, ativo: true, pivos: [4, 5], falha: { id: 1, descricao: 'Falta a fase R na entrada', previsao: 'hoje, 22:30', abertaEm: haMin(140) } },
      { id: 3, tipo: 'transformador', nome: 'Transformador T2', observacao: null, ativo: true, pivos: [6, 7, 8], falha: null },
    ],
    situacao: {
      1: { inoperanteDesde: null, inoperanteMotivo: null, reparoPrevisto: null, painelModelo: 'Valley ICON10' },
      2: { inoperanteDesde: null, inoperanteMotivo: null, reparoPrevisto: null, painelModelo: 'Valley ICON10' },
      3: { inoperanteDesde: null, inoperanteMotivo: null, reparoPrevisto: null, painelModelo: 'Bauer SmartTouch' },
      4: { inoperanteDesde: null, inoperanteMotivo: null, reparoPrevisto: null, painelModelo: 'Bauer SmartTouch' },
      5: { inoperanteDesde: null, inoperanteMotivo: null, reparoPrevisto: null, painelModelo: 'Bauer SmartTouch' },
      6: { inoperanteDesde: null, inoperanteMotivo: null, reparoPrevisto: null, painelModelo: 'Bauer Universal Pro' },
      7: { inoperanteDesde: hoje(), inoperanteMotivo: 'placa de relé do ICON10 queimada', reparoPrevisto: null, painelModelo: 'Valley ICON10' },
      8: { inoperanteDesde: null, inoperanteMotivo: null, reparoPrevisto: null, painelModelo: 'Valley ICON10' },
    },
    gado: { 103: true, 501: true },
    seq: 10,
  };
}

function ler(): Estado {
  try { const s = localStorage.getItem(CHAVE); if (s) return JSON.parse(s) as Estado; } catch { /* sem storage */ }
  return estadoInicial();
}
function gravar(e: Estado) { try { localStorage.setItem(CHAVE, JSON.stringify(e)); } catch { /* sem storage */ } }

/** Os pivôs de exemplo, sempre iguais; o que muda (situação, gado, vistorias) vem do estado. */
function pivos(e: Estado): PivoCampo[] {
  const tel = (id: number, provedor: 'agsense' | 'irricontrol', categoria: CategoriaTel, statusTxt: string, angulo: number | null) =>
    ({ id, provedor, categoria, statusTxt, angulo, atualizadoEm: haMin(3) });
  const base: Omit<PivoCampo, 'inoperanteDesde' | 'inoperanteMotivo' | 'reparoPrevisto' | 'painelModelo' | 'gado' | 'vistoriaHoje'>[] = [
    { id: 1, nome: 'Pivô 01', culturas: 'Mombaça', telemetria: tel(1, 'agsense', 'irrigando', 'Irrigando · 72 %', 95), piquetes: fatias('P01', 6, 101) },
    { id: 2, nome: 'Pivô 02', culturas: 'Mombaça', telemetria: tel(2, 'agsense', 'parado', 'Parado', 210), piquetes: fatias('P02', 6, 201) },
    { id: 3, nome: 'Pivô 03', culturas: 'Amendoim', telemetria: tel(3, 'irricontrol', 'movendo', 'Movendo a seco', 300), piquetes: [] },
    { id: 4, nome: 'Pivô 04', culturas: 'Amendoim', telemetria: tel(4, 'irricontrol', 'sem_sinal', 'Sem comunicação desde 21:02', null), piquetes: [] },
    { id: 5, nome: 'Pivô 05', culturas: 'Mombaça', telemetria: tel(5, 'irricontrol', 'alarme', 'Safety · pressão baixa', 40), piquetes: fatias('P05', 4, 501) },
    { id: 6, nome: 'Pivô 06', culturas: 'Amendoim', telemetria: null, piquetes: [] },
    { id: 7, nome: 'Pivô 07', culturas: 'Mombaça', telemetria: tel(7, 'agsense', 'desligado', 'Painel desligado', 180), piquetes: fatias('P07', 6, 701) },
    { id: 8, nome: 'Pivô 08', culturas: 'Preparo', telemetria: tel(8, 'agsense', 'aguardando', 'Programado 02:00', 0), piquetes: [] },
  ];
  const d = hoje();
  return base.map((p) => {
    const s = e.situacao[p.id] ?? { inoperanteDesde: null, inoperanteMotivo: null, reparoPrevisto: null, painelModelo: null };
    const piquetes = p.piquetes.map((q) => ({ ...q, ocupado: !!e.gado[q.id] }));
    const v = e.vistorias.filter((x) => x.pivoId === p.id && x.data === d).sort((a, b) => (b.concluidaEm ?? '').localeCompare(a.concluidaEm ?? ''))[0];
    return {
      ...p, ...s, piquetes,
      gado: piquetes.filter((q) => q.ocupado).map((q) => ({ piquete: q.nome, de: q.de, ate: q.ate })),
      vistoriaHoje: v ? { id: v.id, tipo: v.tipo, resultado: v.resultado, concluidaEm: v.concluidaEm, usuario: v.usuario } : null,
    };
  });
}

function ordem(e: Estado, ps: PivoCampo[]): Ordem {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }).format(new Date()));
  const item = (id: number, pivoId: number, sequencia: number, laminaMm: number, percentual: number, inicio: string | null, duracaoMin: number, sentido: 0 | 1 | null, anguloParada: number | null, status: ItemOrdem['status'], motivo: string | null = null): ItemOrdem => {
    const p = ps.find((x) => x.id === pivoId)!;
    const o = e.ordem[id];
    return {
      id, pivoId, pivoNome: p.nome, sequencia, inicio, fim: inicio ? new Date(new Date(inicio).getTime() + duracaoMin * 60_000).toISOString() : null, duracaoMin, laminaMm, sentido, anguloParada, percentual,
      avisos: [], status: o?.status ?? status, motivo: o?.motivo ?? motivo, telemetriaId: p.telemetria?.id ?? null, categoria: p.telemetria?.categoria ?? null, angulo: p.telemetria?.angulo ?? null,
    };
  };
  return {
    data: hoje(), permitidoAgora: h >= 21 || h < 16,
    janelas: [{ inicio: '21:00', fim: '16:00', dias: [0, 1, 2, 3, 4, 5, 6] }],
    itens: [
      item(1, 3, 1, 12, 48, horaHoje(21, 0), 620, 0, null, 'planejada'),
      item(2, 1, 2, 8, 72, horaHoje(21, 0), 410, 0, 118, 'enviada'),
      item(3, 4, 3, 10, 58, horaHoje(21, 30), 520, 0, null, 'planejada'),
      item(4, 5, 4, 8, 72, horaHoje(22, 0), 410, 1, 92, 'planejada'),
      item(5, 6, 5, 10, 58, horaHoje(23, 0), 520, 0, null, 'planejada'),
      item(6, 2, 6, 8, 72, null, 410, 0, null, 'cancelada', 'capim alto, segurar o crescimento'),
      item(7, 8, 7, 6, 100, horaHoje(2, 0), 300, 0, null, 'planejada'),
    ],
  };
}

const plano = (e: Estado): PlanoCampo => { const ps = pivos(e); return { data: hoje(), ordem: ordem(e, ps), pivos: ps, ativos: e.ativos, roteiro: e.roteiro }; };

/** Liga o simulador: toda chamada a /api/... passa a ser respondida aqui. */
export function instalarDemo() {
  const real = window.fetch.bind(window);
  const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

  window.fetch = async (entrada: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const i = url.indexOf('/api/');
    if (i < 0) return real(entrada, init);
    const caminho = url.slice(i + 4).split('?')[0];
    const metodo = (init?.method ?? (typeof entrada !== 'string' && !(entrada instanceof URL) ? entrada.method : 'GET')).toUpperCase();
    const corpo = init?.body ? JSON.parse(String(init.body)) : null;
    await new Promise((r) => setTimeout(r, 120)); // latência de celular
    const e = ler();
    const m = (re: RegExp) => caminho.match(re);
    let r: RegExpMatchArray | null;

    if (caminho === '/auth/login') return json({ token: 'demo' });
    if (caminho === '/auth/me') return json(DEMO_USUARIO);
    if (caminho === '/fazendas') return json([DEMO_FAZENDA]);
    if (m(/^\/fazendas\/\d+\/alertas$/)) return json({ abertos: [], recentes: [], destinatarios: [], envioAutomatico: false });
    if (m(/^\/fazendas\/\d+\/campo$/)) return json(plano(e));
    if (m(/^\/fazendas\/\d+\/ordem$/)) return json(ordem(e, pivos(e)));
    if (m(/^\/fazendas\/\d+\/campo\/roteiro$/) && metodo === 'PUT') {
      e.roteiro = { saida: corpo.saida ?? null, paradas: corpo.paradas ?? [], atualizadoEm: new Date().toISOString() };
      gravar(e); return json(e.roteiro);
    }
    if (m(/^\/fazendas\/\d+\/campo\/vistorias$/)) {
      const d = hoje();
      return json({ data: d, vistorias: e.vistorias.filter((v) => v.data === d).sort((a, b) => (b.concluidaEm ?? '').localeCompare(a.concluidaEm ?? '')).map((v) => ({ ...v, fotos: v.fotos.map((f) => ({ id: f.id, tipo: f.tipo })) })) });
    }
    if (caminho === '/vistorias' && metodo === 'POST') {
      const v = corpo as VistoriaEnvio;
      const ja = e.vistorias.find((x) => x.clientUuid === v.clientUuid);
      if (ja) return json({ id: ja.id, duplicado: true });
      const id = ++e.seq;
      const p = pivos(e).find((x) => x.id === v.pivoId);
      e.vistorias.push({ ...v, id, pivoNome: p?.nome ?? `Pivô #${v.pivoId}`, usuario: DEMO_USUARIO.nome, fotos: v.fotos.map((f) => ({ id: ++e.seq, tipo: f.tipo, dados: f.dados })) });
      if (v.integridade.gadoPiquetes) for (const q of p?.piquetes ?? []) e.gado[q.id] = v.integridade.gadoPiquetes.includes(q.id);
      if (v.falha?.ativoId && !v.resolvidoLocal) { const a = e.ativos.find((x) => x.id === v.falha!.ativoId); if (a && !a.falha) a.falha = { id: ++e.seq, descricao: v.falha.descricao || 'falha registrada na vistoria', previsao: v.falha.previsao ?? null, abertaEm: new Date().toISOString() }; }
      if (v.ordemId && v.resultado !== 'nao_iniciou') { const o = e.ordem[v.ordemId]; if (!o || o.status === 'planejada') e.ordem[v.ordemId] = { status: 'enviada', motivo: o?.motivo ?? null }; }
      gravar(e); return json({ id, duplicado: false });
    }
    if ((r = m(/^\/vistorias\/fotos\/(\d+)$/))) {
      const f = e.vistorias.flatMap((v) => v.fotos).find((x) => x.id === Number(r![1]));
      return f ? real(f.dados) : json({ erro: 'foto não encontrada' }, 404);
    }
    if (m(/^\/fazendas\/\d+\/ativos$/)) {
      if (metodo === 'POST') e.ativos.push({ id: ++e.seq, tipo: corpo.tipo, nome: corpo.nome, observacao: corpo.observacao ?? null, ativo: true, pivos: corpo.pivos ?? [], falha: null });
      gravar(e); return json(e.ativos);
    }
    if ((r = m(/^\/ativos\/(\d+)$/))) {
      const a = e.ativos.find((x) => x.id === Number(r![1]));
      if (metodo === 'DELETE') e.ativos = e.ativos.filter((x) => x !== a);
      else if (metodo === 'PUT' && a) Object.assign(a, { nome: corpo.nome ?? a.nome, tipo: corpo.tipo ?? a.tipo, pivos: corpo.pivos ?? a.pivos });
      gravar(e); return json(e.ativos);
    }
    if ((r = m(/^\/ativos\/(\d+)\/falhas$/)) && metodo === 'POST') {
      const a = e.ativos.find((x) => x.id === Number(r![1]));
      if (a) a.falha = { id: ++e.seq, descricao: corpo.descricao, previsao: corpo.previsao ?? null, abertaEm: new Date().toISOString() };
      gravar(e); return json(e.ativos);
    }
    if ((r = m(/^\/falhas-ativo\/(\d+)\/encerrar$/))) {
      for (const a of e.ativos) if (a.falha?.id === Number(r![1])) a.falha = null;
      gravar(e); return json(e.ativos);
    }
    if ((r = m(/^\/pivos\/(\d+)\/situacao$/))) {
      const id = Number(r![1]);
      const s = e.situacao[id] ?? { inoperanteDesde: null, inoperanteMotivo: null, reparoPrevisto: null, painelModelo: null };
      e.situacao[id] = { ...s, ...('inoperanteDesde' in corpo ? { inoperanteDesde: corpo.inoperanteDesde, inoperanteMotivo: corpo.inoperanteDesde ? corpo.inoperanteMotivo ?? null : null, reparoPrevisto: corpo.inoperanteDesde ? corpo.reparoPrevisto ?? null : null } : {}), ...(corpo.painelModelo !== undefined ? { painelModelo: corpo.painelModelo } : {}) };
      gravar(e); return json({ ok: true });
    }
    if ((r = m(/^\/ordem\/(\d+)\/manejo$/))) { e.ordem[Number(r![1])] = { status: 'cancelada', motivo: corpo.motivo }; gravar(e); return json({ ok: true }); }
    if ((r = m(/^\/ordem\/(\d+)\/status$/))) { e.ordem[Number(r![1])] = { status: corpo.status, motivo: null }; gravar(e); return json({ ok: true }); }
    return json({ erro: 'Não disponível na demonstração' }, 404);
  };
}

/** Apaga o que foi registrado na demonstração (estado e fila offline) e recarrega. */
export async function reiniciarDemo() {
  try { localStorage.removeItem(CHAVE); for (const k of Object.keys(localStorage)) if (k.startsWith('irrigacao.campo.')) localStorage.removeItem(k); } catch { /* sem storage */ }
  await new Promise<void>((res) => { const req = indexedDB.deleteDatabase('irrigacao-offline'); req.onsuccess = req.onerror = req.onblocked = () => res(); });
  location.reload();
}
