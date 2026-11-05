/**
 * Campo: vistoria presencial dos pivôs da ordem do dia.
 * Regra da fazenda: todo pivô com ordem recebe vistoria no local; o comando remoto só encurta a vistoria.
 * Funciona sem internet: o plano fica guardado no aparelho e as vistorias vão para a fila (IndexedDB).
 * Visual: linhas simples, etiquetas quadradas, botões retangulares; o formulário de vistoria é uma folha em etapas.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ErroApi, fmt, hojeLocal, token } from '../api';
import { haQuanto } from '../hooks';
import { descartarVistoria, enfileirarVistoria, guardarCache, lerCache, listarVistoriasFila, novoUuid, reduzirFoto, sincronizarVistorias, type VistoriaFila } from '../offline';
import {
  COR_TEL, ROTULO_ATIVO, ROTULO_RESULTADO, ROTULO_TEL,
  type Ativo, type ConfigPainel, type FalhaVistoria, type Fazenda, type Integridade, type ItemOrdem, type Leituras, type Parada, type PivoCampo, type PlanoCampo,
  type PiqueteCampo, type ResultadoVistoria, type TipoAtivo, type TipoFoto, type Usuario, type VistoriaEnvio, type VistoriaRegistro,
} from '../tipos';
import { arcoSvg, cunha, planejarSetor, pontoAzimute, type Arco } from '../setor';

const TZ = 'America/Campo_Grande';
const AZUL = '#0e7490';
const VERDE = '#047857';
const AMBAR = '#b45309';
const VERMELHO = '#b91c1c';
const ROXO = '#7e22ce';
const CINZA = '#64748b';
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
const setorDoGado = (p: PivoCampo) => (p.gado.length ? p.gado.map((g) => `${g.piquete}${g.de != null ? ` ${g.de}°→${g.ate}°` : ''}`).join(', ') : null);
const arcoDo = (p: PiqueteCampo): Arco | null => (p.de != null && p.ate != null ? { de: p.de, ate: p.ate } : null);
const sentidoTxt = (s: 0 | 1 | null) => (s === 0 ? 'frente ↻' : s === 1 ? 'reverso ↺' : 'sentido padrão');

/** Miniatura do pivô: fatias dos piquetes (roxo = com animais), arco azul = setor a irrigar, traço = posição atual. Toque numa fatia marca ou desmarca animais. */
function MiniPivo({ piquetes, ocupados, setor, posicao, aoTocar }: { piquetes: PiqueteCampo[]; ocupados: Set<number>; setor: Arco | null; posicao: number | null; aoTocar?: (id: number) => void }) {
  const c = 64, r = 50;
  const pos = posicao != null ? pontoAzimute(c, c, r, posicao) : null;
  return (
    <svg viewBox="0 0 128 128" className="h-36 w-36 shrink-0" role="img" aria-label="Miniatura do pivô">
      <circle cx={c} cy={c} r={r} fill="rgb(148 163 184 / .18)" stroke="rgb(148 163 184 / .6)" />
      {piquetes.map((p) => { const a = arcoDo(p); if (!a) return null; const on = ocupados.has(p.id); return (
        <path key={p.id} d={cunha(c, c, r, a.de, a.ate)} fill={on ? `${ROXO}88` : 'rgb(148 163 184 / .12)'} stroke="#fff" strokeWidth={1.2} className={aoTocar ? 'cursor-pointer' : undefined} onClick={aoTocar ? () => aoTocar(p.id) : undefined}>
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
function Painel({ titulo, sub, extra, children }: { titulo: string; sub?: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="c-card">
      <header className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div><h2 className="text-sm font-bold">{titulo}</h2>{sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}</div>
        {extra && <div className="flex flex-wrap items-center gap-2">{extra}</div>}
      </header>
      {children}
    </section>
  );
}
function Tag({ cor, children, title }: { cor: string; children: ReactNode; title?: string }) {
  return <span className="c-tag" title={title} style={{ color: cor, background: `${cor}14` }}>{children}</span>;
}
function Opt({ v, t, aoMudar, sub }: { v: boolean | null | undefined; t: string; aoMudar: (b: boolean) => void; sub?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={!!v} onClick={() => aoMudar(!v)} className="c-opt">
      <span className="c-box">{v ? '✓' : ''}</span><span className="min-w-0"><span className="block">{t}</span>{sub && <span className="block text-xs font-normal text-slate-500">{sub}</span>}</span>
    </button>
  );
}
function Seg<T extends string>({ opcoes, v, aoMudar }: { opcoes: { v: T; t: string }[]; v: T | null | undefined; aoMudar: (x: T) => void }) {
  return (
    <div className="c-seg" role="radiogroup" style={{ gridTemplateColumns: `repeat(${opcoes.length}, minmax(0, 1fr))` }}>
      {opcoes.map((o) => <button key={o.v} type="button" role="radio" aria-checked={v === o.v} onClick={() => aoMudar(o.v)}>{o.t}</button>)}
    </div>
  );
}
function Campo_({ r, children, id }: { r: string; children: ReactNode; id?: string }) {
  return <div><label className="rotulo" htmlFor={id}>{r}</label>{children}</div>;
}
const NumInput = ({ id, v, aoMudar, min, max, placeholder, decimal }: { id: string; v: number | null | undefined; aoMudar: (n: number | null) => void; min?: number; max?: number; placeholder?: string; decimal?: boolean }) => (
  <input id={id} className="campo !py-2.5 text-base" type={decimal ? 'text' : 'number'} inputMode={decimal ? 'decimal' : 'numeric'} min={min} max={max} step={1} placeholder={placeholder} value={v ?? ''}
    onChange={(e) => { const s = e.target.value.replace(',', '.'); if (s === '') return aoMudar(null); let n = Number(s); if (Number.isNaN(n)) return; if (!decimal) n = Math.round(n); if (min != null) n = Math.max(min, n); if (max != null) n = Math.min(max, n); aoMudar(n); }} />
);

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
      <button type="button" className="c-btn !min-h-0 !px-2 !py-1 text-xs" onClick={abrir}>{erro ? 'Sem foto (offline?)' : `📷 ${rotulo}`}</button>
      {url && <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 p-4" onClick={() => setUrl(null)} role="dialog" aria-label={rotulo}><img src={url} alt={rotulo} className="max-h-full max-w-full rounded-lg" /></div>}
    </>
  );
}

/* ---------------- formulário de vistoria em etapas ---------------- */
interface Rascunho {
  tipo: 'rapida' | 'completa'; suspeita: string | null; passoEntrada: number | null;
  integridade: Integridade; leituras: Leituras; noPainel: boolean; config: ConfigPainel;
  comFalha: boolean; falha: FalhaVistoria; resolvidoLocal: boolean | null; resultado: ResultadoVistoria | null; observacao: string;
  fotos: { tipo: TipoFoto; dados: string }[];
}
const ETAPAS = [
  { id: 'inicio', t: 'Início' }, { id: 'integridade', t: 'Integridade' }, { id: 'leituras', t: 'Leituras' },
  { id: 'painel', t: 'Painel' }, { id: 'falha', t: 'Falha' }, { id: 'fim', t: 'Conclusão' },
] as const;

function FormVistoria({ pivo, item, ativos, data, aoFechar, aoSalvar }: { pivo: PivoCampo; item: ItemOrdem | null; ativos: Ativo[]; data: string; aoFechar: () => void; aoSalvar: (v: VistoriaEnvio) => void }) {
  const remoto = iniciouRemoto(pivo);
  const [iniciadaEm] = useState(() => new Date().toISOString());
  const [lendo, setLendo] = useState(false);
  const [etapa, setEtapa] = useState(0);
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

  // trava a rolagem da página enquanto a folha está aberta; cada etapa começa no topo
  useEffect(() => { const antes = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = antes; }; }, []);
  useEffect(() => { document.getElementById('folha-corpo')?.scrollTo({ top: 0 }); }, [etapa]);

  const meusAtivos = ativos.filter((a) => a.pivos.includes(pivo.id));
  const ativosDaOrigem = r.falha.origem === 'pivo' ? [] : ativos.filter((a) => a.tipo === r.falha.origem || (r.falha.origem === 'captacao' && a.tipo === 'reservatorio'));
  const afetados = r.falha.ativoId ? ativos.find((a) => a.id === r.falha.ativoId)?.pivos.filter((id) => id !== pivo.id) ?? [] : [];
  const temFotoPainel = r.fotos.some((f) => f.tipo === 'painel');
  const faltaFoto = r.noPainel && !temFotoPainel;
  const pendencia = r.resultado == null ? 'Informe o resultado' : faltaFoto ? 'Tire a foto do painel' : r.comFalha && r.resolvidoLocal == null ? 'Diga se a falha foi resolvida no local' : null;

  async function foto(tipo: TipoFoto, f: File | undefined) {
    if (!f) return;
    setLendo(true);
    try { const d = await reduzirFoto(f); setR((x) => ({ ...x, fotos: [...x.fotos.filter((y) => y.tipo !== tipo), { tipo, dados: d }] })); } finally { setLendo(false); }
  }
  function concluir() {
    if (pendencia || !r.resultado) return;
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
  const fotoBtn = (tipo: TipoFoto, t: string, obrig = false) => {
    const tem = r.fotos.some((f) => f.tipo === tipo);
    return (
      <label className="c-opt cursor-pointer" aria-pressed={tem} style={obrig && !tem ? { borderColor: VERMELHO } : undefined}>
        <span className="c-box">{tem ? '✓' : ''}</span>
        <span className="min-w-0"><span className="block">📷 {t}{obrig && !tem ? ' · obrigatória' : ''}</span>{tem && <span className="block text-xs font-normal text-slate-500">toque para trocar</span>}</span>
        <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => foto(tipo, e.target.files?.[0])} />
      </label>
    );
  };
  const resumoCab = `${pivo.culturas ?? 'sem cultura'}${item ? ` · ${fmt(item.laminaMm, 1)} mm · ${fmt(item.percentual, 0)} %` : ' · sem ordem hoje'}`;
  const telTxt = pivo.telemetria ? (pivo.telemetria.categoria ? ROTULO_TEL[pivo.telemetria.categoria] : pivo.telemetria.statusTxt ?? '—') : 'sem telemetria';

  const corpo: Record<(typeof ETAPAS)[number]['id'], ReactNode> = {
    inicio: (
      <>
        <div className="c-card !p-3 text-sm">
          <div className="flex items-baseline justify-between gap-2"><b className="text-base">{pivo.nome}</b><span className="text-xs font-semibold" style={{ color: pivo.telemetria?.categoria ? COR_TEL[pivo.telemetria.categoria] : CINZA }}>{telTxt}</span></div>
          <p className="text-xs text-slate-500">{resumoCab}</p>
          {item?.anguloParada != null && <p className="text-xs text-slate-500">{sentidoTxt(item.sentido)} · parar em {item.anguloParada}°</p>}
        </div>
        <Campo_ r="Tipo de vistoria">
          <Seg opcoes={[{ v: 'rapida' as const, t: 'Roteiro rápido' }, { v: 'completa' as const, t: 'Roteiro completo' }]} v={r.tipo} aoMudar={(v) => set({ tipo: v })} />
          <p className="mt-1 text-xs text-slate-500">{remoto ? 'A telemetria diz que o pivô iniciou pelo remoto: confirme no local giro, pressão, posição e setor, e registre a foto.' : 'Sem confirmação pela telemetria: o roteiro completo segue a cadeia de diagnóstico.'}</p>
        </Campo_>
        {r.tipo === 'completa' && (
          <Campo_ r="Suspeita antes de entrar">
            <div className="space-y-1.5">
              {SUSPEITAS.map((s) => <Opt key={s.passo} v={r.passoEntrada === s.passo} t={s.t} aoMudar={() => set({ passoEntrada: r.passoEntrada === s.passo ? null : s.passo, suspeita: r.passoEntrada === s.passo ? null : s.t })} />)}
              <Opt v={r.passoEntrada == null} t="Sem suspeita: seguir a cadeia do passo 1" aoMudar={() => set({ passoEntrada: null, suspeita: null })} />
            </div>
            <p className="mt-1 text-xs text-slate-500">A suspeita define por qual passo da cadeia começar. A cadeia continua disponível se a suspeita não se confirmar.</p>
          </Campo_>
        )}
      </>
    ),
    integridade: (
      <>
        <div className="space-y-1.5">
          <Opt v={r.integridade.pneus} t="Pneus das torres" aoMudar={(b) => setI({ pneus: b })} />
          <Opt v={r.integridade.bicos} t="Bicos e aspersores" aoMudar={(b) => setI({ bicos: b })} />
          <Opt v={r.integridade.estrutura} t="Alinhamento e estrutura" aoMudar={(b) => setI({ estrutura: b })} />
          <Opt v={r.integridade.caminho} t="Caminho livre de obstáculos" aoMudar={(b) => setI({ caminho: b })} />
        </div>
        <div className="flex gap-3">
          <MiniPivo piquetes={pivo.piquetes} ocupados={ocupados} setor={r.noPainel ? planoSetor.setor : null} posicao={r.integridade.posicaoGraus ?? null} aoTocar={pivo.piquetes.length ? alternarPiquete : undefined} />
          <div className="min-w-0 flex-1 space-y-2">
            <Campo_ r="Posição atual (0 a 360°)" id="pos"><NumInput id="pos" v={r.integridade.posicaoGraus} aoMudar={(n) => setI({ posicaoGraus: n })} min={0} max={360} placeholder="ex.: 270" /></Campo_>
            <Campo_ r="Gado no piquete">
              {pivo.piquetes.length === 0
                ? <p className="text-xs text-slate-500">Sem piquetes de pastagem neste pivô.</p>
                : <div className="flex flex-wrap gap-1">{pivo.piquetes.map((p) => <button key={p.id} type="button" className="c-btn !min-h-9 !px-2 !py-1 text-xs" aria-pressed={ocupados.has(p.id)} style={ocupados.has(p.id) ? { borderColor: ROXO, color: ROXO, background: `${ROXO}14` } : undefined} title={p.de != null ? `${p.de}°→${p.ate}°` : 'sem arco no mapa'} onClick={() => alternarPiquete(p.id)}>{ocupados.has(p.id) ? '🐄 ' : ''}{p.nome}</button>)}</div>}
            </Campo_>
          </div>
        </div>
        {ocupados.size > 0 && (
          <p className="rounded-md px-3 py-2 text-xs" style={{ color: planoSetor.situacao === 'bloqueado' ? VERMELHO : ROXO, background: `${planoSetor.situacao === 'bloqueado' ? VERMELHO : ROXO}10` }}>
            Animais em {pivo.piquetes.filter((p) => ocupados.has(p.id)).map((p) => p.nome).join(', ')}.
            {planoSetor.setor ? ` Setor livre ${planoSetor.setor.de}°→${planoSetor.setor.ate}°, sentido ${planoSetor.sentido === 'anti_horario' ? 'anti-horário' : 'horário'}.` : ''}
            {planoSetor.avisos.map((a) => ` ${a}`)}
          </p>
        )}
      </>
    ),
    leituras: (
      <>
        <div className="grid grid-cols-2 gap-3">
          <Campo_ r="Pressão no centro (bar)" id="pres"><NumInput id="pres" v={r.leituras.pressaoBar} aoMudar={(n) => setL({ pressaoBar: n })} min={0} max={30} decimal placeholder="3,0" /></Campo_>
          <Campo_ r="Tensão (V)" id="tens"><NumInput id="tens" v={r.leituras.tensaoV} aoMudar={(n) => setL({ tensaoV: n })} min={0} max={1000} placeholder="380" /></Campo_>
        </div>
        <Campo_ r="Fonte de energia"><Seg opcoes={[{ v: 'rede' as const, t: 'Rede' }, { v: 'usina' as const, t: 'Usina' }, { v: 'gerador' as const, t: 'Gerador' }]} v={r.leituras.fonteEnergia} aoMudar={(v) => setL({ fonteEnergia: v })} /></Campo_>
        <Campo_ r="Painel respondeu ao comando remoto?"><Seg opcoes={[{ v: 'sim' as const, t: 'Sim' }, { v: 'nao' as const, t: 'Não' }]} v={r.leituras.painelRespondeu == null ? null : r.leituras.painelRespondeu ? 'sim' : 'nao'} aoMudar={(v) => setL({ painelRespondeu: v === 'sim' })} /></Campo_>
      </>
    ),
    painel: (
      <>
        <Opt v={r.noPainel} t="Irrigação configurada direto no painel do pivô" sub="Só quando a equipe programou no painel em vez do comando remoto. É o que a telemetria não vê." aoMudar={(b) => set({ noPainel: b })} />
        {r.noPainel ? (
          <>
            <Campo_ r="Modelo do painel" id="mod">
              <input id="mod" className="campo !py-2.5 text-base" list="modelos-painel" value={r.config.modelo ?? ''} onChange={(e) => setC({ modelo: e.target.value })} placeholder="Valley ICON10" />
              <datalist id="modelos-painel">{MODELOS_PAINEL.map((m) => <option key={m} value={m} />)}</datalist>
            </Campo_>
            <Campo_ r="Sentido de giro"><Seg opcoes={[{ v: 'horario' as const, t: '↻ Horário' }, { v: 'anti_horario' as const, t: '↺ Anti-horário' }]} v={r.config.sentido} aoMudar={(v) => setC({ sentido: v })} /></Campo_>
            <div className="grid grid-cols-2 gap-3">
              <Campo_ r="Percentímetro (%)" id="perc"><NumInput id="perc" v={r.config.percentimetro} aoMudar={(n) => setC({ percentimetro: n })} min={1} max={100} /></Campo_>
              <Campo_ r="Lâmina (mm)" id="lam"><NumInput id="lam" v={r.config.laminaMm} aoMudar={(n) => setC({ laminaMm: n })} min={0} max={100} decimal /></Campo_>
            </div>
            <Campo_ r="Água"><Seg opcoes={[{ v: 'com_agua' as const, t: 'Com água' }, { v: 'a_seco' as const, t: 'A seco' }]} v={r.config.agua} aoMudar={(v) => setC({ agua: v })} /></Campo_>
            <div className="grid grid-cols-2 gap-3">
              <Campo_ r="Setor de (°)" id="sde"><NumInput id="sde" v={r.config.setorDe} aoMudar={(n) => setC({ setorDe: n })} min={0} max={360} placeholder="giro completo" /></Campo_>
              <Campo_ r="até (°)" id="sate"><NumInput id="sate" v={r.config.setorAte} aoMudar={(n) => setC({ setorAte: n })} min={0} max={360} placeholder="giro completo" /></Campo_>
            </div>
            <p className="text-xs text-slate-500">{r.config.setorDe != null && r.config.setorAte != null ? 'Setor calculado para contornar os piquetes com animais; ajuste se o painel pedir outro valor.' : 'Sem animais marcados: giro completo.'}</p>
          </>
        ) : <p className="text-sm text-slate-500">Nada a registrar aqui: a programação veio do comando remoto.</p>}
      </>
    ),
    falha: (
      <>
        <Opt v={r.comFalha} t="Há falha impedindo a partida ou a irrigação" aoMudar={(b) => set({ comFalha: b })} />
        {r.comFalha ? (
          <>
            <Campo_ r="Passo da cadeia em que apareceu">
              <div className="grid grid-cols-2 gap-1.5">{PASSOS.map((p) => <button key={p.n} type="button" className="c-btn !justify-start" aria-pressed={r.falha.passo === p.n} style={r.falha.passo === p.n ? { borderColor: AZUL, color: AZUL, background: `${AZUL}12` } : undefined} title={p.s} onClick={() => setF({ passo: p.n })}>{p.n} · {p.t}</button>)}</div>
            </Campo_>
            <Campo_ r="Origem da falha">
              <div className="space-y-1.5">{ORIGENS.map((o) => <Opt key={o.v} v={r.falha.origem === o.v} t={o.t} aoMudar={() => setF({ origem: o.v, ativoId: null })} />)}</div>
            </Campo_>
            {r.falha.origem !== 'pivo' && (
              <Campo_ r={`Qual ${ROTULO_ATIVO[r.falha.origem as TipoAtivo].toLowerCase()}?`} id="atv">
                <select id="atv" className="campo !py-2.5 text-base" value={r.falha.ativoId ?? ''} onChange={(e) => setF({ ativoId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— não cadastrado —</option>
                  {ativosDaOrigem.map((a) => <option key={a.id} value={a.id}>{a.nome}{meusAtivos.includes(a) ? ' (alimenta este pivô)' : ''}</option>)}
                </select>
                {ativosDaOrigem.length === 0 && <p className="mt-1 text-xs text-slate-500">Nenhum ativo desse tipo cadastrado. O gestor cadastra em "Ativos compartilhados" no plano do dia.</p>}
              </Campo_>
            )}
            {afetados.length > 0 && <p className="rounded-md px-3 py-2 text-xs font-medium" style={{ background: `${VERMELHO}10`, color: VERMELHO }}>Afeta também {afetados.length} pivô{afetados.length > 1 ? 's' : ''} alimentado{afetados.length > 1 ? 's' : ''} por este ativo. A mesma causa vale para todos, sem nova vistoria.</p>}
            <div className="grid grid-cols-2 gap-3">
              <Campo_ r="Onde" id="loc"><input id="loc" className="campo !py-2.5 text-base" placeholder="entrada da casa de bombas 3" value={r.falha.local ?? ''} onChange={(e) => setF({ local: e.target.value })} /></Campo_>
              <Campo_ r="Previsão informada" id="prev"><input id="prev" className="campo !py-2.5 text-base" placeholder="hoje, 22:30" value={r.falha.previsao ?? ''} onChange={(e) => setF({ previsao: e.target.value })} /></Campo_>
            </div>
            <Campo_ r="Descrição" id="desc"><textarea id="desc" className="campo text-base" rows={3} value={r.falha.descricao ?? ''} onChange={(e) => setF({ descricao: e.target.value })} /></Campo_>
            <Campo_ r="Resolvido no local?"><Seg opcoes={[{ v: 'sim' as const, t: 'Sim · partida local' }, { v: 'nao' as const, t: 'Não · encaminhar' }]} v={r.resolvidoLocal == null ? null : r.resolvidoLocal ? 'sim' : 'nao'} aoMudar={(v) => set({ resolvidoLocal: v === 'sim', resultado: v === 'sim' ? 'partida_local' : 'nao_iniciou' })} /></Campo_>
          </>
        ) : <p className="text-sm text-slate-500">Sem falha: avance para o resultado.</p>}
      </>
    ),
    fim: (
      <>
        <Campo_ r="Resultado"><Seg opcoes={[{ v: 'operando' as const, t: 'Em operação' }, { v: 'partida_local' as const, t: 'Partida no painel' }, { v: 'nao_iniciou' as const, t: 'Não iniciou' }]} v={r.resultado} aoMudar={(v) => set({ resultado: v })} /></Campo_>
        <Campo_ r="Fotos">
          <div className="space-y-1.5">
            {fotoBtn('painel', 'Foto do painel', r.noPainel)}
            {fotoBtn('ultima_torre', 'Foto da última torre')}
            {r.comFalha && fotoBtn('quadro', 'Foto do quadro ou medidor')}
          </div>
          {lendo && <p className="mt-1 text-xs text-slate-500">Preparando a foto…</p>}
          {r.fotos.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{r.fotos.map((f) => <img key={f.tipo} src={f.dados} alt={f.tipo} className="h-20 rounded-md" />)}</div>}
        </Campo_>
        <Campo_ r="Observação" id="obs"><textarea id="obs" className="campo text-base" rows={3} maxLength={2000} value={r.observacao} onChange={(e) => set({ observacao: e.target.value })} /></Campo_>
        <div className="rounded-md bg-slate-100 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <b>Resumo:</b> {r.tipo === 'rapida' ? 'roteiro rápido' : 'roteiro completo'}{r.suspeita ? ` · suspeita: ${r.suspeita}` : ''}
          {r.integridade.posicaoGraus != null ? ` · posição ${r.integridade.posicaoGraus}°` : ''}{ocupados.size ? ` · gado em ${ocupados.size} piquete${ocupados.size > 1 ? 's' : ''}` : ''}
          {r.leituras.pressaoBar != null ? ` · ${fmt(r.leituras.pressaoBar, 1)} bar` : ''}
          {r.noPainel ? ` · painel ${r.config.modelo || '?'} · ${r.config.sentido === 'anti_horario' ? '↺' : '↻'} ${r.config.percentimetro ?? '?'} %${r.config.setorDe != null ? ` · setor ${r.config.setorDe}°→${r.config.setorAte}°` : ' · giro completo'}` : ''}
          {r.comFalha ? ` · falha: ${ORIGENS.find((o) => o.v === r.falha.origem)?.t ?? r.falha.origem}${r.resolvidoLocal == null ? '' : r.resolvidoLocal ? ', resolvida no local' : ', encaminhada'}` : ''}
        </div>
      </>
    ),
  };
  const ultima = etapa === ETAPAS.length - 1;

  return (
    <div className="fixed inset-0 z-[1200] flex flex-col bg-slate-900/40 sm:items-center sm:justify-center sm:p-4" role="dialog" aria-modal="true" aria-label={`Vistoria · ${pivo.nome}`}>
      <div className="flex h-full w-full flex-col bg-white dark:bg-slate-900 sm:h-auto sm:max-h-[94vh] sm:max-w-xl sm:rounded-2xl sm:shadow-xl">
        <header className="border-b border-slate-200 px-4 pt-3 dark:border-slate-700">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-bold">Vistoria · {pivo.nome}</h3>
            <button type="button" className="c-ghost" onClick={aoFechar}>Cancelar</button>
          </div>
          <div className="mt-2 flex gap-1" aria-label="Etapas">
            {ETAPAS.map((e, i) => <button key={e.id} type="button" onClick={() => setEtapa(i)} aria-current={i === etapa ? 'step' : undefined} className="h-1.5 flex-1 rounded-sm" style={{ background: i <= etapa ? AZUL : 'rgb(148 163 184 / .35)' }} title={e.t} />)}
          </div>
          <p className="py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Etapa {etapa + 1} de {ETAPAS.length} · {ETAPAS[etapa].t}</p>
        </header>
        <div id="folha-corpo" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">{corpo[ETAPAS[etapa].id]}</div>
        <footer className="flex items-center gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-700" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
          <button type="button" className="c-btn" onClick={() => setEtapa((e) => Math.max(0, e - 1))} disabled={etapa === 0}>Voltar</button>
          {ultima
            ? <button type="button" className="c-btn-pri flex-1 !py-3" onClick={concluir} disabled={!!pendencia || lendo}>{pendencia ?? 'Concluir vistoria'}</button>
            : <button type="button" className="c-btn-pri flex-1 !py-3" onClick={() => setEtapa((e) => e + 1)}>Avançar</button>}
        </footer>
      </div>
    </div>
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
    <Painel titulo="Ativos compartilhados" sub="Casa de bomba, transformador, rede: quem alimenta quais pivôs. Uma falha aqui vale para todos os pivôs do ativo."
      extra={podeEditar && !novo ? <button className="c-btn" onClick={() => setNovo({ tipo: 'casa_bomba', nome: '', pivos: [] })}>+ Cadastrar</button> : undefined}>
      {ativos.length === 0 && !novo && <p className="text-sm text-slate-500">Nenhum ativo cadastrado. {podeEditar ? 'Cadastre as casas de bomba e o que cada uma alimenta.' : 'Peça ao gestor para cadastrar.'}</p>}
      <div>
        {ativos.map((a) => (
          <div key={a.id} className="c-linha">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1"><b>{a.nome}</b> <span className="text-xs text-slate-500">{ROTULO_ATIVO[a.tipo]}</span></span>
              {a.falha && <button className="c-btn !min-h-8 !px-2 !py-1 text-xs" onClick={() => encerrar.mutate(a.falha!.id)}>Regularizou</button>}
              {podeEditar && <button className="c-ghost !min-h-8 !px-2 !py-1 text-xs" onClick={() => confirm(`Apagar ${a.nome}?`) && apagar.mutate(a.id)}>Apagar</button>}
            </div>
            <p className="text-xs text-slate-500">alimenta {a.pivos.length ? a.pivos.map(nomePivo).join(', ') : 'nenhum pivô'}</p>
            {a.falha && <p className="mt-0.5 text-xs font-medium" style={{ color: VERMELHO }}>Falha {haQuanto(a.falha.abertaEm)}: {a.falha.descricao}{a.falha.previsao ? ` · previsão ${a.falha.previsao}` : ''}</p>}
          </div>
        ))}
      </div>
      {novo && (
        <form className="mt-3 space-y-3 border-t border-slate-200 pt-3 dark:border-slate-700" onSubmit={(e) => { e.preventDefault(); if (novo.nome.trim()) criar.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Campo_ r="Tipo" id="atipo"><select id="atipo" className="campo !py-2.5 text-base" value={novo.tipo} onChange={(e) => setNovo({ ...novo, tipo: e.target.value as TipoAtivo })}>{(Object.keys(ROTULO_ATIVO) as TipoAtivo[]).map((t) => <option key={t} value={t}>{ROTULO_ATIVO[t]}</option>)}</select></Campo_>
            <Campo_ r="Nome" id="anome"><input id="anome" className="campo !py-2.5 text-base" placeholder="Casa de bombas 3" value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} required /></Campo_>
          </div>
          <Campo_ r="Alimenta os pivôs">
            <div className="flex flex-wrap gap-1.5">{pivos.map((p) => <button key={p.id} type="button" className="c-btn !min-h-9 !px-2 !py-1 text-xs" aria-pressed={novo.pivos.includes(p.id)} style={novo.pivos.includes(p.id) ? { borderColor: AZUL, color: AZUL, background: `${AZUL}12` } : undefined} onClick={() => setNovo({ ...novo, pivos: novo.pivos.includes(p.id) ? novo.pivos.filter((x) => x !== p.id) : [...novo.pivos, p.id] })}>{p.nome}</button>)}</div>
          </Campo_>
          <div className="flex gap-2"><button className="c-btn-pri" disabled={criar.isPending}>Salvar</button><button type="button" className="c-btn" onClick={() => setNovo(null)}>Cancelar</button></div>
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
  const inicioMin = saida ? Number(saida.slice(0, 2)) * 60 + Number(saida.slice(3, 5)) : 0;
  let min = inicioMin;
  const linhas = paradas.map((p) => {
    const chegada = min;
    const pivo = p.tipo === 'pivo' ? porId.get(p.id) : undefined;
    const dur = p.tipo === 'ativo' ? DUR.ativo : pendentes.has(p.id) || pivo?.vistoriaHoje ? DUR.rapida : iniciouRemoto(pivo) ? DUR.rapida : DUR.completa;
    min += dur + DUR.deslocamento;
    return { p, chegada, dur, pivo, ativo: p.tipo === 'ativo' ? plano.ativos.find((a) => a.id === p.id) : undefined };
  });
  const hm = (m: number) => `${String(Math.floor((m / 60) % 24)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  return (
    <Painel titulo="Roteiro de vistoria" sub="Sugestão: pivôs sem resposta primeiro, depois a sequência da ordem; antes de cada pivô, o ativo com falha que o alimenta."
      extra={<label className="flex items-center gap-2 text-xs text-slate-500">Saída <input type="time" className="campo !w-auto !py-1.5" value={saida} onChange={(e) => setSaida(e.target.value)} /></label>}>
      <p className="mb-2 text-xs text-slate-500">{paradas.length} parada{paradas.length === 1 ? '' : 's'} · {fmt((min - inicioMin) / 60, 1)} h previstas{plano.roteiro ? ` · salvo ${haQuanto(plano.roteiro.atualizadoEm)}` : ''}</p>
      <ol>
        {linhas.map(({ p, chegada, dur, pivo, ativo }, i) => {
          const item = pivo ? itens.find((x) => x.pivoId === pivo.id) : undefined;
          const cor = ativo ? (ativo.falha ? VERMELHO : AZUL) : pivo?.vistoriaHoje || (pivo && pendentes.has(pivo.id)) ? VERDE : iniciouRemoto(pivo) ? VERDE : semResposta(pivo) ? VERMELHO : AMBAR;
          const estado = ativo ? (ativo.falha ? `conferir: ${ativo.falha.descricao}` : ROTULO_ATIVO[ativo.tipo]) : pivo?.vistoriaHoje || (pivo && pendentes.has(pivo.id)) ? 'vistoriado' : iniciouRemoto(pivo) ? 'roteiro rápido' : semResposta(pivo) ? 'sem resposta · roteiro completo' : 'roteiro completo';
          return (
            <li key={`${p.tipo}${p.id}`} className="c-linha grid grid-cols-[1.5rem_3rem_1fr_auto] items-center gap-x-2 text-sm">
              <span className="text-xs font-semibold tabular-nums text-slate-400">{i + 1}.</span>
              <span className="text-sm font-semibold tabular-nums">{hm(chegada)}</span>
              <span className="min-w-0">
                <span className="block truncate"><b>{ativo ? ativo.nome : pivo?.nome}</b>{pivo?.vistoriaHoje ? <span className="text-xs text-slate-500"> · vistoriado {hora(pivo.vistoriaHoje.concluidaEm)}</span> : null}</span>
                <span className="block truncate text-xs" style={{ color: cor }}>{estado} · {dur} min</span>
              </span>
              <span className="flex gap-1">
                <button type="button" className="c-btn !min-h-9 !px-2.5" aria-label="Subir" onClick={() => mover(i, -1)} disabled={i === 0}>↑</button>
                <button type="button" className="c-btn !min-h-9 !px-2.5" aria-label="Descer" onClick={() => mover(i, 1)} disabled={i === paradas.length - 1}>↓</button>
                <button type="button" className="c-btn !min-h-9 !px-2.5" aria-label="Tirar da rota" onClick={() => setParadas(paradas.filter((_, k) => k !== i))}>×</button>
              </span>
            </li>
          );
        })}
      </ol>
      {paradas.length === 0 && <p className="text-sm text-slate-500">Nenhuma parada. Inclua pivôs abaixo.</p>}
      {(fora.length > 0 || ativosFora.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-slate-200 pt-3 text-xs text-slate-500 dark:border-slate-700">
          Incluir:
          {fora.map((i) => <button key={`p${i.pivoId}`} type="button" className="c-btn !min-h-9 !px-2 !py-1 text-xs" onClick={() => setParadas([...paradas, { tipo: 'pivo', id: i.pivoId }])}>+ {porId.get(i.pivoId)?.nome ?? i.pivoNome}</button>)}
          {ativosFora.map((a) => <button key={`a${a.id}`} type="button" className="c-btn !min-h-9 !px-2 !py-1 text-xs" onClick={() => setParadas([...paradas, { tipo: 'ativo', id: a.id }])}>+ {a.nome}</button>)}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="c-btn" onClick={() => setParadas(sugerido)}>Recalcular</button>
        <button type="button" className="c-btn-pri" disabled={salvar.isPending} onClick={() => salvar.mutate()}>{salvar.isPending ? 'Salvando…' : 'Salvar roteiro'}</button>
        {erro && <p role="alert" className="text-sm text-red-600">{erro}</p>}
      </div>
    </Painel>
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
      <article key={v.clientUuid} className="c-linha text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <b>{nome}</b>
          <Tag cor={corRes[v.resultado]}>{ROTULO_RESULTADO[v.resultado]}</Tag>
          {pendente && <Tag cor={erro ? VERMELHO : AMBAR}>{erro ? 'recusada' : 'aguardando envio'}</Tag>}
          <span className="ml-auto text-xs text-slate-500">{hora(v.iniciadaEm)}{v.concluidaEm ? `–${hora(v.concluidaEm)}` : ''}{'usuario' in v && v.usuario ? ` · ${v.usuario}` : ''}</span>
        </div>
        <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
          {v.tipo === 'rapida' ? 'Roteiro rápido' : 'Roteiro completo'}
          {cp && <> · painel {cp.modelo || '?'} · {cp.sentido === 'anti_horario' ? '↺' : '↻'} {cp.percentimetro ?? '?'} % · {cp.agua === 'a_seco' ? 'a seco' : 'com água'}{cp.setorDe != null ? ` · setor ${cp.setorDe}°→${cp.setorAte}°` : ' · giro completo'}</>}
          {v.integridade.posicaoGraus != null && <> · posição {v.integridade.posicaoGraus}°</>}
          {v.leituras.pressaoBar != null && <> · {fmt(v.leituras.pressaoBar, 1)} bar</>}
          {v.integridade.gadoPiquetes?.length ? <span style={{ color: ROXO }}> · gado em {v.integridade.gadoPiquetes.map((id) => porId.get(v.pivoId)?.piquetes.find((p) => p.id === id)?.nome ?? `#${id}`).join(', ')}</span> : null}
        </p>
        {v.falha && <p className="mt-0.5 text-xs font-medium" style={{ color: VERMELHO }}>Falha: {ORIGENS.find((o) => o.v === v.falha!.origem)?.t ?? v.falha.origem}{v.falha.local ? ` · ${v.falha.local}` : ''}{v.falha.descricao ? ` · ${v.falha.descricao}` : ''} · {v.resolvidoLocal ? 'resolvida no local' : 'encaminhada'}</p>}
        {v.observacao && <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{v.observacao}</p>}
        {('id' in v && v.fotos.length > 0) || (pendente && erro) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {'id' in v && v.fotos.map((f) => <Foto key={f.id} id={f.id} rotulo={f.tipo === 'painel' ? 'painel' : f.tipo === 'ultima_torre' ? 'última torre' : f.tipo === 'quadro' ? 'quadro' : 'foto'} />)}
            {pendente && erro && <><span className="text-xs text-red-600">{erro}</span><button className="c-btn !min-h-8 !px-2 !py-1 text-xs" onClick={() => aoDescartar(v.clientUuid)}>Descartar</button></>}
          </div>
        ) : null}
      </article>
    );
  };
  return (
    <Painel titulo={`Registros · ${dataBR(data)}`} sub="O que de fato aconteceu em cada pivô. Cada vistoria volta para o histórico do Irrivert.">
      <div>
        {fila.map((v) => linha(v, true))}
        {q.data?.vistorias.map((v) => linha(v, false))}
        {!fila.length && !q.data?.vistorias.length && <p className="text-sm text-slate-500">{q.isLoading ? 'Carregando…' : 'Nenhuma vistoria registrada hoje.'}</p>}
      </div>
    </Painel>
  );
}

/* ---------------- tela ---------------- */
type Tela = 'hoje' | 'roteiro' | 'registros' | 'mais';

export default function Campo({ fazenda, usuario }: { fazenda: Fazenda; usuario: Usuario }) {
  const qc = useQueryClient();
  const podeEditar = usuario.papel !== 'operador';
  const chave = `irrigacao.campo.${fazenda.id}`;
  const [tela, setTela] = useState<Tela>('hoje');
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
      ? <div className="space-y-3"><div className="esqueleto h-24 rounded-2xl" /><div className="esqueleto h-16 rounded-2xl" /><div className="esqueleto h-64 rounded-2xl" /></div>
      : <p role="alert" className="c-card text-sm text-red-600">{(plano.error as Error)?.message ?? 'Erro ao carregar o plano do dia'}. Sem cópia guardada no aparelho.</p>;
  }

  const kVist = itens.filter((i) => vistoriado(porId.get(i.pivoId))).length;
  const emFila = fila.filter((v) => !v.erro).length;
  const pivoVist = vistoriando != null ? porId.get(vistoriando) : undefined;
  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;
  const grupos = new Map<string, ItemOrdem[]>();
  for (const i of itens) { const c = porId.get(i.pivoId)?.culturas ?? 'Sem cultura'; grupos.set(c, [...(grupos.get(c) ?? []), i]); }

  return (
    <div className="space-y-3">
      {/* cabeçalho enxuto: situação da conexão, data e as partes do app */}
      <div className="c-card !py-2">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className={online ? 'ponto-vivo' : 'h-2.5 w-2.5 rounded-full bg-slate-400'} aria-hidden />
          <span className="min-w-0 flex-1 truncate">{dataBR(d.data)} · {fazenda.nome}{!online ? ' · sem internet' : ''}{emFila > 0 ? ` · ${plural(emFila, 'vistoria')} a enviar` : ''}</span>
          {emFila > 0 && online && <button className="c-btn !min-h-8 !px-2 !py-1 text-xs" onClick={sincronizar}>Enviar</button>}
        </div>
        <nav className="mt-2 flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" aria-label="Partes do campo">
          {([['hoje', 'Hoje'], ['roteiro', 'Roteiro'], ['registros', 'Registros'], ['mais', 'Mais']] as [Tela, string][]).map(([id, t]) => (
            <button key={id} onClick={() => { setTela(id); setVistoriando(null); }} aria-current={tela === id ? 'page' : undefined} className="c-tab flex-1">{t}</button>
          ))}
        </nav>
      </div>
      {erroAcao && <p role="alert" className="c-card text-sm text-red-600">{erroAcao}</p>}

      {pivoVist && <FormVistoria pivo={pivoVist} item={itens.find((i) => i.pivoId === pivoVist.id) ?? null} ativos={d.ativos} data={d.data} aoFechar={() => setVistoriando(null)} aoSalvar={salvar} />}

      {tela === 'hoje' && (
        <section className="c-card">
          <header className="mb-1 flex items-baseline justify-between gap-2">
            <h2 className="text-base font-bold">Irrigar hoje</h2>
            <span className="text-xs text-slate-500">{plural(itens.length, 'pivô')} · {kVist} vistoriado{kVist === 1 ? '' : 's'}</span>
          </header>
          {itens.length === 0 && <p className="py-2 text-sm text-slate-500">Nenhum pivô para irrigar hoje.</p>}
          {[...grupos.entries()].map(([cultura, lista]) => (
          <div key={cultura}>
          <div className="mt-3 border-b border-slate-200 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-700">{cultura}</div>
          {lista.map((i) => {
            const p = porId.get(i.pivoId);
            const cat = p?.telemetria?.categoria ?? null;
            const falhas = ativoComFalha(i.pivoId);
            const vist = p?.vistoriaHoje;
            const pend = !!p && pendentes.has(p.id);
            const corVist = vist || pend ? VERDE : semResposta(p) || falhas.length ? VERMELHO : AMBAR;
            const txtVist = vist ? `Vistoriado ${hora(vist.concluidaEm)} · ${ROTULO_RESULTADO[vist.resultado]}` : pend ? 'Vistoria no aparelho' : iniciouRemoto(p) ? 'Vistoria rápida pendente' : 'Vistoria completa pendente';
            const txtTel = cat ? ROTULO_TEL[cat] : 'Sem telemetria';
            return (
              <div key={i.id} className="c-linha flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <b className="block text-base">{i.pivoNome}</b>
                  <p className="text-xs text-slate-500">{fmt(i.laminaMm, 1)} mm · {fmt(i.percentual, 0)} % · {sentidoTxt(i.sentido)}{i.anguloParada != null ? ` · parar em ${i.anguloParada}°` : ''}</p>
                  <p className="mt-0.5 text-xs"><span className="font-semibold" style={{ color: cat ? COR_TEL[cat] : CINZA }}>{txtTel}{i.status === 'enviada' ? ' · comando enviado' : ''}</span><span className="text-slate-400"> · </span><span style={{ color: corVist }}>{txtVist}</span></p>
                  {falhas.map((a) => <p key={a.id} className="text-xs font-medium" style={{ color: VERMELHO }}>{a.nome}: {a.falha!.descricao}{a.falha!.previsao ? ` · previsão ${a.falha!.previsao}` : ''}</p>)}
                  {p?.gado.length ? <p className="text-xs" style={{ color: ROXO }}>Gado em {setorDoGado(p)}</p> : null}
                </div>
                <button className={vist || pend ? 'c-btn' : 'c-btn-pri'} onClick={() => setVistoriando(i.pivoId)}>{vist || pend ? 'Nova' : 'Vistoriar'}</button>
              </div>
            );
          })}
          </div>
          ))}
        </section>
      )}

      {tela === 'mais' && (
        <>
          <Painel titulo="Fora da ordem" sub="Pivôs retirados por orientação de manejo. O déficit fica registrado como intencional." extra={podeEditar && itens.length > 0 ? (
            <select className="campo !w-auto !py-1.5 text-xs" value="" onChange={(e) => {
              const id = Number(e.target.value); if (!id) return;
              const i = itens.find((x) => x.id === id); if (!i) return;
              const m = window.prompt(`Tirar ${i.pivoNome} da ordem. Motivo (ex.: capim alto, segurar o crescimento):`); if (m?.trim()) manejo.mutate({ id, motivo: m.trim() });
            }}>
              <option value="">Tirar da ordem…</option>
              {itens.filter((i) => i.status !== 'concluida').map((i) => <option key={i.id} value={i.id}>{i.pivoNome}</option>)}
            </select>
          ) : undefined}>
            {cancelados.length === 0 && <p className="text-sm text-slate-500">Nenhum pivô fora da ordem.</p>}
            {cancelados.map((i) => (
              <div key={i.id} className="c-linha flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1"><b>{i.pivoNome}</b> <span className="text-xs text-slate-500">· {i.motivo ?? i.avisos.join(' ') ?? 'retirado'}</span></span>
                {podeEditar && <button className="c-btn !min-h-8 !px-2 !py-1 text-xs" onClick={() => voltar.mutate(i.id)}>Voltar à ordem</button>}
              </div>
            ))}
          </Painel>

          <Painel titulo={`Inoperantes com necessidade · ${inoperantes.length}`} sub="Pivôs que não podem irrigar por defeito. Continuam visíveis com a previsão de reparo." extra={podeEditar ? (
            <select className="campo !w-auto !py-1.5 text-xs" value="" onChange={(e) => {
              const id = Number(e.target.value); if (!id) return;
              const motivo = window.prompt('Motivo (ex.: placa de relé do ICON10 queimada):'); if (!motivo?.trim()) return;
              const prev = window.prompt('Reparo previsto (AAAA-MM-DD), ou deixe em branco:') ?? '';
              situacao.mutate({ id, corpo: { inoperanteDesde: hojeLocal(), inoperanteMotivo: motivo.trim(), reparoPrevisto: /^\d{4}-\d{2}-\d{2}$/.test(prev.trim()) ? prev.trim() : null } });
            }}>
              <option value="">Marcar inoperante…</option>
              {d.pivos.filter((p) => !p.inoperanteDesde).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
          ) : undefined}>
            {inoperantes.length === 0 && <p className="text-sm text-slate-500">Nenhum pivô inoperante.</p>}
            {inoperantes.map((p) => (
              <div key={p.id} className="c-linha flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block"><b>{p.nome}</b> <Tag cor={VERMELHO}>inoperante</Tag></span>
                  <span className="block text-xs text-slate-500">{p.inoperanteMotivo ?? 'sem motivo'} · desde {dataBR(p.inoperanteDesde!)}{p.reparoPrevisto ? ` · reparo previsto ${dataBR(p.reparoPrevisto)}` : ''}{p.reparoPrevisto === d.data ? ' · parada condicional na rota' : ''}</span>
                </span>
                {podeEditar && <button className="c-btn !min-h-8 !px-2 !py-1 text-xs" onClick={() => situacao.mutate({ id: p.id, corpo: { inoperanteDesde: null } })}>Voltou a operar</button>}
              </div>
            ))}
          </Painel>

          <Ativos fazenda={fazenda} pivos={d.pivos} ativos={d.ativos} podeEditar={podeEditar} />
        </>
      )}

      {tela === 'roteiro' && <RoteiroView fazenda={fazenda} plano={d} itens={itens} porId={porId} pendentes={pendentes} aoSalvo={() => { setAviso('Roteiro salvo.'); qc.invalidateQueries({ queryKey: ['campo'] }); }} />}

      {tela === 'registros' && <Registros fazenda={fazenda} data={d.data} fila={fila} porId={porId} aoDescartar={async (u) => { await descartarVistoria(u); recarregarFila(); }} />}

      {aviso && (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-emerald-600/40 bg-white px-4 py-2 text-sm font-medium text-emerald-800 shadow-lg dark:bg-slate-900 dark:text-emerald-300">✔ {aviso}</div>
      )}
    </div>
  );
}
