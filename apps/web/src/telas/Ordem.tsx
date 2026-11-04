import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api, ErroApi, fmt, hhmm } from '../api';
import { LinhaDoDia } from '../graficos';
import { haQuanto } from '../hooks';
import { COR_TEL, ROTULO_TEL, type Fazenda, type ItemOrdem, type Janela, type Ordem as DadosOrdem, type PreviaComando, type Usuario } from '../tipos';
import { Numero } from '../ui';

const DIAS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const TZ = 'America/Campo_Grande';
const hora = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ }).replace('.', '') : '—');
const msg = (x: unknown) => (x instanceof ErroApi ? x.message : 'Não foi possível falar com o servidor');
const AZUL = 'var(--s-irr)';
const ANIMAIS = '#a855f7';
const COR_STATUS_ORDEM: Record<ItemOrdem['status'], string> = { planejada: '#0891b2', enviada: '#2563eb', concluida: '#64748b', cancelada: '#a855f7' };
const ROTULO_STATUS_ORDEM: Record<ItemOrdem['status'], string> = { planejada: 'Planejada', enviada: 'Comando enviado', concluida: 'Concluída', cancelada: 'Fora da ordem' };

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

function Kpi({ rotulo, valor, unidade, sub, cor, atraso }: { rotulo: string; valor: number; unidade?: string; sub?: string; cor: string; atraso: number }) {
  return (
    <div className="vidro vidro-forte surge p-4" style={{ animationDelay: `${atraso}ms`, ['--cor' as string]: cor } as CSSProperties}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: cor, boxShadow: `0 0 16px ${cor}` }} />
      <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-slate-500 dark:text-slate-400">{rotulo}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="num-grande text-3xl" style={{ color: cor }}><Numero valor={valor} /></span>
        {unidade && <span className="text-sm text-slate-500">{unidade}</span>}
      </div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

/** Plano do pivô: onde está, para que lado vai e onde deve parar (início da área com animais). */
function PlanoPivo({ item }: { item: ItemOrdem }) {
  const R = 36;
  const pt = (ang: number, r = R) => ({ x: 46 + r * Math.sin((ang * Math.PI) / 180), y: 46 - r * Math.cos((ang * Math.PI) / 180) });
  const cor = item.categoria ? COR_TEL[item.categoria] : '#94a3b8';
  const a0 = item.angulo ?? 0;
  const parada = item.anguloParada;
  let arco: string | null = null;
  if (parada != null && item.sentido != null) {
    const horario = item.sentido === 0;
    const delta = horario ? (parada - a0 + 360) % 360 : (a0 - parada + 360) % 360;
    const p0 = pt(a0, R - 7), p1 = pt(parada, R - 7);
    arco = `M${p0.x},${p0.y} A${R - 7},${R - 7} 0 ${delta > 180 ? 1 : 0},${horario ? 1 : 0} ${p1.x},${p1.y}`;
  }
  const pa = pt(a0), pp = parada != null ? pt(parada) : null;
  return (
    <svg viewBox="0 0 92 92" className="h-24 w-24 shrink-0" role="img" aria-label={`Posição ${item.angulo != null ? `${fmt(item.angulo, 0)}°` : 'desconhecida'}${parada != null ? `, parar em ${fmt(parada, 0)}°` : ''}`}>
      <circle cx="46" cy="46" r={R} fill={`${AZUL}`} fillOpacity=".08" stroke="currentColor" strokeOpacity=".25" strokeWidth="1" />
      {[0, 90, 180, 270].map((g) => { const p1 = pt(g, R - 3), p2 = pt(g, R); return <line key={g} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="currentColor" strokeOpacity=".5" />; })}
      {arco ? <path d={arco} fill="none" stroke={AZUL} strokeWidth="9" strokeOpacity=".55" strokeLinecap="butt" className="linha-desenha" style={{ ['--len' as string]: 230 }} />
        : <circle cx="46" cy="46" r={R - 7} fill="none" stroke={AZUL} strokeWidth="9" strokeOpacity=".3" strokeDasharray="3 3" />}
      {item.angulo != null && <line x1="46" y1="46" x2={pa.x} y2={pa.y} stroke={cor} strokeWidth="3.5" strokeLinecap="round" />}
      {item.angulo != null && <circle cx={pa.x} cy={pa.y} r="4" fill={cor} className={item.categoria === 'irrigando' ? 'pulsa' : ''} />}
      {pp && <g><line x1="46" y1="46" x2={pp.x} y2={pp.y} stroke={ANIMAIS} strokeWidth="2" strokeDasharray="3 2" /><circle cx={pp.x} cy={pp.y} r="4.5" fill={ANIMAIS} stroke="#fff" strokeWidth="1.5" /></g>}
      <circle cx="46" cy="46" r="3.5" fill="currentColor" />
      <text x="46" y="7" textAnchor="middle" className="fill-slate-500 text-[7px] font-semibold">N</text>
      <text x="46" y="88" textAnchor="middle" className="fill-slate-500 text-[8px] font-semibold">{item.sentido === 0 ? '↻ frente' : item.sentido === 1 ? '↺ reverso' : 'padrão'}</text>
    </svg>
  );
}

/* ---------------- janelas de energia ---------------- */
const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

function BarraJanela({ j }: { j: Janela }) {
  const a = mins(j.inicio), b = mins(j.fim);
  const faixas: [number, number][] = a === b ? [[0, 1440]] : a < b ? [[a, b]] : [[a, 1440], [0, b]];
  return (
    <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-700" aria-hidden>
      {faixas.map(([x, y], k) => <div key={k} className="barra-h absolute inset-y-0 rounded-full" style={{ left: `${(x / 1440) * 100}%`, width: `${((y - x) / 1440) * 100}%`, background: '#10b981', boxShadow: '0 0 8px rgb(16 185 129 / .6)' }} />)}
      {[6, 12, 18].map((h) => <i key={h} className="absolute inset-y-0 w-px bg-white/70 dark:bg-slate-900/70" style={{ left: `${(h / 24) * 100}%` }} />)}
    </div>
  );
}

function Janelas({ fazenda, podeEditar, aoSalvar }: { fazenda: Fazenda; podeEditar: boolean; aoSalvar: () => void }) {
  const cfg = useQuery({ queryKey: ['janelas', fazenda.id], queryFn: () => api<{ janelas: Janela[]; maxSimultaneos: number }>(`/fazendas/${fazenda.id}/janelas`) });
  const [lista, setLista] = useState<Janela[]>([]);
  const [simult, setSimult] = useState(1);
  const [erro, setErro] = useState('');
  useEffect(() => { if (cfg.data) { setLista(cfg.data.janelas); setSimult(cfg.data.maxSimultaneos); } }, [cfg.data]);
  const mudou = !!cfg.data && (JSON.stringify(cfg.data.janelas) !== JSON.stringify(lista) || cfg.data.maxSimultaneos !== simult);
  const salvar = useMutation({
    mutationFn: () => api(`/fazendas/${fazenda.id}/janelas`, { method: 'PUT', corpo: { janelas: lista, maxSimultaneos: simult } }),
    onSuccess: () => { setErro(''); cfg.refetch(); aoSalvar(); },
    onError: (x) => setErro(msg(x)),
  });
  const mudar = (i: number, p: Partial<Janela>) => setLista(lista.map((j, k) => (k === i ? { ...j, ...p } : j)));
  const horasDia = lista.reduce((s, j) => { const a = mins(j.inicio), b = mins(j.fim); return s + (a === b ? 1440 : a < b ? b - a : 1440 - a + b); }, 0) / 60;

  return (
    <Painel atraso={320} titulo="Horário de energia" sub="A irrigação só é programada e liberada dentro destas janelas. Fora delas o comando é bloqueado e o app alerta se o pivô estiver irrigando. Sem janela cadastrada = qualquer horário."
      extra={lista.length > 0 ? <span className="chip cursor-default">{fmt(horasDia, 1)} h/dia liberadas</span> : undefined}>
      <div className="space-y-3">
        {lista.map((j, i) => (
          <div key={i} className="rounded-xl bg-slate-100/70 p-3 dark:bg-slate-800/60">
            <div className="flex flex-wrap items-end gap-3">
              <div><label className="rotulo">Início</label><input type="time" className="campo !w-auto !py-1.5" value={j.inicio} disabled={!podeEditar} onChange={(e) => mudar(i, { inicio: e.target.value })} /></div>
              <div><label className="rotulo">Fim</label><input type="time" className="campo !w-auto !py-1.5" value={j.fim} disabled={!podeEditar} onChange={(e) => mudar(i, { fim: e.target.value })} /></div>
              <div className="flex gap-1" role="group" aria-label="Dias da semana">
                {DIAS.map((d, n) => (
                  <button key={n} type="button" disabled={!podeEditar} aria-pressed={j.dias.includes(n)}
                    onClick={() => mudar(i, { dias: j.dias.includes(n) ? j.dias.filter((x) => x !== n) : [...j.dias, n].sort() })}
                    className={`h-8 w-8 rounded-full border text-xs font-semibold transition ${j.dias.includes(n) ? 'border-transparent bg-emerald-600 text-white shadow-[0_0_10px_rgb(16_185_129/.5)]' : 'border-slate-300 text-slate-500 dark:border-slate-600'}`}>{d}</button>
                ))}
              </div>
              {j.fim < j.inicio && <span className="text-xs text-slate-500">atravessa a meia-noite</span>}
              {podeEditar && <button type="button" className="chip ml-auto" onClick={() => setLista(lista.filter((_, k) => k !== i))}>Remover</button>}
            </div>
            <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500"><span>0h</span><BarraJanela j={j} /><span>24h</span></div>
          </div>
        ))}
        {lista.length === 0 && <p className="text-sm text-slate-500">Nenhuma janela: irrigação liberada o dia todo.</p>}
        {podeEditar && (
          <div className="flex flex-wrap items-end gap-3">
            <button type="button" className="chip" onClick={() => setLista([...lista, { inicio: '21:00', fim: '06:00', dias: [0, 1, 2, 3, 4, 5, 6] }])}>+ Adicionar janela</button>
            <div><label className="rotulo" htmlFor="simult">Pivôs ao mesmo tempo</label><input id="simult" type="number" min={1} max={20} className="campo !w-24 !py-1.5" value={simult} onChange={(e) => setSimult(Math.max(1, Number(e.target.value) || 1))} /></div>
            <button className={mudou ? 'btn' : 'btn-sec'} disabled={salvar.isPending || !mudou} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Salvando…' : mudou ? 'Salvar horários' : 'Sem alterações'}</button>
          </div>
        )}
        {erro && <p role="alert" className="text-sm text-red-600">{erro}</p>}
      </div>
    </Painel>
  );
}

/* ---------------- comando ao pivô ---------------- */
function Comando({ item, aoEnviar }: { item: ItemOrdem; aoEnviar: () => void }) {
  const [previa, setPrevia] = useState<PreviaComando | null>(null);
  const [resultado, setResultado] = useState<{ ok: boolean; t: string } | null>(null);
  const ver = useMutation({
    mutationFn: () => api<PreviaComando>(`/telemetria/pivos/${item.telemetriaId}/comando/previa`, { corpo: { acao: 'iniciar', percentual: item.percentual ?? undefined } }),
    onSuccess: (p) => { setResultado(null); setPrevia(p); },
    onError: (x) => setResultado({ ok: false, t: msg(x) }),
  });
  const iniciar = useMutation({
    mutationFn: () => api(`/telemetria/pivos/${item.telemetriaId}/comando`, { corpo: { acao: 'iniciar', percentual: item.percentual ?? undefined } }),
    onSuccess: () => { setPrevia(null); setResultado({ ok: true, t: 'Comando enviado ao pivô.' }); aoEnviar(); },
    onError: (x) => { setPrevia(null); setResultado({ ok: false, t: msg(x) }); aoEnviar(); },
  });
  const parar = useMutation({
    mutationFn: () => api(`/telemetria/pivos/${item.telemetriaId}/comando`, { corpo: { acao: 'parar' } }),
    onSuccess: () => { setResultado({ ok: true, t: 'Comando de parada enviado.' }); aoEnviar(); },
    onError: (x) => setResultado({ ok: false, t: msg(x) }),
  });
  if (item.telemetriaId == null) return <span className="chip cursor-default border-amber-500 text-amber-700 dark:text-amber-300">Pivô sem telemetria vinculada</span>;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button className="btn !bg-emerald-600 hover:!bg-emerald-700" disabled={ver.isPending || iniciar.isPending} onClick={() => ver.mutate()}>{ver.isPending ? 'Conferindo…' : '▶ Iniciar'}</button>
        <button className="btn-sec" disabled={parar.isPending} onClick={() => confirm(`Parar ${item.pivoNome} agora?`) && parar.mutate()}>■ Parar</button>
      </div>
      {previa && (
        <div className="surge rounded-xl border border-cyan-500/40 bg-cyan-500/5 p-3 text-sm shadow-[0_0_24px_rgb(8_145_178/.15)]">
          <p className="font-medium">Confira o que será enviado a {item.pivoNome}:</p>
          <ul className="my-1 space-y-0.5 text-slate-600 dark:text-slate-300">
            <li>Sentido: <b>{previa.comando.sentido === 1 ? '↺ Reverso' : previa.comando.sentido === 0 ? '↻ Frente' : 'o padrão do pivô (sem animais no setor)'}</b></li>
            {previa.comando.anguloParada != null && <li>Parar em <b>{previa.comando.anguloParada}°</b> (início da área com animais)</li>}
            {previa.comando.percentual != null && <li>Velocidade: <b>{fmt(previa.comando.percentual, 0)}%</b></li>}
          </ul>
          {previa.comando.avisos.map((a) => <p key={a} className="text-xs text-amber-600">⚠ {a}</p>)}
          {previa.bloqueios.map((b) => <p key={b} role="alert" className="text-sm font-medium text-red-600">⛔ {b}</p>)}
          <div className="mt-2 flex gap-2">
            <button className="btn" disabled={previa.bloqueios.length > 0 || iniciar.isPending} onClick={() => iniciar.mutate()}>{iniciar.isPending ? 'Enviando…' : 'Confirmar e enviar'}</button>
            <button className="btn-sec" onClick={() => setPrevia(null)}>Cancelar</button>
          </div>
        </div>
      )}
      {resultado && <p role="alert" className={`text-xs ${resultado.ok ? 'text-emerald-600' : 'text-red-600'}`}>{resultado.t}</p>}
    </div>
  );
}

/* ---------------- card de um pivô na ordem ---------------- */
function CardItem({ i, podeEditar, atraso, aoRefrescar, aoStatus }: { i: ItemOrdem; podeEditar: boolean; atraso: number; aoRefrescar: () => void; aoStatus: (s: 'concluida' | 'cancelada') => void }) {
  const cor = COR_STATUS_ORDEM[i.status];
  const dado = (r: string, v: ReactNode) => <div className="rounded-lg bg-slate-100/70 px-2 py-1.5 dark:bg-slate-800/60"><div className="text-[10px] uppercase tracking-wide text-slate-500">{r}</div><div className="text-sm font-semibold tabular-nums">{v}</div></div>;
  const animais = i.avisos.find((a) => a.startsWith('Animais em'));
  return (
    <article className="vidro surge p-4" style={{ animationDelay: `${atraso}ms` }}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: cor, boxShadow: `0 0 12px ${cor}` }} />
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-bold text-white" style={{ background: cor, boxShadow: `0 0 14px ${cor}88` }}>{i.sequencia}</span>
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-bold">
            {i.pivoNome}
            {i.categoria && <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ background: `${COR_TEL[i.categoria]}22`, color: COR_TEL[i.categoria] }}><i className={`h-1.5 w-1.5 rounded-full ${i.categoria === 'irrigando' || i.categoria === 'alarme' ? 'animate-pulse' : ''}`} style={{ background: COR_TEL[i.categoria] }} />{ROTULO_TEL[i.categoria]}</span>}
            {i.status !== 'planejada' && <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white" style={{ background: cor }}>{ROTULO_STATUS_ORDEM[i.status]}</span>}
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-300"><b className="tabular-nums">{hora(i.inicio)}</b> → <b className="tabular-nums">{hora(i.fim)}</b> <span className="text-xs text-slate-500">· {hhmm(i.duracaoMin)} h</span></p>
          {animais && <p className="mt-0.5 text-xs" style={{ color: ANIMAIS }}>🐄 {animais}</p>}
        </div>
        <PlanoPivo item={i} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {dado('Lâmina', `${fmt(i.laminaMm, 1)} mm`)}
        {dado('Velocidade', `${fmt(i.percentual, 0)}%`)}
        {dado('Sentido', i.sentido === 0 ? '↻ Frente' : i.sentido === 1 ? '↺ Reverso' : 'Padrão')}
        {dado('Parar em', i.anguloParada != null ? <span style={{ color: ANIMAIS }}>{fmt(i.anguloParada, 0)}°</span> : <span className="text-slate-400">volta inteira</span>)}
      </div>
      {i.avisos.filter((a) => !a.startsWith('Animais em')).map((a) => <p key={a} className="mt-2 text-xs text-amber-600">⚠ {a}</p>)}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-2 border-t border-slate-200/70 pt-3 dark:border-slate-700">
        {i.status === 'planejada' || i.status === 'enviada' ? <Comando item={i} aoEnviar={aoRefrescar} /> : <span />}
        {podeEditar && i.status !== 'concluida' && (
          <span className="flex gap-2">
            <button className="chip" onClick={() => aoStatus('concluida')}>✔ Concluída</button>
            <button className="chip" onClick={() => aoStatus('cancelada')}>Tirar da ordem</button>
          </span>
        )}
      </div>
    </article>
  );
}

/* ---------------- tela ---------------- */
export default function Ordem({ fazenda, usuario }: { fazenda: Fazenda; usuario: Usuario }) {
  const qc = useQueryClient();
  const podeEditar = usuario.papel !== 'operador';
  const ordem = useQuery({ queryKey: ['ordem', fazenda.id], queryFn: () => api<DadosOrdem>(`/fazendas/${fazenda.id}/ordem`), refetchInterval: 30_000, placeholderData: (a) => a });
  const refrescar = () => { qc.invalidateQueries({ queryKey: ['ordem'] }); qc.invalidateQueries({ queryKey: ['telemetria'] }); qc.invalidateQueries({ queryKey: ['alertas'] }); };
  const gerar = useMutation({ mutationFn: () => api<DadosOrdem>(`/fazendas/${fazenda.id}/ordem/gerar`, { corpo: {} }), onSuccess: (d) => qc.setQueryData(['ordem', fazenda.id], d) });
  const status = useMutation({ mutationFn: (a: { id: number; status: string }) => api(`/ordem/${a.id}/status`, { method: 'PUT', corpo: { status: a.status } }), onSuccess: refrescar });

  const d = ordem.data;
  const ativos = d?.itens.filter((i) => i.status !== 'cancelada') ?? [];
  const adiados = d?.itens.filter((i) => i.status === 'cancelada') ?? [];
  const horas = ativos.reduce((s, i) => s + i.duracaoMin, 0) / 60;
  const enviados = ativos.filter((i) => i.status === 'enviada').length;
  const concluidos = ativos.filter((i) => i.status === 'concluida').length;
  const pendentes = ativos.filter((i) => i.status === 'planejada').length;
  const comAnimais = ativos.filter((i) => i.anguloParada != null).length;
  const dataBR = d ? d.data.split('-').reverse().join('/') : '';

  if (ordem.isLoading) {
    return (
      <div className="space-y-4">
        <div className="esqueleto h-20 rounded-2xl" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="esqueleto h-24 rounded-2xl" />)}</div>
        <div className="esqueleto h-48 rounded-2xl" />
      </div>
    );
  }
  if (!d) return <p role="alert" className="vidro p-4 text-sm text-red-600">{(ordem.error as Error)?.message ?? 'Erro ao carregar a ordem'}</p>;

  const destaques: { t: string; cor: string }[] = [
    d.permitidoAgora ? { t: 'Agora é horário permitido para irrigar', cor: '#059669' } : { t: 'Fora do horário permitido: comandos de início bloqueados', cor: '#f59e0b' },
    ...(pendentes ? [{ t: `${pendentes} pivô${pendentes > 1 ? 's' : ''} aguardando comando`, cor: '#0891b2' }] : []),
    ...(comAnimais ? [{ t: `${comAnimais} pivô${comAnimais > 1 ? 's' : ''} com ângulo de parada por animais`, cor: ANIMAIS }] : []),
    ...(adiados.length ? [{ t: `${adiados.length} pivô${adiados.length > 1 ? 's' : ''} fora da ordem`, cor: '#f59e0b' }] : []),
  ];

  return (
    <div className="viz space-y-4">
      {/* barra de comando */}
      <div className="vidro vidro-forte surge flex flex-wrap items-center gap-3 p-4">
        <div className="mr-auto">
          <h1 className="flex items-center gap-2 text-lg font-bold"><span className="ponto-vivo" aria-hidden /> Ordem de irrigação</h1>
          <p className="text-xs text-slate-500">{fazenda.nome} · {dataBR} · pivôs escolhidos no Preciso irrigar (as sugestões do balanço vêm marcadas), do mais seco ao menos seco, encaixados no horário de energia{ordem.dataUpdatedAt ? ` · atualizado ${haQuanto(new Date(ordem.dataUpdatedAt).toISOString())}` : ''}</p>
        </div>
        <span className="chip cursor-default" style={{ borderColor: d.permitidoAgora ? '#059669' : '#f59e0b', color: d.permitidoAgora ? '#059669' : '#d97706' }}>
          <i className="h-2 w-2 rounded-full" style={{ background: d.permitidoAgora ? '#059669' : '#f59e0b', boxShadow: `0 0 6px ${d.permitidoAgora ? '#059669' : '#f59e0b'}` }} />{d.permitidoAgora ? 'Horário permitido' : 'Fora do horário'}
        </span>
        {podeEditar && (
          <button
            className="btn-sec"
            disabled={gerar.isPending}
            title="Monta a ordem só com os pivôs que o balanço pede, com a lâmina recomendada"
            onClick={() => {
              // refazer pelas sugestões descarta os pivôs escolhidos à mão no Preciso irrigar
              if (ativos.some((i) => i.status === 'planejada') && !window.confirm('Substituir a ordem planejada de hoje pelas sugestões do balanço? Os pivôs escolhidos à mão saem da ordem.')) return;
              gerar.mutate();
            }}
          >
            {gerar.isPending ? 'Calculando…' : 'Montar pelas sugestões'}
          </button>
        )}
      </div>
      {gerar.error && <p role="alert" className="vidro p-3 text-sm text-red-600">{msg(gerar.error)}</p>}

      {/* destaques */}
      <div className="flex flex-wrap gap-2 surge" style={{ animationDelay: '40ms' }}>
        {destaques.map((x) => (
          <span key={x.t} className="inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 text-xs font-medium backdrop-blur dark:border-slate-700 dark:bg-slate-900/50">
            <i className="h-2 w-2 rounded-full" style={{ background: x.cor, boxShadow: `0 0 8px ${x.cor}` }} />{x.t}
          </span>
        ))}
      </div>

      {/* indicadores */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi atraso={60} rotulo="Na ordem de hoje" valor={ativos.length} unidade="pivôs" sub={ativos.length ? `${fmt(ativos.reduce((s, i) => s + (i.laminaMm ?? 0), 0) / ativos.length, 1)} mm de lâmina média` : 'nenhuma reposição pendente'} cor={AZUL} />
        <Kpi atraso={100} rotulo="Horas programadas" valor={horas} unidade="h" sub="soma das durações" cor="#0891b2" />
        <Kpi atraso={140} rotulo="Enviados / concluídos" valor={enviados + concluidos} unidade={`de ${ativos.length}`} sub={`${enviados} enviados · ${concluidos} concluídos`} cor={enviados + concluidos === ativos.length && ativos.length ? '#059669' : '#2563eb'} />
        <Kpi atraso={180} rotulo="Fora da ordem" valor={adiados.length} unidade="pivôs" sub="adiados por animais ou retirados" cor={adiados.length ? '#f59e0b' : '#64748b'} />
      </div>

      {/* linha do tempo */}
      <Painel atraso={200} titulo={`Linha do tempo · ${dataBR}`} sub="Faixa verde = horário de energia permitido. Barras = pivôs na ordem; linha vermelha = agora.">
        <LinhaDoDia data={d.data} itens={d.itens} janelas={d.janelas} />
      </Painel>

      {/* itens */}
      <Painel atraso={240} titulo={`Pivôs na ordem · ${ativos.length}`} sub="O sentido e o ângulo de parada saem de onde estão os animais: o pivô para antes do piquete ocupado. Iniciar mostra uma prévia antes de enviar.">
        {ativos.length === 0 ? (
          <p className="text-sm text-slate-500">Nenhum pivô na ordem. {podeEditar ? 'Escolha os pivôs no Preciso irrigar e toque em "Enviar para a ordem", ou use "Montar pelas sugestões".' : ''}</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {ativos.map((i, k) => <CardItem key={`${i.id}-${i.status}`} i={i} podeEditar={podeEditar} atraso={Math.min(k, 8) * 50} aoRefrescar={refrescar} aoStatus={(s) => status.mutate({ id: i.id, status: s })} />)}
          </div>
        )}
        {adiados.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="titulo-secao">Fora da ordem</div>
            {adiados.map((i) => (
              <div key={i.id} className="flex items-start gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: `${ANIMAIS}55`, background: `${ANIMAIS}0d` }}>
                <span>🐄</span>
                <span className="min-w-0 flex-1"><b>{i.pivoNome}</b> · {i.avisos.join(' ') || 'retirado manualmente.'}</span>
                {podeEditar && <button className="chip shrink-0" onClick={() => status.mutate({ id: i.id, status: 'planejada' })}>Voltar à ordem</button>}
              </div>
            ))}
          </div>
        )}
      </Painel>

      <Janelas fazenda={fazenda} podeEditar={podeEditar} aoSalvar={refrescar} />
    </div>
  );
}
