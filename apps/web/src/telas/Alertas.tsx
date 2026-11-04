import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ErroApi } from '../api';
import { haQuanto, useAlertas } from '../hooks';
import type { Alerta, Fazenda, SeveridadeAlerta, Usuario } from '../tipos';

const COR: Record<SeveridadeAlerta, string> = { alta: '#dc2626', media: '#f59e0b', baixa: '#64748b' };
const ROTULO: Record<SeveridadeAlerta, string> = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };

const telefoneWa = (t: string) => {
  const d = t.replace(/\D/g, '');
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
};

/** Abre o WhatsApp com o alerta pronto — um toque para enviar. */
function EnviarZap({ alerta, destinatarios }: { alerta: Alerta; destinatarios: { id: number; nome: string; telefone: string }[] }) {
  const [alvo, setAlvo] = useState(destinatarios[0] ? String(destinatarios[0].id) : 'outro');
  const [outro, setOutro] = useState('');
  const tel = alvo === 'outro' ? outro : destinatarios.find((d) => String(d.id) === alvo)?.telefone ?? '';
  const valido = telefoneWa(tel).length >= 12;

  function abrir() {
    const texto = `${alerta.mensagem}\n\n${window.location.origin}`;
    window.open(`https://wa.me/${telefoneWa(tel)}?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <select className="campo !w-auto !py-1 !text-xs" value={alvo} onChange={(e) => setAlvo(e.target.value)} aria-label="Quem recebe">
        {destinatarios.map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}
        <option value="outro">Outro número…</option>
      </select>
      {alvo === 'outro' && <input className="campo !w-40 !py-1 !text-xs" inputMode="tel" placeholder="(67) 99999-9999" value={outro} onChange={(e) => setOutro(e.target.value)} />}
      <button className="btn !py-1 !text-xs" disabled={!valido} onClick={abrir}>Enviar no WhatsApp</button>
    </div>
  );
}

function Cartao({ a, destinatarios, podeDispensar, aoMudar }: { a: Alerta; destinatarios: { id: number; nome: string; telefone: string }[]; podeDispensar: boolean; aoMudar: () => void }) {
  const [zap, setZap] = useState(false);
  const dispensar = useMutation({ mutationFn: () => api(`/alertas/${a.id}/dispensar`, { method: 'PUT', corpo: {} }), onSuccess: aoMudar });
  return (
    <article className="card animate-entrar !p-3" style={{ borderLeft: `4px solid ${COR[a.severidade]}` }}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold leading-tight">{a.titulo}</h3>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{a.mensagem}</p>
          <p className="mt-1 text-xs text-slate-500">
            <span className="mr-2 rounded-full px-2 py-0.5 text-white" style={{ background: COR[a.severidade] }}>{ROTULO[a.severidade]}</span>
            aberto {haQuanto(a.criadoEm)}
            {a.notificadoEm && !a.erroEnvio && <span className="ml-2 text-emerald-600">· enviado {haQuanto(a.notificadoEm)}</span>}
            {a.erroEnvio && <span className="ml-2 text-red-600">· falha no envio: {a.erroEnvio}</span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <button className="btn-sec !py-1 !text-xs" onClick={() => setZap((v) => !v)} aria-expanded={zap}>WhatsApp</button>
          {podeDispensar && <button className="btn-sec !py-1 !text-xs" disabled={dispensar.isPending} onClick={() => dispensar.mutate()} title="Esconde até a condição acabar e voltar">Dispensar</button>}
        </div>
      </div>
      {zap && <EnviarZap alerta={a} destinatarios={destinatarios} />}
    </article>
  );
}

function Destinatarios({ fazenda, lista, envioAutomatico, aoMudar }: { fazenda: Fazenda; lista: { id: number; nome: string; telefone: string; severidadeMin: SeveridadeAlerta }[]; envioAutomatico: boolean; aoMudar: () => void }) {
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [sev, setSev] = useState<SeveridadeAlerta>('media');
  const [erro, setErro] = useState('');
  const add = useMutation({
    mutationFn: () => api(`/fazendas/${fazenda.id}/alertas/destinatarios`, { method: 'POST', corpo: { nome, telefone, severidadeMin: sev } }),
    onSuccess: () => { setNome(''); setTelefone(''); aoMudar(); },
    onError: (x) => setErro(x instanceof ErroApi ? x.message : 'Falha ao salvar'),
  });
  const del = useMutation({ mutationFn: (id: number) => api(`/alertas/destinatarios/${id}`, { method: 'DELETE' }), onSuccess: aoMudar });
  function enviar(e: FormEvent) { e.preventDefault(); setErro(''); add.mutate(); }

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="font-semibold">Quem recebe os alertas</h2>
        <p className="text-xs text-slate-500">
          {envioAutomatico
            ? 'Envio automático ativo: cada alerta novo vai para esses números sem ninguém tocar.'
            : 'Os alertas aparecem aqui e você envia com um toque. Para envio automático, o servidor precisa de um serviço de WhatsApp conectado (ver abaixo).'}
        </p>
      </div>
      {lista.length > 0 && (
        <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-700">
          {lista.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2">
              <span className="mr-auto"><b>{d.nome}</b> <span className="text-slate-500">{d.telefone} · a partir de {ROTULO[d.severidadeMin].toLowerCase()}</span></span>
              <button className="btn-sec !py-1 !text-xs" onClick={() => confirm(`Remover ${d.nome}?`) && del.mutate(d.id)}>Remover</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={enviar} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
        <div><label className="rotulo" htmlFor="d-nome">Nome</label><input id="d-nome" className="campo" value={nome} onChange={(e) => setNome(e.target.value)} required minLength={2} /></div>
        <div><label className="rotulo" htmlFor="d-tel">WhatsApp (com DDD)</label><input id="d-tel" className="campo" inputMode="tel" placeholder="(67) 99999-9999" value={telefone} onChange={(e) => setTelefone(e.target.value)} required /></div>
        <div>
          <label className="rotulo" htmlFor="d-sev">Receber</label>
          <select id="d-sev" className="campo" value={sev} onChange={(e) => setSev(e.target.value as SeveridadeAlerta)}>
            <option value="alta">Só urgentes</option><option value="media">Médios e urgentes</option><option value="baixa">Todos</option>
          </select>
        </div>
        <button className="btn" disabled={add.isPending}>Adicionar</button>
      </form>
      {erro && <p role="alert" className="text-sm text-red-600">{erro}</p>}
      {!envioAutomatico && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">Como ligar o envio automático</summary>
          <p className="mt-1">
            O sistema chama um endereço (webhook) do seu serviço de WhatsApp, com <code>telefone</code> e <code>mensagem</code> em JSON, a cada alerta novo. Serve para Z-API, Evolution API, n8n, entre outros.
            Basta configurar <code>WHATSAPP_WEBHOOK_URL</code> (e, se houver, <code>WHATSAPP_WEBHOOK_TOKEN</code>) no servidor.
          </p>
        </details>
      )}
    </section>
  );
}

export default function Alertas({ fazenda, usuario }: { fazenda: Fazenda; usuario: Usuario }) {
  const qc = useQueryClient();
  const q = useAlertas(fazenda.id);
  const podeEditar = usuario.papel !== 'operador';
  const refrescar = () => qc.invalidateQueries({ queryKey: ['alertas'] });

  if (q.isLoading) return <div className="space-y-3"><div className="esqueleto h-20 rounded-xl" /><div className="esqueleto h-20 rounded-xl" /></div>;
  const d = q.data;
  if (!d) return <p className="card text-red-600">Não foi possível carregar os alertas.</p>;

  return (
    <div className="space-y-4">
      {d.abertos.length === 0 ? (
        <div className="card animate-entrar space-y-1 text-center">
          <div className="text-3xl" aria-hidden>✅</div>
          <h2 className="text-lg font-semibold">Nenhum alerta aberto</h2>
          <p className="text-sm text-slate-500">Nenhum pivô em alarme, sem comunicação ou parado quando precisa irrigar. Isso é checado a cada 2 minutos.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {d.abertos.map((a) => <Cartao key={a.id} a={a} destinatarios={d.destinatarios} podeDispensar aoMudar={refrescar} />)}
        </div>
      )}

      {podeEditar && <Destinatarios fazenda={fazenda} lista={d.destinatarios} envioAutomatico={d.envioAutomatico} aoMudar={refrescar} />}

      {d.recentes.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-medium">Resolvidos nos últimos 7 dias ({d.recentes.length})</summary>
          <ul className="mt-2 divide-y divide-slate-200 text-sm dark:divide-slate-700">
            {d.recentes.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: COR[a.severidade] }} />
                <span className="mr-auto">{a.titulo}</span>
                <span className="text-xs text-slate-500">{a.dispensado && !a.resolvidoEm ? 'dispensado' : `resolvido ${haQuanto(a.resolvidoEm)}`}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
