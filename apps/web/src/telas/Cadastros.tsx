import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { api, dataBR, fmt } from '../api';
import { haQuanto } from '../hooks';
import { COR_STATUS, type Fazenda, type Usuario } from '../tipos';
import { Numero } from '../ui';

interface Fase { fase: string; kc: number; dias: number; kc_fim?: number | null; raiz_mm?: number | null; raiz_fim_mm?: number | null }
interface Cultura { id: number; nome: string; nome_cientifico: string | null; tipo: string; parametros_confirmados: boolean; prof_raiz_mm: number; fracao_agua_disponivel_p: number; fases: Fase[] }
interface Pivo { id: number; nome: string; area_ha: number; vazao_m3h: number | null; lamina_volta_100_mm: number; horas_volta_100: number; eficiencia: number; parametros_confirmados: boolean }
interface ParcelaCad { id: number; nome: string; pivo_id: number; pivo: string; cultura_id: number; cultura: string; area_ha: number; data_plantio: string | null; cap_campo_mm: number; lamina_seguranca_mm: number; ad_mm_por_cm: number }
interface Estacao { id: number; nome: string; tipo: string; online: boolean; ultima_leitura_em?: string | null }
interface Dados { pivos: Pivo[]; parcelas: ParcelaCad[]; culturas: Cultura[]; estacoes: Estacao[] }

const num = (s: string) => Number(String(s).replace(',', '.'));
const CIANO = 'var(--s-irr)';
const ROXO = '#a855f7';

/* ---------------- peças visuais ---------------- */
function Painel({ id, titulo, sub, extra, atraso = 0, className = '', children }: { id?: string; titulo: string; sub?: string; extra?: ReactNode; atraso?: number; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={`vidro surge p-4 ${className}`} style={{ animationDelay: `${atraso}ms` }}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="titulo-secao">{titulo}</h2>{sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}</div>
        {extra && <div className="flex flex-wrap items-center gap-2">{extra}</div>}
      </header>
      {children}
    </section>
  );
}

function Kpi({ rotulo, valor, unidade, sub, cor, progresso, atraso, aoClicar }: { rotulo: string; valor: number; unidade?: string; sub?: string; cor: string; progresso?: number; atraso: number; aoClicar?: () => void }) {
  return (
    <button type="button" onClick={aoClicar} className="vidro vidro-forte surge p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md" style={{ animationDelay: `${atraso}ms`, ['--cor' as string]: cor } as CSSProperties}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: cor, boxShadow: `0 0 16px ${cor}` }} />
      <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-slate-500 dark:text-slate-400">{rotulo}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="num-grande text-3xl sm:text-4xl" style={{ color: cor }}><Numero valor={valor} /></span>
        {unidade && <span className="text-sm text-slate-500">{unidade}</span>}
      </div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
      {progresso != null && (
        <div className="mt-2 h-1.5 rounded-full bg-slate-200/80 dark:bg-slate-700" aria-hidden>
          <div className="barra-h h-full rounded-full" style={{ width: `${Math.round(progresso * 100)}%`, background: cor, boxShadow: `0 0 8px ${cor}` }} />
        </div>
      )}
    </button>
  );
}

/** Selo de situação dos parâmetros: confirmados pelo agrônomo ou ainda no valor padrão. */
function Selo({ ok, textoOk = 'confirmado', textoPadrao = 'padrão · confirmar' }: { ok: boolean; textoOk?: string; textoPadrao?: string }) {
  const cor = ok ? COR_STATUS.ok : COR_STATUS.atencao;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ background: `${cor}22`, color: cor }}>
      <i className="h-1.5 w-1.5 rounded-full" style={{ background: cor, boxShadow: `0 0 6px ${cor}` }} />{ok ? textoOk : textoPadrao}
    </span>
  );
}

function Campo({ rotulo, valor, aoMudar, unidade, disabled, largura = '' }: { rotulo: string; valor: string; aoMudar: (v: string) => void; unidade?: string; disabled?: boolean; largura?: string }) {
  return (
    <label className="block min-w-0">
      <span className="rotulo !mb-0.5 truncate">{rotulo}</span>
      <span className="flex items-center gap-1.5">
        <input className={`campo !py-1.5 text-right tabular-nums ${largura}`} inputMode="decimal" value={valor} disabled={disabled} onChange={(e) => aoMudar(e.target.value)} aria-label={rotulo} />
        {unidade && <span className="w-10 shrink-0 text-xs text-slate-500">{unidade}</span>}
      </span>
    </label>
  );
}

/** Faixa de Kc por fase: largura = duração (limitada para a fase perene não engolir as outras), altura = Kc. */
function FaixaKc({ fases, altura = 30 }: { fases: Fase[]; altura?: number }) {
  const W = 160;
  const dur = fases.map((f) => Math.min(Math.max(f.dias, 5), 60));
  const total = dur.reduce((s, d) => s + d, 0) || 1;
  let x = 0;
  return (
    <svg viewBox={`0 0 ${W} ${altura}`} className="h-7 w-40" role="img" aria-label={fases.map((f) => `${f.fase} Kc ${fmt(f.kc, 2)} por ${f.dias} dias`).join('; ')}>
      {fases.map((f, i) => {
        const w = (dur[i] / total) * W;
        const h = Math.max(3, (Math.min(f.kc, 1.3) / 1.3) * altura);
        const el = <rect key={i} x={x + 0.5} y={altura - h} width={Math.max(1, w - 1)} height={h} rx="2" className="barra-v" style={{ fill: CIANO, opacity: 0.35 + (Math.min(f.kc, 1.3) / 1.3) * 0.65, animationDelay: `${i * 70}ms` }}><title>{`${f.fase}: Kc ${fmt(f.kc, 2)}${f.kc_fim != null ? ` → ${fmt(f.kc_fim, 2)}` : ''} · ${f.dias} dias${f.raiz_mm != null ? ` · raiz ${fmt(f.raiz_mm, 0)}${f.raiz_fim_mm != null ? `→${fmt(f.raiz_fim_mm, 0)}` : ''} mm` : ''}`}</title></rect>;
        x += w;
        return el;
      })}
    </svg>
  );
}

/** Barra de capacidade da parcela: faixa vermelha = abaixo do limite de segurança (irrigar). */
function BarraSolo({ cap, limite }: { cap: number; limite: number }) {
  const k = cap > 0 ? Math.min(1, limite / cap) : 0;
  return (
    <div className="relative h-2 w-24 overflow-visible rounded-full bg-cyan-500/25" title={`Limite ${fmt(limite)} mm de ${fmt(cap)} mm de capacidade`}>
      <div className="barra-h absolute inset-y-0 left-0 rounded-l-full" style={{ width: `${k * 100}%`, background: COR_STATUS.irrigar, opacity: 0.75 }} />
      <i className="absolute -top-1 h-4 w-0.5 rounded bg-slate-800 dark:bg-slate-100" style={{ left: `calc(${k * 100}% - 1px)` }} />
    </div>
  );
}

function useAviso(): [string, (m: string) => void] {
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(''), 5000);
    return () => clearTimeout(t);
  }, [msg]);
  return [msg, setMsg];
}

/* ---------------- Cultivares ---------------- */
function EditorCultura({ c, aoFechar, aoSalvar, erro, salvando }: { c: Cultura | null; aoFechar: () => void; aoSalvar: (v: object) => void; erro: string; salvando: boolean }) {
  const [nome, setNome] = useState(c?.nome ?? '');
  const [cient, setCient] = useState(c?.nome_cientifico ?? '');
  const [raiz, setRaiz] = useState(String(c?.prof_raiz_mm ?? 400));
  const [p, setP] = useState(String(c?.fracao_agua_disponivel_p ?? 0.55));
  const [fases, setFases] = useState<{ fase: string; kc: string; dias: string; curva: Pick<Fase, 'kc_fim' | 'raiz_mm' | 'raiz_fim_mm'> }[]>(
    (c?.fases.length ? c.fases : [{ fase: 'inicial', kc: 0.5, dias: 15 }, { fase: 'desenvolvimento', kc: 0.75, dias: 25 }, { fase: 'médio', kc: 0.95, dias: 365 }, { fase: 'final', kc: 0.85, dias: 30 }]).map((f: Fase) => ({ fase: f.fase, kc: String(f.kc), dias: String(f.dias), curva: { kc_fim: f.kc_fim ?? null, raiz_mm: f.raiz_mm ?? null, raiz_fim_mm: f.raiz_fim_mm ?? null } })),
  );
  const set = (i: number, k: 'fase' | 'kc' | 'dias', v: string) => setFases(fases.map((f, j) => (j === i ? { ...f, [k]: v } : f)));
  const previa = fases.map((f) => ({ fase: f.fase, kc: num(f.kc) || 0, dias: Math.round(num(f.dias)) || 1, ...f.curva }));
  const ad = 1.4; // mm/cm só para a prévia
  const cap = (num(raiz) / 10) * ad;

  return (
    <div className="surge rounded-xl border border-cyan-500/40 bg-cyan-500/5 p-4 shadow-[0_0_24px_rgb(8_145_178/.15)]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{c ? `Editar ${c.nome}` : 'Nova cultivar'}</h3>
        <FaixaKc fases={previa} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2"><label className="rotulo">Cultivar (nome)</label><input className="campo" value={nome} onChange={(e) => setNome(e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="rotulo">Nome científico</label><input className="campo" value={cient} onChange={(e) => setCient(e.target.value)} /></div>
        <Campo rotulo="Profundidade efetiva de raiz" valor={raiz} aoMudar={setRaiz} unidade="mm" />
        <Campo rotulo="Fator p (depleção permitida)" valor={p} aoMudar={setP} />
        <div className="rounded-lg bg-white/60 px-3 py-2 text-xs text-slate-600 dark:bg-slate-900/40 dark:text-slate-300 sm:col-span-2">
          Prévia num solo de {fmt(ad)} mm/cm: capacidade <b className="tabular-nums">{fmt(cap, 0)} mm</b>, limite de segurança <b className="tabular-nums">{fmt(cap * (1 - num(p)), 0)} mm</b>.
        </div>
      </div>
      <div className="rotulo mt-3">Kc por fase · nome, Kc e dias (sem data de plantio o balanço usa a fase “médio”)</div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {fases.map((f, i) => (
          <div key={i} className="flex gap-1.5">
            <input className="campo" aria-label="Fase" value={f.fase} onChange={(e) => set(i, 'fase', e.target.value)} />
            <input className="campo !w-16 text-right" aria-label="Kc" inputMode="decimal" value={f.kc} onChange={(e) => set(i, 'kc', e.target.value)} />
            <input className="campo !w-16 text-right" aria-label="Dias" inputMode="numeric" value={f.dias} onChange={(e) => set(i, 'dias', e.target.value)} />
            {(f.curva.kc_fim != null || f.curva.raiz_mm != null) && (
              <span className="self-center whitespace-nowrap text-[11px] tabular-nums text-cyan-700 dark:text-cyan-300" title="Curva do iCrop: o valor segue em linha reta até o último dia da fase">
                {f.curva.kc_fim != null ? `→ ${fmt(f.curva.kc_fim, 2)}` : ''}
                {f.curva.raiz_mm != null ? ` · ${fmt(f.curva.raiz_mm / 10, 0)}${f.curva.raiz_fim_mm != null ? `→${fmt(f.curva.raiz_fim_mm / 10, 0)}` : ''} cm` : ''}
              </span>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">Ao salvar, a capacidade e o limite das parcelas que usam esta cultivar são recalculados (raiz × água do solo, e × (1 − p)).</p>
      {erro && <p role="alert" className="mt-1 text-sm text-red-600">{erro}</p>}
      <div className="mt-3 flex gap-2">
        <button className="btn" disabled={salvando} onClick={() => aoSalvar({ nome, nome_cientifico: cient || null, prof_raiz_mm: num(raiz), fracao_agua_disponivel_p: num(p), fases: previa })}>{salvando ? 'Salvando…' : 'Salvar cultivar'}</button>
        <button className="btn-sec" onClick={aoFechar}>Cancelar</button>
      </div>
    </div>
  );
}

function Cultivares({ culturas, uso, busca, soPendentes, podeEditar, novaAberta, aoFecharNova, aoMudar }: { culturas: Cultura[]; uso: Map<number, { parcelas: number; area: number }>; busca: string; soPendentes: boolean; podeEditar: boolean; novaAberta: boolean; aoFecharNova: () => void; aoMudar: (m: string) => void }) {
  const [filtro, setFiltro] = useState<'todas' | 'uso' | 'pendentes'>('uso');
  const [editando, setEditando] = useState<number | null>(null);
  const [erro, setErro] = useState('');
  const alvo = novaAberta ? 'nova' : editando;
  const salvar = useMutation({
    mutationFn: (v: object) => (alvo === 'nova' ? api<{ parcelas_recalculadas?: number }>('/culturas', { corpo: v }) : api<{ parcelas_recalculadas?: number }>(`/culturas/${alvo}`, { method: 'PUT', corpo: v })),
    onSuccess: (r) => {
      setEditando(null); aoFecharNova(); setErro('');
      aoMudar(r.parcelas_recalculadas != null ? `Cultivar salva · ${r.parcelas_recalculadas} parcela(s) recalculada(s).` : 'Cultivar criada.');
    },
    onError: (e: Error) => setErro(e.message),
  });
  const lista = useMemo(() => {
    const q = busca.toLowerCase();
    return culturas.filter((c) => {
      if (q && !`${c.nome} ${c.nome_cientifico ?? ''}`.toLowerCase().includes(q)) return false;
      if (soPendentes && c.parametros_confirmados) return false;
      if (filtro === 'uso') return uso.has(c.id);
      if (filtro === 'pendentes') return !c.parametros_confirmados;
      return true;
    });
  }, [culturas, uso, busca, soPendentes, filtro]);
  const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const kcMedio = (c: Cultura) => c.fases.find((f) => semAcento(f.fase).startsWith('med'))?.kc ?? Math.max(0, ...c.fases.map((f) => f.kc));
  const nUso = culturas.filter((c) => uso.has(c.id)).length;
  const nPend = culturas.filter((c) => !c.parametros_confirmados).length;

  return (
    <Painel id="cultivares" atraso={200} titulo={`Cultivares e Kc · ${culturas.length}`} sub="Raiz e fator p definem a capacidade e o limite de segurança; o Kc por fase define o consumo diário."
      extra={<>
        <button className="chip" aria-pressed={filtro === 'uso'} onClick={() => setFiltro('uso')}>Em uso {nUso}</button>
        <button className="chip" aria-pressed={filtro === 'pendentes'} onClick={() => setFiltro('pendentes')}><i className="h-2 w-2 rounded-full" style={{ background: COR_STATUS.atencao }} />A confirmar {nPend}</button>
        <button className="chip" aria-pressed={filtro === 'todas'} onClick={() => setFiltro('todas')}>Todas {culturas.length}</button>
      </>}>
      {novaAberta && <div className="mb-3"><EditorCultura c={null} erro={erro} salvando={salvar.isPending} aoFechar={() => { setErro(''); aoFecharNova(); }} aoSalvar={(v) => salvar.mutate(v)} /></div>}
      <div className="overflow-x-auto">
        <table className="tabela">
          <thead><tr><th>Cultivar</th><th>Kc por fase</th><th className="num">Raiz</th><th className="num">Fator p</th><th className="num">Kc médio</th><th className="num">Em uso</th><th>Parâmetros</th><th /></tr></thead>
          <tbody>
            {lista.map((c, k) => {
              const u = uso.get(c.id);
              if (editando === c.id && !novaAberta) {
                return <tr key={c.id}><td colSpan={8} className="!whitespace-normal !px-0 !py-2"><EditorCultura c={c} erro={erro} salvando={salvar.isPending} aoFechar={() => { setErro(''); setEditando(null); }} aoSalvar={(v) => salvar.mutate(v)} /></td></tr>;
              }
              return (
                <tr key={c.id} className="surge" style={{ animationDelay: `${Math.min(k, 12) * 25}ms` }}>
                  <td className="!whitespace-normal"><div className="font-medium">{c.nome}</div>{c.nome_cientifico && <div className="text-xs italic text-slate-500">{c.nome_cientifico}</div>}</td>
                  <td><FaixaKc fases={c.fases} /></td>
                  <td className="num">{fmt(c.prof_raiz_mm, 0)} <span className="text-xs text-slate-500">mm</span></td>
                  <td className="num">{fmt(c.fracao_agua_disponivel_p, 2)}</td>
                  <td className="num font-semibold" style={{ color: CIANO }}>{fmt(kcMedio(c), 2)}</td>
                  <td className="num">{u ? <span>{u.parcelas} <span className="text-xs text-slate-500">parc. · {fmt(u.area, 0)} ha</span></span> : <span className="text-xs text-slate-400">—</span>}</td>
                  <td><Selo ok={c.parametros_confirmados} /></td>
                  <td>{podeEditar && <button className="chip" onClick={() => { setErro(''); aoFecharNova(); setEditando(c.id); }}>editar</button>}</td>
                </tr>
              );
            })}
            {lista.length === 0 && <tr><td colSpan={8} className="text-sm text-slate-500">Nenhuma cultivar neste filtro.</td></tr>}
          </tbody>
        </table>
      </div>
    </Painel>
  );
}

/* ---------------- Pivôs ---------------- */
function CardPivo({ p, parcelas, culturas, podeEditar, atraso, aoMudar }: { p: Pivo; parcelas: ParcelaCad[]; culturas: Cultura[]; podeEditar: boolean; atraso: number; aoMudar: (m: string) => void }) {
  const [lam, setLam] = useState(String(p.lamina_volta_100_mm));
  const [horas, setHoras] = useState(String(p.horas_volta_100));
  const [vaz, setVaz] = useState(p.vazao_m3h != null ? String(p.vazao_m3h) : '');
  const [ef, setEf] = useState(String(Math.round(p.eficiencia * 100)));
  const [cult, setCult] = useState('');
  const [erro, setErro] = useState('');
  const mudou = num(lam) !== p.lamina_volta_100_mm || num(horas) !== p.horas_volta_100 || (vaz.trim() ? num(vaz) : null) !== p.vazao_m3h || num(ef) !== Math.round(p.eficiencia * 100);
  const salvar = useMutation({
    mutationFn: () => api(`/pivos/${p.id}`, { method: 'PUT', corpo: { lamina_volta_100_mm: num(lam), horas_volta_100: num(horas), vazao_m3h: vaz.trim() ? num(vaz) : null, eficiencia: num(ef) / 100 } }),
    onSuccess: () => { setErro(''); aoMudar(`${p.nome}: hidráulica salva e marcada como confirmada.`); },
    onError: (e: Error) => setErro(e.message),
  });
  const aplicar = useMutation({
    mutationFn: () => api<{ parcelas: number }>(`/pivos/${p.id}/cultivar`, { corpo: { cultura_id: Number(cult) } }),
    onSuccess: (r) => { setCult(''); aoMudar(`${p.nome}: cultivar aplicada a ${r.parcelas} parcela(s).`); },
    onError: (e: Error) => setErro(e.message),
  });
  const mmh = num(horas) > 0 ? num(lam) / num(horas) : 0;
  const resumoCult = useMemo(() => {
    const m = new Map<string, number>();
    parcelas.forEach((x) => m.set(x.cultura, (m.get(x.cultura) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [parcelas]);
  const cor = p.parametros_confirmados ? COR_STATUS.ok : COR_STATUS.atencao;

  return (
    <article className="vidro surge flex flex-col gap-3 p-4" style={{ animationDelay: `${atraso}ms` }}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: cor, boxShadow: `0 0 12px ${cor}` }} />
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-bold"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: cor, boxShadow: `0 0 8px ${cor}` }} />{p.nome}</h3>
          <p className="truncate text-xs text-slate-500">{fmt(p.area_ha)} ha · {parcelas.length} parcela{parcelas.length === 1 ? '' : 's'}{resumoCult.length > 0 && ` · ${resumoCult.slice(0, 2).map(([n, q]) => `${n} (${q})`).join(', ')}${resumoCult.length > 2 ? '…' : ''}`}</p>
        </div>
        <Selo ok={p.parametros_confirmados} textoPadrao="a confirmar" />
      </header>

      <div className="grid grid-cols-2 gap-2">
        <Campo rotulo="Lâmina/volta 100%" valor={lam} aoMudar={setLam} unidade="mm" disabled={!podeEditar} />
        <Campo rotulo="Horas/volta 100%" valor={horas} aoMudar={setHoras} unidade="h" disabled={!podeEditar} />
        <Campo rotulo="Vazão" valor={vaz} aoMudar={setVaz} unidade="m³/h" disabled={!podeEditar} />
        <Campo rotulo="Eficiência" valor={ef} aoMudar={setEf} unidade="%" disabled={!podeEditar} />
      </div>

      <div className="flex items-center gap-3 rounded-lg bg-slate-100/70 px-3 py-2 text-xs dark:bg-slate-800/60">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-700" aria-hidden>
          <div className="barra-h h-full rounded-full" style={{ width: `${Math.min(100, mmh * 24 * 4)}%`, background: CIANO, boxShadow: `0 0 8px ${CIANO}` }} />
        </div>
        <span className="tabular-nums text-slate-600 dark:text-slate-300">≈ <b style={{ color: CIANO }}>{fmt(mmh, 2)}</b> mm/h · <b style={{ color: CIANO }}>{fmt(mmh * 24)}</b> mm/dia a 100%</span>
      </div>

      {podeEditar && (
        <footer className="mt-auto flex flex-wrap items-center gap-2">
          <button className={mudou ? 'btn' : 'btn-sec'} disabled={salvar.isPending || !mudou} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Salvando…' : mudou ? 'Salvar hidráulica' : 'Sem alterações'}</button>
          <select className="campo !w-auto !py-1.5 ml-auto" aria-label={`Aplicar cultivar ao ${p.nome}`} value={cult} onChange={(e) => setCult(e.target.value)}>
            <option value="">Aplicar cultivar a todas…</option>
            {culturas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
          {cult && <button className="btn" disabled={aplicar.isPending} onClick={() => confirm(`Aplicar esta cultivar a TODAS as ${parcelas.length} parcelas do ${p.nome}?`) && aplicar.mutate()}>Aplicar</button>}
        </footer>
      )}
      {erro && <p role="alert" className="text-xs text-red-600">{erro}</p>}
    </article>
  );
}

/* ---------------- Parcelas ---------------- */
function LinhaParcela({ p, culturas, podeEditar, atraso, aoMudar }: { p: ParcelaCad; culturas: Cultura[]; podeEditar: boolean; atraso: number; aoMudar: () => void }) {
  const [ad, setAd] = useState(String(p.ad_mm_por_cm));
  const salvar = useMutation({ mutationFn: (corpo: object) => api(`/parcelas/${p.id}`, { method: 'PUT', corpo }), onSuccess: aoMudar });
  return (
    <tr className="surge" style={{ animationDelay: `${atraso}ms` }}>
      <td className="font-medium">{p.nome}</td>
      <td>
        <select className="campo !w-56 !py-1" aria-label={`Cultivar ${p.pivo} ${p.nome}`} value={p.cultura_id} disabled={!podeEditar || salvar.isPending} onChange={(e) => salvar.mutate({ cultura_id: Number(e.target.value) })}>
          {culturas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select>
      </td>
      <td className="num">{fmt(p.area_ha)}</td>
      <td className="num">
        <input className="campo !w-16 !py-1 text-right" aria-label={`Água do solo ${p.nome}`} inputMode="decimal" value={ad} disabled={!podeEditar} onChange={(e) => setAd(e.target.value)} onBlur={() => num(ad) !== p.ad_mm_por_cm && num(ad) > 0 && salvar.mutate({ ad_mm_por_cm: num(ad) })} />
      </td>
      <td><div className="flex items-center gap-2"><BarraSolo cap={p.cap_campo_mm} limite={p.lamina_seguranca_mm} /><span className="text-xs tabular-nums"><b className="text-sm">{fmt(p.lamina_seguranca_mm, 0)}</b> / {fmt(p.cap_campo_mm, 0)} mm</span></div></td>
      <td className="text-xs">{p.data_plantio ? dataBR(p.data_plantio) : <span className="text-slate-500">perene</span>}</td>
      <td>{salvar.isError && <span role="alert" className="text-xs text-red-600">{(salvar.error as Error).message}</span>}{salvar.isPending && <span className="text-xs text-slate-400">salvando…</span>}</td>
    </tr>
  );
}

/* ---------------- tela ---------------- */
export default function Cadastros({ fazenda, usuario }: { fazenda: Fazenda; usuario: Usuario }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cadastros', fazenda.id], queryFn: () => api<Dados>(`/fazendas/${fazenda.id}/cadastros`), placeholderData: (a) => a });
  const [busca, setBusca] = useState('');
  const [soPendentes, setSoPendentes] = useState(false);
  const [filtroPivo, setFiltroPivo] = useState<number | null>(null);
  const [novaCultivar, setNovaCultivar] = useState(false);
  const [msg, setMsg] = useAviso();
  const podeEditar = usuario.papel !== 'operador';
  const recarregar = (m = '') => { setMsg(m); qc.invalidateQueries({ queryKey: ['cadastros'] }); qc.invalidateQueries({ queryKey: ['preciso'] }); };
  const d = q.data;
  const qb = busca.trim().toLowerCase();

  const uso = useMemo(() => {
    const m = new Map<number, { parcelas: number; area: number }>();
    d?.parcelas.forEach((p) => { const u = m.get(p.cultura_id) ?? { parcelas: 0, area: 0 }; u.parcelas++; u.area += p.area_ha; m.set(p.cultura_id, u); });
    return m;
  }, [d]);
  const porPivo = useMemo(() => {
    const m = new Map<number, ParcelaCad[]>();
    d?.parcelas.forEach((p) => m.set(p.pivo_id, [...(m.get(p.pivo_id) ?? []), p]));
    return m;
  }, [d]);

  const pivos = useMemo(() => (d?.pivos ?? []).filter((p) => (!qb || p.nome.toLowerCase().includes(qb)) && (!soPendentes || !p.parametros_confirmados)), [d, qb, soPendentes]);
  const parcelas = useMemo(() => (d?.parcelas ?? []).filter((p) => (filtroPivo == null || p.pivo_id === filtroPivo) && (!qb || `${p.pivo} ${p.nome} ${p.cultura}`.toLowerCase().includes(qb))), [d, filtroPivo, qb]);
  const gruposParcelas = useMemo(() => (d?.pivos ?? []).map((pv) => ({ pivo: pv, itens: parcelas.filter((p) => p.pivo_id === pv.id) })).filter((g) => g.itens.length > 0), [d, parcelas]);

  const ir = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <div className="esqueleto h-20 rounded-2xl" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="esqueleto h-28 rounded-2xl" />)}</div>
        <div className="esqueleto h-72 rounded-2xl" />
      </div>
    );
  }
  if (!d) return <p role="alert" className="vidro p-4 text-sm text-red-600">{(q.error as Error)?.message ?? 'Erro ao carregar os cadastros'}</p>;

  const pivosPend = d.pivos.filter((p) => !p.parametros_confirmados).length;
  const cultUso = d.culturas.filter((c) => uso.has(c.id));
  const cultPend = cultUso.filter((c) => !c.parametros_confirmados).length;
  const areaTotal = d.parcelas.reduce((s, p) => s + p.area_ha, 0);
  const online = d.estacoes.filter((e) => e.online).length;
  const totalPend = pivosPend + cultPend;

  const destaques: { t: string; cor: string }[] = [];
  destaques.push(pivosPend ? { t: `${pivosPend} pivô${pivosPend > 1 ? 's' : ''} com hidráulica padrão (lâmina e horas por volta)`, cor: COR_STATUS.atencao } : { t: 'Hidráulica de todos os pivôs confirmada', cor: COR_STATUS.ok });
  destaques.push(cultPend ? { t: `${cultPend} cultivar${cultPend > 1 ? 'es' : ''} em uso com Kc, raiz e fator p padrão`, cor: COR_STATUS.atencao } : { t: 'Cultivares em uso com parâmetros confirmados', cor: COR_STATUS.ok });
  if (d.estacoes.length) destaques.push(online < d.estacoes.length ? { t: `${d.estacoes.length - online} estação${d.estacoes.length - online > 1 ? 'ões' : ''} sem comunicação`, cor: COR_STATUS.irrigar } : { t: `Estaç${d.estacoes.length > 1 ? 'ões' : 'ão'} meteorológica${d.estacoes.length > 1 ? 's' : ''} online`, cor: COR_STATUS.ok });

  return (
    <div className="viz space-y-4">
      {/* barra de comando */}
      <div className="vidro vidro-forte surge flex flex-wrap items-center gap-3 p-4">
        <div className="mr-auto">
          <h1 className="flex items-center gap-2 text-lg font-bold"><span className="ponto-vivo" aria-hidden /> Central de cadastros</h1>
          <p className="text-xs text-slate-500">{fazenda.nome} · {d.pivos.length} pivôs · {d.parcelas.length} parcelas · {fmt(areaTotal, 0)} ha irrigados</p>
        </div>
        <label className="relative">
          <span className="sr-only">Buscar pivô, parcela ou cultivar</span>
          <input className="campo !w-56 !py-1.5 pl-8" placeholder="Buscar pivô, parcela, cultivar…" value={busca} onChange={(e) => setBusca(e.target.value)} />
          <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">⌕</span>
        </label>
        <button className="chip" aria-pressed={soPendentes} onClick={() => setSoPendentes(!soPendentes)}><i className="h-2 w-2 rounded-full" style={{ background: COR_STATUS.atencao }} />Só a confirmar {totalPend}</button>
        {podeEditar && <button className="btn" onClick={() => { setNovaCultivar(true); ir('cultivares'); }}>+ Nova cultivar</button>}
      </div>

      {!podeEditar && <p className="text-sm text-slate-500">Seu perfil é de operador: os cadastros são somente leitura.</p>}

      {/* destaques */}
      <div className="flex flex-wrap gap-2 surge">
        {destaques.map((x) => (
          <span key={x.t} className="inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 text-xs font-medium backdrop-blur dark:border-slate-700 dark:bg-slate-900/50">
            <i className="h-2 w-2 rounded-full" style={{ background: x.cor, boxShadow: `0 0 8px ${x.cor}` }} />{x.t}
          </span>
        ))}
      </div>

      {/* indicadores */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi atraso={40} rotulo="Pivôs" valor={d.pivos.length} sub={pivosPend ? `${d.pivos.length - pivosPend} com hidráulica confirmada` : 'hidráulica confirmada'} cor={pivosPend ? COR_STATUS.atencao : COR_STATUS.ok} progresso={d.pivos.length ? (d.pivos.length - pivosPend) / d.pivos.length : 0} aoClicar={() => ir('pivos')} />
        <Kpi atraso={80} rotulo="Cultivares" valor={d.culturas.length} sub={`${cultUso.length} em uso · ${cultPend} a confirmar`} cor={cultPend ? COR_STATUS.atencao : COR_STATUS.ok} progresso={cultUso.length ? (cultUso.length - cultPend) / cultUso.length : 0} aoClicar={() => ir('cultivares')} />
        <Kpi atraso={120} rotulo="Parcelas" valor={d.parcelas.length} unidade={`· ${fmt(areaTotal, 0)} ha`} sub="cultivar e solo por parcela" cor={CIANO} aoClicar={() => ir('parcelas')} />
        <Kpi atraso={160} rotulo="Estações" valor={online} unidade={`de ${d.estacoes.length}`} sub="online agora" cor={d.estacoes.length && online < d.estacoes.length ? COR_STATUS.irrigar : ROXO} progresso={d.estacoes.length ? online / d.estacoes.length : 0} aoClicar={() => ir('estacoes')} />
      </div>

      {/* pivôs */}
      <Painel id="pivos" atraso={160} titulo={`Pivôs · ${pivos.length}${pivos.length !== d.pivos.length ? ` de ${d.pivos.length}` : ''}`} sub="Lâmina e horas por volta a 100% definem o tempo de cada irrigação. Salvar marca a hidráulica como confirmada.">
        {pivos.length === 0 ? <p className="text-sm text-slate-500">Nenhum pivô neste filtro.</p> : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {pivos.map((p, k) => <CardPivo key={`${p.id}-${p.parametros_confirmados}-${p.lamina_volta_100_mm}-${p.horas_volta_100}-${p.vazao_m3h}-${p.eficiencia}`} p={p} parcelas={porPivo.get(p.id) ?? []} culturas={d.culturas} podeEditar={podeEditar} atraso={Math.min(k, 9) * 40} aoMudar={recarregar} />)}
          </div>
        )}
      </Painel>

      <Cultivares culturas={d.culturas} uso={uso} busca={qb} soPendentes={soPendentes} podeEditar={podeEditar} novaAberta={novaCultivar} aoFecharNova={() => setNovaCultivar(false)} aoMudar={recarregar} />

      {/* parcelas */}
      <Painel id="parcelas" atraso={240} titulo={`Parcelas e cultivar · ${parcelas.length}${parcelas.length !== d.parcelas.length ? ` de ${d.parcelas.length}` : ''}`} sub="Barra = capacidade de água da parcela; faixa vermelha = abaixo do limite de segurança, onde o pivô precisa irrigar.">
        <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filtrar parcelas por pivô">
          <button className="chip shrink-0" aria-pressed={filtroPivo == null} onClick={() => setFiltroPivo(null)}>Todos {d.parcelas.length}</button>
          {d.pivos.map((p) => <button key={p.id} className="chip shrink-0" aria-pressed={filtroPivo === p.id} onClick={() => setFiltroPivo(filtroPivo === p.id ? null : p.id)}>{p.nome} <span className="opacity-60">{porPivo.get(p.id)?.length ?? 0}</span></button>)}
        </div>
        <div className="overflow-x-auto lg:max-h-[36rem] lg:overflow-y-auto">
          <table className="tabela">
            <thead className="sticky top-0 z-10 bg-white/90 backdrop-blur dark:bg-slate-900/90"><tr><th>Parcela</th><th>Cultivar</th><th className="num">Área (ha)</th><th className="num">Solo (mm/cm)</th><th>Limite / capacidade</th><th>Plantio</th><th /></tr></thead>
            <tbody>
              {gruposParcelas.map((g, gi) => (
                <GrupoParcelas key={g.pivo.id} g={g} culturas={d.culturas} podeEditar={podeEditar} atrasoBase={Math.min(gi, 6) * 40} aoMudar={() => recarregar('Parcela atualizada · capacidade e limite recalculados pela cultivar.')} />
              ))}
              {gruposParcelas.length === 0 && <tr><td colSpan={7} className="text-sm text-slate-500">Nenhuma parcela neste filtro.</td></tr>}
            </tbody>
          </table>
        </div>
      </Painel>

      {/* estações */}
      <Painel id="estacoes" atraso={280} titulo={`Estações meteorológicas · ${d.estacoes.length}`} sub="Leitura atual pelo WeatherLink. A integração é configurada na aba Clima.">
        {d.estacoes.length === 0 ? <p className="text-sm text-slate-500">Nenhuma estação cadastrada.</p> : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {d.estacoes.map((e, k) => {
              const cor = e.online ? COR_STATUS.ok : COR_STATUS.irrigar;
              return (
                <article key={e.id} className="vidro surge flex items-center gap-3 p-4" style={{ animationDelay: `${k * 50}ms` }}>
                  <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full" style={{ background: `${cor}22` }}>
                    {e.online && <span className="absolute inset-0 rounded-full" style={{ background: `${cor}33`, animation: 'onda 2.2s ease-out infinite' }} />}
                    <i className="h-3 w-3 rounded-full" style={{ background: cor, boxShadow: `0 0 10px ${cor}` }} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{e.nome}</h3>
                    <p className="text-xs text-slate-500">{e.tipo} · <span style={{ color: cor }}>{e.online ? 'online' : 'offline'}</span>{e.ultima_leitura_em ? ` · leitura ${haQuanto(e.ultima_leitura_em)}` : ''}</p>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Painel>

      {msg && (
        <div role="status" className="surge fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-emerald-400/40 bg-white/90 px-4 py-2 text-sm font-medium text-emerald-700 shadow-lg backdrop-blur dark:bg-slate-900/90 dark:text-emerald-300">
          ✔ {msg}
        </div>
      )}
    </div>
  );
}

function GrupoParcelas({ g, culturas, podeEditar, atrasoBase, aoMudar }: { g: { pivo: Pivo; itens: ParcelaCad[] }; culturas: Cultura[]; podeEditar: boolean; atrasoBase: number; aoMudar: () => void }) {
  const area = g.itens.reduce((s, p) => s + p.area_ha, 0);
  return (
    <>
      <tr className="bg-slate-100/70 dark:bg-slate-800/60">
        <td colSpan={7} className="!py-1.5 text-xs font-semibold uppercase tracking-[.12em] text-slate-600 dark:text-slate-300">
          <span className="inline-block h-2 w-2 rounded-full align-middle" style={{ background: CIANO, boxShadow: `0 0 6px ${CIANO}` }} /> {g.pivo.nome} <span className="font-normal normal-case tracking-normal text-slate-500">· {g.itens.length} parcela{g.itens.length === 1 ? '' : 's'} · {fmt(area)} ha</span>
        </td>
      </tr>
      {g.itens.map((p, k) => <LinhaParcela key={`${p.id}-${p.cultura_id}-${p.cap_campo_mm}`} p={p} culturas={culturas} podeEditar={podeEditar} atraso={atrasoBase + Math.min(k, 8) * 20} aoMudar={aoMudar} />)}
    </>
  );
}
