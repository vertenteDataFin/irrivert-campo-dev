/**
 * Campo: vistoria presencial dos pivôs da ordem do dia.
 * Regra da fazenda: todo pivô com ordem recebe vistoria no local; o comando remoto só encurta a vistoria.
 * Funciona sem internet: o plano fica guardado no aparelho e as vistorias vão para a fila (IndexedDB).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api, ErroApi, fmt, hojeLocal, token } from '../api';
import { haQuanto } from '../hooks';
import { descartarVistoria, enfileirarVistoria, guardarCache, lerCache, listarVistoriasFila, novoUuid, reduzirFoto, sincronizarVistorias, type VistoriaFila } from '../offline';
import {
  COR_TEL, ROTULO_ATIVO, ROTULO_RESULTADO, ROTULO_TEL,
  type Ativo, type ConfigPainel, type FalhaVistoria, type Fazenda, type Integridade, type ItemOrdem, type Leituras, type Parada, type PivoCampo, type PlanoCampo,
  type PiqueteCampo, type ResultadoVistoria, type TipoAtivo, type TipoFoto, type Usuario, type VistoriaEnvio, type VistoriaRegistro,
} from '../tipos';
import { arcoSvg, cunha, planejarSetor, pontoAzimute, type Arco } from '../setor';
import { Numero } from '../ui';

const TZ = 'America/Campo_Grande';
const AZUL = 'var(--s-irr)';
const VERDE = '#059669';
const AMBAR = '#d97706';
const VERMELHO = '#dc2626';
const ROXO = '#a855f7';
const msg = (x: unknown) => (x instanceof ErroApi ? x.message : 'Não foi possível falar com o servidor');
const hora = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—');
const dataBR = (iso: string) => iso.split('-').reverse().join('/');

/** Cadeia de diagnóstico do quadro 4 do fluxograma: segue a água e a energia, do mais a montante ao painel. */
const PASSOS = [
  { n: 1, t: 'Comunicação', s: 'sinal, modem, chip, painel em remoto' },
  { n: 2, t: 'Energia', s: 'rede, transformador, usina, fases, disjuntor, cabos' },
  { n: 3, t: 'Água a montante', s: 'reservatório, captação e sua bomba' },
  { n: 4, t: 'Bomba e adutora', s: 'pressão no centro, válvulas, vazamentos' },
  { n: 5, t: 'Estrutura', s: 'alinhamento, torres, obstáculo, posição' },
  { n: 6, t: 'Painel', s: 'alarme, modo, sentido, percentímetro, pressostato' },
];
const SUSPEITAS: { passo: number; t: string }[] = [
  { passo: 1, t: 'Comunicação: modem, chip, antena' },
  { passo: 2, t: 'Energia: disjuntor, fase, cabos' },
  { passo: 4, t: 'Bomba ou adutora: pressão' },
  { passo: 5, t: 'Estrutura: alinhamento, obstáculo' },
  { passo: 6, t: 'Painel: modo local, alarme' },
];
const ORIGENS: { v: FalhaVistoria['origem']; t: string }[] = [
  { v: 'pivo', t: 'No pivô: painel, modem, estrutura' },
  { v: 'casa_bomba', t: 'Casa de bomba: bomba, quadro, partida' },
  { v: 'transformador', t: 'Transformador ou subestação' },
  { v: 'rede', t: 'Rede da concessionária: falta de fase' },
  { v: 'usina', t: 'Usina fotovoltaica ou inversor' },
  { v: 'captacao', t: 'Captação ou reservatório' },
  { v: 'adutora', t: 'Adutora: vazamento, válvula' },
];
const MODELOS_PAINEL = ['Valley ICON10', 'Valley ICON1', 'Valley Pro2', 'Bauer SmartTouch', 'Bauer Universal Pro', 'Outro'];

/** Telemetria diz que o pivô iniciou pelo comando remoto → vistoria rápida. */
const iniciouRemoto = (p: PivoCampo | undefined) => p?.telemetria?.categoria === 'irrigando' || p?.telemetria?.categoria === 'movendo';
const semResposta = (p: PivoCampo | undefined) => p?.telemetria?.categoria === 'sem_sinal' || p?.telemetria?.categoria === 'alarme' || p?.telemetria?.categoria === 'desligado';
/** Graus a partir do norte → hora do relógio (12h = norte, 3h = leste), como a equipe fala dos piquetes. */
const grausParaHora = (g: number | null) => (g == null ? '?' : `${((Math.round(g / 30) + 11) % 12) + 1}h`);
const setorDoGado = (p: PivoCampo) => (p.gado.length ? p.gado.map((g) => `${g.piquete}${g.de != null ? ` ${g.de}°→${g.ate}°` : ''}`).join(', ') : null);
const arcoDo = (p: PiqueteCampo): Arco | null => (p.de != null && p.ate != null ? { de: p.de, ate: p.ate } : null);

/** Miniatura do pivô: fatias dos piquetes (roxo = com animais), arco azul = setor a irrigar, traço = posição atual. Toque numa fatia marca ou desmarca animais. */
function MiniPivo({ piquetes, ocupados, setor, posicao, aoTocar }: { piquetes: PiqueteCampo[]; ocupados: Set<number>; setor: Arco | null; posicao: number | null; aoTocar?: (id: number) => void }) {
  const c = 64, r = 50;
  const pos = posicao != null ? pontoAzimute(c, c, r, posicao) : null;
  return (
    <svg viewBox="0 0 128 128" className="h-32 w-32 shrink-0" role="img" aria-label="Miniatura do pivô">
      <circle cx={c} cy={c} r={r} fill="rgb(148 163 184 / .18)" stroke="rgb(148 163 184 / .6)" />
      {piquetes.map((p) => { const a = arcoDo(p); if (!a) return null; const on = ocupados.has(p.id); return (
        <path key={p.id} d={cunha(c, c, r, a.de, a.ate)} fill={on ? `${ROXO}99` : 'rgb(148 163 184 / .12)'} stroke="#fff" strokeWidth={1.2} className={aoTocar ? 'cursor-pointer' : undefined} onClick={aoTocar ? () => aoTocar(p.id) : undefined}>
          <title>{p.nome}{on ? ' · com animais' : ''}</title>
        </path>); })}
      {setor && <path d={arcoSvg(c, c, r + 6, setor.de, setor.ate)} fill="none" stroke={AZUL} strokeWidth={4} strokeLinecap="round" />}
      {pos && <><line x1={c} y1={c} x2={pos.x} y2={pos.y} stroke="#0f172a" strokeWidth={2.5} strokeLinecap="round" /><circle cx={pos.x} cy={pos.y} r={3.5} fill="#0f172a" /></>}
      <circle cx={c} cy={c} r={3} fill="#fff" stroke="#0f172a" />
      <text x={c} y={9} textAnchor="middle" fontSize={9} fontWeight={700} fill="#64748b">N</text>
    </svg>
  );
}

/* ---------------- peças ---------------- */
function Kpi({ rotulo, valor, unidade, sub, cor, atraso = 0 }: { rotulo: string; valor: number; unidade?: string; sub?: string; cor: string; atraso?: number }) {
  return (
    <div className="vidro vidro-forte surge p-4" style={{ animationDelay: `${atraso}ms` }}>
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: cor, boxShadow: `0 0 16px ${cor}` }} />
      <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-slate-500 dark:text-slate-400">{rotulo}</div>
      <div className="mt-1 flex items-baseline gap-1.5"><span className="num-grande text-3xl" style={{ color: cor }}><Numero valor={valor} /></span>{unidade && <span className="text-sm text-slate-500">{unidade}</span>}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
function Painel({ titulo, sub, extra, atraso = 0, children }: { titulo: string; sub?: string; extra?: ReactNode; atraso?: number; children: ReactNode }) {
  return (
    <section className="vidro surge p-4" style={{ animationDelay: `${atraso}ms` }}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="titulo-secao">{titulo}</h2>{sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}</div>
        {extra && <div className="flex flex-wrap items-center gap-2">{extra}</div>}
      </header>
      {children}
    </section>
  );
}
function Chip({ cor, children, title }: { cor: string; children: ReactNode; title?: string }) {
  return <span title={title} className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: `${cor}22`, color: cor }}><i className="h-1.5 w-1.5 rounded-full" style={{ background: cor }} />{children}</span>;
}
function Marcar({ v, t, aoMudar, cor = VERDE }: { v: boolean | null | undefined; t: string; aoMudar: (b: boolean) => void; cor?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={!!v} onClick={() => aoMudar(!v)} className="flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm transition" style={{ borderColor: v ? cor : 'rgb(148 163 184 / .5)', background: v ? `${cor}14` : undefined }}>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] text-white" style={{ background: v ? cor : 'transparent', borderColor: v ? cor : 'rgb(148 163 184)' }}>{v ? '✓' : ''}</span>{t}
    </button>
  );
}
function Seg<T extends string>({ opcoes, v, aoMudar, cor = AZUL }: { opcoes: { v: T; t: string }[]; v: T | null | undefined; aoMudar: (x: T) => void; cor?: string }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-slate-300 dark:border-slate-600" role="radiogroup">
      {opcoes.map((o) => <button key={o.v} type="button" role="radio" aria-checked={v === o.v} onClick={() => aoMudar(o.v)} className="flex-1 px-2 py-1.5 text-xs font-medium transition" style={v === o.v ? { background: cor, color: '#fff' } : undefined}>{o.t}</button>)}
    </div>
  );
}
function Campo_({ r, children, id }: { r: string; children: ReactNode; id?: string }) {
  return <div><label className="rotulo" htmlFor={id}>{r}</label>{children}</div>;
}

/** Foto protegida por login: baixa com o token e mostra num pop-up. */
function Foto({ id, rotulo }: { id: number; rotulo: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [erro, setErro] = useState(false);
  async function abrir() {
    try {
      const r = await fetch(`/api/vistorias/fotos/${id}`, { headers: { Authorization: `Bearer ${token.get() ?? ''}` } });
      if (!r.ok) throw new Error();
      setUrl(URL.createObjectURL(await r.blob()));
    } catch { setErro(true); }
  }
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return (
    <>
      <button type="button" className="chip" onClick={abrir}>{erro ? 'Sem foto (offline?)' : `📷 ${rotulo}`}</button>
      {url && <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 p-4" onClick={() => setUrl(null)} role="dialog" aria-label={rotulo}><img src={url} alt={rotulo} className="max-h-full max-w-full rounded-lg" /></div>}
    </>
  );
}

/* ---------------- formulário de vistoria ---------------- */
interface Rascunho {
  tipo: 'rapida' | 'completa'; suspeita: string | null; passoEntrada: number | null;
  integridade: Integridade; leituras: Leituras; noPainel: boolean; config: ConfigPainel;
  comFalha: boolean; falha: FalhaVistoria; resolvidoLocal: boolean | null; resultado: ResultadoVistoria | null; observacao: string;
  fotos: { tipo: TipoFoto; dados: string }[];
}

function FormVistoria({ pivo, item, ativos, data, aoFechar, aoSalvar }: { pivo: PivoCampo; item: ItemOrdem | null; ativos: Ativo[]; data: string; aoFechar: () => void; aoSalvar: (v: VistoriaEnvio) => void }) {
  const remoto = iniciouRemoto(pivo);
  const [iniciadaEm] = useState(() => new Date().toISOString());
  const [lendo, setLendo] = useState(false);
  const [r, setR] = useState<Rascunho>(() => ({
    tipo: remoto ? 'rapida' : 'completa', suspeita: null, passoEntrada: null,
    integridade: { pneus: null, bicos: null, estrutura: null, caminho: null, posicaoGraus: pivo.telemetria?.angulo != null ? Math.round(pivo.telemetria.angulo) : null, gadoPiquetes: pivo.piquetes.filter((p) => p.ocupado).map((p) => p.id) },
    leituras: { pressaoBar: null, fonteEnergia: 'rede', tensaoV: null, painelRespondeu: pivo.telemetria ? !semResposta(pivo) : null },
    noPainel: !remoto, config: {
      modelo: pivo.painelModelo ?? '', sentido: item?.sentido === 1 ? 'anti_horario' : item?.sentido === 0 ? 'horario' : null, percentimetro: item?.percentual ?? null, laminaMm: item?.laminaMm ?? null,
      agua: 'com_agua', setorDe: null, setorAte: null, partidaEm: null,
    },
    comFalha: false, falha: { passo: null, origem: 'pivo', ativoId: null, local: '', descricao: '', previsao: '' }, resolvidoLocal: null,
    resultado: remoto ? 'operando' : null, observacao: '', fotos: [],
  }));
  const set = (p: Partial<Rascunho>) => setR((x) => ({ ...x, ...p }));
  const setI = (p: Partial<Integridade>) => setR((x) => ({ ...x, integridade: { ...x.integridade, ...p } }));
  const setL = (p: Partial<Leituras>) => setR((x) => ({ ...x, leituras: { ...x.leituras, ...p } }));
  const setC = (p: Partial<ConfigPainel>) => setR((x) => ({ ...x, config: { ...x.config, ...p } }));
  const setF = (p: Partial<FalhaVistoria>) => setR((x) => ({ ...x, falha: { ...x.falha, ...p } }));

  // setor a irrigar: contorna os piquetes marcados com animais, a partir da posição atual informada
  const ocupados = useMemo(() => new Set(r.integridade.gadoPiquetes ?? []), [r.integridade.gadoPiquetes]);
  const planoSetor = useMemo(() => planejarSetor(r.integridade.posicaoGraus ?? null, pivo.piquetes.filter((p) => ocupados.has(p.id)).map(arcoDo).filter((a): a is Arco => a != null)), [ocupados, pivo.piquetes, r.integridade.posicaoGraus]);
  useEffect(() => {
    setR((x) => ({ ...x, config: { ...x.config, setorDe: planoSetor.setor?.de ?? null, setorAte: planoSetor.setor?.ate ?? null, sentido: planoSetor.sentido ?? x.config.sentido } }));
  }, [planoSetor]);
  const alternarPiquete = (id: number) => setI({ gadoPiquetes: ocupados.has(id) ? [...ocupados].filter((x) => x !== id) : [...ocupados, id] });

  const meusAtivos = ativos.filter((a) => a.pivos.includes(pivo.id));
  const ativosDaOrigem = r.falha.origem === 'pivo' ? [] : ativos.filter((a) => a.tipo === r.falha.origem || (r.falha.origem === 'captacao' && a.tipo === 'reservatorio'));
  const afetados = r.falha.ativoId ? ativos.find((a) => a.id === r.falha.ativoId)?.pivos.filter((id) => id !== pivo.id) ?? [] : [];
  const temFotoPainel = r.fotos.some((f) => f.tipo === 'painel');
  const faltaFoto = r.noPainel && !temFotoPainel;
  const pronto = r.resultado != null && !faltaFoto && (!r.comFalha || r.resolvidoLocal != null);

  async function foto(tipo: TipoFoto, f: File | undefined) {
    if (!f) return;
    setLendo(true);
    try { const d = await reduzirFoto(f); setR((x) => ({ ...x, fotos: [...x.fotos.filter((y) => y.tipo !== tipo), { tipo, dados: d }] })); } finally { setLendo(false); }
  }
  function enviar(e: FormEvent) {
    e.preventDefault();
    if (!pronto || !r.resultado) return;
    const n = (v: number | string | null | undefined) => (v === '' || v == null ? null : Number(v));
    aoSalvar({
      clientUuid: novoUuid(), pivoId: pivo.id, ordemId: item?.id ?? null, data, tipo: r.tipo, iniciadaEm, concluidaEm: new Date().toISOString(),
      suspeita: r.suspeita, passoEntrada: r.passoEntrada,
      integridade: { ...r.integridade, posicaoGraus: n(r.integridade.posicaoGraus), gadoPiquetes: r.integridade.gadoPiquetes?.length ? r.integridade.gadoPiquetes : null },
      leituras: { ...r.leituras, pressaoBar: n(r.leituras.pressaoBar), tensaoV: n(r.leituras.tensaoV) },
      configPainel: r.noPainel ? { ...r.config, modelo: r.config.modelo || null, percentimetro: n(r.config.percentimetro), laminaMm: n(r.config.laminaMm), setorDe: n(r.config.setorDe), setorAte: n(r.config.setorAte), partidaEm: r.config.partidaEm || new Date().toISOString() } : null,
      falha: r.comFalha ? { ...r.falha, ativoId: r.falha.origem === 'pivo' ? null : r.falha.ativoId ?? null, local: r.falha.local || null, descricao: r.falha.descricao || null, previsao: r.falha.previsao || null } : null,
      resolvidoLocal: r.comFalha ? r.resolvidoLocal : null, resultado: r.resultado, observacao: r.observacao.trim() || null, fotos: r.fotos,
    });
  }
  const bloco = (t: string, children: ReactNode, sub?: string) => <section className="rounded-xl bg-slate-100/70 p-3 dark:bg-slate-800/60"><h3 className="titulo-secao mb-2">{t}</h3>{sub && <p className="-mt-1 mb-2 text-xs text-slate-500">{sub}</p>}<div className="space-y-2">{children}</div></section>;
  const fotoBtn = (tipo: TipoFoto, t: string, obrig = false) => {
    const tem = r.fotos.some((f) => f.tipo === tipo);
    return (
      <label className="chip cursor-pointer" style={obrig && !tem ? { borderColor: VERMELHO, color: VERMELHO } : tem ? { borderColor: VERDE, color: VERDE } : undefined}>
        {lendo ? 'Preparando…' : tem ? `✓ ${t} (trocar)` : `📷 ${t}${obrig ? ' · obrigatória' : ''}`}
        <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => foto(tipo, e.target.files?.[0])} />
      </label>
    );
  };

  return (
    <form onSubmit={enviar} className="surge space-y-3 rounded-xl border border-cyan-500/40 bg-cyan-500/5 p-4 shadow-[0_0_24px_rgb(8_145_178/.15)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-bold">Vistoria · {pivo.nome}</h3>
          <p className="text-xs text-slate-500">{pivo.culturas ?? 'sem cultura'}{item ? ` · ${fmt(item.laminaMm, 1)} mm · ${fmt(item.percentual, 0)}% · ${hora(item.inicio)}` : ' · sem ordem hoje'}{pivo.telemetria ? ` · telemetria: ${pivo.telemetria.categoria ? ROTULO_TEL[pivo.telemetria.categoria] : pivo.telemetria.statusTxt ?? '—'}` : ' · sem telemetria'}</p>
        </div>
        <div className="flex items-center gap-2">
          <Seg opcoes={[{ v: 'rapida' as const, t: 'Roteiro rápido' }, { v: 'completa' as const, t: 'Roteiro completo' }]} v={r.tipo} aoMudar={(v) => set({ tipo: v, noPainel: v === 'completa' ? r.noPainel : r.noPainel })} />
          <button type="button" className="chip" onClick={aoFechar}>Cancelar</button>
        </div>
      </div>
      {remoto && <p className="text-xs" style={{ color: VERDE }}>A telemetria diz que o pivô iniciou pelo comando remoto: confirme no local giro, pressão, posição e setor, e registre a foto.</p>}

      {r.tipo === 'completa' && bloco('Suspeita antes de entrar', (
        <div className="grid gap-1 sm:grid-cols-2">
          {SUSPEITAS.map((s) => <Marcar key={s.passo} v={r.passoEntrada === s.passo} t={s.t} aoMudar={() => set({ passoEntrada: r.passoEntrada === s.passo ? null : s.passo, suspeita: r.passoEntrada === s.passo ? null : s.t })} cor={AZUL} />)}
          <Marcar v={r.passoEntrada == null} t="Sem suspeita: seguir a cadeia do passo 1" aoMudar={() => set({ passoEntrada: null, suspeita: null })} cor={AZUL} />
        </div>
      ), 'A suspeita define por qual passo da cadeia começar. A cadeia continua disponível se a suspeita não se confirmar.')}

      {bloco('Integridade física', (
        <>
          <div className="grid gap-1 sm:grid-cols-2">
            <Marcar v={r.integridade.pneus} t="Pneus das torres" aoMudar={(b) => setI({ pneus: b })} />
            <Marcar v={r.integridade.bicos} t="Bicos e aspersores" aoMudar={(b) => setI({ bicos: b })} />
            <Marcar v={r.integridade.estrutura} t="Alinhamento e estrutura" aoMudar={(b) => setI({ estrutura: b })} />
            <Marcar v={r.integridade.caminho} t="Caminho livre de obstáculos" aoMudar={(b) => setI({ caminho: b })} />
          </div>
          <div className="flex gap-3">
            <MiniPivo piquetes={pivo.piquetes} ocupados={ocupados} setor={r.noPainel ? planoSetor.setor : null} posicao={r.integridade.posicaoGraus ?? null} aoTocar={pivo.piquetes.length ? alternarPiquete : undefined} />
            <div className="min-w-0 flex-1 space-y-2">
              <Campo_ r="Posição atual (0 a 360°)" id="pos"><input id="pos" className="campo" type="number" inputMode="numeric" min={0} max={360} step={1} placeholder="ex.: 270" value={r.integridade.posicaoGraus ?? ''} onChange={(e) => setI({ posicaoGraus: e.target.value === '' ? null : Math.min(360, Math.max(0, Math.round(Number(e.target.value)))) })} /></Campo_>
              <Campo_ r="Gado no piquete">
                {pivo.piquetes.length === 0
                  ? <p className="text-xs text-slate-500">Sem piquetes de pastagem neste pivô.</p>
                  : <div className="flex flex-wrap gap-1">{pivo.piquetes.map((p) => <button key={p.id} type="button" className="chip" aria-pressed={ocupados.has(p.id)} style={ocupados.has(p.id) ? { borderColor: ROXO, color: ROXO } : undefined} title={p.de != null ? `${p.de}°→${p.ate}°` : 'sem arco no mapa'} onClick={() => alternarPiquete(p.id)}>{ocupados.has(p.id) ? '🐄 ' : ''}{p.nome}</button>)}</div>}
              </Campo_>
            </div>
          </div>
          {ocupados.size > 0 && (
            <p className="text-xs" style={{ color: planoSetor.situacao === 'bloqueado' ? VERMELHO : ROXO }}>
              🐄 Animais em {pivo.piquetes.filter((p) => ocupados.has(p.id)).map((p) => p.nome).join(', ')}.
              {planoSetor.setor ? ` Setor livre: ${planoSetor.setor.de}°→${planoSetor.setor.ate}°, sentido ${planoSetor.sentido === 'anti_horario' ? 'anti-horário' : 'horário'}.` : ''}
              {planoSetor.avisos.map((a) => ` ${a}`)}
            </p>
          )}
        </>
      ))}

      {bloco('Leituras', (
        <div className="grid grid-cols-2 gap-2">
          <Campo_ r="Pressão no centro (bar)" id="pres"><input id="pres" className="campo" inputMode="decimal" value={r.leituras.pressaoBar ?? ''} onChange={(e) => setL({ pressaoBar: e.target.value === '' ? null : Number(e.target.value.replace(',', '.')) })} /></Campo_>
          <Campo_ r="Tensão (V)" id="tens"><input id="tens" className="campo" inputMode="numeric" value={r.leituras.tensaoV ?? ''} onChange={(e) => setL({ tensaoV: e.target.value === '' ? null : Number(e.target.value) })} /></Campo_>
          <Campo_ r="Fonte de energia"><Seg opcoes={[{ v: 'rede' as const, t: 'Rede' }, { v: 'usina' as const, t: 'Usina' }, { v: 'gerador' as const, t: 'Gerador' }]} v={r.leituras.fonteEnergia} aoMudar={(v) => setL({ fonteEnergia: v })} /></Campo_>
          <Campo_ r="Painel respondeu ao remoto?"><Seg opcoes={[{ v: 'sim' as const, t: 'Sim' }, { v: 'nao' as const, t: 'Não' }]} v={r.leituras.painelRespondeu == null ? null : r.leituras.painelRespondeu ? 'sim' : 'nao'} aoMudar={(v) => setL({ painelRespondeu: v === 'sim' })} /></Campo_>
        </div>
      ))}

      {bloco('Configuração no painel', (
        <>
          <Marcar v={r.noPainel} t="Irrigação configurada direto no painel do pivô" aoMudar={(b) => set({ noPainel: b })} cor={AMBAR} />
          {r.noPainel && (
            <div className="grid grid-cols-2 gap-2">
              <Campo_ r="Modelo do painel" id="mod">
                <input id="mod" className="campo" list="modelos-painel" value={r.config.modelo ?? ''} onChange={(e) => setC({ modelo: e.target.value })} placeholder="Valley ICON10" />
                <datalist id="modelos-painel">{MODELOS_PAINEL.map((m) => <option key={m} value={m} />)}</datalist>
              </Campo_>
              <Campo_ r="Sentido de giro"><Seg opcoes={[{ v: 'horario' as const, t: '↻ Horário' }, { v: 'anti_horario' as const, t: '↺ Anti-horário' }]} v={r.config.sentido} aoMudar={(v) => setC({ sentido: v })} /></Campo_>
              <Campo_ r="Percentímetro (%)" id="perc"><input id="perc" className="campo" inputMode="numeric" value={r.config.percentimetro ?? ''} onChange={(e) => setC({ percentimetro: e.target.value === '' ? null : Number(e.target.value) })} /></Campo_>
              <Campo_ r="Lâmina (mm)" id="lam"><input id="lam" className="campo" inputMode="decimal" value={r.config.laminaMm ?? ''} onChange={(e) => setC({ laminaMm: e.target.value === '' ? null : Number(e.target.value.replace(',', '.')) })} /></Campo_>
              <Campo_ r="Água"><Seg opcoes={[{ v: 'com_agua' as const, t: 'Com água' }, { v: 'a_seco' as const, t: 'A seco' }]} v={r.config.agua} aoMudar={(v) => setC({ agua: v })} /></Campo_>
              <div className="grid grid-cols-2 gap-2">
                <Campo_ r="Setor de (°)" id="sde"><input id="sde" className="campo" type="number" inputMode="numeric" min={0} max={360} step={1} placeholder="giro completo" value={r.config.setorDe ?? ''} onChange={(e) => setC({ setorDe: e.target.value === '' ? null : Math.min(360, Math.max(0, Math.round(Number(e.target.value)))) })} /></Campo_>
                <Campo_ r="até (°)" id="sate"><input id="sate" className="campo" type="number" inputMode="numeric" min={0} max={360} step={1} placeholder="giro completo" value={r.config.setorAte ?? ''} onChange={(e) => setC({ setorAte: e.target.value === '' ? null : Math.min(360, Math.max(0, Math.round(Number(e.target.value)))) })} /></Campo_>
              </div>
              <p className="col-span-2 text-xs text-slate-500">{r.config.setorDe != null && r.config.setorAte != null ? `Setor calculado para contornar os piquetes com animais; ajuste se o painel pedir outro valor.` : 'Sem animais marcados: giro completo.'}</p>
            </div>
          )}
        </>
      ), 'Só quando a equipe programou no painel em vez do comando remoto. É o que a telemetria não vê.')}

      {bloco('Falha encontrada', (
        <>
          <Marcar v={r.comFalha} t="Há falha impedindo a partida ou a irrigação" aoMudar={(b) => set({ comFalha: b, resultado: b ? r.resultado : r.resultado })} cor={VERMELHO} />
          {r.comFalha && (
            <>
              <Campo_ r="Passo da cadeia em que apareceu">
                <div className="flex flex-wrap gap-1">{PASSOS.map((p) => <button key={p.n} type="button" className="chip" aria-pressed={r.falha.passo === p.n} title={p.s} onClick={() => setF({ passo: p.n })}>{p.n} · {p.t}</button>)}</div>
              </Campo_>
              <Campo_ r="Origem da falha">
                <div className="grid gap-1 sm:grid-cols-2">{ORIGENS.map((o) => <Marcar key={o.v} v={r.falha.origem === o.v} t={o.t} aoMudar={() => setF({ origem: o.v, ativoId: null })} cor={VERMELHO} />)}</div>
              </Campo_>
              {r.falha.origem !== 'pivo' && (
                <Campo_ r={`Qual ${ROTULO_ATIVO[r.falha.origem as TipoAtivo].toLowerCase()}?`} id="atv">
                  <select id="atv" className="campo" value={r.falha.ativoId ?? ''} onChange={(e) => setF({ ativoId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">— não cadastrado —</option>
                    {ativosDaOrigem.map((a) => <option key={a.id} value={a.id}>{a.nome}{meusAtivos.includes(a) ? ' (alimenta este pivô)' : ''}</option>)}
                  </select>
                  {ativosDaOrigem.length === 0 && <p className="mt-1 text-xs text-slate-500">Nenhum ativo desse tipo cadastrado. O gestor cadastra em "Ativos compartilhados" no plano do dia.</p>}
                </Campo_>
              )}
              {afetados.length > 0 && <p className="rounded-lg px-3 py-2 text-xs font-medium" style={{ background: `${VERMELHO}14`, color: VERMELHO }}>Afeta também {afetados.length} pivô{afetados.length > 1 ? 's' : ''} alimentado{afetados.length > 1 ? 's' : ''} por este ativo. A mesma causa será aplicada a todos, sem nova vistoria.</p>}
              <div className="grid grid-cols-2 gap-2">
                <Campo_ r="Onde" id="loc"><input id="loc" className="campo" placeholder="entrada da casa de bombas 3" value={r.falha.local ?? ''} onChange={(e) => setF({ local: e.target.value })} /></Campo_>
                <Campo_ r="Previsão informada" id="prev"><input id="prev" className="campo" placeholder="hoje, 22:30" value={r.falha.previsao ?? ''} onChange={(e) => setF({ previsao: e.target.value })} /></Campo_>
              </div>
              <Campo_ r="Descrição" id="desc"><textarea id="desc" className="campo" rows={2} value={r.falha.descricao ?? ''} onChange={(e) => setF({ descricao: e.target.value })} /></Campo_>
              <Campo_ r="Resolvido no local?"><Seg opcoes={[{ v: 'sim' as const, t: 'Sim · partida local' }, { v: 'nao' as const, t: 'Não · encaminhar' }]} v={r.resolvidoLocal == null ? null : r.resolvidoLocal ? 'sim' : 'nao'} aoMudar={(v) => set({ resolvidoLocal: v === 'sim', resultado: v === 'sim' ? 'partida_local' : 'nao_iniciou' })} cor={r.resolvidoLocal ? VERDE : VERMELHO} /></Campo_>
            </>
          )}
        </>
      ))}

      {bloco('Resultado e evidência', (
        <>
          <Seg opcoes={[{ v: 'operando' as const, t: 'Em operação' }, { v: 'partida_local' as const, t: 'Partida no painel' }, { v: 'nao_iniciou' as const, t: 'Não iniciou' }]} v={r.resultado} aoMudar={(v) => set({ resultado: v })} cor={r.resultado === 'nao_iniciou' ? VERMELHO : VERDE} />
          <div className="flex flex-wrap gap-2">
            {fotoBtn('painel', 'Foto do painel', r.noPainel)}
            {fotoBtn('ultima_torre', 'Foto da última torre')}
            {r.comFalha && fotoBtn('quadro', 'Foto do quadro ou medidor')}
          </div>
          {r.fotos.length > 0 && <div className="flex flex-wrap gap-2">{r.fotos.map((f) => <img key={f.tipo} src={f.dados} alt={f.tipo} className="h-16 rounded-lg" />)}</div>}
          <Campo_ r="Observação" id="obs"><textarea id="obs" className="campo" rows={2} maxLength={2000} value={r.observacao} onChange={(e) => set({ observacao: e.target.value })} /></Campo_>
        </>
      ))}

      <button className="btn w-full !py-3" disabled={!pronto || lendo}>
        {r.resultado == null ? 'Informe o resultado para concluir' : faltaFoto ? 'Tire a foto do painel para concluir' : r.comFalha && r.resolvidoLocal == null ? 'Diga se a falha foi resolvida no local' : 'Concluir vistoria'}
      </button>
    </form>
  );
}

/* ---------------- ativos compartilhados (gestor) ---------------- */
function Ativos({ fazenda, pivos, ativos, podeEditar }: { fazenda: Fazenda; pivos: PivoCampo[]; ativos: Ativo[]; podeEditar: boolean }) {
  const qc = useQueryClient();
  const [novo, setNovo] = useState<{ tipo: TipoAtivo; nome: string; pivos: number[] } | null>(null);
  const [erro, setErro] = useState('');
  const atualizar = () => qc.invalidateQueries({ queryKey: ['campo', fazenda.id] });
  const criar = useMutation({ mutationFn: () => api(`/fazendas/${fazenda.id}/ativos`, { corpo: novo }), onSuccess: () => { setNovo(null); setErro(''); atualizar(); }, onError: (x) => setErro(msg(x)) });
  const apagar = useMutation({ mutationFn: (id: number) => api(`/ativos/${id}`, { method: 'DELETE' }), onSuccess: atualizar, onError: (x) => setErro(msg(x)) });
  const encerrar = useMutation({ mutationFn: (id: number) => api(`/falhas-ativo/${id}/encerrar`, { method: 'PUT', corpo: {} }), onSuccess: atualizar, onError: (x) => setErro(msg(x)) });
  const nomePivo = (id: number) => pivos.find((p) => p.id === id)?.nome ?? `#${id}`;
  return (
    <Painel atraso={260} titulo="Ativos compartilhados" sub="Casa de bomba, transformador, rede: quem alimenta quais pivôs. Uma falha aqui vale para todos os pivôs do ativo, e o roteiro agrupa as visitas por ele."
      extra={podeEditar && !novo ? <button className="chip" onClick={() => setNovo({ tipo: 'casa_bomba', nome: '', pivos: [] })}>+ Cadastrar ativo</button> : undefined}>
      {ativos.length === 0 && !novo && <p className="text-sm text-slate-500">Nenhum ativo cadastrado. {podeEditar ? 'Cadastre as casas de bomba e o que cada uma alimenta.' : 'Peça ao gestor para cadastrar.'}</p>}
      <div className="grid gap-2 lg:grid-cols-2">
        {ativos.map((a) => (
          <div key={a.id} className="rounded-xl border px-3 py-2 text-sm" style={{ borderColor: a.falha ? `${VERMELHO}66` : 'rgb(148 163 184 / .35)', background: a.falha ? `${VERMELHO}0d` : undefined }}>
            <div className="flex flex-wrap items-center gap-2">
              <b>{a.nome}</b><span className="text-xs text-slate-500">{ROTULO_ATIVO[a.tipo]}</span>
              {a.falha && <Chip cor={VERMELHO}>falha aberta {haQuanto(a.falha.abertaEm)}</Chip>}
              <span className="ml-auto flex gap-1">
                {a.falha && <button className="chip" onClick={() => encerrar.mutate(a.falha!.id)}>Regularizou</button>}
                {podeEditar && <button className="chip" onClick={() => confirm(`Apagar ${a.nome}?`) && apagar.mutate(a.id)}>Apagar</button>}
              </span>
            </div>
            <p className="text-xs text-slate-500">alimenta: {a.pivos.length ? a.pivos.map(nomePivo).join(', ') : 'nenhum pivô vinculado'}</p>
            {a.falha && <p className="text-xs" style={{ color: VERMELHO }}>{a.falha.descricao}{a.falha.previsao ? ` · previsão: ${a.falha.previsao}` : ''}</p>}
          </div>
        ))}
      </div>
      {novo && (
        <form className="mt-3 space-y-2 rounded-xl border border-cyan-500/40 bg-cyan-500/5 p-3" onSubmit={(e) => { e.preventDefault(); if (novo.nome.trim()) criar.mutate(); }}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Campo_ r="Tipo" id="atipo"><select id="atipo" className="campo" value={novo.tipo} onChange={(e) => setNovo({ ...novo, tipo: e.target.value as TipoAtivo })}>{(Object.keys(ROTULO_ATIVO) as TipoAtivo[]).map((t) => <option key={t} value={t}>{ROTULO_ATIVO[t]}</option>)}</select></Campo_>
            <Campo_ r="Nome" id="anome"><input id="anome" className="campo" placeholder="Casa de bombas 3" value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} required /></Campo_>
          </div>
          <Campo_ r="Alimenta os pivôs">
            <div className="flex flex-wrap gap-1">{pivos.map((p) => <button key={p.id} type="button" className="chip" aria-pressed={novo.pivos.includes(p.id)} onClick={() => setNovo({ ...novo, pivos: novo.pivos.includes(p.id) ? novo.pivos.filter((x) => x !== p.id) : [...novo.pivos, p.id] })}>{p.nome}</button>)}</div>
          </Campo_>
          <div className="flex gap-2"><button className="btn" disabled={criar.isPending}>Salvar</button><button type="button" className="btn-sec" onClick={() => setNovo(null)}>Cancelar</button></div>
        </form>
      )}
      {erro && <p role="alert" className="mt-2 text-sm text-red-600">{erro}</p>}
    </Painel>
  );
}

/* ---------------- roteiro editável ---------------- */
const DUR = { ativo: 10, rapida: 15, completa: 45, deslocamento: 10 };

function RoteiroView({ fazenda, plano, itens, porId, pendentes, aoSalvo }: { fazenda: Fazenda; plano: PlanoCampo; itens: ItemOrdem[]; porId: Map<number, PivoCampo>; pendentes: Set<number>; aoSalvo: () => void }) {
  const sugerido = useMemo<Parada[]>(() => {
    // urgência primeiro (sem resposta → completa), depois a sequência da ordem; antes de cada pivô, o ativo com falha que o alimenta
    const ordenados = [...itens].sort((a, b) => Number(iniciouRemoto(porId.get(a.pivoId))) - Number(iniciouRemoto(porId.get(b.pivoId))) || a.sequencia - b.sequencia);
    const out: Parada[] = [];
    const vistos = new Set<string>();
    for (const i of ordenados) {
      for (const a of plano.ativos.filter((x) => x.falha && x.pivos.includes(i.pivoId))) if (!vistos.has(`a${a.id}`)) { vistos.add(`a${a.id}`); out.push({ tipo: 'ativo', id: a.id }); }
      if (!vistos.has(`p${i.pivoId}`)) { vistos.add(`p${i.pivoId}`); out.push({ tipo: 'pivo', id: i.pivoId }); }
    }
    return out;
  }, [itens, plano.ativos, porId]);
  const valido = (p: Parada) => (p.tipo === 'pivo' ? porId.has(p.id) : plano.ativos.some((a) => a.id === p.id));
  const [paradas, setParadas] = useState<Parada[]>(() => (plano.roteiro?.paradas.filter(valido).length ? plano.roteiro.paradas.filter(valido) : sugerido));
  const [saida, setSaida] = useState(plano.roteiro?.saida ?? '19:30');
  const [erro, setErro] = useState('');
  const salvar = useMutation({ mutationFn: () => api(`/fazendas/${fazenda.id}/campo/roteiro`, { method: 'PUT', corpo: { data: plano.data, saida: saida || null, paradas } }), onSuccess: () => { setErro(''); aoSalvo(); }, onError: (x) => setErro(msg(x)) });
  const mover = (i: number, d: -1 | 1) => { const j = i + d; if (j < 0 || j >= paradas.length) return; const n = [...paradas]; [n[i], n[j]] = [n[j], n[i]]; setParadas(n); };
  const fora = itens.filter((i) => !paradas.some((p) => p.tipo === 'pivo' && p.id === i.pivoId));
  const ativosFora = plano.ativos.filter((a) => !paradas.some((p) => p.tipo === 'ativo' && p.id === a.id));

  // hora prevista de chegada: deslocamento fixo + duração da parada anterior (ajuste fino vem com o mapa das estradas)
  let min = saida ? Number(saida.slice(0, 2)) * 60 + Number(saida.slice(3, 5)) : 0;
  const linhas = paradas.map((p) => {
    const chegada = min;
    const pivo = p.tipo === 'pivo' ? porId.get(p.id) : undefined;
    const dur = p.tipo === 'ativo' ? DUR.ativo : pendentes.has(p.id) || pivo?.vistoriaHoje ? DUR.rapida : iniciouRemoto(pivo) ? DUR.rapida : DUR.completa;
    min += dur + DUR.deslocamento;
    return { p, chegada, dur, pivo, ativo: p.tipo === 'ativo' ? plano.ativos.find((a) => a.id === p.id) : undefined };
  });
  const hm = (m: number) => `${String(Math.floor((m / 60) % 24)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  return (
    <div className="space-y-3">
      <Painel titulo="Roteiro de vistoria" sub="Ordem sugerida: pivôs sem resposta primeiro, depois a sequência da ordem; antes de cada pivô, o ativo com falha que o alimenta. Reordene, inclua paradas ou tire o que fica para uma segunda saída."
        extra={<><label className="flex items-center gap-2 text-xs text-slate-500">Saída <input type="time" className="campo !w-auto !py-1" value={saida} onChange={(e) => setSaida(e.target.value)} /></label><span className="chip cursor-default">{fmt((min - (saida ? Number(saida.slice(0, 2)) * 60 + Number(saida.slice(3, 5)) : 0)) / 60, 1)} h previstas</span></>}>
        <ol className="space-y-1.5">
          {linhas.map(({ p, chegada, dur, pivo, ativo }, i) => {
            const item = pivo ? itens.find((x) => x.pivoId === pivo.id) : undefined;
            const cor = ativo ? (ativo.falha ? VERMELHO : AZUL) : pivo?.vistoriaHoje || (pivo && pendentes.has(pivo.id)) ? VERDE : iniciouRemoto(pivo) ? VERDE : semResposta(pivo) ? VERMELHO : AMBAR;
            return (
              <li key={`${p.tipo}${p.id}`} className="flex items-center gap-2 rounded-xl border px-2 py-1.5 text-sm" style={{ borderColor: `${cor}55`, borderStyle: ativo ? 'dashed' : 'solid' }}>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: cor }}>{i + 1}</span>
                <span className="w-11 shrink-0 text-xs font-semibold tabular-nums">{hm(chegada)}</span>
                <span className="min-w-0 flex-1 truncate">
                  <b>{ativo ? ativo.nome : pivo?.nome}</b>
                  <span className="text-xs text-slate-500"> · {ativo ? (ativo.falha ? `conferir: ${ativo.falha.descricao}` : ROTULO_ATIVO[ativo.tipo]) : pivo?.vistoriaHoje || (pivo && pendentes.has(pivo.id)) ? 'vistoriado' : iniciouRemoto(pivo) ? 'roteiro rápido' : semResposta(pivo) ? 'sem resposta · roteiro completo' : 'roteiro completo'}{item?.inicio ? ` · parte ${hora(item.inicio)}` : ''} · {dur} min</span>
                </span>
                <span className="flex shrink-0 gap-0.5">
                  <button type="button" className="chip !px-2" aria-label="Subir" onClick={() => mover(i, -1)} disabled={i === 0}>↑</button>
                  <button type="button" className="chip !px-2" aria-label="Descer" onClick={() => mover(i, 1)} disabled={i === paradas.length - 1}>↓</button>
                  <button type="button" className="chip !px-2" aria-label="Tirar da rota" onClick={() => setParadas(paradas.filter((_, k) => k !== i))}>×</button>
                </span>
              </li>
            );
          })}
        </ol>
        {paradas.length === 0 && <p className="text-sm text-slate-500">Nenhuma parada. Inclua pivôs abaixo.</p>}
        {(fora.length > 0 || ativosFora.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-1 text-xs text-slate-500">
            Incluir:
            {fora.map((i) => <button key={`p${i.pivoId}`} type="button" className="chip" onClick={() => setParadas([...paradas, { tipo: 'pivo', id: i.pivoId }])}>+ {porId.get(i.pivoId)?.nome ?? i.pivoNome}</button>)}
            {ativosFora.map((a) => <button key={`a${a.id}`} type="button" className="chip" onClick={() => setParadas([...paradas, { tipo: 'ativo', id: a.id }])}>+ {a.nome}</button>)}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="btn-sec" onClick={() => setParadas(sugerido)}>Recalcular pela sugestão</button>
          <button type="button" className="btn" disabled={salvar.isPending} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Salvando…' : 'Salvar roteiro'}</button>
          {plano.roteiro && <span className="text-xs text-slate-500">salvo {haQuanto(plano.roteiro.atualizadoEm)}</span>}
          {erro && <p role="alert" className="text-sm text-red-600">{erro}</p>}
        </div>
      </Painel>
    </div>
  );
}

/* ---------------- registros do dia ---------------- */
function Registros({ fazenda, data, fila, porId, aoDescartar }: { fazenda: Fazenda; data: string; fila: VistoriaFila[]; porId: Map<number, PivoCampo>; aoDescartar: (uuid: string) => void }) {
  const q = useQuery({ queryKey: ['campo-vistorias', fazenda.id, data], queryFn: () => api<{ data: string; vistorias: VistoriaRegistro[] }>(`/fazendas/${fazenda.id}/campo/vistorias?data=${data}`), refetchInterval: 60_000, networkMode: 'always', retry: false });
  const corRes: Record<ResultadoVistoria, string> = { operando: VERDE, partida_local: AMBAR, nao_iniciou: VERMELHO };
  const linha = (v: VistoriaRegistro | VistoriaFila, pendente: boolean) => {
    const nome = 'pivoNome' in v ? v.pivoNome : porId.get(v.pivoId)?.nome ?? `Pivô #${v.pivoId}`;
    const cp = v.configPainel;
    const erro = 'erro' in v ? v.erro : undefined;
    return (
      <article key={v.clientUuid} className="rounded-xl border px-3 py-2 text-sm" style={{ borderColor: `${corRes[v.resultado]}55`, background: pendente ? 'rgb(245 158 11 / .06)' : undefined }}>
        <div className="flex flex-wrap items-center gap-2">
          <b>{nome}</b>
          <Chip cor={corRes[v.resultado]}>{ROTULO_RESULTADO[v.resultado]}</Chip>
          <span className="text-xs text-slate-500">{v.tipo === 'rapida' ? 'roteiro rápido' : 'roteiro completo'} · {hora(v.iniciadaEm)}{v.concluidaEm ? ` → ${hora(v.concluidaEm)}` : ''}{'usuario' in v && v.usuario ? ` · ${v.usuario}` : ''}</span>
          {pendente && <Chip cor={AMBAR}>{erro ? 'recusada' : 'aguardando envio'}</Chip>}
        </div>
        <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
          {cp && <>painel: {cp.modelo || '?'} · {cp.sentido === 'anti_horario' ? '↺' : '↻'} · {cp.percentimetro ?? '?'}% · {cp.agua === 'a_seco' ? 'a seco' : 'com água'}{cp.setorDe != null ? ` · setor ${cp.setorDe}°→${cp.setorAte}°` : ' · giro completo'} · </>}
          {v.integridade.posicaoGraus != null && <>posição {v.integridade.posicaoGraus}° · </>}
          {v.integridade.gadoPiquetes?.length ? <span style={{ color: ROXO }}>🐄 {v.integridade.gadoPiquetes.map((id) => porId.get(v.pivoId)?.piquetes.find((p) => p.id === id)?.nome ?? `#${id}`).join(', ')} · </span> : null}
          {v.leituras.pressaoBar != null && <>pressão {fmt(v.leituras.pressaoBar, 1)} bar · </>}
          {v.falha && <span style={{ color: VERMELHO }}>falha: {ORIGENS.find((o) => o.v === v.falha!.origem)?.t ?? v.falha.origem}{v.falha.local ? ` · ${v.falha.local}` : ''}{v.falha.descricao ? ` · ${v.falha.descricao}` : ''} · {v.resolvidoLocal ? 'resolvida no local' : 'encaminhada'} · </span>}
          {v.observacao && <span>{v.observacao}</span>}
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {'id' in v && v.fotos.map((f) => <Foto key={f.id} id={f.id} rotulo={f.tipo === 'painel' ? 'painel' : f.tipo === 'ultima_torre' ? 'última torre' : f.tipo === 'quadro' ? 'quadro' : 'foto'} />)}
          {pendente && erro && <><span className="text-xs text-red-600">{erro}</span><button className="chip" onClick={() => aoDescartar(v.clientUuid)}>Descartar</button></>}
        </div>
      </article>
    );
  };
  return (
    <Painel titulo={`Registros · ${dataBR(data)}`} sub="O que de fato aconteceu em cada pivô: resultado, leituras, configuração no painel, falha e fotos. Cada vistoria volta para o histórico do Irrivert.">
      <div className="space-y-2">
        {fila.map((v) => linha(v, true))}
        {q.data?.vistorias.map((v) => linha(v, false))}
        {!fila.length && !q.data?.vistorias.length && <p className="text-sm text-slate-500">{q.isLoading ? 'Carregando…' : 'Nenhuma vistoria registrada hoje.'}</p>}
      </div>
    </Painel>
  );
}

/* ---------------- tela ---------------- */
type Tela = 'plano' | 'roteiro' | 'registros';

export default function Campo({ fazenda, usuario }: { fazenda: Fazenda; usuario: Usuario }) {
  const qc = useQueryClient();
  const podeEditar = usuario.papel !== 'operador';
  const chave = `irrigacao.campo.${fazenda.id}`;
  const [tela, setTela] = useState<Tela>('plano');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [fila, setFila] = useState<VistoriaFila[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [vistoriando, setVistoriando] = useState<number | null>(null);
  const [erroAcao, setErroAcao] = useState('');

  const plano = useQuery({
    queryKey: ['campo', fazenda.id],
    queryFn: async () => { const d = await api<PlanoCampo>(`/fazendas/${fazenda.id}/campo`); guardarCache(chave, d); return d; },
    initialData: () => lerCache<PlanoCampo>(chave),
    initialDataUpdatedAt: 0,
    refetchInterval: 60_000,
    networkMode: 'always',
    retry: false,
  });

  const recarregarFila = useCallback(async () => setFila(await listarVistoriasFila().catch(() => [])), []);
  const sincronizar = useCallback(async () => {
    const r = await sincronizarVistorias().catch(() => null);
    await recarregarFila();
    if (r?.enviados) { qc.invalidateQueries({ queryKey: ['campo'] }); qc.invalidateQueries({ queryKey: ['campo-vistorias'] }); qc.invalidateQueries({ queryKey: ['ordem'] }); }
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
  useEffect(() => { if (!aviso) return; const t = setTimeout(() => setAviso(null), 6000); return () => clearTimeout(t); }, [aviso]);

  const d = plano.data;
  const porId = useMemo(() => new Map((d?.pivos ?? []).map((p) => [p.id, p])), [d]);
  const itens = useMemo(() => (d?.ordem.itens ?? []).filter((i) => i.status !== 'cancelada'), [d]);
  const cancelados = useMemo(() => (d?.ordem.itens ?? []).filter((i) => i.status === 'cancelada'), [d]);
  const pendentes = useMemo(() => new Set(fila.filter((v) => !v.erro).map((v) => v.pivoId)), [fila]);
  const inoperantes = useMemo(() => (d?.pivos ?? []).filter((p) => p.inoperanteDesde), [d]);
  const vistoriado = (p: PivoCampo | undefined) => !!p?.vistoriaHoje || (!!p && pendentes.has(p.id));
  const ativoComFalha = (pivoId: number) => (d?.ativos ?? []).filter((a) => a.falha && a.pivos.includes(pivoId));

  const manejo = useMutation({ mutationFn: (a: { id: number; motivo: string }) => api(`/ordem/${a.id}/manejo`, { method: 'PUT', corpo: { motivo: a.motivo } }), onSuccess: () => { setErroAcao(''); qc.invalidateQueries({ queryKey: ['campo'] }); qc.invalidateQueries({ queryKey: ['ordem'] }); }, onError: (x) => setErroAcao(msg(x)) });
  const voltar = useMutation({ mutationFn: (id: number) => api(`/ordem/${id}/status`, { method: 'PUT', corpo: { status: 'planejada' } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['campo'] }); qc.invalidateQueries({ queryKey: ['ordem'] }); }, onError: (x) => setErroAcao(msg(x)) });
  const situacao = useMutation({ mutationFn: (a: { id: number; corpo: unknown }) => api(`/pivos/${a.id}/situacao`, { method: 'PUT', corpo: a.corpo }), onSuccess: () => { setErroAcao(''); qc.invalidateQueries({ queryKey: ['campo'] }); }, onError: (x) => setErroAcao(msg(x)) });

  async function salvar(v: VistoriaEnvio) {
    await enfileirarVistoria(v);
    setVistoriando(null);
    await recarregarFila();
    setAviso(online ? 'Vistoria salva. Enviando…' : 'Vistoria salva no aparelho. Será enviada quando houver internet.');
    sincronizar();
  }

  if (!d) {
    return plano.isLoading
      ? <div className="space-y-4"><div className="esqueleto h-20 rounded-2xl" /><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="esqueleto h-24 rounded-2xl" />)}</div></div>
      : <p role="alert" className="vidro p-4 text-sm text-red-600">{(plano.error as Error)?.message ?? 'Erro ao carregar o plano do dia'}. Sem cópia guardada no aparelho.</p>;
  }

  const kRemoto = itens.filter((i) => iniciouRemoto(porId.get(i.pivoId))).length;
  const kSem = itens.filter((i) => semResposta(porId.get(i.pivoId))).length;
  const kVist = itens.filter((i) => vistoriado(porId.get(i.pivoId))).length;
  const emFila = fila.filter((v) => !v.erro).length;
  const grupos = new Map<string, ItemOrdem[]>();
  for (const i of itens) { const c = porId.get(i.pivoId)?.culturas ?? 'Sem cultura'; grupos.set(c, [...(grupos.get(c) ?? []), i]); }
  const pivoVist = vistoriando != null ? porId.get(vistoriando) : undefined;

  return (
    <div className="viz space-y-4">
      {/* barra de comando */}
      <div className="vidro vidro-forte surge flex flex-wrap items-center gap-3 p-4">
        <div className="mr-auto">
          <h1 className="flex items-center gap-2 text-lg font-bold"><span className={online ? 'ponto-vivo' : 'h-2.5 w-2.5 rounded-full bg-slate-400'} aria-hidden /> Campo · vistoria dos pivôs</h1>
          <p className="text-xs text-slate-500">{fazenda.nome} · {dataBR(d.data)} · todo pivô da ordem recebe vistoria no local; o comando remoto só encurta a vistoria{plano.dataUpdatedAt ? ` · atualizado ${haQuanto(new Date(plano.dataUpdatedAt).toISOString())}` : ''}</p>
        </div>
        {!online && <span className="chip cursor-default border-amber-500 text-amber-700 dark:text-amber-300">Sem internet · salvando no aparelho</span>}
        {emFila > 0 && <span className="chip cursor-default border-amber-500 text-amber-700 dark:text-amber-300">{emFila} vistoria{emFila > 1 ? 's' : ''} aguardando envio</span>}
        {emFila > 0 && online && <button className="btn" onClick={sincronizar}>Enviar agora</button>}
        <nav className="flex gap-1 rounded-xl bg-slate-200/60 p-1 dark:bg-slate-800" aria-label="Partes do campo">
          {([['plano', 'Plano do dia'], ['roteiro', 'Roteiro'], ['registros', 'Registros']] as [Tela, string][]).map(([id, t]) => (
            <button key={id} onClick={() => { setTela(id); setVistoriando(null); }} aria-current={tela === id ? 'page' : undefined} className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${tela === id ? 'bg-white text-agua-600 shadow dark:bg-slate-700 dark:text-cyan-300' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}>{t}</button>
          ))}
        </nav>
      </div>
      {erroAcao && <p role="alert" className="vidro p-3 text-sm text-red-600">{erroAcao}</p>}

      {tela === 'plano' && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi atraso={40} rotulo="Na ordem de hoje" valor={itens.length} unidade="pivôs" sub={`${cancelados.length} fora da ordem · ${inoperantes.length} inoperantes`} cor={AZUL} />
            <Kpi atraso={80} rotulo="Iniciaram pelo remoto" valor={kRemoto} unidade={`de ${itens.length}`} sub="telemetria: irrigando ou movendo" cor={VERDE} />
            <Kpi atraso={120} rotulo="Sem resposta" valor={kSem} unidade="pivôs" sub="sem sinal, alarme ou painel desligado" cor={kSem ? VERMELHO : '#64748b'} />
            <Kpi atraso={160} rotulo="Vistoriados" valor={kVist} unidade={`de ${itens.length}`} sub={emFila ? `${emFila} no aparelho, a enviar` : 'confirmados no local'} cor={kVist === itens.length && itens.length ? VERDE : AMBAR} />
          </div>

          {pivoVist && (
            <FormVistoria pivo={pivoVist} item={itens.find((i) => i.pivoId === pivoVist.id) ?? null} ativos={d.ativos} data={d.data} aoFechar={() => setVistoriando(null)} aoSalvar={salvar} />
          )}

          <Painel atraso={200} titulo={`Pivôs com ordem · ${itens.length}`} sub="Agrupados por cultura. O chip da telemetria diz o que o remoto fez; a vistoria confirma no local. Toque em Vistoriar para abrir o formulário.">
            {itens.length === 0 && <p className="text-sm text-slate-500">Nenhum pivô na ordem de hoje. A ordem é montada na aba "Ordem de irrigação".</p>}
            {[...grupos.entries()].map(([cultura, lista]) => (
              <div key={cultura} className="mb-3">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[.12em]" style={{ color: AZUL }}>{cultura}</div>
                <div className="space-y-1.5">
                  {lista.map((i) => {
                    const p = porId.get(i.pivoId);
                    const cat = p?.telemetria?.categoria ?? null;
                    const falhas = ativoComFalha(i.pivoId);
                    const vist = p?.vistoriaHoje;
                    const pend = !!p && pendentes.has(p.id);
                    const cor = vist || pend ? VERDE : falhas.length || semResposta(p) ? VERMELHO : iniciouRemoto(p) ? VERDE : AMBAR;
                    return (
                      <div key={i.id} className="flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: `${cor}55` }}>
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: cor }}>{i.sequencia}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <b>{i.pivoNome}</b>
                            {cat ? <Chip cor={COR_TEL[cat]} title={p?.telemetria?.statusTxt ?? undefined}>{ROTULO_TEL[cat]}</Chip> : <Chip cor="#94a3b8">sem telemetria</Chip>}
                            {i.status === 'enviada' && <Chip cor={AZUL}>comando enviado</Chip>}
                            {vist ? <Chip cor={VERDE}>vistoriado {hora(vist.concluidaEm)} · {ROTULO_RESULTADO[vist.resultado]}</Chip> : pend ? <Chip cor={AMBAR}>vistoria no aparelho</Chip> : iniciouRemoto(p) ? <Chip cor={AMBAR}>vistoria rápida pendente</Chip> : <Chip cor={AMBAR}>vistoria completa pendente</Chip>}
                            {falhas.map((a) => <Chip key={a.id} cor={VERMELHO} title={a.falha!.descricao}>{a.nome}: {a.falha!.descricao}</Chip>)}
                          </div>
                          <p className="text-xs text-slate-500">
                            {fmt(i.laminaMm, 1)} mm · {fmt(i.percentual, 0)}% · parte {hora(i.inicio)} · {i.sentido === 0 ? '↻ frente' : i.sentido === 1 ? '↺ reverso' : 'sentido padrão'}{i.anguloParada != null ? ` · parar em ${grausParaHora(i.anguloParada)}` : ' · giro completo'}
                            {p?.gado.length ? <span style={{ color: ROXO }}> · 🐄 {setorDoGado(p)}</span> : null}
                            {p?.painelModelo ? ` · ${p.painelModelo}` : ''}
                          </p>
                        </div>
                        <span className="flex shrink-0 gap-1">
                          <button className={vist || pend ? 'chip' : 'btn !py-1.5'} onClick={() => { setVistoriando(i.pivoId); window.scrollTo({ top: 0 }); }}>{vist || pend ? 'Nova vistoria' : 'Vistoriar'}</button>
                          {podeEditar && i.status !== 'concluida' && <button className="chip" title="Tirar da ordem por orientação de manejo (o déficit fica registrado como intencional)" onClick={() => { const m = window.prompt(`Tirar ${i.pivoNome} da ordem. Motivo (ex.: capim alto, segurar o crescimento):`); if (m?.trim()) manejo.mutate({ id: i.id, motivo: m.trim() }); }}>Manejo</button>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {cancelados.length > 0 && (
              <div className="mt-2 space-y-1.5">
                <div className="titulo-secao">Fora da ordem</div>
                {cancelados.map((i) => (
                  <div key={i.id} className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: `${ROXO}55`, background: `${ROXO}0d` }}>
                    <span className="min-w-0 flex-1"><b>{i.pivoNome}</b> · {i.motivo ?? i.avisos.join(' ') ?? 'retirado'}</span>
                    {podeEditar && <button className="chip shrink-0" onClick={() => voltar.mutate(i.id)}>Voltar à ordem</button>}
                  </div>
                ))}
              </div>
            )}
          </Painel>

          <Painel atraso={240} titulo={`Inoperantes com necessidade · ${inoperantes.length}`} sub="Pivôs que não podem irrigar por defeito. Continuam visíveis com a previsão de reparo; o déficit acumula no histórico." extra={podeEditar ? (
            <select className="campo !w-auto !py-1 text-xs" value="" onChange={(e) => {
              const id = Number(e.target.value); if (!id) return;
              const motivo = window.prompt('Motivo (ex.: placa de relé do ICON10 queimada):'); if (!motivo?.trim()) return;
              const prev = window.prompt('Reparo previsto (AAAA-MM-DD), ou deixe em branco:') ?? '';
              situacao.mutate({ id, corpo: { inoperanteDesde: hojeLocal(), inoperanteMotivo: motivo.trim(), reparoPrevisto: /^\d{4}-\d{2}-\d{2}$/.test(prev.trim()) ? prev.trim() : null } });
            }}>
              <option value="">Marcar pivô inoperante…</option>
              {d.pivos.filter((p) => !p.inoperanteDesde).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
          ) : undefined}>
            {inoperantes.length === 0 && <p className="text-sm text-slate-500">Nenhum pivô inoperante.</p>}
            <div className="space-y-1.5">
              {inoperantes.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: `${VERMELHO}55` }}>
                  <Chip cor={VERMELHO}>inoperante</Chip>
                  <span className="min-w-0 flex-1"><b>{p.nome}</b> · {p.inoperanteMotivo ?? 'sem motivo'} · desde {dataBR(p.inoperanteDesde!)}{p.reparoPrevisto ? ` · reparo previsto ${dataBR(p.reparoPrevisto)}` : ''}{p.reparoPrevisto === d.data ? ' · parada condicional na rota' : ''}</span>
                  {podeEditar && <button className="chip" onClick={() => situacao.mutate({ id: p.id, corpo: { inoperanteDesde: null } })}>Voltou a operar</button>}
                </div>
              ))}
            </div>
          </Painel>

          <Ativos fazenda={fazenda} pivos={d.pivos} ativos={d.ativos} podeEditar={podeEditar} />
        </>
      )}

      {tela === 'roteiro' && <RoteiroView fazenda={fazenda} plano={d} itens={itens} porId={porId} pendentes={pendentes} aoSalvo={() => { setAviso('Roteiro salvo.'); qc.invalidateQueries({ queryKey: ['campo'] }); }} />}

      {tela === 'registros' && <Registros fazenda={fazenda} data={d.data} fila={fila} porId={porId} aoDescartar={async (u) => { await descartarVistoria(u); recarregarFila(); }} />}

      {aviso && (
        <div role="status" className="surge fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-emerald-400/40 bg-white/90 px-4 py-2 text-sm font-medium text-emerald-700 shadow-lg backdrop-blur dark:bg-slate-900/90 dark:text-emerald-300">✔ {aviso}</div>
      )}
    </div>
  );
}
