const CHAVE = 'irrigacao.token';

export const token = {
  get: () => {
    try { return localStorage.getItem(CHAVE); } catch { return null; }
  },
  set: (t: string) => { try { localStorage.setItem(CHAVE, t); } catch { /* sem storage */ } },
  limpar: () => { try { localStorage.removeItem(CHAVE); } catch { /* sem storage */ } },
};

export class ErroApi extends Error {
  constructor(public status: number, mensagem: string) { super(mensagem); }
}

export async function api<T>(caminho: string, opts: { method?: string; corpo?: unknown } = {}): Promise<T> {
  const t = token.get();
  const r = await fetch(`/api${caminho}`, {
    method: opts.method ?? (opts.corpo ? 'POST' : 'GET'),
    headers: { ...(opts.corpo ? { 'Content-Type': 'application/json' } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: opts.corpo ? JSON.stringify(opts.corpo) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && caminho !== '/auth/login') { token.limpar(); window.dispatchEvent(new Event('irrigacao:sair')); }
    throw new ErroApi(r.status, json.erro ?? `Erro ${r.status}`);
  }
  return json as T;
}

export const fmt = (n: number | null | undefined, d = 1) =>
  n == null ? '–' : n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * Percentímetro do pivô (velocidade, %) para aplicar a lâmina recomendada numa volta, como no iCrop e na Ordem.
 * percentualVolta = lâmina bruta ÷ lâmina de uma volta a 100 % × 100; abaixo de 1 volta fica em 100 % (o pivô não acelera).
 */
export const percentimetro = (percentualVolta: number) => (percentualVolta > 0 ? Math.min(100, Math.max(1, 10000 / percentualVolta)) : 0);

export const hhmm = (min: number) => {
  const t = Math.round(min);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export const dataBR = (iso: string) => iso.split('-').reverse().slice(0, 2).join('/');
export const hojeLocal = () => new Intl.DateTimeFormat('en-CA').format(new Date());
