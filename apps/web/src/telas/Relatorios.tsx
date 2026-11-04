import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { api, dataBR, fmt, hhmm, hojeLocal } from '../api';
import { GraficoDias, LinhaDoDia, Medidor, Spark } from '../graficos';
import { haQuanto } from '../hooks';
import { COR_STATUS, ROTULO_STATUS, type Fazenda, type Relatorio, type Status } from '../tipos';
import { statusDe } from '../cores';
import { Numero } from '../ui';
import { LogoVertente } from '../Logo';

const somarDias = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TIPO_ALERTA: Record<string, { t: string; grave: boolean }> = {
  alarme: { t: 'Alarme do pivô', grave: true }, sem_sinal: { t: 'Sem comunicação', grave: false }, parado_precisa: { t: 'Parado precisando irrigar', grave: true },
  fora_horario: { t: 'Irrigando fora do horário', grave: true }, irrigando_ocupado: { t: 'Irrigando sobre animais', grave: true },
};

function csv(nome: string, cab: string[], linhas: (string | number | null)[][]) {
  const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const txt = [cab, ...linhas].map((l) => l.map(esc).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + txt], { type: 'text/csv;charset=utf-8' }));
  Object.assign(document.createElement('a'), { href: url, download: `${nome}.csv` }).click();
  URL.revokeObjectURL(url);
}

function Painel({ titulo, sub, aoCsv, atraso = 0, className = '', children }: { titulo: string; sub?: string; aoCsv?: () => void; atraso?: number; className?: string; children: ReactNode }) {
  return (
    <section className={`vidro surge p-4 ${className}`} style={{ animationDelay: `${atraso}ms` }}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div><h2 className="titulo-secao">{titulo}</h2>{sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}</div>
        {aoCsv && <button className="chip print:hidden" onClick={aoCsv} aria-label={`Baixar ${titulo} em CSV`}>⭳ CSV</button>}
      </header>
      {children}
    </section>
  );
}

function Kpi({ rotulo, valor, casas = 0, unidade, sub, cor, serie, atraso }: { rotulo: string; valor: number; casas?: number; unidade?: string; sub?: string; cor: string; serie?: number[]; atraso: number }) {
  return (
    <div className="vidro vidro-forte surge p-4" style={{ animationDelay: `${atraso}ms`, ['--cor' as string]: cor } as CSSProperties}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: cor, boxShadow: `0 0 16px ${cor}` }} />
      <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-slate-500 dark:text-slate-400">{rotulo}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="num-grande text-3xl sm:text-4xl" style={{ color: cor }}><Numero valor={valor} casas={casas} /></span>
        {unidade && <span className="text-sm text-slate-500">{unidade}</span>}
      </div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
      {serie && <div className="mt-2"><Spark valores={serie} cor={cor} /></div>}
    </div>
  );
}

function Nota({ n }: { n: number | null }) {
  if (n == null) return <span className="text-xs text-slate-400">sem nota</span>;
  return (
    <span className="inline-flex items-center gap-0.5" title={`Nota média ${fmt(n)} de 5`}>
      {[1, 2, 3, 4, 5].map((k) => <i key={k} className="h-2 w-3.5 rounded-sm" style={{ background: n >= k - 0.25 ? (n >= 4 ? '#10b981' : n >= 3 ? '#f59e0b' : '#ef4444') : 'rgb(148 163 184 / .3)' }} />)}
      <b className="ml-1.5 text-xs tabular-nums">{fmt(n)}</b>
    </span>
  );
}

export default function Relatorios({ fazenda }: { fazenda: Fazenda }) {
  const [ate, setAte] = useState(hojeLocal());
  const [de, setDe] = useState(() => somarDias(hojeLocal(), -6));
  const [filtro, setFiltro] = useState<Status | null>(null);
  const r = useQuery({
    queryKey: ['relatorio', fazenda.id, de, ate],
    queryFn: () => api<Relatorio>(`/fazendas/${fazenda.id}/relatorio?de=${de}&ate=${ate}`),
    enabled: de <= ate,
    placeholderData: (a) => a,
    refetchInterval: 60_000,
  });
  const d = r.data;
  const nDias = Math.round((Date.parse(ate) - Date.parse(de)) / 86_400_000) + 1;
  const rapido = (n: number) => { setAte(hojeLocal()); setDe(somarDias(hojeLocal(), -(n - 1))); };

  const situacao = useMemo(() => {
    const l = (d?.situacao ?? []).map((s) => ({ ...s, st: (s.status ?? statusDe(s.laminaMm, s.limiteMm, s.capMm)) as Status }));
    const peso: Record<Status, number> = { irrigar: 0, atencao: 1, ok: 2 };
    return l.sort((a, b) => peso[a.st] - peso[b.st] || (a.laminaMm - a.limiteMm) - (b.laminaMm - b.limiteMm));
  }, [d]);
  const contagem = (s: Status) => situacao.filter((x) => x.st === s).length;
  const maxLamina = Math.max(1, ...(d?.irrigacao ?? []).map((i) => i.laminaMm));
  const maxDias = Math.max(0.1, ...(d?.pastejo ?? []).map((p) => p.diasOcupado));
  const balanco = d ? d.resumo.chuvaMm + d.resumo.laminaMediaMm - d.resumo.etoMm : 0;
  const cobertura = d && d.resumo.etoMm > 0 ? ((d.resumo.chuvaMm + d.resumo.laminaMediaMm) / d.resumo.etoMm) * 100 : 0;
  const hora = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Campo_Grande' }) : '—');

  const destaques = useMemo(() => {
    if (!d) return [];
    const out: { t: string; cor: string }[] = [];
    const irr = contagem('irrigar');
    if (irr) out.push({ t: `${irr} pivô${irr > 1 ? 's' : ''} para irrigar hoje`, cor: COR_STATUS.irrigar });
    else out.push({ t: 'Nenhum pivô precisa irrigar hoje', cor: COR_STATUS.ok });
    const abx = d.situacao.filter((s) => s.abaixoLimite ?? s.laminaMm < s.limiteMm).length;
    if (abx) out.push({ t: `${abx} pivô${abx > 1 ? 's' : ''} abaixo do limite de segurança (estresse)`, cor: COR_STATUS.irrigar });
    if (d.resumo.etoMm > 0) out.push({ t: `Chuva + irrigação cobriram ${fmt(cobertura, 0)}% do consumo`, cor: cobertura >= 100 ? COR_STATUS.ok : COR_STATUS.atencao });
    const graves = d.alertas.filter((a) => TIPO_ALERTA[a.tipo]?.grave).reduce((s, a) => s + a.n, 0);
    if (graves) out.push({ t: `${graves} alerta${graves > 1 ? 's' : ''} operaciona${graves > 1 ? 'is' : 'l'} no período`, cor: COR_STATUS.irrigar });
    const ruins = d.pastejo.filter((p) => p.notaSaida != null && p.notaSaida < 3);
    if (ruins.length) out.push({ t: `${ruins.length} piquete${ruins.length > 1 ? 's' : ''} saíram com nota baixa`, cor: COR_STATUS.atencao });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);

  return (
    <div className="viz space-y-4">
      {/* barra de comando */}
      <div className="vidro vidro-forte surge flex flex-wrap items-center gap-3 p-4 print:hidden">
        <div className="mr-auto">
          <h1 className="flex items-center gap-2 text-lg font-bold"><span className="ponto-vivo" aria-hidden /> Central de relatórios</h1>
          <p className="text-xs text-slate-500">{fazenda.nome} · {dataBR(de)} a {dataBR(ate)} ({nDias} dia{nDias > 1 ? 's' : ''}){r.dataUpdatedAt ? ` · atualizado ${haQuanto(new Date(r.dataUpdatedAt).toISOString())}` : ''}</p>
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="Período rápido">
          {[7, 15, 30].map((n) => <button key={n} className="chip" aria-pressed={nDias === n && ate === hojeLocal()} onClick={() => rapido(n)}>{n} dias</button>)}
        </div>
        <div className="flex items-center gap-1.5">
          <input aria-label="Data inicial" type="date" className="campo !w-auto !py-1" value={de} max={ate} onChange={(e) => setDe(e.target.value)} />
          <span className="text-slate-400">→</span>
          <input aria-label="Data final" type="date" className="campo !w-auto !py-1" value={ate} min={de} onChange={(e) => setAte(e.target.value)} />
        </div>
        <button className="btn" onClick={() => window.print()}>⎙ Imprimir / PDF</button>
      </div>
      <div className="hidden items-center gap-4 border-b border-slate-300 pb-3 print:flex">
        <LogoVertente className="h-24 w-auto text-[#1d3330]" />
        <div>
          <h1 className="text-lg font-bold">IRRIVERT · Relatório de irrigação</h1>
          <p className="text-sm text-slate-600">{fazenda.nome} · {dataBR(de)} a {dataBR(ate)} ({nDias} dia{nDias > 1 ? 's' : ''}) · emitido em {new Date().toLocaleString('pt-BR', { timeZone: 'America/Campo_Grande' })}</p>
        </div>
      </div>

      {r.isLoading && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="esqueleto h-32 rounded-2xl" />)}</div>}
      {r.error && <p role="alert" className="vidro p-4 text-sm text-red-600">{(r.error as Error).message}</p>}

      {d && (
        <>
          {/* destaques automáticos */}
          <div className="flex flex-wrap gap-2 surge">
            {destaques.map((x) => (
              <span key={x.t} className="inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 text-xs font-medium backdrop-blur dark:border-slate-700 dark:bg-slate-900/50">
                <i className="h-2 w-2 rounded-full" style={{ background: x.cor, boxShadow: `0 0 8px ${x.cor}` }} />{x.t}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi atraso={40} rotulo="Lâmina aplicada" valor={d.resumo.laminaMediaMm} casas={1} unidade="mm" sub="média ponderada pela área" cor="var(--s-irr)" serie={d.dias.map((x) => x.irrigacaoMm)} />
            <Kpi atraso={80} rotulo="Chuva" valor={d.resumo.chuvaMm} casas={1} unidade="mm" sub="no período" cor="var(--s-chuva)" serie={d.dias.map((x) => x.chuvaMm)} />
            <Kpi atraso={120} rotulo="Consumo (ETo)" valor={d.resumo.etoMm} casas={1} unidade="mm" sub="evapotranspiração" cor="var(--s-eto)" serie={d.dias.map((x) => x.etoMm)} />
            <Kpi atraso={160} rotulo="Precisam irrigar" valor={d.resumo.pivosIrrigar} unidade={`de ${d.resumo.pivos}`} sub="pivôs com reposição hoje" cor={d.resumo.pivosIrrigar ? COR_STATUS.irrigar : COR_STATUS.ok} />
            <div className="col-span-2 lg:col-span-1"><Kpi atraso={200} rotulo="Com animais" valor={d.resumo.piquetesOcupados} unidade="piquetes" sub="agora" cor="#a855f7" /></div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Painel className="lg:col-span-2" atraso={120} titulo="Água no período" sub="Irrigação, chuva e consumo por dia (mm). Passe o mouse sobre um dia."
              aoCsv={() => csv('agua-por-dia', ['Dia', 'Irrigação mm', 'Chuva mm', 'ETo mm'], d.dias.map((x) => [x.data, x.irrigacaoMm, x.chuvaMm, x.etoMm]))}>
              <GraficoDias dias={d.dias} />
            </Painel>

            <Painel atraso={180} titulo="Balanço do período" sub="Água que entrou menos água que as plantas consumiram.">
              <div className="flex flex-col items-center py-2 text-center">
                <svg viewBox="0 0 120 70" className="w-48" aria-hidden>
                  <path d="M10 62 A50 50 0 0 1 110 62" fill="none" strokeWidth="9" strokeLinecap="round" className="stroke-slate-200 dark:stroke-slate-700" />
                  <path d="M10 62 A50 50 0 0 1 110 62" fill="none" strokeWidth="9" strokeLinecap="round" stroke={cobertura >= 100 ? COR_STATUS.ok : cobertura >= 70 ? COR_STATUS.atencao : COR_STATUS.irrigar}
                    strokeDasharray="157" strokeDashoffset={157 * (1 - Math.min(1, cobertura / 100))} className="linha-desenha" style={{ ['--len' as string]: 157 }} />
                </svg>
                <div className="-mt-9 num-grande text-3xl"><Numero valor={cobertura} casas={0} />%</div>
                <div className="mt-1 text-xs text-slate-500">do consumo coberto</div>
                <div className={`mt-4 rounded-lg px-3 py-1.5 text-sm font-semibold tabular-nums ${balanco >= 0 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-red-500/15 text-red-700 dark:text-red-300'}`}>
                  {balanco >= 0 ? '▲ sobra' : '▼ falta'} {fmt(Math.abs(balanco))} mm
                </div>
                <dl className="mt-4 grid w-full grid-cols-2 gap-y-1 text-xs text-slate-500">
                  <dt>Irrigação + chuva</dt><dd className="text-right font-medium text-slate-800 dark:text-slate-100">{fmt(d.resumo.laminaMediaMm + d.resumo.chuvaMm)} mm</dd>
                  <dt>Consumo (ETo)</dt><dd className="text-right font-medium text-slate-800 dark:text-slate-100">{fmt(d.resumo.etoMm)} mm</dd>
                </dl>
              </div>
            </Painel>
          </div>

          <Painel atraso={200} titulo={`Programação de hoje · ${dataBR(d.ordem.data)}`} sub="Faixa verde = horário de energia permitido. Barras = pivôs programados na ordem de irrigação.">
            <LinhaDoDia data={d.ordem.data} itens={d.ordem.itens} janelas={d.ordem.janelas} />
            {d.ordem.itens.filter((i) => i.status !== 'cancelada').length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="tabela">
                  <thead><tr><th>#</th><th>Pivô</th><th>Início</th><th>Fim</th><th>Duração</th><th className="num">Lâmina</th><th>Sentido</th><th>Parar em</th><th>Situação</th></tr></thead>
                  <tbody>{d.ordem.itens.filter((i) => i.status !== 'cancelada').map((i) => (
                    <tr key={i.id}><td>{i.sequencia}</td><td className="font-medium">{i.pivoNome}</td><td>{hora(i.inicio)}</td><td>{hora(i.fim)}</td><td>{hhmm(i.duracaoMin)} h</td><td className="num">{fmt(i.laminaMm)} mm</td>
                      <td>{i.sentido === 0 ? '↻ Frente' : i.sentido === 1 ? '↺ Reverso' : '–'}</td><td>{i.anguloParada != null ? `${fmt(i.anguloParada, 0)}°` : '–'}</td><td className="capitalize">{i.status}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            {d.ordem.itens.filter((i) => i.status === 'cancelada').map((i) => <p key={i.id} className="mt-2 text-xs text-amber-600">🐄 {i.pivoNome} fora da ordem: {i.avisos[0]}</p>)}
          </Painel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Painel atraso={220} titulo="Situação hídrica agora" sub="Marca preta = limite de segurança. Abaixo dela o pivô precisa irrigar."
              aoCsv={() => csv('situacao-hidrica', ['Pivô', 'Cultura', 'Lâmina mm', 'Limite mm', 'Capacidade mm', 'Situação'], situacao.map((s) => [s.pivoNome, s.culturas, s.laminaMm, s.limiteMm, s.capMm, ROTULO_STATUS[s.st]]))}>
              <div className="mb-3 flex flex-wrap gap-2">
                <button className="chip" aria-pressed={filtro === null} onClick={() => setFiltro(null)}>Todos {situacao.length}</button>
                {(['irrigar', 'atencao', 'ok'] as Status[]).map((s) => <button key={s} className="chip" aria-pressed={filtro === s} onClick={() => setFiltro(filtro === s ? null : s)}><i className="h-2 w-2 rounded-full" style={{ background: COR_STATUS[s] }} />{ROTULO_STATUS[s]} {contagem(s)}</button>)}
              </div>
              <ul className="max-h-[26rem] space-y-3 overflow-y-auto pr-1">
                {situacao.filter((s) => !filtro || s.st === filtro).map((s) => (
                  <li key={s.pivoNome}>
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-medium">{s.pivoNome} <span className="text-xs font-normal text-slate-500">{s.culturas}</span></span>
                      <span className="flex items-center gap-2 tabular-nums"><span className="text-xs text-slate-500">{fmt(s.laminaMm)} / {fmt(s.capMm)} mm</span>
                        <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ background: COR_STATUS[s.st] }}>{ROTULO_STATUS[s.st]}</span></span>
                    </div>
                    <Medidor lamina={s.laminaMm} limite={s.limiteMm} cap={s.capMm} status={s.st} />
                  </li>
                ))}
                {situacao.length === 0 && <li className="text-sm text-slate-500">Sem pivôs cadastrados.</li>}
              </ul>
            </Painel>

            <Painel atraso={240} titulo="Lâmina aplicada por pivô" sub="Azul escuro = lançada pela telemetria; azul claro = lançada à mão."
              aoCsv={() => csv('lamina-por-pivo', ['Pivô', 'Área ha', 'Lâmina mm', 'Da telemetria mm', 'Dias irrigados'], d.irrigacao.map((i) => [i.pivoNome, i.areaHa, i.laminaMm, i.laminaTelemetriaMm, i.diasIrrigados]))}>
              <ul className="max-h-[26rem] space-y-2.5 overflow-y-auto pr-1">
                {[...d.irrigacao].sort((a, b) => b.laminaMm - a.laminaMm).map((i, k) => {
                  const manual = Math.max(0, i.laminaMm - i.laminaTelemetriaMm);
                  return (
                    <li key={i.pivoNome} className="grid grid-cols-[5.5rem_1fr_4.5rem] items-center gap-2 text-sm">
                      <span className="truncate font-medium">{i.pivoNome}</span>
                      <div className="flex h-4 gap-0.5" title={`${i.diasIrrigados} dia(s) irrigado(s) · ${fmt(i.areaHa)} ha`}>
                        {i.laminaTelemetriaMm > 0 && <div className="barra-h h-full rounded-l-md rounded-r-sm" style={{ width: `${(i.laminaTelemetriaMm / maxLamina) * 100}%`, background: 'var(--s-irr)', animationDelay: `${k * 40}ms` }} />}
                        {manual > 0 && <div className="barra-h h-full rounded-r-md rounded-l-sm" style={{ width: `${(manual / maxLamina) * 100}%`, background: 'var(--s-irr)', opacity: .45, animationDelay: `${k * 40}ms` }} />}
                        {i.laminaMm === 0 && <div className="h-full w-px self-center bg-slate-300" />}
                      </div>
                      <span className="text-right text-xs tabular-nums"><b className="text-sm">{fmt(i.laminaMm)}</b> mm</span>
                    </li>
                  );
                })}
              </ul>
            </Painel>
          </div>

          <Painel atraso={260} titulo="Pastejo por piquete" sub="Dias com animais no período e qualidade do pasto na entrada e na saída (nota média de 1 a 5)."
            aoCsv={() => csv('pastejo', ['Pivô', 'Piquete', 'Entradas', 'Saídas', 'Dias ocupado', 'Nota média entrada', 'Nota média saída'], d.pastejo.map((p) => [p.pivoNome, p.piquete, p.entradas, p.saidas, p.diasOcupado, p.notaEntrada, p.notaSaida]))}>
            {d.pastejo.length === 0 ? <p className="text-sm text-slate-500">Nenhum movimento de animais no período.</p> : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {d.pastejo.map((p) => {
                  const delta = p.notaEntrada != null && p.notaSaida != null ? p.notaSaida - p.notaEntrada : null;
                  return (
                    <article key={p.pivoNome + p.piquete} className="rounded-xl border border-slate-200/80 bg-white/50 p-3 dark:border-slate-700 dark:bg-slate-800/40">
                      <div className="flex items-baseline justify-between"><h3 className="text-sm font-semibold">{p.pivoNome} · {p.piquete}</h3><span className="text-xs text-slate-500">{p.entradas}⬇ {p.saidas}⬆</span></div>
                      <div className="mt-2 flex items-center gap-2"><div className="h-2 flex-1 rounded-full bg-slate-200/80 dark:bg-slate-700"><div className="barra-h h-full rounded-full bg-purple-500" style={{ width: `${(p.diasOcupado / maxDias) * 100}%`, boxShadow: '0 0 8px rgb(168 85 247 / .6)' }} /></div><b className="text-xs tabular-nums">{fmt(p.diasOcupado)} d</b></div>
                      <dl className="mt-2 grid grid-cols-[4rem_1fr] items-center gap-y-1 text-xs text-slate-500"><dt>Entrada</dt><dd><Nota n={p.notaEntrada} /></dd><dt>Saída</dt><dd><Nota n={p.notaSaida} /></dd></dl>
                      {delta != null && <p className={`mt-2 text-xs font-medium ${delta >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{delta >= 0 ? '▲' : '▼'} {fmt(Math.abs(delta))} ponto{Math.abs(delta) === 1 ? '' : 's'} {delta >= 0 ? 'melhor' : 'pior'} na saída</p>}
                    </article>
                  );
                })}
              </div>
            )}
            {d.movimentos.length > 0 && (
              <details className="mt-4"><summary className="cursor-pointer text-xs font-medium text-cyan-700 dark:text-cyan-300">Ver últimos {d.movimentos.length} movimentos</summary>
                <div className="mt-2 max-h-64 overflow-auto"><table className="tabela"><thead><tr><th>Quando</th><th>Piquete</th><th>Movimento</th><th className="num">Cab.</th><th className="num">Nota</th><th>Observação</th></tr></thead>
                  <tbody>{d.movimentos.map((m) => <tr key={m.id}><td>{new Date(m.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Campo_Grande' })}</td><td>{m.pivoNome} · {m.piquete}</td><td>{m.tipo === 'entrada' ? '⬇ Entrada' : '⬆ Saída'}{m.temFoto ? ' 📷' : ''}</td><td className="num">{m.cabecas ?? '–'}</td><td className="num">{m.nota ?? '–'}</td><td className="max-w-xs truncate">{m.observacao ?? ''}</td></tr>)}</tbody></table></div>
              </details>
            )}
          </Painel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Painel atraso={280} titulo="Alertas no período">
              {d.alertas.length === 0 ? <p className="text-sm text-slate-500">Nenhum alerta. ✔</p> : (
                <ul className="space-y-2">{d.alertas.map((a) => {
                  const info = TIPO_ALERTA[a.tipo] ?? { t: a.tipo, grave: false };
                  const max = Math.max(...d.alertas.map((x) => x.n));
                  return (
                    <li key={a.tipo} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 text-sm">
                      <span>{info.t}</span><b className="tabular-nums">{a.n}</b>
                      <div className="col-span-2 h-1.5 rounded-full bg-slate-200/80 dark:bg-slate-700"><div className="barra-h h-full rounded-full" style={{ width: `${(a.n / max) * 100}%`, background: info.grave ? COR_STATUS.irrigar : COR_STATUS.atencao }} /></div>
                    </li>
                  );
                })}</ul>
              )}
            </Painel>
            <Painel atraso={300} titulo="Comandos aos pivôs" sub="Toda tentativa fica registrada, inclusive as bloqueadas.">
              {d.comandos.length === 0 ? <p className="text-sm text-slate-500">Nenhum comando no período.</p> : (
                <ol className="relative max-h-72 space-y-3 overflow-y-auto border-l border-slate-300/70 pl-4 dark:border-slate-600">
                  {d.comandos.map((c) => (
                    <li key={c.id} className="relative text-sm">
                      <i className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white dark:ring-slate-900" style={{ background: c.estado === 'enviado' ? COR_STATUS.ok : COR_STATUS.irrigar }} />
                      <div className="flex flex-wrap items-baseline gap-x-2"><b>{c.pivoNome}</b><span className="uppercase">{c.acao}</span><span className="text-xs" style={{ color: c.estado === 'enviado' ? COR_STATUS.ok : COR_STATUS.irrigar }}>{c.estado}</span></div>
                      <div className="text-xs text-slate-500">{new Date(c.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Campo_Grande' })}{c.usuario ? ` · ${c.usuario}` : ''}{c.detalhe ? ` · ${c.detalhe}` : ''}</div>
                    </li>
                  ))}
                </ol>
              )}
            </Painel>
          </div>
        </>
      )}
    </div>
  );
}
