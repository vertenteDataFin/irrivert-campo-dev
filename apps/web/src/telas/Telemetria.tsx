import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { api, ErroApi, fmt } from '../api';
import { haQuanto, usePreciso, useTelemetria } from '../hooks';
import { agruparPorPivo } from '../pivos';
import { COR_TEL, ROTULO_TEL, type CategoriaTel, type Fazenda, type PivoTel, type Usuario } from '../tipos';
import { Numero } from '../ui';

const ORDEM: CategoriaTel[] = ['irrigando', 'movendo', 'aguardando', 'parado', 'desligado', 'alarme', 'sem_sinal'];

/** Mostrador do pivô: o braço gira até o ângulo real; irrigando ganha rastro de água e onda. */
function Mostrador({ p }: { p: PivoTel }) {
  const cor = COR_TEL[p.categoria];
  const ang = p.angulo ?? 0;
  const rastro = p.direcao === 1 ? 1 : 0; // reverso: o rastro fica do outro lado
  const x = 60 + 50 * Math.sin((-30 * Math.PI) / 180) * (rastro ? -1 : 1);
  const y = 60 - 50 * Math.cos((30 * Math.PI) / 180);
  return (
    <svg viewBox="0 0 120 120" className="h-36 w-36" role="img" aria-label={`${p.nome}: ${p.statusTxt}, ${fmt(p.angulo, 0)} graus`}>
      <circle cx="60" cy="60" r="54" fill={cor} fillOpacity=".12" stroke={cor} strokeOpacity=".5" strokeWidth="1.5" />
      {p.categoria === 'irrigando' && <circle cx="60" cy="60" r="54" fill="none" stroke={cor} strokeWidth="2" className="onda" />}
      {[0, 90, 180, 270].map((a) => (
        <line key={a} x1="60" y1="6" x2="60" y2="11" stroke="currentColor" strokeOpacity=".35" transform={`rotate(${a} 60 60)`} />
      ))}
      <text x="60" y="15" textAnchor="middle" className="fill-slate-400 text-[7px]">N</text>
      {p.destinoAngulo != null && p.categoria === 'irrigando' && (
        <g transform={`rotate(${p.destinoAngulo} 60 60)`}><path d="M60 9 L56 2 L64 2 Z" fill={cor} /></g>
      )}
      <g style={{ transform: `rotate(${ang}deg)`, transformOrigin: '60px 60px', transition: 'transform 1.2s cubic-bezier(.2,.8,.2,1)' }}>
        {p.categoria === 'irrigando' && <path d={`M60 60 L60 10 A50 50 0 0 ${rastro ? 1 : 0} ${x} ${y} Z`} fill={cor} fillOpacity=".35" />}
        <line x1="60" y1="60" x2="60" y2="8" stroke={cor} strokeWidth="3" strokeLinecap="round" />
        <circle cx="60" cy="8" r="3" fill={cor} />
      </g>
      <circle cx="60" cy="60" r="4" fill={cor} />
      <text x="60" y="84" textAnchor="middle" className="fill-current text-[15px] font-semibold">{p.angulo != null ? `${fmt(p.angulo, 0)}°` : '—'}</text>
    </svg>
  );
}

function Cartao({ p, precisa, podeEditar, pivosMapa }: { p: PivoTel; precisa: 'irrigar' | 'atencao' | 'ok' | null; podeEditar: boolean; pivosMapa: { id: number; nome: string }[] }) {
  const qc = useQueryClient();
  const cor = COR_TEL[p.categoria];
  const refrescar = () => { qc.invalidateQueries({ queryKey: ['telemetria'] }); qc.invalidateQueries({ queryKey: ['preciso'] }); qc.invalidateQueries({ queryKey: ['mapa-base'] }); };
  const vincular = useMutation({ mutationFn: (pivoId: number | null) => api(`/telemetria/pivos/${p.id}`, { method: 'PUT', corpo: { pivoId } }), onSuccess: refrescar });
  const criar = useMutation({ mutationFn: () => api(`/telemetria/pivos/${p.id}/criar-pivo`, { method: 'POST', corpo: {} }), onSuccess: refrescar });

  const alerta =
    p.categoria === 'alarme' ? { t: `Alarme: ${p.statusTxt}`, c: 'bg-red-600' }
    : precisa === 'irrigar' && p.categoria !== 'irrigando' && p.categoria !== 'movendo' && p.categoria !== 'aguardando' ? { t: 'Precisa irrigar e está parado', c: 'bg-red-600' }
    : precisa === 'ok' && p.categoria === 'irrigando' ? { t: 'Irrigando com a lâmina já em dia', c: 'bg-amber-500' }
    : null;

  return (
    <article className="card animate-entrar relative overflow-hidden !p-0" style={{ borderTop: `3px solid ${cor}` }}>
      {alerta && <div className={`${alerta.c} px-3 py-1 text-xs font-medium text-white`}>{alerta.t}</div>}
      <div className="flex items-center gap-3 p-4">
        <Mostrador p={p} />
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="flex items-baseline gap-2 truncate font-semibold">{p.nome}<span className="text-[10px] font-normal uppercase tracking-wide text-slate-400">{p.provedor === 'agsense' ? 'AgSense' : 'Irricontrol'}</span></h3>
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium text-white" style={{ background: cor }}>{p.statusTxt}</span>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 pt-1 text-xs text-slate-500">
            {p.categoria === 'irrigando' && p.percentual != null && (<><dt>Velocidade</dt><dd className="text-right font-medium text-slate-800 dark:text-slate-100">{fmt(p.percentual, 0)}%</dd></>)}
            {p.categoria === 'irrigando' && p.direcao != null && (<><dt>Sentido</dt><dd className="text-right font-medium text-slate-800 dark:text-slate-100">{p.direcao === 1 ? 'Reverso' : 'Frente'}</dd></>)}
            {p.destinoAngulo != null && p.categoria === 'irrigando' && (<><dt>Vai até</dt><dd className="text-right font-medium text-slate-800 dark:text-slate-100">{fmt(p.destinoAngulo, 0)}°</dd></>)}
            {p.tensaoV != null && (<><dt>Tensão</dt><dd className="text-right font-medium text-slate-800 dark:text-slate-100">{fmt(p.tensaoV, 0)} V</dd></>)}
            {p.pressaoPonta != null && (<><dt>Pressão ponta</dt><dd className="text-right font-medium text-slate-800 dark:text-slate-100">{fmt(p.pressaoPonta, 1)} bar</dd></>)}
            {p.horasMolhado != null && (<><dt>Horas molhado</dt><dd className="text-right font-medium text-slate-800 dark:text-slate-100">{fmt(p.horasMolhado, 0)} h</dd></>)}
            <dt>Atualizado</dt><dd className="text-right font-medium text-slate-800 dark:text-slate-100" title={p.atualizadoEm ?? ''}>{haQuanto(p.atualizadoEm)}</dd>
          </dl>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-2 text-xs dark:border-slate-700">
        {p.pivoId != null ? (
          <span className="text-slate-500">Mapa: <b className="text-slate-800 dark:text-slate-100">{p.pivoNome}</b>{p.areaHa ? ` · ${fmt(p.areaHa, 0)} ha` : ''}{p.vazaoM3h ? ` · ${fmt(p.vazaoM3h, 0)} m³/h` : ''}</span>
        ) : (
          <span className="text-amber-600">Ainda não está no mapa</span>
        )}
        {podeEditar && (
          <span className="ml-auto flex items-center gap-2">
            <select className="campo !w-auto !py-1 !text-xs" value={p.pivoId ?? ''} aria-label={`Vincular ${p.nome} a um pivô do mapa`} onChange={(e) => vincular.mutate(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Sem vínculo</option>
              {pivosMapa.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
            </select>
            {p.pivoId == null && p.lat != null && <button className="btn-sec !py-1 !text-xs" disabled={criar.isPending} onClick={() => criar.mutate()}>{criar.isPending ? 'Criando…' : 'Criar no mapa'}</button>}
          </span>
        )}
      </div>
      {(vincular.error || criar.error) && <p role="alert" className="px-4 pb-2 text-xs text-red-600">{((vincular.error ?? criar.error) as Error).message}</p>}
    </article>
  );
}

const PROVEDORES = [
  { id: 'irricontrol', rotulo: 'Irricontrol' },
  { id: 'agsense', rotulo: 'AgSense 365' },
] as const;

function Conexao({ fazenda, provedor, rotulo, conta, aoSalvar }: { fazenda: Fazenda; provedor: string; rotulo: string; conta: { usuario: string } | null; aoSalvar: () => void }) {
  const [usuario, setUsuario] = useState(conta?.usuario ?? '');
  const [senha, setSenha] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const salvar = useMutation({
    mutationFn: () => api<{ pivos: number; casados: number }>(`/fazendas/${fazenda.id}/telemetria/${provedor}`, { method: 'PUT', corpo: { usuario, senha } }),
    onSuccess: (r) => { setSenha(''); setMsg({ ok: true, t: `Conectado: ${r.pivos} pivôs lidos, ${r.casados} já casados com o mapa.` }); aoSalvar(); },
    onError: (x) => setMsg({ ok: false, t: x instanceof ErroApi ? x.message : 'Falha ao conectar' }),
  });
  const desconectar = useMutation({ mutationFn: () => api(`/fazendas/${fazenda.id}/telemetria/${provedor}`, { method: 'DELETE' }), onSuccess: aoSalvar });
  function enviar(e: FormEvent) { e.preventDefault(); setMsg(null); salvar.mutate(); }

  return (
    <form onSubmit={enviar} className="card space-y-3">
      <div>
        <h2 className="font-semibold">Conta {rotulo}</h2>
        <p className="text-xs text-slate-500">Somente leitura: o sistema consulta status, posição e horas, e não envia comandos aos pivôs. A senha fica cifrada no servidor.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div><label className="rotulo" htmlFor={`u-${provedor}`}>Usuário ou e-mail</label><input id={`u-${provedor}`} className="campo" autoComplete="off" value={usuario} onChange={(e) => setUsuario(e.target.value)} required /></div>
        <div><label className="rotulo" htmlFor={`s-${provedor}`}>Senha</label><input id={`s-${provedor}`} className="campo" type="password" autoComplete="new-password" value={senha} onChange={(e) => setSenha(e.target.value)} required /></div>
        <button className="btn" disabled={salvar.isPending}>{salvar.isPending ? 'Conectando…' : conta ? 'Atualizar acesso' : 'Conectar'}</button>
      </div>
      {msg && <p role="alert" className={`text-sm ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{msg.t}</p>}
      {conta && <button type="button" className="btn-sec" disabled={desconectar.isPending} onClick={() => confirm(`Desconectar ${rotulo} e apagar o histórico de telemetria dela?`) && desconectar.mutate()}>Desconectar</button>}
    </form>
  );
}

export default function Telemetria({ fazenda, usuario }: { fazenda: Fazenda; usuario: Usuario }) {
  const qc = useQueryClient();
  const tel = useTelemetria(fazenda.id);
  const preciso = usePreciso(fazenda.id, true);
  const [filtro, setFiltro] = useState<CategoriaTel | null>(null);
  const podeEditar = usuario.papel !== 'operador';

  const pivosMapa = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of preciso.data?.parcelas ?? []) m.set(p.pivoId, p.pivoNome);
    return [...m.entries()].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
  }, [preciso.data]);
  const situacao = useMemo(() => {
    const m = new Map<number, 'irrigar' | 'atencao' | 'ok'>();
    for (const g of agruparPorPivo(preciso.data?.parcelas ?? [])) m.set(g.parcelas[0].pivoId, g.status);
    return m;
  }, [preciso.data]);
  const sincronizar = useMutation({
    mutationFn: () => api(`/fazendas/${fazenda.id}/telemetria/sincronizar`, { method: 'POST', corpo: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telemetria'] }),
  });

  if (tel.isLoading) return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="esqueleto h-56 rounded-2xl" />)}</div>;
  const contas = tel.data?.contas ?? [];
  const pivos = tel.data?.pivos ?? [];
  const erros = contas.filter((c) => c.ultimoErro);
  const ultima = contas.map((c) => c.ultimaSincronizacao).filter((d): d is string => d != null).sort().pop() ?? null;
  const conta_ = (c: CategoriaTel) => pivos.filter((p) => p.categoria === c).length;
  const lista = pivos.filter((p) => !filtro || p.categoria === filtro)
    .sort((a, b) => ORDEM.indexOf(a.categoria) - ORDEM.indexOf(b.categoria) || a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));

  return (
    <div className="space-y-4">
      {contas.length === 0 && (
        <div className="card animate-entrar space-y-1 text-center">
          <div className="text-3xl" aria-hidden>📡</div>
          <h2 className="text-lg font-semibold">Conecte a telemetria dos pivôs</h2>
          <p className="text-sm text-slate-500">Veja cada pivô ao vivo (ângulo, status, velocidade, tensão), receba alertas e deixe a lâmina aplicada entrar sozinha no balanço hídrico.</p>
        </div>
      )}

      {contas.length > 0 && (
        <>
          <div className="card flex flex-wrap items-center gap-2 !p-3">
            {ORDEM.filter((c) => conta_(c) > 0).map((c) => (
              <button key={c} onClick={() => setFiltro(filtro === c ? null : c)} aria-pressed={filtro === c}
                className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition ${filtro === c ? 'border-transparent text-white shadow-md' : 'border-slate-300 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700'}`}
                style={filtro === c ? { background: COR_TEL[c] } : undefined}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: COR_TEL[c] }} />{ROTULO_TEL[c]} <b className="tabular-nums"><Numero valor={conta_(c)} /></b>
              </button>
            ))}
            <span className="ml-auto flex items-center gap-3 text-xs text-slate-500">
              {erros.length > 0
                ? <span className="text-red-600" role="alert">{erros.map((c) => `${c.provedor === 'agsense' ? 'AgSense' : 'Irricontrol'}: ${c.ultimoErro}`).join(' · ')}</span>
                : <span><span className="ponto-vivo mr-1.5 inline-block align-middle" aria-hidden />{contas.map((c) => (c.provedor === 'agsense' ? 'AgSense' : 'Irricontrol')).join(' + ')} · sincronizado {haQuanto(ultima)}</span>}
              {podeEditar && <button className="btn-sec !py-1 !text-xs" disabled={sincronizar.isPending} onClick={() => sincronizar.mutate()}>{sincronizar.isPending ? 'Lendo…' : 'Atualizar agora'}</button>}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {lista.map((p) => <Cartao key={p.id} p={p} precisa={p.pivoId != null ? situacao.get(p.pivoId) ?? null : null} podeEditar={podeEditar} pivosMapa={pivosMapa} />)}
          </div>
          {lista.length === 0 && <p className="card text-sm text-slate-500">Nenhum pivô nesta situação.</p>}
        </>
      )}

      {podeEditar && (
        <div className="grid gap-3 lg:grid-cols-2">
          {PROVEDORES.map((pv) => (
            <Conexao key={pv.id} fazenda={fazenda} provedor={pv.id} rotulo={pv.rotulo} conta={contas.find((c) => c.provedor === pv.id) ?? null}
              aoSalvar={() => qc.invalidateQueries({ queryKey: ['telemetria'] })} />
          ))}
        </div>
      )}
    </div>
  );
}
