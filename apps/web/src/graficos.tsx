import { useEffect, useMemo, useRef, useState } from 'react';
import { dataBR, fmt } from './api';
import { COR_STATUS, type ItemOrdem, type Janela, type Relatorio, type Status } from './tipos';
import { statusDe } from './cores';

const TZ = 'America/Campo_Grande';

function useLargura<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || 640);
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const bonito = (max: number) => {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  const m = max / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};

/** Barra com só o topo arredondado (ancorada na base). */
const barraTopo = (x: number, y: number, w: number, h: number, r = 4) => {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
};

// ---------- série diária: irrigação × chuva (barras) e ETo (linha), um só eixo em mm ----------
type Serie = 'irr' | 'chuva' | 'eto';
const SERIES: { id: Serie; rotulo: string; cor: string }[] = [
  { id: 'irr', rotulo: 'Irrigação', cor: 'var(--s-irr)' },
  { id: 'chuva', rotulo: 'Chuva', cor: 'var(--s-chuva)' },
  { id: 'eto', rotulo: 'ETo (consumo)', cor: 'var(--s-eto)' },
];

export function GraficoDias({ dias }: { dias: Relatorio['dias'] }) {
  const [ref, W] = useLargura<HTMLDivElement>();
  const [ativas, setAtivas] = useState<Record<Serie, boolean>>({ irr: true, chuva: true, eto: true });
  const [tabela, setTabela] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const H = 250, L = 38, R = 10, T = 14, B = 26;
  const iw = Math.max(120, W - L - R), ih = H - T - B;
  const valor = (d: Relatorio['dias'][number], s: Serie) => (s === 'irr' ? d.irrigacaoMm : s === 'chuva' ? d.chuvaMm : d.etoMm);
  const max = bonito(Math.max(1, ...dias.flatMap((d) => SERIES.filter((s) => ativas[s.id]).map((s) => valor(d, s.id)))) * 1.08);
  const bw = iw / Math.max(1, dias.length);
  const grupo = Math.min(bw * 0.78, 34);
  const barras = SERIES.filter((s) => s.id !== 'eto' && ativas[s.id]);
  const y = (v: number) => T + ih - (v / max) * ih;
  const cx = (i: number) => L + bw * i + bw / 2;
  const passo = Math.max(1, Math.ceil(46 / bw));
  const linha = dias.map((d, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(d.etoMm).toFixed(1)}`).join(' ');
  const compr = Math.round(iw * 1.4);
  const h = hover != null ? dias[hover] : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {SERIES.map((s) => (
          <button key={s.id} className="chip" aria-pressed={ativas[s.id]} onClick={() => setAtivas({ ...ativas, [s.id]: !ativas[s.id] })}>
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.cor }} />{s.rotulo}
          </button>
        ))}
        <button className="chip ml-auto" aria-pressed={tabela} onClick={() => setTabela(!tabela)}>{tabela ? 'Ver gráfico' : 'Ver tabela'}</button>
      </div>

      {tabela ? (
        <div className="max-h-72 overflow-auto">
          <table className="tabela">
            <thead><tr><th>Dia</th><th className="num">Irrigação mm</th><th className="num">Chuva mm</th><th className="num">ETo mm</th></tr></thead>
            <tbody>{dias.map((d) => <tr key={d.data}><td>{dataBR(d.data)}</td><td className="num">{fmt(d.irrigacaoMm)}</td><td className="num">{fmt(d.chuvaMm)}</td><td className="num">{fmt(d.etoMm)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
          <svg width={W} height={H} role="img" aria-label="Irrigação, chuva e evapotranspiração por dia, em milímetros">
            <defs>
              <linearGradient id="g-irr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--s-irr)" /><stop offset="1" stopColor="var(--s-irr)" stopOpacity=".55" /></linearGradient>
              <linearGradient id="g-chuva" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--s-chuva)" /><stop offset="1" stopColor="var(--s-chuva)" stopOpacity=".55" /></linearGradient>
            </defs>
            {[0, 1, 2, 3, 4].map((k) => {
              const v = (max / 4) * k;
              return (<g key={k}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--grade)" strokeDasharray={k ? '3 4' : undefined} /><text x={L - 6} y={y(v) + 3} textAnchor="end" className="fill-slate-500 text-[10px]">{fmt(v, max < 10 ? 1 : 0)}</text></g>);
            })}
            {dias.map((d, i) => i % passo === 0 && <text key={d.data} x={cx(i)} y={H - 8} textAnchor="middle" className="fill-slate-500 text-[10px]">{dataBR(d.data)}</text>)}
            {hover != null && <rect x={L + bw * hover} y={T} width={bw} height={ih} fill="var(--s-irr)" opacity=".08" rx="4" />}
            {dias.map((d, i) => barras.map((s, k) => {
              const w = grupo / barras.length - 2;
              const x = cx(i) - grupo / 2 + k * (grupo / barras.length) + 1;
              const v = valor(d, s.id);
              const hh = Math.max(v > 0 ? 2 : 0, (v / max) * ih);
              return hh > 0 && <path key={`${d.data}${s.id}`} d={barraTopo(x, T + ih - hh, w, hh)} fill={`url(#g-${s.id})`} className="barra-v" style={{ animationDelay: `${i * 18}ms` }} />;
            }))}
            {ativas.eto && (
              <>
                <path d={linha} fill="none" stroke="var(--s-eto)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="linha-desenha" style={{ ['--len' as string]: compr * 2 }} />
                {dias.length <= 31 && dias.map((d, i) => <circle key={d.data} cx={cx(i)} cy={y(d.etoMm)} r={hover === i ? 5 : 3.5} fill="var(--s-eto)" className="stroke-white dark:stroke-slate-900" strokeWidth="2" />)}
              </>
            )}
            {dias.map((d, i) => <rect key={d.data} x={L + bw * i} y={T} width={bw} height={ih + B} fill="transparent" onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />)}
          </svg>
          {h && hover != null && (
            <div className="tip" style={{ left: Math.min(Math.max(cx(hover) - 70, 4), W - 150), top: 6 }}>
              <div className="mb-1 font-semibold">{dataBR(h.data)}</div>
              {SERIES.filter((s) => ativas[s.id]).map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-4"><span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: s.cor }} />{s.rotulo}</span><b className="tabular-nums">{fmt(valor(h, s.id))} mm</b></div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- sparkline ----------
export function Spark({ valores, cor = 'var(--s-irr)', altura = 34 }: { valores: number[]; cor?: string; altura?: number }) {
  const w = 120;
  const max = Math.max(0.0001, ...valores);
  const pts = valores.map((v, i) => [(i / Math.max(1, valores.length - 1)) * w, altura - 3 - (v / max) * (altura - 8)] as const);
  if (valores.length < 2) return null;
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const ultimo = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${altura}`} className="h-8 w-full" preserveAspectRatio="none" aria-hidden>
      <path d={`${d} L${w},${altura} L0,${altura} Z`} fill={cor} opacity=".14" />
      <path d={d} fill="none" stroke={cor} strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className="linha-desenha" style={{ ['--len' as string]: 400 }} />
      <circle cx={ultimo[0]} cy={ultimo[1]} r="2.6" fill={cor} />
    </svg>
  );
}

// ---------- medidor de lâmina: preenchimento = lâmina, marca = limite de segurança, fundo = capacidade ----------
export function Medidor({ lamina, limite, cap, status }: { lamina: number; limite: number; cap: number; status?: Status }) {
  const st = status ?? statusDe(lamina, limite, cap);
  const cor = COR_STATUS[st];
  const frac = (v: number) => `${Math.max(0, Math.min(100, (v / Math.max(cap, 1)) * 100))}%`;
  return (
    <div className="relative h-3 rounded-full bg-slate-200/80 dark:bg-slate-700/70" role="img" aria-label={`Lâmina ${fmt(lamina)} mm de ${fmt(cap)} mm; limite ${fmt(limite)} mm`}>
      <div className="barra-h absolute inset-y-0 left-0 rounded-full" style={{ width: frac(lamina), background: `linear-gradient(90deg, ${cor}aa, ${cor})`, boxShadow: `0 0 10px ${cor}66` }} />
      <div className="absolute -inset-y-1 w-0.5 rounded bg-slate-900/70 dark:bg-white/80" style={{ left: frac(limite) }} title={`Limite de segurança ${fmt(limite)} mm`} />
    </div>
  );
}

// ---------- linha do tempo do dia: janelas de energia (faixa) e pivôs programados (barras) ----------
const minLocal = (iso: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
};
const hh = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export function LinhaDoDia({ data, itens, janelas }: { data: string; itens: ItemOrdem[]; janelas: Janela[] }) {
  const [ref, W] = useLargura<HTMLDivElement>();
  const [agora, setAgora] = useState(() => minLocal(new Date().toISOString()));
  useEffect(() => { const t = setInterval(() => setAgora(minLocal(new Date().toISOString())), 30_000); return () => clearInterval(t); }, []);

  const dow = new Date(`${data}T12:00:00Z`).getUTCDay();
  const faixas = useMemo(() => {
    const f: [number, number][] = [];
    for (const j of janelas) {
      const a = mins(j.inicio), b = mins(j.fim);
      if (a === b) { if (j.dias.includes(dow)) f.push([0, 1440]); }
      else if (a < b) { if (j.dias.includes(dow)) f.push([a, b]); }
      else { if (j.dias.includes(dow)) f.push([a, 1440]); if (j.dias.includes((dow + 6) % 7)) f.push([0, b]); }
    }
    return f;
  }, [janelas, dow]);

  const L = 96, R = 12, T = 34, linhaH = 30;
  const ativos = itens.filter((i) => i.status !== 'cancelada' && i.inicio && i.fim);
  const hoje = ativos.map((i) => ({ i, a: minLocal(i.inicio!), b: minLocal(i.fim!) })).filter((x) => x.a.data === data);
  const outros = ativos.filter((i) => minLocal(i.inicio!).data !== data);
  const H = T + Math.max(1, hoje.length) * linhaH + 22;
  const iw = Math.max(200, W - L - R);
  const x = (m: number) => L + (m / 1440) * iw;
  const sem = janelas.length === 0;

  return (
    <div ref={ref} className="space-y-2">
      <svg width={W} height={H} role="img" aria-label="Programação do dia em linha do tempo">
        {faixas.map(([a, b], k) => <rect key={k} x={x(a)} y={T - 6} width={x(b) - x(a)} height={H - T - 10} rx="6" fill="#10b981" opacity=".13" />)}
        {sem && <rect x={L} y={T - 6} width={iw} height={H - T - 10} rx="6" fill="#10b981" opacity=".07" />}
        {Array.from({ length: 9 }, (_, k) => k * 3).map((h3) => (
          <g key={h3}><line x1={x(h3 * 60)} x2={x(h3 * 60)} y1={T - 6} y2={H - 16} stroke="var(--grade)" strokeDasharray="2 4" /><text x={x(h3 * 60)} y={H - 4} textAnchor="middle" className="fill-slate-500 text-[10px]">{String(h3 % 24).padStart(2, '0')}h</text></g>
        ))}
        {hoje.map(({ i, a, b }, k) => {
          const fim = b.data === data ? b.min : 1440;
          const w = Math.max(6, x(fim) - x(a.min));
          const cor = i.status === 'enviada' ? '#0891b2' : i.status === 'concluida' ? '#64748b' : 'var(--s-irr)';
          const yy = T + k * linhaH;
          return (
            <g key={i.id}>
              <text x={L - 8} y={yy + 14} textAnchor="end" className="fill-current text-[11px] font-medium">{i.pivoNome.replace('PIVÔ', 'Pivô')}</text>
              <rect x={x(a.min)} y={yy} width={w} height={20} rx="6" fill={cor} opacity=".9" className="barra-h" style={{ animationDelay: `${k * 90}ms`, transformOrigin: `${x(a.min)}px 0` }} />
              <text x={x(a.min) + 7} y={yy + 14} className="fill-white text-[10px] font-semibold">{w > 90 ? `${hh(a.min)} → ${fim >= 1440 ? '24:00+' : hh(fim)}  ${i.sentido === 0 ? '↻' : i.sentido === 1 ? '↺' : ''}` : ''}</text>
            </g>
          );
        })}
        {hoje.length === 0 && <text x={L} y={T + 14} className="fill-slate-500 text-[12px]">Nenhum pivô programado para hoje.</text>}
        {agora.data === data && (
          <g>
            <line x1={x(agora.min)} x2={x(agora.min)} y1={T - 12} y2={H - 16} stroke="#ef4444" strokeWidth="1.5" />
            <circle cx={x(agora.min)} cy={T - 12} r="3.5" fill="#ef4444"><animate attributeName="r" values="3;6;3" dur="1.8s" repeatCount="indefinite" /></circle>
            <text x={x(agora.min)} y={T - 16} textAnchor={agora.min > 1200 ? 'end' : 'start'} dx={agora.min > 1200 ? -6 : 6} className="fill-red-500 text-[10px] font-semibold">agora {hh(agora.min)}</text>
          </g>
        )}
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-4 rounded-sm bg-emerald-500/30" />{sem ? 'Sem restrição de horário' : 'Horário de energia permitido'}</span>
        <span>↻ frente · ↺ reverso</span>
        {outros.length > 0 && <span className="text-amber-600">Continua em outro dia: {outros.map((i) => i.pivoNome).join(', ')}</span>}
      </div>
    </div>
  );
}
