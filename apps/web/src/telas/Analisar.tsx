import { useState } from 'react';
import { dataBR, fmt, hhmm, percentimetro } from '../api';
import { usePreciso } from '../hooks';
import type { Fazenda } from '../tipos';
import { Selo } from './Preciso';

export default function Analisar({ fazenda }: { fazenda: Fazenda }) {
  const [soRecomendadas, setSo] = useState(false);
  const q = usePreciso(fazenda.id, true);
  if (q.isLoading) return <p>Calculando…</p>;
  if (q.error || !q.data) return <p className="card text-red-600">Erro: {(q.error as Error)?.message}</p>;

  const linhas = q.data.parcelas.filter((p) => !soRecomendadas || p.recomendacao.recomendaIrrigar);
  const semClima = q.data.parcelas.reduce((s, p) => s + p.estimados, 0);

  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4" checked={soRecomendadas} onChange={(e) => setSo(e.target.checked)} /> Mostrar só parcelas com irrigação recomendada
      </label>
      <div className="card overflow-x-auto !p-0">
        <table className="tabela">
          <thead>
            <tr>
              <th>Parcela</th><th>Cultivar</th><th className="num">Área (ha)</th><th className="num">Kc</th>
              <th className="num">Lâmina (mm)</th><th className="num">Etc hoje (mm)</th>
              <th className="num">ITN (mm)</th><th className="num" title="Velocidade do pivô para aplicar a lâmina numa volta">Percentímetro</th><th className="num">Tempo (hh:mm)</th>
              <th>Última irrigação</th><th>Situação</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((p) => (
              <tr key={p.id}>
                <td className="font-medium">{p.pivoNome} · {p.nome}</td>
                <td>{p.cultura}</td>
                <td className="num">{fmt(p.areaHa, 0)}</td>
                <td className="num">{fmt(p.kc, 2)}</td>
                <td className="num">{fmt(p.laminaMm)}</td>
                <td className="num">{fmt(p.etcHojeMm)}</td>
                <td className="num">{p.recomendacao.recomendaIrrigar ? fmt(p.recomendacao.itnMm) : '–'}</td>
                <td className="num">{p.recomendacao.recomendaIrrigar ? `${fmt(percentimetro(p.recomendacao.percentualVolta), 0)}%` : '–'}</td>
                <td className="num font-medium">{p.recomendacao.recomendaIrrigar ? hhmm(p.recomendacao.tempoMin) : '–'}</td>
                <td>{p.ultimaIrrigacao ? dataBR(p.ultimaIrrigacao) : 'sem registro'}</td>
                <td><Selo status={p.status} /></td>
              </tr>
            ))}
            {linhas.length === 0 && <tr><td colSpan={11} className="py-6 text-center text-slate-500">Nenhuma parcela precisa de irrigação agora.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        ITN = irrigação total necessária (líquida, repõe até a capacidade). O tempo considera a eficiência do pivô e a lâmina bruta por hora a 100%.
        “% volta” é a ITN bruta sobre a lâmina de uma volta completa a 100%.
        {semClima > 0 && ` ${semClima} dia(s) de histórico sem leitura de clima usaram a ETo média recente.`}
      </p>
    </div>
  );
}
