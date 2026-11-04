import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, dataBR, fmt, hhmm, hojeLocal } from '../api';
import { usePreciso } from '../hooks';
import type { Fazenda, Usuario } from '../tipos';

interface Linha { id: number; data: string; lamina_mm: number | null; tempo_min: number | null; origem: string; parcela: string; pivo: string; usuario: string | null }

export default function Lancamento({ fazenda, usuario }: { fazenda: Fazenda; usuario: Usuario }) {
  const qc = useQueryClient();
  const preciso = usePreciso(fazenda.id, true);
  const lista = useQuery({ queryKey: ['lancamentos', fazenda.id], queryFn: () => api<Linha[]>(`/fazendas/${fazenda.id}/lancamentos`) });
  const [parcelaId, setParcela] = useState('');
  const [data, setData] = useState(hojeLocal());
  const [modo, setModo] = useState<'mm' | 'min'>('mm');
  const [valor, setValor] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['lancamentos', fazenda.id] });
    qc.invalidateQueries({ queryKey: ['preciso'] });
  };

  const salvar = useMutation({
    mutationFn: (v: { parcela_id: number; data: string; lamina_mm?: number; tempo_min?: number }) => api('/lancamentos', { corpo: v }),
    onSuccess: () => { setMsg({ ok: true, texto: 'Irrigação registrada e balanço atualizado.' }); setValor(''); invalidar(); },
    onError: (e: Error) => setMsg({ ok: false, texto: e.message }),
  });
  const excluir = useMutation({
    mutationFn: (id: number) => api(`/lancamentos/${id}`, { method: 'DELETE' }),
    onSuccess: invalidar,
    onError: (e: Error) => setMsg({ ok: false, texto: e.message }),
  });

  function enviar(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const n = Number(valor.replace(',', '.'));
    if (!parcelaId || !(n > 0)) return setMsg({ ok: false, texto: 'Escolha a parcela e informe um valor maior que zero.' });
    salvar.mutate({ parcela_id: Number(parcelaId), data, ...(modo === 'mm' ? { lamina_mm: n } : { tempo_min: n * 60 }) });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
      <form onSubmit={enviar} className="card space-y-3 self-start">
        <h2 className="font-semibold">Lançar irrigação aplicada</h2>
        <div>
          <label className="rotulo" htmlFor="parcela">Parcela</label>
          <select id="parcela" className="campo" value={parcelaId} onChange={(e) => setParcela(e.target.value)} required>
            <option value="">Selecione…</option>
            {preciso.data?.parcelas.map((p) => <option key={p.id} value={p.id}>{p.pivoNome} · {p.nome} ({p.cultura})</option>)}
          </select>
        </div>
        <div>
          <label className="rotulo" htmlFor="data">Data</label>
          <input id="data" className="campo" type="date" value={data} max={hojeLocal()} onChange={(e) => setData(e.target.value)} required />
        </div>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5"><input type="radio" checked={modo === 'mm'} onChange={() => setModo('mm')} /> Lâmina (mm)</label>
          <label className="flex items-center gap-1.5"><input type="radio" checked={modo === 'min'} onChange={() => setModo('min')} /> Horas de pivô</label>
        </div>
        <div>
          <label className="rotulo" htmlFor="valor">{modo === 'mm' ? 'Lâmina bruta aplicada (mm)' : 'Horas de pivô ligado'}</label>
          <input id="valor" className="campo" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} required />
        </div>
        {msg && <p role="status" className={`text-sm ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{msg.texto}</p>}
        <button className="btn w-full" disabled={salvar.isPending}>{salvar.isPending ? 'Salvando…' : 'Registrar'}</button>
      </form>

      <div className="card overflow-x-auto !p-0">
        <h2 className="px-4 pt-4 font-semibold">Últimos 14 dias</h2>
        <table className="tabela mt-2">
          <thead><tr><th>Data</th><th>Parcela</th><th className="num">Lâmina (mm)</th><th className="num">Tempo</th><th>Origem</th><th>Quem</th><th /></tr></thead>
          <tbody>
            {lista.data?.map((l) => (
              <tr key={l.id}>
                <td>{dataBR(l.data)}</td><td>{l.pivo} · {l.parcela}</td>
                <td className="num">{l.lamina_mm != null ? fmt(l.lamina_mm) : '–'}</td>
                <td className="num">{l.tempo_min != null ? hhmm(l.tempo_min) : '–'}</td>
                <td>{l.origem}</td><td>{l.usuario ?? '–'}</td>
                <td>{usuario.papel !== 'operador' && <button className="text-xs text-red-600 hover:underline" onClick={() => confirm('Excluir este lançamento?') && excluir.mutate(l.id)}>excluir</button>}</td>
              </tr>
            ))}
            {lista.data?.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-slate-500">Nenhum lançamento no período.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
