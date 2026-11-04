import { useEffect, useRef, useState } from 'react';

/** Número que "rola" até o novo valor (dá vida aos indicadores). */
export function Numero({ valor, casas = 0 }: { valor: number; casas?: number }) {
  const [v, setV] = useState(valor);
  const atual = useRef(valor);
  useEffect(() => {
    const de = atual.current;
    const ini = performance.now();
    let raf = 0;
    const passo = (t: number) => {
      const k = Math.min(1, (t - ini) / 600);
      const e = 1 - Math.pow(1 - k, 3);
      atual.current = de + (valor - de) * e;
      setV(atual.current);
      if (k < 1) raf = requestAnimationFrame(passo);
    };
    raf = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(raf);
  }, [valor]);
  return <>{v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}</>;
}

/** Anel de progresso: preenchimento = lâmina/capacidade; marca = limite de segurança. */
export function Anel({ frac, limite, cor, rotulo, sub }: { frac: number; limite: number; cor: string; rotulo: string; sub: string }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac));
  const ang = (Math.max(0, Math.min(1, limite)) * 360 - 90) * (Math.PI / 180);
  return (
    <svg viewBox="0 0 120 120" className="h-28 w-28" role="img" aria-label={`${rotulo} ${sub}`}>
      <circle cx="60" cy="60" r={r} fill="none" strokeWidth="10" className="stroke-slate-200 dark:stroke-slate-700" />
      <circle
        cx="60" cy="60" r={r} fill="none" strokeWidth="10" strokeLinecap="round" stroke={cor}
        strokeDasharray={c} strokeDashoffset={c * (1 - f)} transform="rotate(-90 60 60)"
        style={{ transition: 'stroke-dashoffset .7s ease, stroke .4s' }}
      />
      <line
        x1={60 + (r - 9) * Math.cos(ang)} y1={60 + (r - 9) * Math.sin(ang)}
        x2={60 + (r + 9) * Math.cos(ang)} y2={60 + (r + 9) * Math.sin(ang)}
        stroke="currentColor" strokeWidth="2" opacity=".7"
      />
      <text x="60" y="58" textAnchor="middle" className="fill-current text-[20px] font-semibold">{rotulo}</text>
      <text x="60" y="76" textAnchor="middle" className="fill-slate-500 text-[9px]">{sub}</text>
    </svg>
  );
}
