import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import L from 'leaflet';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Circle, CircleMarker, GeoJSON, LayerGroup, LayersControl, MapContainer, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { api, dataBR, fmt, hhmm, percentimetro } from '../api';
import { corGradiente, laminaNoDia, statusParcelaNoDia } from '../cores';
import { Medidor } from '../graficos';
import { haQuanto, usePreciso, useTelemetria } from '../hooks';
import { COR_STATUS, COR_TEL, ROTULO_STATUS, ROTULO_TEL, type CategoriaTel, type Fazenda, type Parcela, type PivoTel, type Status, type Usuario } from '../tipos';
import { Anel, Numero } from '../ui';
import { Selo } from './Preciso';

interface MapaBase {
  limites: GeoJSON.FeatureCollection;
  pastos: GeoJSON.FeatureCollection;
}
type Modo = 'status' | 'gradiente' | 'operacao';

/** Do mais grave ao mais tranquilo: é a ordem da legenda e da lista de operação. */
const ORDEM_TEL: CategoriaTel[] = ['alarme', 'sem_sinal', 'desligado', 'parado', 'aguardando', 'movendo', 'irrigando'];
const nomeCurto = (n: string) => n.replace(/^piv[oô]\s*/i, 'P');
const SEM_TEL = '#94a3b8';
/** A partir deste zoom os nomes ficam fixos no mapa; antes disso eles se empilhariam. */
const ZOOM_ROTULOS = 14;

/** Ponta do braço do pivô no ângulo informado (norte = 0°, sentido horário). */
function ponta(t: PivoTel): [number, number] | null {
  if (t.lat == null || t.lon == null || t.angulo == null) return null;
  const r = t.raioM ?? 300;
  const a = (t.angulo * Math.PI) / 180;
  return [t.lat + (r * Math.cos(a)) / 111_320, t.lon + (r * Math.sin(a)) / (111_320 * Math.cos((t.lat * Math.PI) / 180))];
}

function Ajustar({ limites, foco, todas, enquadrar }: { limites: L.LatLngBounds | null; foco: Parcela | null; todas: Parcela[]; enquadrar: number }) {
  const mapa = useMap();
  useEffect(() => { if (limites?.isValid()) mapa.fitBounds(limites, { padding: [20, 20] }); }, [limites, mapa, enquadrar]);
  useEffect(() => {
    if (!foco) return;
    // aproxima no pivô inteiro, não só na parcela
    const grupo = todas.filter((p) => p.pivoId === foco.pivoId);
    const b = L.geoJSON(grupo.map((p) => ({ type: 'Feature' as const, properties: {}, geometry: p.geom }))).getBounds();
    if (b.isValid()) mapa.flyToBounds(b, { padding: [60, 60], maxZoom: 17, duration: 0.8 });
  }, [foco, mapa]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function Zoom({ aoMudar }: { aoMudar: (z: number) => void }) {
  const mapa = useMapEvents({ zoomend: () => aoMudar(mapa.getZoom()) });
  useEffect(() => { aoMudar(mapa.getZoom()); }, [mapa, aoMudar]);
  return null;
}

/* ---------------- peças visuais ---------------- */
function Chip({ cor, ativo, pulsa, aoClicar, children }: { cor?: string; ativo?: boolean; pulsa?: boolean; aoClicar?: () => void; children: ReactNode }) {
  return (
    <button type="button" className="chip" aria-pressed={ativo} onClick={aoClicar} style={ativo && cor ? { borderColor: cor, background: `${cor}22`, boxShadow: `0 0 12px ${cor}55` } : undefined}>
      {cor && <i className={`h-2 w-2 rounded-full ${pulsa ? 'animate-pulse' : ''}`} style={{ background: cor, boxShadow: `0 0 6px ${cor}` }} />}
      {children}
    </button>
  );
}

/** Bússola do pivô: braço no ângulo atual, tracejado no destino, seta do sentido. */
function Bussola({ t }: { t: PivoTel }) {
  const cor = COR_TEL[t.categoria];
  const R = 34;
  const pt = (ang: number, r = R) => ({ x: 44 + r * Math.sin((ang * Math.PI) / 180), y: 44 - r * Math.cos((ang * Math.PI) / 180) });
  const a = t.angulo != null ? pt(t.angulo) : null;
  const d = t.destinoAngulo != null ? pt(t.destinoAngulo) : null;
  return (
    <svg viewBox="0 0 88 88" className="h-24 w-24 shrink-0" role="img" aria-label={`Posição ${t.angulo != null ? `${fmt(t.angulo, 0)}°` : 'desconhecida'}`}>
      <circle cx="44" cy="44" r={R} fill={`${cor}14`} stroke={cor} strokeWidth="1.5" strokeOpacity=".6" />
      {[0, 90, 180, 270].map((g) => { const p1 = pt(g, R - 4), p2 = pt(g, R); return <line key={g} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="currentColor" strokeOpacity=".5" />; })}
      {d && <line x1="44" y1="44" x2={d.x} y2={d.y} stroke={cor} strokeWidth="2" strokeDasharray="3 3" strokeOpacity=".7" />}
      {a && <line x1="44" y1="44" x2={a.x} y2={a.y} stroke={cor} strokeWidth="4" strokeLinecap="round" className="linha-desenha" style={{ ['--len' as string]: 40 }} />}
      {a && <circle cx={a.x} cy={a.y} r="4" fill={cor} className={t.categoria === 'irrigando' ? 'pulsa' : ''} />}
      <circle cx="44" cy="44" r="3.5" fill="currentColor" />
      <text x="44" y="8" textAnchor="middle" className="fill-slate-500 text-[7px] font-semibold">N</text>
      {t.direcao != null && <text x="44" y="82" textAnchor="middle" className="fill-slate-500 text-[7px]">{t.direcao === 0 ? '↻ frente' : '↺ reverso'}</text>}
    </svg>
  );
}

function BlocoTelemetria({ t }: { t: PivoTel }) {
  const cor = COR_TEL[t.categoria];
  const dado = (r: string, v: ReactNode) => <div className="rounded-lg bg-slate-100/70 px-2 py-1.5 dark:bg-slate-800/60"><div className="text-[10px] uppercase tracking-wide text-slate-500">{r}</div><div className="text-sm font-semibold tabular-nums">{v}</div></div>;
  return (
    <div className="vidro p-3 text-sm" style={{ borderColor: `${cor}66` }}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: cor, boxShadow: `0 0 12px ${cor}` }} />
      <div className="flex items-start gap-3">
        <Bussola t={t} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${t.categoria === 'irrigando' || t.categoria === 'alarme' ? 'animate-pulse' : ''}`} style={{ background: cor, boxShadow: `0 0 8px ${cor}` }} />
            <b style={{ color: cor }}>{t.statusTxt}</b>
          </div>
          <div className="text-xs text-slate-500">{ROTULO_TEL[t.categoria]} · {t.provedor === 'agsense' ? 'AgSense' : 'Irricontrol'} · {haQuanto(t.atualizadoEm)}</div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {t.angulo != null && dado('Posição', `${fmt(t.angulo, 0)}°`)}
            {t.destinoAngulo != null && dado('Parar em', `${fmt(t.destinoAngulo, 0)}°`)}
            {t.percentual != null && dado('Velocidade', `${fmt(t.percentual, 0)}%`)}
            {t.pressaoPonta != null && dado('Pressão', `${fmt(t.pressaoPonta, 1)} bar`)}
            {t.tensaoV != null && dado('Tensão', `${fmt(t.tensaoV, 0)} V`)}
            {t.vazaoM3h != null && dado('Vazão', `${fmt(t.vazaoM3h, 0)} m³/h`)}
          </div>
        </div>
      </div>
    </div>
  );
}

function Detalhe({ p, dia, datas }: { p: Parcela; dia: number; datas: string[] }) {
  const lam = laminaNoDia(p, dia);
  const st = statusParcelaNoDia(p, dia);
  const r = p.recomendacao;
  const max = Math.max(...p.projecao.map((d) => d.laminaMm), p.capMm);
  const caixa = (t: string, v: string) => <div className="rounded-lg bg-slate-100/70 p-2 dark:bg-slate-800/60"><dt className="text-[10px] uppercase tracking-wide text-slate-500">{t}</dt><dd className="text-sm font-semibold tabular-nums">{v}</dd></div>;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Anel frac={lam / p.capMm} limite={p.limiteMm / p.capMm} cor={COR_STATUS[st]} rotulo={`${fmt((lam / p.capMm) * 100, 0)}%`} sub={`${fmt(lam)} / ${fmt(p.capMm, 0)} mm`} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-base font-bold leading-tight">{p.pivoNome} <span className="font-normal text-slate-500">· {p.nome}</span></div>
          <div className="text-sm text-slate-500">{p.cultura}</div>
          <div className="text-sm text-slate-500">{fmt(p.areaHa, 1)} ha · Kc {fmt(p.kc, 2)}</div>
          <Selo status={st} />
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-center">
        {caixa('Limite', `${fmt(p.limiteMm)} mm`)}
        {caixa('ETc hoje', `${fmt(p.etcHojeMm)} mm`)}
        {caixa('Última irrig.', p.ultimaIrrigacao ? dataBR(p.ultimaIrrigacao) : '—')}
      </dl>
      {r.recomendaIrrigar ? (
        <div className={`rounded-xl border p-3 text-sm ${st === 'irrigar' ? 'border-red-400/50 bg-red-500/10' : 'border-cyan-400/50 bg-cyan-500/10'}`}>
          {st === 'irrigar' ? 'Repor' : 'Reposição do dia:'} <b className="tabular-nums">{fmt(r.itnMm, 0)} mm</b> — pivô a <b className="tabular-nums">{fmt(percentimetro(r.percentualVolta), 0)}%</b> por cerca de <b className="tabular-nums">{hhmm(r.tempoMin)} h</b>.
        </div>
      ) : (
        <div className="rounded-xl border border-emerald-400/50 bg-emerald-500/10 p-3 text-sm">Sem necessidade de irrigar hoje.</div>
      )}
      <div>
        <div className="titulo-secao mb-2">Projeção sem irrigar</div>
        <div className="flex h-24 items-end gap-1.5">
          {p.projecao.map((d, i) => {
            const s = statusParcelaNoDia(p, i + 1);
            return (
              <div key={d.data} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${dataBR(d.data)} — ${fmt(d.laminaMm)} mm`}>
                <span className="text-[10px] tabular-nums text-slate-500">{fmt(d.laminaMm, 0)}</span>
                <div className={`barra-v w-full rounded-t ${i + 1 === dia ? 'ring-2 ring-cyan-400' : ''}`} style={{ height: `${Math.max(4, (d.laminaMm / max) * 64)}px`, background: COR_STATUS[s], animationDelay: `${i * 60}ms` }} />
                <span className="text-[10px] text-slate-500">{datas[i + 1]?.slice(0, 5) ?? ''}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-1 h-px w-full bg-slate-300/60 dark:bg-slate-600" />
      </div>
    </div>
  );
}

interface PastoSel { id: number; grupo: string; nome: string; cultivar: string | null; area_ha: number }

function PainelPasto({ pasto, podeEditar, aoFechar, aoPromover }: { pasto: PastoSel; podeEditar: boolean; aoFechar: () => void; aoPromover: () => void }) {
  const qc = useQueryClient();
  const promover = useMutation({
    mutationFn: () => api<{ pivoId: number; nome: string }>(`/pastos/${pasto.id}/promover-pivo`, { method: 'POST', corpo: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['preciso'] });
      qc.invalidateQueries({ queryKey: ['mapa-base'] });
      qc.invalidateQueries({ queryKey: ['cadastros'] });
      aoPromover();
    },
  });
  return (
    <div className="surge space-y-3">
      <button className="chip" onClick={aoFechar}>← Voltar</button>
      <div>
        <div className="titulo-secao">Pasto de sequeiro</div>
        <div className="mt-1 text-lg font-bold">{pasto.nome}</div>
        <div className="text-sm text-slate-500">{pasto.grupo} · {fmt(pasto.area_ha, 1)} ha</div>
        <div className="text-sm text-slate-500">{pasto.cultivar ?? 'cultivar não informada'}</div>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Este polígono está cadastrado como sequeiro, por isso não entra no balanço hídrico nem muda de cor. Se ele é irrigado, torne-o um pivô: passa a ser calculado como os demais.
      </p>
      {podeEditar ? (
        <button className="btn w-full" disabled={promover.isPending} onClick={() => promover.mutate()}>
          {promover.isPending ? 'Convertendo…' : 'Tornar pivô irrigado'}
        </button>
      ) : (
        <p className="text-sm text-slate-500">Apenas gestor ou administrador converte pastos.</p>
      )}
      {promover.error && <p role="alert" className="text-sm text-red-600">{(promover.error as Error).message}</p>}
      <p className="text-xs text-slate-500">Os parâmetros hidráulicos entram como padrão “a confirmar”; ajuste em Cadastros.</p>
    </div>
  );
}

type Hover = { tel: PivoTel; parcela?: Parcela } | { tel?: PivoTel; parcela: Parcela } | null;

/* ---------------- tela ---------------- */
export default function Mapa({ fazenda, foco, aoFocar, usuario }: { fazenda: Fazenda; foco: number | null; aoFocar: (id: number | null) => void; usuario: Usuario }) {
  const [pasto, setPasto] = useState<PastoSel | null>(null);
  const [comChuva, setComChuva] = useState(true);
  const q = usePreciso(fazenda.id, comChuva);
  const tel = useTelemetria(fazenda.id);
  const telemetria = tel.data?.pivos ?? [];
  const base = useQuery({ queryKey: ['mapa-base', fazenda.id], queryFn: () => api<MapaBase>(`/fazendas/${fazenda.id}/mapa-base`), staleTime: 300_000 });
  const [modoEscolhido, setModoEscolhido] = useState<Modo | null>(null);
  const modo: Modo = modoEscolhido ?? (telemetria.length ? 'operacao' : 'status');
  const [dia, setDia] = useState(0);
  const [tocando, setTocando] = useState(false);
  const [filtro, setFiltro] = useState<Status | null>(null);
  const [filtroOp, setFiltroOp] = useState<CategoriaTel | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [zoom, setZoom] = useState(12);
  const [enquadrar, setEnquadrar] = useState(0);
  const setModo = (m: Modo) => {
    setModoEscolhido(m);
    if (m === 'operacao') { setDia(0); setTocando(false); }
  };

  const parcelas = q.data?.parcelas ?? [];
  const nDias = parcelas[0]?.projecao.length ?? 0;
  const datas = useMemo(() => ['Hoje', ...(parcelas[0]?.projecao.map((d) => dataBR(d.data)) ?? [])], [parcelas]);

  useEffect(() => {
    if (!tocando) return;
    const t = setInterval(() => setDia((d) => (d >= nDias ? 0 : d + 1)), 1300);
    return () => clearInterval(t);
  }, [tocando, nDias]);

  const situacao = useMemo(() => parcelas.map((p) => {
    const lam = laminaNoDia(p, dia);
    return { p, lam, st: statusParcelaNoDia(p, dia), frac: (lam - p.limiteMm) / Math.max(1, p.capMm - p.limiteMm) };
  }), [parcelas, dia]);

  const contagem = useMemo(() => {
    const c = { irrigar: 0, atencao: 0, ok: 0 };
    let area = 0;
    for (const s of situacao) { c[s.st]++; if (s.st === 'irrigar') area += s.p.areaHa; }
    return { ...c, area };
  }, [situacao]);

  const telPorPivo = useMemo(() => new Map(telemetria.filter((t) => t.pivoId != null).map((t) => [t.pivoId!, t])), [telemetria]);
  const contagemOp = useMemo(() => {
    const c = new Map<CategoriaTel, number>();
    for (const t of telemetria) c.set(t.categoria, (c.get(t.categoria) ?? 0) + 1);
    return c;
  }, [telemetria]);
  const nPivos = useMemo(() => new Set(parcelas.map((p) => p.pivoId)).size, [parcelas]);
  const semTel = useMemo(() => [...new Set(parcelas.map((p) => p.pivoId))].filter((id) => !telPorPivo.has(id)).length, [parcelas, telPorPivo]);
  const filaOp = useMemo(
    () => [...telemetria].sort((a, b) => ORDEM_TEL.indexOf(a.categoria) - ORDEM_TEL.indexOf(b.categoria) || a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true })),
    [telemetria],
  );
  const fila = useMemo(() => [...situacao].sort((a, b) => a.frac - b.frac).slice(0, 8), [situacao]);
  const sel = parcelas.find((p) => p.id === foco) ?? null;
  const telSel = sel ? telPorPivo.get(sel.pivoId) ?? null : null;
  const parcelaDoTel = (t: PivoTel) => (t.pivoId != null ? parcelas.find((p) => p.pivoId === t.pivoId) : undefined);

  const limites = useMemo(() => {
    if (base.data?.limites.features.length) return L.geoJSON(base.data.limites).getBounds();
    if (parcelas.length) return L.geoJSON(parcelas.map((p) => ({ type: 'Feature' as const, properties: {}, geometry: p.geom }))).getBounds();
    return null;
  }, [base.data, parcelas.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) {
    return (
      <div className="space-y-3">
        <div className="esqueleto h-20 rounded-2xl" />
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]"><div className="esqueleto h-[66vh] rounded-2xl" /><div className="esqueleto h-[66vh] rounded-2xl" /></div>
      </div>
    );
  }
  if (q.error || !q.data) return <p role="alert" className="vidro p-4 text-sm text-red-600">{(q.error as Error)?.message ?? 'Erro ao carregar o mapa'}</p>;

  const op = modo === 'operacao';
  const botoesModo: [Modo, string][] = [...(telemetria.length ? [['operacao', 'Operação'] as [Modo, string]] : []), ['status', 'Situação'], ['gradiente', 'Gradiente']];
  const irrigando = contagemOp.get('irrigando') ?? 0;
  const alarmes = contagemOp.get('alarme') ?? 0;
  const atualizado = tel.dataUpdatedAt ? haQuanto(new Date(tel.dataUpdatedAt).toISOString()) : null;

  /* conteúdo do painel flutuante sobre o mapa */
  const hud = (() => {
    if (hover?.tel) {
      const t = hover.tel;
      const cor = COR_TEL[t.categoria];
      return (
        <>
          <div className="flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full" style={{ background: cor, boxShadow: `0 0 8px ${cor}` }} /><b>{t.nome}</b><span className="text-xs text-slate-500">{haQuanto(t.atualizadoEm)}</span></div>
          <div className="text-sm" style={{ color: cor }}>{t.statusTxt}{t.percentual != null ? ` · ${fmt(t.percentual, 0)}%` : ''}{t.angulo != null ? ` · ${fmt(t.angulo, 0)}°` : ''}</div>
          {hover.parcela && <div className="text-xs text-slate-500">{hover.parcela.cultura} · lâmina {fmt(hover.parcela.laminaMm)} / {fmt(hover.parcela.capMm, 0)} mm</div>}
        </>
      );
    }
    if (hover?.parcela) {
      const p = hover.parcela;
      const lam = laminaNoDia(p, dia);
      const st = statusParcelaNoDia(p, dia);
      return (
        <>
          <div className="flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full" style={{ background: COR_STATUS[st] }} /><b>{p.pivoNome} · {p.nome}</b></div>
          <div className="text-xs text-slate-500">{p.cultura} · {fmt(p.areaHa, 1)} ha</div>
          <div className="text-sm tabular-nums"><b style={{ color: COR_STATUS[st] }}>{fmt(lam)} mm</b> <span className="text-xs text-slate-500">de {fmt(p.capMm, 0)} · limite {fmt(p.limiteMm, 0)} · {ROTULO_STATUS[st]}</span></div>
        </>
      );
    }
    if (op) {
      return (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full pulsa" style={{ background: COR_TEL.irrigando }} /><b className="tabular-nums">{irrigando}</b> irrigando</span>
            {alarmes > 0 && <span className="flex items-center gap-1.5"><i className="h-2 w-2 animate-pulse rounded-full" style={{ background: COR_TEL.alarme }} /><b className="tabular-nums">{alarmes}</b> em alarme</span>}
            <span className="text-xs text-slate-500">{telemetria.length} pivôs com telemetria{atualizado ? ` · ${atualizado}` : ''}</span>
          </div>
          {zoom < ZOOM_ROTULOS && <div className="text-xs text-slate-500">Aproxime o mapa para ver o nome de cada pivô.</div>}
        </>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {(['irrigar', 'atencao', 'ok'] as const).map((s) => <span key={s} className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full" style={{ background: COR_STATUS[s] }} /><b className="tabular-nums">{contagem[s]}</b> {ROTULO_STATUS[s].toLowerCase()}</span>)}
        {contagem.irrigar > 0 && <span className="text-xs font-medium" style={{ color: COR_STATUS.irrigar }}>{fmt(contagem.area, 0)} ha a irrigar {dia === 0 ? 'hoje' : `até ${datas[dia]}`}</span>}
      </div>
    );
  })();

  return (
    <div className="viz space-y-3">
      {/* barra de comando */}
      <div className="vidro vidro-forte surge flex flex-wrap items-center gap-3 p-4">
        <div className="mr-auto">
          <h1 className="flex items-center gap-2 text-lg font-bold"><span className="ponto-vivo" aria-hidden /> Mapa operacional</h1>
          <p className="text-xs text-slate-500">{fazenda.nome} · {nPivos} pivôs · {parcelas.length} parcelas{telemetria.length ? ` · telemetria em ${telemetria.length}` : ''}{semTel && telemetria.length ? ` · ${semTel} sem telemetria` : ''}</p>
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="Cor dos pivôs">
          {botoesModo.map(([m, r]) => <button key={m} className="chip" aria-pressed={modo === m} onClick={() => setModo(m)}>{r}</button>)}
        </div>
        {!op && <button className="chip" aria-pressed={comChuva} onClick={() => setComChuva(!comChuva)}>☂ Chuva prevista</button>}
        <button className="chip" onClick={() => { aoFocar(null); setPasto(null); setEnquadrar((n) => n + 1); }} title="Enquadrar a fazenda inteira">⌖ Enquadrar</button>
      </div>

      {/* filtros / legenda */}
      <div className="flex flex-wrap items-center gap-2 surge" style={{ animationDelay: '60ms' }}>
        {op ? (
          <>
            {ORDEM_TEL.filter((c) => (contagemOp.get(c) ?? 0) > 0).map((c) => (
              <Chip key={c} cor={COR_TEL[c]} ativo={filtroOp === c} pulsa={c === 'alarme'} aoClicar={() => setFiltroOp(filtroOp === c ? null : c)}>
                {ROTULO_TEL[c]} <b className="tabular-nums"><Numero valor={contagemOp.get(c) ?? 0} /></b>
              </Chip>
            ))}
            {semTel > 0 && <span className="chip cursor-default opacity-70"><i className="h-2 w-2 rounded-full" style={{ background: SEM_TEL }} />Sem telemetria {semTel}</span>}
          </>
        ) : (
          <>
            {(['irrigar', 'atencao', 'ok'] as const).map((s) => (
              <Chip key={s} cor={COR_STATUS[s]} ativo={filtro === s} aoClicar={() => setFiltro(filtro === s ? null : s)}>
                {ROTULO_STATUS[s]} <b className="tabular-nums"><Numero valor={contagem[s]} /></b>
              </Chip>
            ))}
            <span className="chip cursor-default opacity-70"><i className="h-2 w-2 rounded-full bg-slate-400" />Sequeiro</span>
            {modo === 'gradiente' && <span className="ml-1 flex items-center gap-2 text-xs text-slate-500">seco <i className="h-2 w-24 rounded-full" style={{ background: 'linear-gradient(90deg, hsl(0 78% 48%), hsl(40 78% 48%), hsl(150 78% 40%))' }} /> cheio</span>}
          </>
        )}
      </div>

      {/* linha do tempo da projeção */}
      {!op && (
        <div className="vidro surge flex items-center gap-3 p-3" style={{ animationDelay: '90ms' }}>
          <button className="btn !px-3" onClick={() => setTocando((t) => !t)} aria-label={tocando ? 'Pausar' : 'Reproduzir evolução'}>{tocando ? '⏸' : '▶'}</button>
          <div className="min-w-0 flex-1">
            <input type="range" min={0} max={nDias} value={dia} onChange={(e) => { setTocando(false); setDia(Number(e.target.value)); }} className="w-full accent-cyan-600" aria-label="Dia da projeção" />
            <div className="flex justify-between gap-1 overflow-x-auto text-[11px]">
              {datas.map((d, i) => <button key={i} className={`shrink-0 rounded px-1 transition ${i === dia ? 'bg-cyan-500/15 font-semibold text-cyan-700 dark:text-cyan-300' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`} onClick={() => { setTocando(false); setDia(i); }}>{d}</button>)}
            </div>
          </div>
          <span className="hidden text-xs text-slate-500 sm:block">{dia === 0 ? 'Situação ao amanhecer' : 'Projeção sem irrigar'}</span>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="vidro surge !overflow-hidden" style={{ height: '66vh', minHeight: 420, animationDelay: '120ms' }}>
          <MapContainer center={[fazenda.lat ?? -19.6, fazenda.lon ?? -53.28]} zoom={12} style={{ height: '100%', width: '100%' }}>
            <LayersControl position="topright">
              <LayersControl.BaseLayer checked name="Satélite">
                <TileLayer attribution="Imagens © Esri" url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" />
              </LayersControl.BaseLayer>
              <LayersControl.BaseLayer name="Rua">
                <TileLayer attribution="© OpenStreetMap" url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
              </LayersControl.BaseLayer>
              {base.data && (
                <LayersControl.Overlay checked name="Limites da fazenda">
                  <GeoJSON data={base.data.limites} style={{ color: '#fde047', weight: 2, fill: false }} interactive={false} />
                </LayersControl.Overlay>
              )}
              {base.data && (
                <LayersControl.Overlay checked name="Pastos de sequeiro">
                  <GeoJSON
                    data={base.data.pastos}
                    style={{ color: '#e2e8f0', weight: 1, fillColor: '#94a3b8', fillOpacity: 0.28 }}
                    onEachFeature={(f, l) => {
                      const p = (f.properties ?? {}) as PastoSel;
                      l.bindTooltip(`${p.grupo} · ${p.nome} — ${p.cultivar ?? 'cultivar não informada'} · ${fmt(p.area_ha, 1)} ha`, { sticky: true });
                      l.on('click', () => { aoFocar(null); setPasto(p); });
                    }}
                  />
                </LayersControl.Overlay>
              )}
              {telemetria.length > 0 && (
                <LayersControl.Overlay checked name="Telemetria ao vivo">
                  <LayerGroup>
                    {telemetria.filter((t) => t.lat != null && t.lon != null).map((t) => {
                      const cor = COR_TEL[t.categoria];
                      const fim = ponta(t);
                      const centro: [number, number] = [t.lat!, t.lon!];
                      const apagado = op && filtroOp != null && t.categoria !== filtroOp;
                      const chama = t.categoria === 'irrigando' || t.categoria === 'alarme';
                      const rotulo = op && !apagado && zoom >= ZOOM_ROTULOS;
                      const alvo = parcelaDoTel(t);
                      return (
                        <LayerGroup key={`${t.id}-${t.categoria}-${t.angulo}-${apagado}-${op}-${rotulo}`}>
                          {t.pivoId == null && t.raioM && (
                            <Circle center={centro} radius={t.raioM} pathOptions={{ color: cor, weight: 2, dashArray: '6 6', fillColor: cor, fillOpacity: apagado ? 0.04 : op ? 0.35 : 0.12, opacity: apagado ? 0.3 : 1 }} />
                          )}
                          {fim && !apagado && <Polyline positions={[centro, fim]} pathOptions={{ color: '#ffffff', weight: 8, opacity: 0.9 }} />}
                          {fim && <Polyline positions={[centro, fim]} pathOptions={{ color: cor, weight: 4.5, opacity: apagado ? 0.3 : 1, className: chama && !apagado ? 'pulsa' : '' }} />}
                          <CircleMarker
                            center={centro} radius={op ? 9 : 6}
                            pathOptions={{ color: '#fff', weight: 2.5, fillColor: cor, fillOpacity: apagado ? 0.4 : 1, opacity: apagado ? 0.4 : 1, className: chama && !apagado ? 'pulsa' : '' }}
                            eventHandlers={{
                              mouseover: () => setHover({ tel: t, parcela: alvo }),
                              mouseout: () => setHover(null),
                              click: () => { setPasto(null); setHover(null); if (alvo) aoFocar(alvo.id); },
                            }}
                          >
                            {rotulo && <Tooltip permanent direction="right" offset={[10, 0]} className="rotulo-pivo">{nomeCurto(t.nome)}{t.categoria === 'alarme' ? ' ⚠' : ''}</Tooltip>}
                          </CircleMarker>
                        </LayerGroup>
                      );
                    })}
                  </LayerGroup>
                </LayersControl.Overlay>
              )}
            </LayersControl>
            {situacao.map(({ p, lam, st }) => {
              const t = telPorPivo.get(p.pivoId);
              const cor = op ? (t ? COR_TEL[t.categoria] : SEM_TEL) : modo === 'status' ? COR_STATUS[st] : corGradiente(lam, p.limiteMm, p.capMm);
              const apagado = op ? filtroOp != null && t?.categoria !== filtroOp : filtro != null && st !== filtro;
              const chama = op ? t?.categoria === 'irrigando' || t?.categoria === 'alarme' : st === 'irrigar';
              const selecionado = p.id === foco;
              const opac = apagado ? 0.08 : selecionado ? 0.88 : op ? 0.7 : 0.62;
              return (
                <GeoJSON
                  key={`${p.id}-${cor}-${apagado}-${selecionado}-${chama}-${op}`}
                  data={{ type: 'Feature', properties: {}, geometry: p.geom } as GeoJSON.Feature}
                  style={{
                    color: selecionado ? '#ffffff' : '#f8fafc', weight: selecionado ? 3.5 : 1.2, fillColor: cor,
                    fillOpacity: opac, opacity: apagado ? 0.3 : 1,
                    className: chama && !apagado ? 'pulsa' : '',
                  }}
                  eventHandlers={{
                    click: () => { setPasto(null); setHover(null); aoFocar(p.id); },
                    mouseover: (e) => { e.target.setStyle({ weight: 3, fillOpacity: 0.88 }); setHover({ parcela: p, tel: t }); },
                    mouseout: (e) => { e.target.setStyle({ weight: selecionado ? 3.5 : 1.2, fillOpacity: opac }); setHover(null); },
                  }}
                />
              );
            })}
            <Ajustar limites={limites} foco={sel} todas={parcelas} enquadrar={enquadrar} />
            <Zoom aoMudar={setZoom} />
          </MapContainer>

          {/* painel flutuante: detalhe do que está sob o mouse ou o resumo */}
          <div className="pointer-events-none absolute bottom-3 left-3 z-[1000] max-w-[min(26rem,calc(100%-1.5rem))] rounded-xl border border-slate-200/80 bg-white/85 px-3 py-2 shadow-lg backdrop-blur-md dark:border-slate-600 dark:bg-slate-900/85" role="status">
            {hud}
          </div>
        </div>

        <aside className="vidro surge max-h-[66vh] min-h-[200px] overflow-y-auto p-4" style={{ animationDelay: '160ms' }}>
          {pasto ? (
            <PainelPasto pasto={pasto} podeEditar={usuario.papel !== 'operador'} aoFechar={() => setPasto(null)} aoPromover={() => setPasto(null)} />
          ) : sel ? (
            <div className="surge space-y-3">
              <button className="chip" onClick={() => aoFocar(null)}>← Voltar</button>
              {telSel && <BlocoTelemetria t={telSel} />}
              <Detalhe p={sel} dia={dia} datas={datas} />
            </div>
          ) : op ? (
            <div className="surge">
              <h3 className="titulo-secao">Operação dos pivôs</h3>
              <p className="mb-3 mt-1 text-xs text-slate-500">Do que pede mais atenção ao que está rodando. Toque para aproximar no mapa.</p>
              <ul className="space-y-1">
                {filaOp.filter((t) => !filtroOp || t.categoria === filtroOp).map((t, i, arr) => {
                  const alvo = parcelaDoTel(t);
                  const cor = COR_TEL[t.categoria];
                  const novoGrupo = i === 0 || arr[i - 1].categoria !== t.categoria;
                  return (
                    <li key={t.id}>
                      {novoGrupo && <div className="mb-1 mt-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.12em] text-slate-500 first:mt-0"><i className="h-1.5 w-1.5 rounded-full" style={{ background: cor }} />{ROTULO_TEL[t.categoria]} · {contagemOp.get(t.categoria)}</div>}
                      <button
                        disabled={!alvo}
                        onClick={() => { setHover(null); if (alvo) aoFocar(alvo.id); }}
                        onMouseEnter={() => setHover({ tel: t, parcela: alvo })}
                        onMouseLeave={() => setHover(null)}
                        className="surge relative flex w-full items-center gap-3 overflow-hidden rounded-lg px-3 py-1.5 text-left transition enabled:hover:bg-slate-100/80 dark:enabled:hover:bg-slate-700/60"
                        style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}
                      >
                        <i className="absolute inset-y-1 left-0 w-1 rounded-full" style={{ background: cor, boxShadow: chama(t) ? `0 0 8px ${cor}` : undefined }} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{t.nome}</span>
                          <span className="block truncate text-xs" style={{ color: cor }}>
                            {t.statusTxt}{t.categoria === 'irrigando' && t.percentual != null ? ` · ${fmt(t.percentual, 0)}%` : ''}{t.angulo != null ? ` · ${fmt(t.angulo, 0)}°` : ''}
                          </span>
                        </span>
                        <span className="text-xs tabular-nums text-slate-500">{haQuanto(t.atualizadoEm)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="surge">
              <h3 className="titulo-secao">Fila de irrigação</h3>
              <p className="mb-3 mt-1 text-xs text-slate-500">Parcelas mais próximas do limite {dia === 0 ? 'hoje' : `em ${datas[dia]}`}. Marca preta = limite de segurança. Toque para aproximar.</p>
              <ul className="space-y-2">
                {fila.map(({ p, lam, st }, i) => (
                  <li key={p.id}>
                    <button onClick={() => { setHover(null); aoFocar(p.id); }} onMouseEnter={() => setHover({ parcela: p, tel: telPorPivo.get(p.pivoId) })} onMouseLeave={() => setHover(null)} className="surge w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-slate-100/80 dark:hover:bg-slate-700/60" style={{ animationDelay: `${i * 30}ms` }}>
                      <span className="mb-1 flex items-baseline gap-2 text-sm">
                        <span className="w-4 text-xs tabular-nums text-slate-400">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate font-medium">{p.pivoNome} <span className="font-normal text-slate-500">· {p.nome}</span></span>
                        <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ background: COR_STATUS[st] }}>{ROTULO_STATUS[st]}</span>
                        <span className="text-xs tabular-nums text-slate-500">{fmt(lam, 0)} / {fmt(p.capMm, 0)} mm</span>
                      </span>
                      <span className="block pl-6"><Medidor lamina={lam} limite={p.limiteMm} cap={p.capMm} status={st} /></span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

const chama = (t: PivoTel) => t.categoria === 'irrigando' || t.categoria === 'alarme';
