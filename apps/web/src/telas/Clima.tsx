import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { api, dataBR, fmt, hojeLocal } from '../api';
import { haQuanto } from '../hooks';
import type { Fazenda, Usuario } from '../tipos';
import { Numero } from '../ui';

interface Leitura { data: string; temp_min: number | null; temp_max: number | null; umidade: number | null; chuva_mm: number; vento_ms: number | null; radiacao_mj: number | null; eto_mm: number | null; metodo_eto: string | null; origem: string }
interface Status { configurada: boolean; api_key?: string; station_id?: string | null; altura_vento_m?: number; ultima_sincronizacao?: string | null; ultimo_erro?: string | null; estacao?: string }
interface Teste { estacoes: { station_id: string; nome: string; latitude: number | null; longitude: number | null }[]; leitura_atual: { temperaturaC?: number | null; umidade?: number | null; erro?: string } | null }
interface Agora { estacao: string | null; ultima: { ts: string; temp_c: number | null; umidade: number | null; vento_ms: number | null; radiacao_wm2: number | null; chuva_dia_mm: number | null } | null; hoje: { tmin: number | null; tmax: number | null; chuva_mm: number | null; amostras: number; desde: string | null } | null }

const VAZIO = { tmin: '', tmax: '', umid: '', chuva: '0', vento: '', rad: '' };
const TEMP = '#eb6834', UMID = '#2a78d6', VENTO = '#64748b', RAD = '#f59e0b', CHUVA = 'var(--s-chuva)', ETO = 'var(--s-eto)';
const AMOSTRAS_DIA = 100; // o resumo do dia só vale com 100 leituras ou mais

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

function Kpi({ rotulo, valor, casas = 0, unidade, sub, cor, progresso, atraso }: { rotulo: string; valor: number | null; casas?: number; unidade?: string; sub?: string; cor: string; progresso?: number | null; atraso: number }) {
  return (
    <div className="vidro vidro-forte surge p-4" style={{ animationDelay: `${atraso}ms`, ['--cor' as string]: cor } as CSSProperties}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: cor, boxShadow: `0 0 16px ${cor}` }} />
      <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-slate-500 dark:text-slate-400">{rotulo}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="num-grande text-3xl sm:text-4xl" style={{ color: cor }}>{valor == null ? '—' : <Numero valor={valor} casas={casas} />}</span>
        {unidade && <span className="text-sm text-slate-500">{unidade}</span>}
      </div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
      {progresso != null && (
        <div className="mt-2 h-1.5 rounded-full bg-slate-200/80 dark:bg-slate-700" aria-hidden>
          <div className="barra-h h-full rounded-full" style={{ width: `${Math.round(Math.max(0, Math.min(1, progresso)) * 100)}%`, background: cor, boxShadow: `0 0 8px ${cor}` }} />
        </div>
      )}
    </div>
  );
}

/** Chuva (barras) e ETo (linha) dos últimos dias, num só eixo em mm. */
function GraficoClima({ leituras }: { leituras: Leitura[] }) {
  const dias = [...leituras].sort((a, b) => a.data.localeCompare(b.data));
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 200, L = 34, R = 10, T = 14, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const max = Math.max(1, ...dias.map((d) => Math.max(d.chuva_mm, d.eto_mm ?? 0))) * 1.1;
  const bw = iw / Math.max(1, dias.length);
  const y = (v: number) => T + ih - (v / max) * ih;
  const cx = (i: number) => L + bw * i + bw / 2;
  const pts = dias.map((d, i) => (d.eto_mm != null ? { x: cx(i), y: y(d.eto_mm) } : null));
  let linha = '';
  pts.forEach((p, i) => { if (p) linha += `${linha && pts[i - 1] ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`; });
  const h = hover != null ? dias[hover] : null;
  const passo = Math.max(1, Math.ceil(dias.length / 8));
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-52 w-full" role="img" aria-label="Chuva e ETo por dia" onMouseLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75, 1].map((k) => <g key={k}><line x1={L} x2={W - R} y1={y(max * k)} y2={y(max * k)} stroke="var(--grade)" strokeDasharray="2 4" /><text x={L - 4} y={y(max * k) + 3} textAnchor="end" className="fill-slate-500 text-[9px]">{fmt(max * k, 0)}</text></g>)}
        {dias.map((d, i) => (
          <g key={d.data} onMouseEnter={() => setHover(i)}>
            <rect x={L + bw * i} y={T} width={bw} height={ih} fill="transparent" />
            {d.chuva_mm > 0 && <rect x={cx(i) - Math.min(bw * 0.35, 12)} y={y(d.chuva_mm)} width={Math.min(bw * 0.7, 24)} height={ih + T - y(d.chuva_mm)} rx="3" fill={CHUVA} opacity={hover === i ? 1 : 0.8} className="barra-v" style={{ animationDelay: `${i * 25}ms` }} />}
            {i % passo === 0 && <text x={cx(i)} y={H - 8} textAnchor="middle" className="fill-slate-500 text-[9px]">{dataBR(d.data).slice(0, 5)}</text>}
          </g>
        ))}
        {linha && <path d={linha} fill="none" stroke={ETO} strokeWidth="2.5" strokeLinejoin="round" className="linha-desenha" style={{ ['--len' as string]: 1400 }} />}
        {pts.map((p, i) => p && <circle key={i} cx={p.x} cy={p.y} r={hover === i ? 5 : 3} fill={ETO} stroke="#fff" strokeWidth="1.5" />)}
        {h && <line x1={cx(hover!)} x2={cx(hover!)} y1={T} y2={T + ih} stroke="currentColor" strokeOpacity=".3" />}
      </svg>
      {h && (
        <div className="tip left-1/2 top-2 -translate-x-1/2">
          <b>{dataBR(h.data)}</b> · ETo <b style={{ color: ETO }}>{fmt(h.eto_mm, 2)} mm</b> · chuva <b style={{ color: CHUVA }}>{fmt(h.chuva_mm)} mm</b>{h.temp_min != null ? ` · ${fmt(h.temp_min, 0)}–${fmt(h.temp_max, 0)} °C` : ''}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CHUVA }} />Chuva (mm)</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-0.5 w-4" style={{ background: ETO }} />ETo (mm/dia)</span>
      </div>
    </div>
  );
}

/** Faixa de temperatura de cada dia: barra vertical da mínima à máxima. */
function Temperaturas({ leituras }: { leituras: Leitura[] }) {
  const dias = [...leituras].sort((a, b) => a.data.localeCompare(b.data)).filter((d) => d.temp_min != null && d.temp_max != null);
  if (dias.length === 0) return <p className="text-sm text-slate-500">Sem temperaturas registradas.</p>;
  const lo = Math.floor(Math.min(...dias.map((d) => d.temp_min!)) - 2), hi = Math.ceil(Math.max(...dias.map((d) => d.temp_max!)) + 2);
  const H = 120;
  const y = (t: number) => ((hi - t) / (hi - lo)) * H;
  return (
    <div className="flex items-end gap-1 overflow-x-auto pb-1">
      {dias.map((d, i) => (
        <div key={d.data} className="flex min-w-[1.6rem] flex-1 flex-col items-center" title={`${dataBR(d.data)} — mín ${fmt(d.temp_min)} °C · máx ${fmt(d.temp_max)} °C`}>
          <span className="text-[9px] tabular-nums" style={{ color: TEMP }}>{fmt(d.temp_max, 0)}</span>
          <div className="relative w-2.5" style={{ height: H }}>
            <div className="barra-v absolute inset-x-0 rounded-full" style={{ top: y(d.temp_max!), height: Math.max(4, y(d.temp_min!) - y(d.temp_max!)), background: `linear-gradient(${TEMP}, ${UMID})`, boxShadow: `0 0 6px ${TEMP}55`, animationDelay: `${i * 30}ms`, transformOrigin: 'center bottom' }} />
          </div>
          <span className="text-[9px] tabular-nums" style={{ color: UMID }}>{fmt(d.temp_min, 0)}</span>
          <span className="mt-0.5 text-[9px] text-slate-500">{dataBR(d.data).slice(0, 5)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- integração WeatherLink ---------------- */
function IntegracaoWeatherLink({ fazenda, st }: { fazenda: Fazenda; st: Status | undefined }) {
  const qc = useQueryClient();
  const [apiKey, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [station, setStation] = useState('');
  const [altura, setAltura] = useState('2');
  const [teste, setTeste] = useState<Teste | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const base = `/fazendas/${fazenda.id}/integracao/weatherlink`;
  const erro = (e: Error) => setMsg({ ok: false, texto: e.message });
  const configurada = st?.configurada;
  const chave = apiKey.trim() || '';

  const testar = useMutation({
    mutationFn: () => api<Teste>(`${base}/testar`, { corpo: { api_key: chave, ...(secret.trim() ? { api_secret: secret.trim() } : {}), ...(station ? { station_id: station } : {}) } }),
    onSuccess: (r) => {
      setTeste(r);
      if (!station && r.estacoes.length === 1) setStation(r.estacoes[0].station_id);
      const l = r.leitura_atual;
      setMsg({ ok: true, texto: `Conectado. ${r.estacoes.length} estação(ões) na conta.${l && !l.erro && l.temperaturaC != null ? ` Agora: ${fmt(l.temperaturaC)} °C, ${fmt(l.umidade ?? null, 0)}% UR.` : ''}` });
    },
    onError: erro,
  });
  const salvar = useMutation({
    mutationFn: () => api(base, { method: 'PUT', corpo: { api_key: chave, ...(secret.trim() ? { api_secret: secret.trim() } : {}), station_id: station || null, altura_vento_m: Number(altura.replace(',', '.')) } }),
    onSuccess: () => { setSecret(''); setMsg({ ok: true, texto: 'Integração salva. O segredo fica guardado cifrado no servidor.' }); qc.invalidateQueries({ queryKey: ['wl'] }); qc.invalidateQueries({ queryKey: ['clima-agora'] }); },
    onError: erro,
  });
  const sincronizar = useMutation({
    mutationFn: () => api<{ gravados: number; fonte: string; sem_dados: string[] }>(`${base}/sincronizar`, { corpo: { dias: 14 } }),
    onSuccess: (r) => {
      setMsg({
        ok: true,
        texto: r.gravados > 0
          ? `${r.gravados} dia(s) importado(s) ${r.fonte === 'historico' ? 'do histórico da estação' : 'das leituras coletadas'}. O balanço já usa esses dados.`
          : 'Nenhum dia fechado ainda. Plano Basic não fornece histórico: o app coleta a leitura atual a cada 10 minutos e o primeiro dia completo fica pronto amanhã.',
      });
      qc.invalidateQueries({ queryKey: ['wl'] }); qc.invalidateQueries({ queryKey: ['clima'] }); qc.invalidateQueries({ queryKey: ['preciso'] });
    },
    onError: erro,
  });

  return (
    <Painel atraso={0} titulo="Estação WeatherLink (Davis)" sub="No weatherlink.com, abra Conta e clique em Gerar chave v2. Cole aqui a API Key e o API Secret (não use a senha do login). O app coleta a leitura a cada 10 minutos e fecha o resumo de cada dia sozinho; com plano Pro usa também o histórico."
      extra={configurada ? <span className="chip cursor-default" style={{ borderColor: st?.ultimo_erro ? '#dc2626' : '#059669', color: st?.ultimo_erro ? '#dc2626' : '#059669' }}><i className="h-2 w-2 rounded-full" style={{ background: st?.ultimo_erro ? '#dc2626' : '#059669' }} />{st?.ultimo_erro ? 'com erro' : 'ligada'}</span> : <span className="chip cursor-default">não configurada</span>}>
      {configurada && (
        <p className="mb-3 text-sm text-slate-500">
          Estação {st?.station_id ?? '—'} · chave {st?.api_key} · última sincronização {st?.ultima_sincronizacao ? new Date(st.ultima_sincronizacao).toLocaleString('pt-BR') : 'nunca'}
          {st?.ultimo_erro && <span className="block text-red-600">{st.ultimo_erro}</span>}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="rotulo" htmlFor="wlk">API Key v2</label><input id="wlk" className="campo" autoComplete="off" value={apiKey} onChange={(e) => setKey(e.target.value)} /></div>
        <div><label className="rotulo" htmlFor="wls">API Secret {configurada && '(deixe em branco para manter o salvo)'}</label><input id="wls" type="password" className="campo" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} /></div>
        <div>
          <label className="rotulo" htmlFor="wlst">Estação</label>
          <select id="wlst" className="campo" value={station} onChange={(e) => setStation(e.target.value)}>
            <option value="">{teste ? 'Selecione…' : 'Clique em “Testar conexão” para listar'}</option>
            {teste?.estacoes.map((e) => <option key={e.station_id} value={e.station_id}>{e.nome} (#{e.station_id})</option>)}
          </select>
        </div>
        <div><label className="rotulo" htmlFor="wla">Altura do anemômetro (m)</label><input id="wla" className="campo" inputMode="decimal" value={altura} onChange={(e) => setAltura(e.target.value)} /></div>
      </div>
      {msg && <p role="status" className={`mt-2 text-sm ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{msg.texto}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-sec" disabled={!chave || (!secret.trim() && !configurada) || testar.isPending} onClick={() => testar.mutate()}>{testar.isPending ? 'Testando…' : 'Testar conexão'}</button>
        <button className="btn" disabled={!chave || !station || (!secret.trim() && !configurada) || salvar.isPending} onClick={() => salvar.mutate()}>Salvar</button>
        {configurada && st?.station_id && <button className="btn-sec" disabled={sincronizar.isPending} onClick={() => sincronizar.mutate()}>{sincronizar.isPending ? 'Importando…' : 'Importar últimos 14 dias'}</button>}
      </div>
    </Painel>
  );
}

/* ---------------- tela ---------------- */
export default function Clima({ fazenda, usuario }: { fazenda: Fazenda; usuario: Usuario }) {
  const qc = useQueryClient();
  const podeEditar = usuario.papel !== 'operador';
  const q = useQuery({ queryKey: ['clima', fazenda.id], queryFn: () => api<Leitura[]>(`/fazendas/${fazenda.id}/clima`) });
  const agora = useQuery({ queryKey: ['clima-agora', fazenda.id], queryFn: () => api<Agora>(`/fazendas/${fazenda.id}/clima-agora`), refetchInterval: 60_000 });
  const st = useQuery({ queryKey: ['wl', fazenda.id], queryFn: () => api<Status>(`/fazendas/${fazenda.id}/integracao/weatherlink`), enabled: podeEditar });
  const [configurar, setConfigurar] = useState(false);
  const [lancar, setLancar] = useState(false);
  const [data, setData] = useState(hojeLocal());
  const [f, setF] = useState(VAZIO);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));

  const salvar = useMutation({
    mutationFn: () => api<{ eto_mm: number; metodo: string }>('/clima', { corpo: { fazenda_id: fazenda.id, data, temp_min: num(f.tmin), temp_max: num(f.tmax), umidade: num(f.umid), chuva_mm: num(f.chuva) ?? 0, vento_ms: num(f.vento), radiacao_mj: num(f.rad) } }),
    onSuccess: (r) => {
      setMsg({ ok: true, texto: `Leitura salva. ETo calculada: ${fmt(r.eto_mm, 2)} mm/dia (${r.metodo === 'penman-monteith' ? 'Penman-Monteith' : 'Hargreaves, estimada — faltou vento ou radiação'}).` });
      setF(VAZIO);
      qc.invalidateQueries({ queryKey: ['clima', fazenda.id] });
      qc.invalidateQueries({ queryKey: ['preciso'] });
    },
    onError: (e: Error) => setMsg({ ok: false, texto: e.message }),
  });
  function enviar(e: FormEvent) { e.preventDefault(); setMsg(null); salvar.mutate(); }
  const campo = (id: keyof typeof VAZIO, rotulo: string, obrig = false) => (
    <div><label className="rotulo" htmlFor={id}>{rotulo}</label><input id={id} className="campo" inputMode="decimal" value={f[id]} required={obrig} onChange={(e) => setF({ ...f, [id]: e.target.value })} /></div>
  );

  const leituras = q.data ?? [];
  const a = agora.data;
  const u = a?.ultima;
  const online = !!u && Date.now() - Date.parse(u.ts) < 30 * 60_000;
  const resumo = useMemo(() => {
    const n = leituras.length;
    const eto = leituras.filter((l) => l.eto_mm != null);
    return { n, chuva: leituras.reduce((s, l) => s + l.chuva_mm, 0), etoMedia: eto.length ? eto.reduce((s, l) => s + l.eto_mm!, 0) / eto.length : null, estimados: leituras.filter((l) => l.metodo_eto === 'hargreaves').length, ultima: n ? leituras[0] : null };
  }, [leituras]);
  const mostrarConfig = podeEditar && (configurar || st.data?.configurada === false);

  const destaques: { t: string; cor: string }[] = [];
  if (a?.estacao) destaques.push(online ? { t: `${a.estacao} online · leitura ${haQuanto(u!.ts)}`, cor: '#059669' } : { t: `${a.estacao} sem leitura recente${u ? ` (última ${haQuanto(u.ts)})` : ''}`, cor: '#dc2626' });
  else destaques.push({ t: 'Nenhuma estação ligada: as leituras entram à mão', cor: '#f59e0b' });
  if (a?.hoje && a.hoje.amostras > 0) destaques.push(a.hoje.amostras >= AMOSTRAS_DIA ? { t: `Hoje já tem ${a.hoje.amostras} leituras: o dia fecha com ETo`, cor: '#059669' } : { t: `Hoje com ${a.hoje.amostras} de ${AMOSTRAS_DIA} leituras para fechar o dia`, cor: '#0891b2' });
  if (resumo.ultima) destaques.push({ t: `Último dia fechado: ${dataBR(resumo.ultima.data)} · ETo ${fmt(resumo.ultima.eto_mm, 2)} mm`, cor: ETO });
  if (resumo.estimados) destaques.push({ t: `${resumo.estimados} dia${resumo.estimados > 1 ? 's' : ''} com ETo estimada (Hargreaves)`, cor: '#f59e0b' });

  return (
    <div className="viz space-y-4">
      {/* barra de comando */}
      <div className="vidro vidro-forte surge flex flex-wrap items-center gap-3 p-4">
        <div className="mr-auto">
          <h1 className="flex items-center gap-2 text-lg font-bold"><span className={online ? 'ponto-vivo' : 'h-2.5 w-2.5 rounded-full bg-slate-400'} aria-hidden /> Clima</h1>
          <p className="text-xs text-slate-500">{fazenda.nome}{a?.estacao ? ` · ${a.estacao}` : ''} · ETo Penman-Monteith (FAO-56) com Hargreaves como alternativa · fuso de Campo Grande</p>
        </div>
        {podeEditar && <button className="chip" aria-pressed={lancar} onClick={() => setLancar(!lancar)}>✎ Lançar leitura</button>}
        {podeEditar && st.data?.configurada && <button className="chip" aria-pressed={configurar} onClick={() => setConfigurar(!configurar)}>⚙ Estação</button>}
      </div>

      {/* destaques */}
      <div className="flex flex-wrap gap-2 surge" style={{ animationDelay: '40ms' }}>
        {destaques.map((x) => (
          <span key={x.t} className="inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 text-xs font-medium backdrop-blur dark:border-slate-700 dark:bg-slate-900/50">
            <i className="h-2 w-2 rounded-full" style={{ background: x.cor, boxShadow: `0 0 8px ${x.cor}` }} />{x.t}
          </span>
        ))}
      </div>

      {mostrarConfig && <IntegracaoWeatherLink fazenda={fazenda} st={st.data} />}

      {/* ao vivo */}
      {a?.estacao && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi atraso={60} rotulo="Temperatura" valor={u?.temp_c ?? null} casas={1} unidade="°C" sub={a.hoje && a.hoje.amostras > 0 ? `hoje ${fmt(a.hoje.tmin)}–${fmt(a.hoje.tmax)} °C` : 'agora'} cor={TEMP} progresso={u?.temp_c != null ? u.temp_c / 45 : null} />
            <Kpi atraso={100} rotulo="Umidade" valor={u?.umidade ?? null} unidade="%" sub="do ar" cor={UMID} progresso={u?.umidade != null ? u.umidade / 100 : null} />
            <Kpi atraso={140} rotulo="Vento" valor={u?.vento_ms != null ? u.vento_ms * 3.6 : null} casas={1} unidade="km/h" sub={u?.vento_ms != null ? `${fmt(u.vento_ms)} m/s` : 'agora'} cor={VENTO} progresso={u?.vento_ms != null ? (u.vento_ms * 3.6) / 40 : null} />
            <Kpi atraso={180} rotulo="Radiação" valor={u?.radiacao_wm2 ?? null} unidade="W/m²" sub="solar agora" cor={RAD} progresso={u?.radiacao_wm2 != null ? u.radiacao_wm2 / 1100 : null} />
            <div className="col-span-2 lg:col-span-1"><Kpi atraso={220} rotulo="Chuva hoje" valor={u?.chuva_dia_mm ?? null} casas={1} unidade="mm" sub="acumulado do dia" cor={CHUVA} /></div>
          </div>
          {a.hoje && a.hoje.amostras > 0 && (
            <div className="vidro surge flex flex-wrap items-center gap-3 px-4 py-3 text-sm" style={{ animationDelay: '240ms' }}>
              <span className="text-slate-600 dark:text-slate-300">Fechamento de hoje</span>
              <div className="h-2 min-w-[8rem] flex-1 rounded-full bg-slate-200/80 dark:bg-slate-700"><div className="barra-h h-full rounded-full" style={{ width: `${Math.min(100, (a.hoje.amostras / AMOSTRAS_DIA) * 100)}%`, background: a.hoje.amostras >= AMOSTRAS_DIA ? '#059669' : '#0891b2' }} /></div>
              <span className="text-xs tabular-nums text-slate-500">{a.hoje.amostras} / {AMOSTRAS_DIA} leituras desde {a.hoje.desde ? new Date(a.hoje.desde).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Campo_Grande' }) : '—'} · o resumo do dia e a ETo entram no balanço quando o dia fecha</span>
            </div>
          )}
        </>
      )}

      {/* lançamento manual */}
      {podeEditar && lancar && (
        <form onSubmit={enviar} className="surge space-y-3 rounded-xl border border-cyan-500/40 bg-cyan-500/5 p-4 shadow-[0_0_24px_rgb(8_145_178/.15)]">
          <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">Leitura manual do dia</h3><button type="button" className="chip" onClick={() => setLancar(false)}>Fechar</button></div>
          <div className="grid gap-3 sm:grid-cols-4">
            <div><label className="rotulo" htmlFor="dt">Data</label><input id="dt" type="date" className="campo" value={data} max={hojeLocal()} onChange={(e) => setData(e.target.value)} required /></div>
            {campo('tmin', 'Temp. mín (°C)', true)}{campo('tmax', 'Temp. máx (°C)', true)}{campo('umid', 'Umidade (%)')}
            {campo('chuva', 'Chuva (mm)')}{campo('vento', 'Vento a 2 m (m/s)')}{campo('rad', 'Radiação (MJ/m²/dia)')}
          </div>
          <p className="text-xs text-slate-500">Com vento e radiação o cálculo é Penman-Monteith (FAO-56). Sem eles usa Hargreaves (só temperatura) e marca como estimada. Lançar sobre um dia existente substitui a leitura.</p>
          {msg && <p role="status" className={`text-sm ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{msg.texto}</p>}
          <button className="btn" disabled={salvar.isPending}>{salvar.isPending ? 'Salvando…' : 'Salvar leitura'}</button>
        </form>
      )}

      {/* histórico */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi atraso={260} rotulo="Dias fechados" valor={resumo.n} unidade="de 20" sub="com resumo diário" cor="var(--s-irr)" progresso={resumo.n / 20} />
        <Kpi atraso={300} rotulo="ETo média" valor={resumo.etoMedia} casas={2} unidade="mm/dia" sub="nos dias fechados" cor={ETO} />
        <Kpi atraso={340} rotulo="Chuva" valor={resumo.chuva} casas={1} unidade="mm" sub="soma dos dias fechados" cor={CHUVA} />
        <Kpi atraso={380} rotulo="Estimados" valor={resumo.estimados} unidade="dias" sub="ETo por Hargreaves" cor={resumo.estimados ? '#f59e0b' : '#64748b'} />
      </div>

      {q.isLoading && <div className="esqueleto h-52 rounded-2xl" />}
      {!q.isLoading && leituras.length === 0 && <p className="vidro p-4 text-sm text-slate-500">Nenhum dia fechado nos últimos 20 dias. {a?.estacao ? 'A estação está coletando: o primeiro resumo diário aparece quando um dia fecha com leituras suficientes.' : podeEditar ? 'Ligue a estação WeatherLink ou lance a leitura do dia à mão.' : ''}</p>}

      {leituras.length > 0 && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Painel className="lg:col-span-2" atraso={400} titulo="ETo e chuva · últimos 20 dias" sub="Linha = consumo de referência (ETo). Barras = chuva. Passe o mouse sobre um dia.">
              <GraficoClima leituras={leituras} />
            </Painel>
            <Painel atraso={440} titulo="Temperaturas" sub="Da mínima (azul) à máxima (laranja) de cada dia.">
              <Temperaturas leituras={leituras} />
            </Painel>
          </div>
          <Painel atraso={480} titulo="Leituras diárias" sub="Um dia por linha, do mais recente ao mais antigo.">
            <div className="overflow-x-auto">
              <table className="tabela">
                <thead><tr><th>Data</th><th className="num">Mín</th><th className="num">Máx</th><th className="num">UR %</th><th className="num">Chuva</th><th className="num">Vento</th><th className="num">Rad.</th><th className="num">ETo (mm)</th><th>Método</th><th>Origem</th></tr></thead>
                <tbody>
                  {leituras.map((l, i) => (
                    <tr key={l.data} className="surge" style={{ animationDelay: `${Math.min(i, 10) * 20}ms` }}>
                      <td className="font-medium">{dataBR(l.data)}</td><td className="num">{fmt(l.temp_min)}</td><td className="num">{fmt(l.temp_max)}</td><td className="num">{fmt(l.umidade, 0)}</td>
                      <td className="num" style={{ color: l.chuva_mm > 0 ? CHUVA : undefined }}>{fmt(l.chuva_mm)}</td><td className="num">{fmt(l.vento_ms)}</td><td className="num">{fmt(l.radiacao_mj)}</td>
                      <td className="num font-semibold" style={{ color: ETO }}>{fmt(l.eto_mm, 2)}</td>
                      <td>{l.metodo_eto === 'penman-monteith' ? <span className="chip cursor-default !py-0.5 text-[10px]">Penman-Monteith</span> : l.metodo_eto === 'hargreaves' ? <span className="chip cursor-default border-amber-500 !py-0.5 text-[10px] text-amber-700 dark:text-amber-300">Hargreaves · estimada</span> : '–'}</td>
                      <td className="text-xs text-slate-500">{l.origem}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Painel>
        </>
      )}
    </div>
  );
}
