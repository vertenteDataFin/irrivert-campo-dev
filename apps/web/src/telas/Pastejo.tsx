import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api, fmt, token } from '../api';
import { haQuanto } from '../hooks';
import { descartar, enfileirar, guardarPiquetes, lerPiquetes, listarFila, novoUuid, reduzirFoto, sincronizarFila, type Registro } from '../offline';
import type { Fazenda, MovimentoRecente, Pastejo as DadosPastejo, Piquete } from '../tipos';
import { Numero } from '../ui';

const NOTAS = [
  { n: 1, t: 'Muito ruim' }, { n: 2, t: 'Ruim' }, { n: 3, t: 'Regular' }, { n: 4, t: 'Bom' }, { n: 5, t: 'Ideal' },
];
const ANIMAIS = '#a855f7';
const SEM_REGISTRO = '#94a3b8';
/** Descanso do pasto: recém-saído em laranja, descansado em verde (≈ 30 dias para recuperar). */
const corDescanso = (dias: number | null) => {
  if (dias == null) return SEM_REGISTRO;
  const t = Math.max(0, Math.min(1, dias / 30));
  return `hsl(${Math.round(20 + t * 130)} 70% ${Math.round(48 - t * 10)}%)`;
};
const corPiquete = (p: Piquete) => (p.ocupado ? ANIMAIS : corDescanso(p.diasDescanso));

function Estrelas({ nota }: { nota: number | null }) {
  if (nota == null) return <span className="text-slate-400">–</span>;
  return <span title={`Nota ${nota} de 5`} className="text-amber-500">{'★'.repeat(nota)}<span className="text-slate-300 dark:text-slate-600">{'★'.repeat(5 - nota)}</span></span>;
}

/** Foto protegida por login: baixa com o token e mostra num pop-up simples. */
function FotoMov({ id }: { id: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [erro, setErro] = useState(false);
  async function abrir() {
    try {
      const r = await fetch(`/api/movimentos/${id}/foto`, { headers: { Authorization: `Bearer ${token.get() ?? ''}` } });
      if (!r.ok) throw new Error();
      setUrl(URL.createObjectURL(await r.blob()));
    } catch { setErro(true); }
  }
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return (
    <>
      <button className="chip" onClick={abrir}>{erro ? 'Sem foto (offline?)' : '📷 Foto'}</button>
      {url && (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 p-4" onClick={() => setUrl(null)} role="dialog" aria-label="Foto do piquete">
          <img src={url} alt="Foto do piquete" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </>
  );
}

/* ---------------- miniatura do pivô com as fatias reais ---------------- */
function anel(g: Piquete['geom']): [number, number][][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates[0] as [number, number][]];
  return g.coordinates.map((p) => p[0] as [number, number][]);
}

function MiniPivo({ piquetes, sel, aoEscolher }: { piquetes: Piquete[]; sel: number | null; aoEscolher: (id: number) => void }) {
  const V = 200;
  const dados = useMemo(() => {
    const comGeom = piquetes.filter((p) => anel(p.geom).length);
    if (comGeom.length === 0) return null;
    // enquadra só o círculo do pivô: parcelas afastadas (área de serviço, praça) ficam fora do quadro
    const centro = (p: Piquete) => { const pts = anel(p.geom).flat(); return [pts.reduce((s, c) => s + c[0], 0) / pts.length, pts.reduce((s, c) => s + c[1], 0) / pts.length] as [number, number]; };
    const cs = comGeom.map(centro);
    const mediana = (v: number[]) => { const o = [...v].sort((a, b) => a - b); return o[Math.floor(o.length / 2)]; };
    const cx = mediana(cs.map((c) => c[0])), cy = mediana(cs.map((c) => c[1]));
    const dist = cs.map((c) => Math.hypot(c[0] - cx, c[1] - cy));
    const limite = Math.max(mediana(dist) * 2.5, 1e-6);
    const perto = comGeom.filter((_, i) => dist[i] <= limite);
    const todos = perto.flatMap((p) => anel(p.geom).flat());
    const lat0 = todos.reduce((s, c) => s + c[1], 0) / todos.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const xs = todos.map((c) => c[0] * k), ys = todos.map((c) => c[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const esc = (V - 12) / Math.max(maxX - minX, maxY - minY, 1e-9);
    const ox = (V - (maxX - minX) * esc) / 2, oy = (V - (maxY - minY) * esc) / 2;
    const proj = ([lon, lat]: [number, number]) => `${(ox + (lon * k - minX) * esc).toFixed(1)},${(oy + (maxY - lat) * esc).toFixed(1)}`;
    return piquetes.map((p) => ({ p, d: anel(p.geom).map((r) => `M${r.map(proj).join('L')}Z`).join(' ') })).filter((x) => x.d);
  }, [piquetes]);

  if (!dados) {
    // sem geometria: fatias iguais em roda
    const n = piquetes.length || 1;
    return (
      <svg viewBox={`0 0 ${V} ${V}`} className="h-44 w-44 shrink-0" role="img" aria-label="Piquetes do pivô">
        {piquetes.map((p, i) => {
          const a0 = (i / n) * 2 * Math.PI - Math.PI / 2, a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2, r = 92;
          const d = `M100,100 L${100 + r * Math.cos(a0)},${100 + r * Math.sin(a0)} A${r},${r} 0 ${n === 1 ? 1 : 0},1 ${100 + r * Math.cos(a1)},${100 + r * Math.sin(a1)} Z`;
          return <path key={p.parcelaId} d={d} fill={corPiquete(p)} fillOpacity={sel === p.parcelaId ? 0.95 : 0.7} stroke={sel === p.parcelaId ? '#fff' : 'rgb(255 255 255 / .7)'} strokeWidth={sel === p.parcelaId ? 3 : 1} className={`cursor-pointer ${p.ocupado ? 'pulsa' : ''}`} onClick={() => aoEscolher(p.parcelaId)}><title>{p.nome}</title></path>;
        })}
      </svg>
    );
  }
  return (
    <svg viewBox={`0 0 ${V} ${V}`} className="h-44 w-44 shrink-0 drop-shadow-sm" role="img" aria-label="Piquetes do pivô">
      {dados.map(({ p, d }, i) => (
        <path key={p.parcelaId} d={d} fill={corPiquete(p)} fillOpacity={sel === p.parcelaId ? 0.95 : p.ocupado ? 0.9 : 0.7}
          stroke={sel === p.parcelaId ? '#fff' : 'rgb(255 255 255 / .75)'} strokeWidth={sel === p.parcelaId ? 3 : 1.2} strokeLinejoin="round"
          className={`surge cursor-pointer transition-[fill-opacity] hover:fill-opacity-100 ${p.ocupado ? 'pulsa' : ''}`} style={{ animationDelay: `${i * 30}ms` }}
          onClick={() => aoEscolher(p.parcelaId)}>
          <title>{`${p.nome}${p.ocupado ? ' · com animais' : p.diasDescanso != null ? ` · descansa há ${p.diasDescanso} d` : ''}`}</title>
        </path>
      ))}
    </svg>
  );
}

/* ---------------- formulário: um ou dois movimentos de uma vez ---------------- */
interface Passo { tipo: 'entrada' | 'saida'; piquete: Piquete }

function Formulario({ titulo, passos, cabecasIni, loteIni, aoFechar, aoSalvar }: { titulo: string; passos: Passo[]; cabecasIni: number | null; loteIni: string | null; aoFechar: () => void; aoSalvar: (r: Registro[]) => void }) {
  const [cabecas, setCabecas] = useState(cabecasIni?.toString() ?? '');
  const [lote, setLote] = useState(loteIni ?? '');
  const [notas, setNotas] = useState<(number | null)[]>(passos.map(() => null));
  const [fotos, setFotos] = useState<(string | null)[]>(passos.map(() => null));
  const [lendo, setLendo] = useState(false);
  const [obs, setObs] = useState('');
  const [quando, setQuando] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const completo = notas.every((n) => n != null);

  async function escolherFoto(i: number, f: File | undefined) {
    if (!f) return;
    setLendo(true);
    try { const d = await reduzirFoto(f); setFotos(fotos.map((x, j) => (j === i ? d : x))); } finally { setLendo(false); }
  }
  function enviar(e: FormEvent) {
    e.preventDefault();
    if (!completo) return;
    const base = new Date(quando).getTime();
    aoSalvar(passos.map((p, i) => ({
      clientUuid: novoUuid(), parcelaId: p.piquete.parcelaId, tipo: p.tipo, ocorridoEm: new Date(base + i * 60_000).toISOString(),
      lote: lote.trim() || null, cabecas: cabecas ? Number(cabecas) : null, nota: notas[i], observacao: obs.trim() || null, foto: fotos[i],
    })));
  }

  return (
    <form onSubmit={enviar} className="surge space-y-4 rounded-xl border border-cyan-500/40 bg-cyan-500/5 p-4 shadow-[0_0_24px_rgb(8_145_178/.15)]">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{titulo}</h3>
        <button type="button" className="chip" onClick={aoFechar}>Cancelar</button>
      </div>
      <div className={`grid gap-3 ${passos.length > 1 ? 'md:grid-cols-2' : ''}`}>
        {passos.map((p, i) => {
          const cor = p.tipo === 'entrada' ? '#059669' : '#d97706';
          return (
            <div key={i} className="rounded-xl border p-3" style={{ borderColor: `${cor}66`, background: `${cor}0d` }}>
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold" style={{ color: cor }}>
                {p.tipo === 'entrada' ? '⬇ Entrada em' : '⬆ Saída de'} {p.piquete.nome}
                <span className="font-normal text-slate-500">· {fmt(p.piquete.areaHa, 1)} ha</span>
              </div>
              <span className="rotulo">Como está o pasto {p.tipo === 'entrada' ? 'na entrada' : 'na saída'}? (obrigatório)</span>
              <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label={`Nota ${p.tipo} ${p.piquete.nome}`}>
                {NOTAS.map((x) => (
                  <button key={x.n} type="button" role="radio" aria-checked={notas[i] === x.n} onClick={() => setNotas(notas.map((n, j) => (j === i ? x.n : n)))}
                    className={`rounded-lg border px-1 py-2 text-[11px] transition ${notas[i] === x.n ? 'border-transparent text-white shadow-md' : 'border-slate-300 hover:border-slate-400 dark:border-slate-600'}`}
                    style={notas[i] === x.n ? { background: cor } : undefined}>
                    <div className="text-base font-bold">{x.n}</div>{x.t}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="chip cursor-pointer">
                  {lendo ? 'Preparando…' : fotos[i] ? '📷 Trocar foto' : '📷 Tirar foto'}
                  <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => escolherFoto(i, e.target.files?.[0])} />
                </label>
                {fotos[i] && <img src={fotos[i]!} alt="Prévia da foto" className="h-14 rounded-lg" />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div><label className="rotulo" htmlFor="cab">Cabeças</label><input id="cab" className="campo" inputMode="numeric" value={cabecas} onChange={(e) => setCabecas(e.target.value.replace(/\D/g, ''))} /></div>
        <div><label className="rotulo" htmlFor="lote">Lote</label><input id="lote" className="campo" value={lote} onChange={(e) => setLote(e.target.value)} /></div>
        <div><label className="rotulo" htmlFor="quando">Quando</label><input id="quando" type="datetime-local" className="campo" value={quando} onChange={(e) => setQuando(e.target.value)} required /></div>
      </div>
      <div>
        <label className="rotulo" htmlFor="obs">Observação</label>
        <textarea id="obs" className="campo" rows={2} value={obs} onChange={(e) => setObs(e.target.value)} maxLength={1000} />
      </div>
      <button className="btn w-full !py-3" disabled={!completo || lendo}>{completo ? (passos.length > 1 ? 'Salvar saída e entrada' : 'Salvar registro') : 'Dê a nota do pasto para salvar'}</button>
    </form>
  );
}

/* ---------------- card do pivô ---------------- */
function CardPivo({ nome, piquetes, aberto, aoAbrir, aoFechar, aoSalvar, atraso }: { nome: string; piquetes: Piquete[]; aberto: boolean; aoAbrir: () => void; aoFechar: () => void; aoSalvar: (r: Registro[]) => void; atraso: number }) {
  const ocupados = piquetes.filter((p) => p.ocupado);
  const atual = ocupados[0] ?? null;
  const sugestao = useMemo(() => [...piquetes].filter((p) => !p.ocupado).sort((a, b) => (b.diasDescanso ?? 9999) - (a.diasDescanso ?? 9999))[0] ?? null, [piquetes]);
  const [selId, setSelId] = useState<number | null>(null);
  const sel = piquetes.find((p) => p.parcelaId === selId) ?? (atual ? sugestao : sugestao) ?? piquetes[0];
  const [acao, setAcao] = useState<'entrar' | 'mover' | 'retirar' | null>(null);
  const area = piquetes.reduce((s, p) => s + p.areaHa, 0);
  const descansando = piquetes.filter((p) => !p.ocupado && p.diasDescanso != null && p.diasDescanso < 20).length;
  const cor = atual ? ANIMAIS : '#059669';

  const abrir = (a: 'entrar' | 'mover' | 'retirar') => { setAcao(a); aoAbrir(); };
  const fechar = () => { setAcao(null); aoFechar(); };
  const passos: Passo[] = acao === 'entrar' && sel ? [{ tipo: 'entrada', piquete: sel }]
    : acao === 'mover' && atual && sel ? [{ tipo: 'saida', piquete: atual }, { tipo: 'entrada', piquete: sel }]
      : acao === 'retirar' && atual ? [{ tipo: 'saida', piquete: atual }] : [];
  const titulo = acao === 'entrar' ? `${nome} · entrada do lote em ${sel?.nome}` : acao === 'mover' ? `${nome} · mover lote de ${atual?.nome} para ${sel?.nome}` : `${nome} · retirar lote de ${atual?.nome}`;

  const linha = (r: string, v: ReactNode) => <div className="flex items-baseline justify-between gap-2 text-xs"><span className="text-slate-500">{r}</span><span className="font-medium tabular-nums">{v}</span></div>;

  return (
    <article className="vidro surge p-4" style={{ animationDelay: `${atraso}ms` }}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: cor, boxShadow: `0 0 12px ${cor}` }} />
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-bold"><i className={`h-2.5 w-2.5 rounded-full ${atual ? 'animate-pulse' : ''}`} style={{ background: cor, boxShadow: `0 0 8px ${cor}` }} />{nome}</h2>
          <p className="text-xs text-slate-500">{piquetes.length} piquetes · {fmt(area, 0)} ha{descansando ? ` · ${descansando} com descanso curto` : ''}</p>
        </div>
        {atual ? (
          <span className="rounded-full px-2.5 py-1 text-xs font-semibold text-white" style={{ background: ANIMAIS }}>
            {atual.lote ? `${atual.lote} · ` : ''}{atual.cabecas ? `${atual.cabecas} cab. · ` : ''}em {atual.nome} há {atual.diasNoPiquete ?? 0} d
          </span>
        ) : <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">Sem animais</span>}
      </header>
      {ocupados.length > 1 && <p className="mt-2 rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">Há {ocupados.length} piquetes com animais neste pivô ({ocupados.map((p) => p.nome).join(', ')}). O esperado é um lote só: registre a saída dos que já estão vazios.</p>}

      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <MiniPivo piquetes={piquetes} sel={sel?.parcelaId ?? null} aoEscolher={(id) => { setSelId(id); if (acao) setAcao(null); }} />
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap gap-1" role="listbox" aria-label={`Piquetes do ${nome}`}>
            {piquetes.map((p) => (
              <button key={p.parcelaId} role="option" aria-selected={sel?.parcelaId === p.parcelaId} onClick={() => { setSelId(p.parcelaId); if (acao) setAcao(null); }}
                className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium transition ${sel?.parcelaId === p.parcelaId ? 'ring-2 ring-cyan-500' : ''}`}
                style={{ background: `${corPiquete(p)}22`, color: p.ocupado ? ANIMAIS : undefined, borderLeft: `3px solid ${corPiquete(p)}` }}
                title={p.ocupado ? 'com animais' : p.diasDescanso != null ? `descansa há ${p.diasDescanso} d` : 'sem registro'}>
                {p.nome}{p.ocupado ? ' 🐄' : p.diasDescanso != null ? ` ${p.diasDescanso}d` : ''}
              </button>
            ))}
          </div>
          {sel && (
            <div className="rounded-xl bg-slate-100/70 p-3 dark:bg-slate-800/60">
              <div className="mb-1 flex items-center justify-between gap-2">
                <b className="text-sm">{sel.nome}</b>
                <span className="text-xs text-slate-500">{fmt(sel.areaHa, 1)} ha · {sel.cultura}</span>
              </div>
              <div className="space-y-0.5">
                {linha('Situação', sel.ocupado ? <span style={{ color: ANIMAIS }}>com animais há {sel.diasNoPiquete ?? 0} d</span> : sel.diasDescanso != null ? <span style={{ color: corDescanso(sel.diasDescanso) }}>descansando há {sel.diasDescanso} d</span> : 'sem registro de uso')}
                {linha('Última nota de entrada', <Estrelas nota={sel.notaEntrada} />)}
                {linha('Última nota de saída', <Estrelas nota={sel.notaSaida} />)}
              </div>
              {!sel.ocupado && sugestao && sel.parcelaId === sugestao.parcelaId && selId == null && <p className="mt-1 text-[11px] text-cyan-700 dark:text-cyan-300">Sugestão: é o piquete com mais descanso.</p>}
            </div>
          )}
        </div>
      </div>

      {!aberto && (
        <footer className="mt-3 flex flex-wrap gap-2">
          {!atual && sel && !sel.ocupado && <button className="btn w-full !bg-emerald-600 hover:!bg-emerald-700 sm:w-auto" onClick={() => abrir('entrar')}>⬇ Entrar com o lote em {sel.nome}</button>}
          {atual && sel && sel.parcelaId !== atual.parcelaId && !sel.ocupado && <button className="btn w-full sm:w-auto" onClick={() => abrir('mover')}>➜ Mover lote de {atual.nome} para {sel.nome}</button>}
          {atual && <button className="btn w-full !bg-amber-600 hover:!bg-amber-700 sm:w-auto" onClick={() => abrir('retirar')}>⬆ Retirar lote de {atual.nome}</button>}
        </footer>
      )}
      {aberto && acao && passos.length > 0 && (
        <div className="mt-3"><Formulario titulo={titulo} passos={passos} cabecasIni={atual?.cabecas ?? null} loteIni={atual?.lote ?? null} aoFechar={fechar} aoSalvar={(r) => { setAcao(null); aoSalvar(r); }} /></div>
      )}
    </article>
  );
}

/* ---------------- tela ---------------- */
export default function Pastejo({ fazenda }: { fazenda: Fazenda }) {
  const qc = useQueryClient();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [fila, setFila] = useState<Registro[]>([]);
  const [aberto, setAberto] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<'todos' | 'com' | 'sem'>('todos');

  const dados = useQuery({
    queryKey: ['pastejo', fazenda.id],
    queryFn: async () => { const d = await api<DadosPastejo>(`/fazendas/${fazenda.id}/pastejo`); guardarPiquetes(fazenda.id, d); return d; },
    initialData: () => lerPiquetes<DadosPastejo>(fazenda.id),
    initialDataUpdatedAt: 0,
    refetchInterval: 60_000,
    networkMode: 'always',
    retry: false,
  });

  const recarregarFila = useCallback(async () => setFila(await listarFila().catch(() => [])), []);
  const sincronizar = useCallback(async () => {
    const r = await sincronizarFila().catch(() => null);
    await recarregarFila();
    if (r?.enviados) { qc.invalidateQueries({ queryKey: ['pastejo'] }); qc.invalidateQueries({ queryKey: ['alertas'] }); }
  }, [qc, recarregarFila]);

  useEffect(() => {
    const ligar = () => { setOnline(true); sincronizar(); };
    const desligar = () => setOnline(false);
    window.addEventListener('online', ligar);
    window.addEventListener('offline', desligar);
    sincronizar();
    const t = setInterval(sincronizar, 60_000);
    return () => { window.removeEventListener('online', ligar); window.removeEventListener('offline', desligar); clearInterval(t); };
  }, [sincronizar]);

  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(null), 6000);
    return () => clearTimeout(t);
  }, [aviso]);

  // o que o aparelho já sabe (fila ainda não enviada) vale mais que a última cópia do servidor
  const piquetes = useMemo(() => {
    const ultimo = new Map<number, Registro>();
    for (const r of [...fila].filter((x) => !x.erro).sort((a, b) => a.ocorridoEm.localeCompare(b.ocorridoEm))) ultimo.set(r.parcelaId, r);
    return (dados.data?.piquetes ?? []).map((p) => {
      const r = ultimo.get(p.parcelaId);
      if (!r) return p;
      return r.tipo === 'entrada'
        ? { ...p, ocupado: true, desde: r.ocorridoEm, cabecas: r.cabecas, lote: r.lote, diasNoPiquete: 0, diasDescanso: null, notaEntrada: r.nota ?? p.notaEntrada }
        : { ...p, ocupado: false, desde: null, cabecas: null, lote: null, ultimaSaida: r.ocorridoEm, diasNoPiquete: null, diasDescanso: 0, notaSaida: r.nota ?? p.notaSaida };
    });
  }, [dados.data, fila]);

  const porPivo = useMemo(() => {
    const m = new Map<string, Piquete[]>();
    for (const p of piquetes) m.set(p.pivoNome, [...(m.get(p.pivoNome) ?? []), p]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR', { numeric: true }));
  }, [piquetes]);

  async function salvar(rs: Registro[]) {
    for (const r of rs) await enfileirar(r);
    setAberto(null);
    await recarregarFila();
    setAviso(online ? `${rs.length > 1 ? 'Saída e entrada salvas' : 'Registro salvo'}. Enviando…` : `${rs.length > 1 ? 'Saída e entrada salvas' : 'Registro salvo'} no aparelho. Será enviado quando houver internet.`);
    sincronizar();
  }

  const pivosCom = porPivo.filter(([, ps]) => ps.some((p) => p.ocupado));
  const cabecas = piquetes.filter((p) => p.ocupado).reduce((s, p) => s + (p.cabecas ?? 0), 0);
  const emFila = fila.filter((r) => !r.erro).length;
  const recusados = fila.filter((r) => r.erro);
  const nome = (id: number) => piquetes.find((p) => p.parcelaId === id);
  const lista = porPivo.filter(([, ps]) => filtro === 'todos' || (filtro === 'com') === ps.some((p) => p.ocupado));

  return (
    <div className="viz space-y-4">
      {/* barra de comando */}
      <div className="vidro vidro-forte surge flex flex-wrap items-center gap-3 p-4">
        <div className="mr-auto">
          <h1 className="flex items-center gap-2 text-lg font-bold"><span className={online ? 'ponto-vivo' : 'h-2.5 w-2.5 rounded-full bg-slate-400'} aria-hidden /> Animais nos pivôs</h1>
          <p className="text-xs text-slate-500">{fazenda.nome} · um lote por pivô, girando entre os piquetes · pivôs não irrigam o piquete com animais</p>
        </div>
        {!online && <span className="chip cursor-default border-amber-500 text-amber-700 dark:text-amber-300">Sem internet · salvando no aparelho</span>}
        {emFila > 0 && <span className="chip cursor-default border-amber-500 text-amber-700 dark:text-amber-300">{emFila} registro{emFila > 1 ? 's' : ''} aguardando envio</span>}
        {emFila > 0 && online && <button className="btn" onClick={sincronizar}>Enviar agora</button>}
      </div>

      {/* indicadores */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { r: 'Pivôs com lote', v: pivosCom.length, u: `de ${porPivo.length}`, cor: ANIMAIS, f: 'com' as const },
          { r: 'Cabeças no pasto', v: cabecas, u: '', cor: ANIMAIS, f: 'com' as const },
          { r: 'Pivôs livres', v: porPivo.length - pivosCom.length, u: 'sem animais', cor: '#059669', f: 'sem' as const },
          { r: 'Piquetes', v: piquetes.length, u: 'cadastrados', cor: 'var(--s-irr)', f: 'todos' as const },
        ].map((k, i) => (
          <button key={k.r} type="button" onClick={() => setFiltro(k.f)} className="vidro vidro-forte surge p-4 text-left transition hover:-translate-y-0.5" aria-pressed={filtro === k.f} style={{ animationDelay: `${40 + i * 40}ms`, outline: filtro === k.f && k.f !== 'todos' ? `2px solid ${k.cor}` : undefined }}>
            <div className="absolute inset-y-0 left-0 w-1" style={{ background: k.cor, boxShadow: `0 0 16px ${k.cor}` }} />
            <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-slate-500 dark:text-slate-400">{k.r}</div>
            <div className="mt-1 flex items-baseline gap-1.5"><span className="num-grande text-3xl" style={{ color: k.cor }}><Numero valor={k.v} /></span>{k.u && <span className="text-sm text-slate-500">{k.u}</span>}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 surge">
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: ANIMAIS }} />com animais</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-16 rounded-sm" style={{ background: `linear-gradient(90deg, ${corDescanso(0)}, ${corDescanso(15)}, ${corDescanso(30)})` }} />descanso: recém-saído → 30 dias</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: SEM_REGISTRO }} />sem registro</span>
        <span className="ml-auto">Toque numa fatia ou num nome para escolher o piquete.</span>
      </div>

      {recusados.map((r) => (
        <div key={r.clientUuid} role="alert" className="vidro p-3 text-sm text-red-600">
          Registro de {nome(r.parcelaId)?.nome ?? 'piquete'} recusado pelo servidor: {r.erro}{' '}
          <button className="chip" onClick={async () => { await descartar(r.clientUuid); recarregarFila(); }}>Descartar</button>
        </div>
      ))}

      {dados.isLoading && <div className="grid gap-3 lg:grid-cols-2">{[0, 1, 2, 3].map((i) => <div key={i} className="esqueleto h-64 rounded-2xl" />)}</div>}
      {!dados.isLoading && piquetes.length === 0 && <p className="vidro p-4 text-sm text-slate-500">Nenhum piquete cadastrado (parcelas com cultura forrageira).</p>}

      <div className="grid gap-3 lg:grid-cols-2">
        {lista.map(([pivo, ps], i) => (
          <div key={pivo} className={aberto === pivo ? 'lg:col-span-2' : ''}>
            <CardPivo nome={pivo} piquetes={ps} atraso={Math.min(i, 8) * 50} aberto={aberto === pivo} aoAbrir={() => { setAviso(null); setAberto(pivo); }} aoFechar={() => setAberto(null)} aoSalvar={salvar} />
          </div>
        ))}
      </div>

      {(dados.data?.recentes.length ?? 0) > 0 && (
        <section className="vidro surge p-4">
          <h2 className="titulo-secao mb-3">Movimentos recentes</h2>
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead><tr><th>Quando</th><th>Piquete</th><th>Movimento</th><th className="num">Cab.</th><th>Nota</th><th>Observação</th><th /></tr></thead>
              <tbody>
                {dados.data!.recentes.map((m: MovimentoRecente) => (
                  <tr key={m.id}>
                    <td title={m.em}>{new Date(m.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} <span className="text-xs text-slate-400">({haQuanto(m.em)})</span></td>
                    <td>{m.pivoNome} · {m.piquete}</td>
                    <td><span className="font-medium" style={{ color: m.tipo === 'entrada' ? '#059669' : '#d97706' }}>{m.tipo === 'entrada' ? '⬇ Entrada' : '⬆ Saída'}</span></td>
                    <td className="num">{m.cabecas ?? '–'}</td>
                    <td><Estrelas nota={m.nota} /></td>
                    <td className="max-w-xs truncate" title={m.observacao ?? ''}>{m.observacao ?? ''}</td>
                    <td>{m.temFoto && <FotoMov id={m.id} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {aviso && (
        <div role="status" className="surge fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-emerald-400/40 bg-white/90 px-4 py-2 text-sm font-medium text-emerald-700 shadow-lg backdrop-blur dark:bg-slate-900/90 dark:text-emerald-300">
          ✔ {aviso}
        </div>
      )}
    </div>
  );
}
