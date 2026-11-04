import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { api, dataBR, fmt, hhmm, percentimetro } from '../api';
import { statusDoDia } from '../cores';
import { Medidor, Spark } from '../graficos';
import { haQuanto, usePreciso, useTelemetria } from '../hooks';
import { agruparPorPivo, aplicacaoNaVolta, type Pivo } from '../pivos';
import { COR_STATUS, COR_TEL, ROTULO_STATUS, type Fazenda, type ItemOrdem, type Ordem, type PivoTel, type Previsao, type Status, type Usuario } from '../tipos';
import { Numero } from '../ui';

export function Selo({ status }: { status: Status }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium text-white" style={{ background: COR_STATUS[status] }}>
      {ROTULO_STATUS[status]}
    </span>
  );
}

const CHUVA = 'var(--s-chuva)';
const ETO = 'var(--s-eto)';
const CIANO_REPOR = '#0891b2';
const PESO: Record<Status, number> = { irrigar: 0, atencao: 1, ok: 2 };

/** Data ISO somada de `n` dias (projecao[0] é hoje, então o dia k da reposição é hoje + k). */
const diaMais = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Em quantos dias (1..n) a lâmina projetada cai abaixo do limite; null = não cai dentro da projeção. */
const diasAteLimite = (p: Pivo) => { const i = p.projecao.findIndex((d) => d.laminaMm < p.limiteMm); return i < 0 ? null : i + 1; };

/* ---------------- peças visuais ---------------- */
function Painel({ titulo, sub, extra, atraso = 0, className = '', children }: { titulo: string; sub?: string; extra?: ReactNode; atraso?: number; className?: string; children: ReactNode }) {
  return (
    <section className={`vidro surge p-4 ${className}`} style={{ animationDelay: `${atraso}ms` }}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="titulo-secao">{titulo}</h2>{sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}</div>
        {extra && <div className="flex flex-wrap items-center gap-2">{extra}</div>}
      </header>
      {children}
    </section>
  );
}

function Kpi({ rotulo, valor, casas = 0, unidade, sub, cor, serie, atraso, ativo, aoClicar }: { rotulo: string; valor: number; casas?: number; unidade?: string; sub?: string; cor: string; serie?: number[]; atraso: number; ativo?: boolean; aoClicar?: () => void }) {
  const Tag = aoClicar ? 'button' : 'div';
  return (
    <Tag type={aoClicar ? 'button' : undefined} onClick={aoClicar} aria-pressed={aoClicar ? ativo : undefined} className={`vidro vidro-forte surge p-4 text-left ${aoClicar ? 'transition hover:-translate-y-0.5' : ''}`} style={{ animationDelay: `${atraso}ms`, ['--cor' as string]: cor, outline: ativo ? `2px solid ${cor}` : undefined } as CSSProperties}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: cor, boxShadow: `0 0 16px ${cor}` }} />
      <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-slate-500 dark:text-slate-400">{rotulo}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="num-grande text-3xl sm:text-4xl" style={{ color: cor }}><Numero valor={valor} casas={casas} /></span>
        {unidade && <span className="text-sm text-slate-500">{unidade}</span>}
      </div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
      {serie && <div className="mt-2"><Spark valores={serie} cor={cor} /></div>}
    </Tag>
  );
}

/** Previsão dos próximos dias: chuva (barra), probabilidade, temperaturas e ETo. */
function FaixaPrevisao({ previsao }: { previsao: Previsao[] }) {
  const max = Math.max(1, ...previsao.map((p) => p.chuvaMm));
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {previsao.map((p, i) => (
        <div key={p.data} className="surge flex min-w-[5.5rem] flex-1 flex-col items-center rounded-xl bg-slate-100/70 px-2 py-2 text-center dark:bg-slate-800/60" style={{ animationDelay: `${i * 40}ms` }}>
          <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">{dataBR(p.data)}</div>
          <div className="my-1 flex h-10 w-full items-end justify-center" aria-hidden>
            <div className="barra-v w-5 rounded-t" style={{ height: `${Math.max(3, (p.chuvaMm / max) * 40)}px`, background: p.chuvaMm > 0 ? CHUVA : 'rgb(148 163 184 / .35)', boxShadow: p.chuvaMm > 0 ? `0 0 8px ${CHUVA}` : undefined, animationDelay: `${i * 60}ms` }} />
          </div>
          <div className="text-sm font-semibold tabular-nums" style={{ color: p.chuvaMm > 0 ? CHUVA : undefined }}>{p.chuvaMm > 0 ? `${fmt(p.chuvaMm, 0)} mm` : '—'}</div>
          <div className="text-[10px] text-slate-500">{p.chuvaProb != null ? `${fmt(p.chuvaProb, 0)}% chance` : 'sem chuva'}</div>
          <div className="mt-1 text-[10px] text-slate-500">{p.tmin != null && p.tmax != null ? `${fmt(p.tmin, 0)}–${fmt(p.tmax, 0)} °C · ` : ''}ETo {fmt(p.etoMm)}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- seleção para a ordem de irrigação ---------------- */
/** Estado do pivô na montagem da ordem: selecionado (com a lâmina digitada) e o que já está na ordem de hoje. */
export interface SelOrdem {
  podeMontar: boolean;
  lamina: string | undefined; // undefined = fora da seleção
  naOrdem: ItemOrdem['status'] | undefined;
  aoAlternar: () => void;
  aoLamina: (v: string) => void;
}

const numero = (v: string) => Number(v.replace(',', '.'));
/** Lâmina bruta sugerida: a recomendada ou, se o balanço não pede, uma volta a 100 %. */
export const laminaPadrao = (p: Pivo) => (p.recomendaIrrigar && p.itnBrutaMm > 0 ? p.itnBrutaMm : p.hidraulica?.laminaVoltaMm ?? 5);
const travado = (s: ItemOrdem['status'] | undefined) => s === 'enviada' || s === 'concluida';

function ChipOrdem({ p, sel }: { p: Pivo; sel: SelOrdem }) {
  if (travado(sel.naOrdem)) {
    return <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-200">{sel.naOrdem === 'enviada' ? 'Enviado' : 'Concluído'} hoje</span>;
  }
  return (
    <>
      {p.recomendaIrrigar && <span className="rounded-full border border-cyan-500/50 px-2 py-0.5 text-[11px] font-medium text-cyan-700 dark:text-cyan-300" title="O balanço pede reposição hoje">Sugerido</span>}
      {sel.podeMontar ? (
        <button
          type="button"
          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition ${sel.lamina != null ? 'border-cyan-600 bg-cyan-600 text-white' : 'border-slate-300 text-slate-600 hover:border-cyan-500 hover:text-cyan-700 dark:border-slate-600 dark:text-slate-300'}`}
          aria-pressed={sel.lamina != null}
          onClick={sel.aoAlternar}
          title={sel.lamina != null ? 'Tirar da ordem de irrigação' : 'Colocar na ordem de irrigação'}
        >
          {sel.lamina != null ? '✓ Na ordem' : '+ Ordem'}
        </button>
      ) : sel.naOrdem === 'planejada' ? <span className="rounded-full bg-cyan-600 px-2 py-0.5 text-[11px] font-semibold text-white">Na ordem</span> : null}
    </>
  );
}

function LaminaOrdem({ p, sel }: { p: Pivo; sel: SelOrdem }) {
  if (sel.lamina == null || !sel.podeMontar || travado(sel.naOrdem)) return null;
  const mm = numero(sel.lamina);
  const ok = Number.isFinite(mm) && mm >= 0.5 && mm <= 80;
  const a = ok && p.hidraulica ? aplicacaoNaVolta(mm, p.hidraulica.laminaVoltaMm, p.hidraulica.horasVolta) : null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-cyan-600/40 bg-cyan-500/5 px-3 py-2 text-sm">
      <label className="flex items-center gap-1.5">
        <span className="text-xs text-slate-500">Lâmina a aplicar</span>
        <input className="campo !w-20 !py-1 text-right tabular-nums" inputMode="decimal" aria-label={`Lâmina bruta para ${p.nome}`} value={sel.lamina} onChange={(e) => sel.aoLamina(e.target.value)} />
        <span className="text-xs text-slate-500">mm</span>
      </label>
      {a ? (
        <span className="text-xs text-slate-600 dark:text-slate-300">
          pivô a <b className="tabular-nums">{fmt(a.percentual, 0)}%</b> · uma volta de <b className="tabular-nums">{hhmm(a.duracaoMin)} h</b>
          {a.laminaAplicadaMm > mm + 0.05 && <span className="text-amber-600"> · abaixo de uma volta a 100 %: aplica {fmt(a.laminaAplicadaMm)} mm</span>}
        </span>
      ) : (
        <span className="text-xs text-red-600">{ok ? 'sem hidráulica cadastrada' : 'use de 0,5 a 80 mm'}</span>
      )}
      {!p.recomendaIrrigar && <span className="w-full text-[11px] text-amber-600">O balanço não pede reposição hoje: entra na ordem por escolha sua.</span>}
    </div>
  );
}

/* ---------------- card de um pivô ---------------- */
function CardPivo({ p, tel, atraso, aoVerNoMapa, sel }: { p: Pivo; tel: PivoTel | undefined; atraso: number; aoVerNoMapa: () => void; sel: SelOrdem }) {
  const cor = COR_STATUS[p.status];
  const folga = p.laminaMm - p.limiteMm;
  const dias = diasAteLimite(p);
  const max = Math.max(...p.projecao.map((d) => d.laminaMm), p.capMm);
  const chuva = p.projecao.reduce((s, d) => s + d.chuvaMm, 0);
  return (
    <article className="vidro surge flex flex-col gap-3 p-4" style={{ animationDelay: `${atraso}ms` }}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: cor, boxShadow: `0 0 12px ${cor}` }} />
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-bold">{p.nome}<Selo status={p.status} /><ChipOrdem p={p} sel={sel} /></h3>
          <p className="truncate text-xs text-slate-500">{fmt(p.areaHa, 0)} ha · {p.parcelas.length} parcela{p.parcelas.length > 1 ? 's' : ''} · {p.culturas[0]}{p.culturas.length > 1 ? ` +${p.culturas.length - 1}` : ''}</p>
          {tel && (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs" title={`Telemetria: ${tel.statusTxt} (${haQuanto(tel.atualizadoEm)})`}>
              <i className={`h-2 w-2 rounded-full ${tel.categoria === 'irrigando' || tel.categoria === 'alarme' ? 'animate-pulse' : ''}`} style={{ background: COR_TEL[tel.categoria], boxShadow: `0 0 6px ${COR_TEL[tel.categoria]}` }} />
              <span style={{ color: COR_TEL[tel.categoria] }}>{tel.statusTxt}{tel.categoria === 'irrigando' && tel.percentual != null ? ` · ${fmt(tel.percentual, 0)}%` : ''}</span>
              <span className="text-slate-400">{haQuanto(tel.atualizadoEm)}</span>
            </p>
          )}
        </div>
        <div className="text-right">
          <div className="num-grande text-2xl" style={{ color: cor }}>{fmt(p.laminaMm, 0)}<span className="text-xs font-normal text-slate-500"> / {fmt(p.capMm, 0)} mm</span></div>
          <div className="text-[11px] text-slate-500">{folga >= 0 ? `${fmt(folga, 0)} mm acima do limite` : `${fmt(-folga, 0)} mm abaixo do limite`}</div>
        </div>
      </header>

      <Medidor lamina={p.laminaMm} limite={p.limiteMm} cap={p.capMm} status={p.status} />

      {p.recomendaIrrigar ? (
        <div className="rounded-xl border border-red-400/50 bg-red-500/10 px-3 py-2 text-sm" title="Repõe o que falta até a capacidade de campo quando passa de um dia de consumo (regra do iCrop)">
          Irrigar hoje: repor <b className="tabular-nums">{fmt(p.itnMm, 0)} mm</b> · pivô a <b className="tabular-nums">{fmt(percentimetro(p.percentualVolta), 0)}%</b> · cerca de <b className="tabular-nums">{hhmm(p.tempoMin)} h</b>
          {p.abaixoLimite && <div className="mt-1 text-xs font-semibold text-red-600">Abaixo do limite de segurança: risco de estresse.</div>}
        </div>
      ) : p.diasAteRepor != null ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${p.diasAteRepor <= 1 ? 'border-amber-400/50 bg-amber-500/10' : 'border-slate-300/60 bg-slate-100/60 dark:border-slate-600 dark:bg-slate-800/60'}`}>
          Sem reposição hoje. Precisa de reposição <b>{p.diasAteRepor <= 1 ? 'amanhã' : `em ${p.diasAteRepor} dias`}</b> ({dataBR(diaMais(p.projecao[0].data, p.diasAteRepor))}) se não irrigar{chuva > 0 ? `, já contando ${fmt(chuva, 0)} mm de chuva prevista` : ''}.
          {dias != null && <div className="mt-0.5 text-xs text-slate-500">Chega ao limite de segurança em {dias} dia{dias > 1 ? 's' : ''}.</div>}
        </div>
      ) : (
        <div className="rounded-xl border border-emerald-400/50 bg-emerald-500/10 px-3 py-2 text-sm">Sem reposição nos próximos {p.projecao.length} dias{chuva > 0 ? ` (com ${fmt(chuva, 0)} mm de chuva prevista)` : ''}.</div>
      )}
      {!p.abaixoLimite && p.parcelasAbaixo > 0 && <p className="text-xs text-red-600">{p.parcelasAbaixo} de {p.parcelas.length} parcelas já abaixo do limite de segurança.</p>}
      <LaminaOrdem p={p} sel={sel} />

      <div>
        <div className="flex h-16 items-end gap-1" aria-label="Projeção da lâmina sem irrigar">
          {p.projecao.map((d, i) => {
            const s = statusDoDia(p.repor, i + 1);
            return (
              <div key={d.data} className="flex flex-1 flex-col items-center justify-end gap-0.5" title={`${dataBR(d.data)} — lâmina ${fmt(d.laminaMm)} mm, ETc ${fmt(d.etcMm)} mm${d.chuvaMm ? `, chuva ${fmt(d.chuvaMm)} mm` : ''}`}>
                <span className="text-[9px] tabular-nums text-slate-500">{fmt(d.laminaMm, 0)}</span>
                <div className="barra-v w-full rounded-t" style={{ height: `${Math.max(3, (d.laminaMm / max) * 40)}px`, background: COR_STATUS[s], animationDelay: `${i * 50}ms` }} />
                <span className="text-[9px] text-slate-500">{dataBR(d.data).slice(0, 5)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <footer className="mt-auto flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">Limite {fmt(p.limiteMm, 0)} mm{p.ultimaIrrigacao ? ` · última irrigação ${dataBR(p.ultimaIrrigacao)}` : ''}</span>
        <button className="chip" onClick={aoVerNoMapa}>⌖ Ver no mapa</button>
      </footer>
    </article>
  );
}

/* ---------------- tela ---------------- */
export default function Preciso({ fazenda, aoVerNoMapa, usuario, aoIrParaOrdem }: { fazenda: Fazenda; aoVerNoMapa: (parcelaId: number) => void; usuario?: Usuario; aoIrParaOrdem?: () => void }) {
  const [comChuva, setComChuva] = useState(true);
  const [filtro, setFiltro] = useState<Status | null>(null);
  const [visao, setVisao] = useState<'cards' | 'tabela'>('cards');
  const q = usePreciso(fazenda.id, comChuva);
  const telemetria = useTelemetria(fazenda.id).data?.pivos;
  const telPorPivo = useMemo(() => new Map((telemetria ?? []).filter((t) => t.pivoId != null).map((t) => [t.pivoId!, t])), [telemetria]);
  const pivos = useMemo(() => [...agruparPorPivo(q.data?.parcelas ?? [])].sort((a, b) => PESO[a.status] - PESO[b.status] || (a.laminaMm - a.limiteMm) - (b.laminaMm - b.limiteMm)), [q.data]);

  // ---- montagem da ordem de irrigação a partir daqui (sugestões já marcadas; o gestor ajusta e envia) ----
  const qc = useQueryClient();
  const podeMontar = !!usuario && usuario.papel !== 'operador';
  const ordem = useQuery({ queryKey: ['ordem', fazenda.id], queryFn: () => api<Ordem>(`/fazendas/${fazenda.id}/ordem`), refetchInterval: 60_000, placeholderData: (a) => a });
  const statusOrdem = useMemo(() => new Map((ordem.data?.itens ?? []).map((i) => [i.pivoId, i.status])), [ordem.data]);
  const [selecao, setSelecao] = useState<Record<number, string> | null>(null);
  const [alterada, setAlterada] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  useEffect(() => {
    if (selecao != null || !q.data || !ordem.data) return;
    // começa pelo que já está na ordem de hoje; se não há nada, pelas sugestões do balanço
    const ativos = ordem.data.itens.filter((i) => i.status === 'planejada' || i.status === 'enviada');
    const ini: Record<number, string> = {};
    if (ativos.length) for (const i of ativos) ini[i.pivoId] = fmt(i.laminaMm ?? 0, 1);
    else for (const p of pivos) if (p.recomendaIrrigar) ini[p.pivoId] = fmt(laminaPadrao(p), 1);
    setSelecao(ini);
  }, [selecao, q.data, ordem.data, pivos]);
  const sel = selecao ?? {};
  const mexer = (f: (s: Record<number, string>) => Record<number, string>) => { setSelecao((s) => f({ ...(s ?? {}) })); setAlterada(true); setAviso(null); };
  const alternar = (p: Pivo) => mexer((s) => { if (s[p.pivoId] != null) delete s[p.pivoId]; else s[p.pivoId] = fmt(laminaPadrao(p), 1); return s; });
  const marcarSugeridos = () => mexer((s) => { for (const p of pivos) if (p.recomendaIrrigar && s[p.pivoId] == null && !travado(statusOrdem.get(p.pivoId))) s[p.pivoId] = fmt(laminaPadrao(p), 1); return s; });
  const selOf = (p: Pivo): SelOrdem => ({
    podeMontar, lamina: sel[p.pivoId], naOrdem: statusOrdem.get(p.pivoId),
    aoAlternar: () => alternar(p), aoLamina: (v) => mexer((s) => ({ ...s, [p.pivoId]: v })),
  });
  const escolhidos = pivos.filter((p) => sel[p.pivoId] != null && !travado(statusOrdem.get(p.pivoId)));
  const invalidos = escolhidos.filter((p) => { const v = numero(sel[p.pivoId]!); return !(Number.isFinite(v) && v >= 0.5 && v <= 80); });
  const horasSel = escolhidos.reduce((s, p) => { const v = numero(sel[p.pivoId]!); return s + (p.hidraulica && Number.isFinite(v) ? aplicacaoNaVolta(v, p.hidraulica.laminaVoltaMm, p.hidraulica.horasVolta).duracaoMin : 0); }, 0) / 60;
  const sugeridosFora = pivos.filter((p) => p.recomendaIrrigar && sel[p.pivoId] == null && !travado(statusOrdem.get(p.pivoId))).length;
  const enviar = useMutation({
    mutationFn: () => api<Ordem>(`/fazendas/${fazenda.id}/ordem/montar`, { corpo: { itens: escolhidos.map((p) => ({ pivoId: p.pivoId, laminaMm: numero(sel[p.pivoId]!) })) } }),
    onSuccess: (d) => {
      qc.setQueryData(['ordem', fazenda.id], d);
      setAlterada(false);
      const n = d.itens.filter((i) => i.status === 'planejada').length;
      setAviso(n ? `Ordem de hoje atualizada: ${n} pivô${n > 1 ? 's' : ''} planejado${n > 1 ? 's' : ''}.` : 'Ordem de hoje sem pivôs planejados.');
    },
    onError: (e) => setAviso(`Não foi possível enviar: ${(e as Error).message}`),
  });

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <div className="esqueleto h-20 rounded-2xl" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="esqueleto h-28 rounded-2xl" />)}</div>
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="esqueleto h-72 rounded-2xl" />)}</div>
      </div>
    );
  }
  if (q.error || !q.data) return <p role="alert" className="vidro p-4 text-sm text-red-600">Não foi possível carregar: {(q.error as Error)?.message}</p>;
  const r = q.data;
  const conta = (s: Status) => pivos.filter((p) => p.status === s).length;
  const areaIrrigar = pivos.filter((p) => p.status === 'irrigar').reduce((s, p) => s + p.areaHa, 0);
  const lista = pivos.filter((p) => !filtro || p.status === filtro);
  const chuvaPrev = r.previsao.reduce((s, p) => s + p.chuvaMm, 0);
  // situação do dia como no iCrop: irrigar = reposição hoje; atenção = amanhã; o limite de segurança mede o estresse
  const repor = pivos.filter((p) => p.recomendaIrrigar);
  const horasIrrigar = repor.reduce((s, p) => s + p.tempoMin, 0) / 60;
  const amanha = pivos.filter((p) => p.status === 'atencao');
  const abaixo = pivos.filter((p) => p.abaixoLimite);
  const nomes = (l: Pivo[]) => `${l.slice(0, 3).map((p) => p.nome).join(', ')}${l.length > 3 ? '…' : ''}`;

  const destaques: { t: string; cor: string }[] = [];
  destaques.push(repor.length ? { t: `${repor.length} pivô${repor.length > 1 ? 's' : ''} para irrigar hoje · ${fmt(areaIrrigar, 0)} ha · ~${fmt(horasIrrigar, 0)} h de pivô`, cor: COR_STATUS.irrigar } : { t: 'Nenhum pivô precisa irrigar hoje', cor: COR_STATUS.ok });
  if (amanha.length) destaques.push({ t: `${amanha.length} pivô${amanha.length > 1 ? 's' : ''} precisa${amanha.length > 1 ? 'm' : ''} de reposição amanhã: ${nomes(amanha)}`, cor: COR_STATUS.atencao });
  destaques.push(abaixo.length ? { t: `${abaixo.length} pivô${abaixo.length > 1 ? 's' : ''} abaixo do limite de segurança (estresse): ${nomes(abaixo)}`, cor: COR_STATUS.irrigar } : { t: 'Nenhum pivô abaixo do limite de segurança', cor: CIANO_REPOR });
  if (r.previsao.length) destaques.push(chuvaPrev > 0 ? { t: `${fmt(chuvaPrev, 0)} mm de chuva prevista nos próximos ${r.previsao.length} dias${comChuva ? ' (já contada)' : ' (ignorada: pior caso)'}`, cor: CHUVA } : { t: `Sem chuva prevista nos próximos ${r.previsao.length} dias`, cor: ETO });

  return (
    <div className={`viz space-y-4 ${podeMontar ? 'pb-24' : ''}`}>
      {/* barra de comando */}
      <div className="vidro vidro-forte surge flex flex-wrap items-center gap-3 p-4">
        <div className="mr-auto">
          <h1 className="flex items-center gap-2 text-lg font-bold"><span className="ponto-vivo" aria-hidden /> Preciso irrigar?</h1>
          <p className="text-xs text-slate-500">
            {fazenda.nome} · {dataBR(r.data)} · situação ao amanhecer, lâmina média do pivô ponderada pela área
            {r.climaHoje && <> · clima ({r.climaHoje.origem}): ETo {fmt(r.climaHoje.etoMm)} mm, chuva {fmt(r.climaHoje.chuvaMm)} mm{r.climaHoje.tmax != null ? `, ${fmt(r.climaHoje.tmin, 0)}–${fmt(r.climaHoje.tmax, 0)} °C` : ''}</>}
            {q.dataUpdatedAt ? ` · atualizado ${haQuanto(new Date(q.dataUpdatedAt).toISOString())}` : ''}
          </p>
        </div>
        <button className="chip" aria-pressed={comChuva} onClick={() => setComChuva(!comChuva)} title={comChuva ? 'Somando a chuva prevista' : 'Ignorando a chuva prevista (pior caso)'}>☂ E se chover?</button>
        <div className="flex items-center gap-1.5" role="group" aria-label="Forma de ver">
          <button className="chip" aria-pressed={visao === 'cards'} onClick={() => setVisao('cards')}>Cards</button>
          <button className="chip" aria-pressed={visao === 'tabela'} onClick={() => setVisao('tabela')}>Tabela</button>
        </div>
      </div>

      {/* destaques */}
      <div className="flex flex-wrap gap-2 surge" style={{ animationDelay: '40ms' }}>
        {destaques.map((x) => (
          <span key={x.t} className="inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 text-xs font-medium backdrop-blur dark:border-slate-700 dark:bg-slate-900/50">
            <i className="h-2 w-2 rounded-full" style={{ background: x.cor, boxShadow: `0 0 8px ${x.cor}` }} />{x.t}
          </span>
        ))}
      </div>

      {/* indicadores: também filtram */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi atraso={60} rotulo="Irrigar" valor={conta('irrigar')} unidade={`de ${pivos.length}`} sub={`${fmt(areaIrrigar, 0)} ha com reposição hoje`} cor={COR_STATUS.irrigar} ativo={filtro === 'irrigar'} aoClicar={() => setFiltro(filtro === 'irrigar' ? null : 'irrigar')} />
        <Kpi atraso={100} rotulo="Atenção" valor={conta('atencao')} unidade="pivôs" sub="reposição amanhã" cor={COR_STATUS.atencao} ativo={filtro === 'atencao'} aoClicar={() => setFiltro(filtro === 'atencao' ? null : 'atencao')} />
        <Kpi atraso={140} rotulo="Ok" valor={conta('ok')} unidade="pivôs" sub="sem reposição hoje nem amanhã" cor={COR_STATUS.ok} ativo={filtro === 'ok'} aoClicar={() => setFiltro(filtro === 'ok' ? null : 'ok')} />
        <Kpi atraso={180} rotulo="Chuva prevista" valor={chuvaPrev} casas={0} unidade="mm" sub={`próximos ${r.previsao.length} dias`} cor={CHUVA} serie={r.previsao.map((p) => p.chuvaMm)} />
        <div className="col-span-2 lg:col-span-1"><Kpi atraso={220} rotulo="ETo hoje" valor={r.climaHoje?.etoMm ?? 0} casas={1} unidade="mm" sub={r.climaHoje ? `consumo de referência · ${r.climaHoje.origem}` : 'sem leitura de clima'} cor={ETO} serie={r.previsao.map((p) => p.etoMm)} /></div>
      </div>

      {r.previsao.length > 0 && (
        <Painel atraso={240} titulo="Previsão dos próximos dias" sub={`Chuva, chance de chuva, temperaturas e ETo. ${comChuva ? 'A chuva está sendo somada ao balanço.' : 'A chuva está sendo ignorada (pior caso).'}`}>
          <FaixaPrevisao previsao={r.previsao} />
        </Painel>
      )}

      <Painel atraso={280} titulo={`Pivôs · ${lista.length}${lista.length !== pivos.length ? ` de ${pivos.length}` : ''}`} sub="Do mais urgente ao mais folgado. Vermelho = irrigar hoje; amarelo = reposição amanhã; verde = nem amanhã. Marca preta = limite de segurança (abaixo dela há risco de estresse). Barras = lâmina ao fim de cada dia sem irrigar."
        extra={filtro ? <button className="chip" aria-pressed onClick={() => setFiltro(null)}><i className="h-2 w-2 rounded-full" style={{ background: COR_STATUS[filtro] }} />{ROTULO_STATUS[filtro]} ✕</button> : undefined}>
        {lista.length === 0 ? <p className="text-sm text-slate-500">Nenhum pivô neste filtro.</p> : visao === 'cards' ? (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {lista.map((p, k) => <CardPivo key={p.nome} p={p} tel={telPorPivo.get(p.parcelas[0].pivoId)} atraso={Math.min(k, 9) * 40} aoVerNoMapa={() => aoVerNoMapa(p.parcelas[0].id)} sel={selOf(p)} />)}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead>
                <tr>
                  {podeMontar && <th title="Na ordem de irrigação de hoje">Ordem</th>}
                  <th>Pivô</th><th>Cultivar</th><th className="num">Lâmina (mm)</th><th>Hoje</th>
                  {r.previsao.map((p) => (
                    <th key={p.data} className="text-center">{dataBR(p.data)}<div className="font-normal normal-case" style={{ color: CHUVA }}>{p.chuvaMm > 0 ? `${fmt(p.chuvaMm, 0)} mm${p.chuvaProb != null ? ` · ${fmt(p.chuvaProb, 0)}%` : ''}` : '—'}</div></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lista.map((p) => {
                  const t = telPorPivo.get(p.parcelas[0].pivoId);
                  return (
                    <tr key={p.nome} className="cursor-pointer transition hover:bg-cyan-500/10" onClick={() => aoVerNoMapa(p.parcelas[0].id)} title="Ver no mapa">
                      {podeMontar && (
                        <td onClick={(e) => e.stopPropagation()} className="cursor-default">
                          {travado(statusOrdem.get(p.pivoId)) ? (
                            <span className="text-xs text-slate-500">{statusOrdem.get(p.pivoId) === 'enviada' ? 'Enviado' : 'Concluído'}</span>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <input type="checkbox" className="h-4 w-4" checked={sel[p.pivoId] != null} onChange={() => alternar(p)} aria-label={`${p.nome} na ordem`} />
                              {sel[p.pivoId] != null && <input className="campo !w-16 !py-0.5 text-right text-xs tabular-nums" inputMode="decimal" value={sel[p.pivoId]} aria-label={`Lâmina bruta para ${p.nome}`} onChange={(e) => mexer((s) => ({ ...s, [p.pivoId]: e.target.value }))} />}
                            </div>
                          )}
                          {p.recomendaIrrigar && !travado(statusOrdem.get(p.pivoId)) && <div className="mt-0.5 text-[10px] text-cyan-700 dark:text-cyan-300">sugerido</div>}
                        </td>
                      )}
                      <td>
                        <div className="font-medium">{p.nome}</div>
                        <div className="text-xs text-slate-500">{fmt(p.areaHa, 0)} ha{p.parcelas.length > 1 ? ` · ${p.parcelas.length} parcelas` : ''}</div>
                        {t && <div className="mt-0.5 flex items-center gap-1.5 text-xs"><i className="h-2 w-2 rounded-full" style={{ background: COR_TEL[t.categoria] }} /><span style={{ color: COR_TEL[t.categoria] }}>{t.statusTxt}</span></div>}
                      </td>
                      <td>{p.culturas[0]}{p.culturas.length > 1 && <span className="ml-1 text-xs text-slate-500" title={p.culturas.join(' · ')}>+{p.culturas.length - 1}</span>}</td>
                      <td className="num"><div>{fmt(p.laminaMm)} <span className="text-xs text-slate-500">/ {fmt(p.capMm, 0)}</span></div><div className="ml-auto mt-1 w-28"><Medidor lamina={p.laminaMm} limite={p.limiteMm} cap={p.capMm} status={p.status} /></div></td>
                      <td><Selo status={p.status} />{p.recomendaIrrigar && <div className="mt-1 text-xs text-slate-500">repor {fmt(p.itnMm, 0)} mm · {hhmm(p.tempoMin)} h</div>}</td>
                      {p.projecao.map((d, i) => (
                        <td key={d.data} className="text-center">
                          <span className="inline-block min-w-[3.2rem] rounded-md px-1.5 py-1 text-xs font-semibold tabular-nums text-white" style={{ background: COR_STATUS[statusDoDia(p.repor, i + 1)] }} title={`${dataBR(d.data)} — lâmina ${fmt(d.laminaMm)} mm, ETc ${fmt(d.etcMm)} mm${d.chuvaMm ? `, chuva ${fmt(d.chuvaMm)} mm` : ''}`}>{fmt(d.laminaMm, 0)}</span>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Painel>

      {/* barra da ordem de irrigação: fica no rodapé enquanto o gestor monta a ordem do dia */}
      {podeMontar && selecao != null && (
        <div className="fixed inset-x-3 bottom-3 z-[1050] mx-auto max-w-3xl print:hidden">
          <div className="vidro vidro-forte flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 shadow-lg">
            <div className="mr-auto min-w-0 text-sm">
              <b className="tabular-nums">{escolhidos.length}</b> pivô{escolhidos.length === 1 ? '' : 's'} para a ordem de hoje
              {escolhidos.length > 0 && <> · ~<b className="tabular-nums">{fmt(horasSel, 0)} h</b> de pivô</>}
              <div className="text-[11px] text-slate-500">
                {aviso ?? (alterada ? 'Alterações ainda não enviadas.' : ordem.data?.itens.some((i) => i.status === 'planejada') ? 'Igual à ordem de hoje.' : 'Sugestões do balanço já marcadas; ajuste e envie.')}
                {!aviso && sugeridosFora > 0 && <> · {sugeridosFora} sugerido{sugeridosFora > 1 ? 's' : ''} fora</>}
                {invalidos.length > 0 && <span className="text-red-600"> · lâmina inválida em {invalidos.map((p) => p.nome).join(', ')}</span>}
              </div>
            </div>
            {sugeridosFora > 0 && <button type="button" className="chip" onClick={marcarSugeridos}>Marcar sugeridos</button>}
            {aviso && !alterada && aoIrParaOrdem && <button type="button" className="chip" onClick={aoIrParaOrdem}>Ver a ordem →</button>}
            <button type="button" className="btn" disabled={enviar.isPending || invalidos.length > 0 || (!alterada && escolhidos.length === 0)} onClick={() => enviar.mutate()}>
              {enviar.isPending ? 'Enviando…' : 'Enviar para a ordem'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
