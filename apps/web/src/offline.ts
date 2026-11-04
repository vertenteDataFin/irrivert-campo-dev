/**
 * Coleta offline: o registro vai para uma fila no aparelho (IndexedDB) e é enviado quando houver internet.
 * O client_uuid garante que um reenvio nunca duplica nada no servidor.
 *
 * Lojas: `fila` (entrada/saída de animais) e `vistorias` (vistorias de campo).
 */
import { api, ErroApi } from './api';
import type { VistoriaEnvio } from './tipos';

export interface Registro {
  clientUuid: string;
  parcelaId: number;
  tipo: 'entrada' | 'saida';
  ocorridoEm: string;
  lote: string | null;
  cabecas: number | null;
  nota: number | null;
  observacao: string | null;
  foto: string | null; // data URL já reduzida
  erro?: string; // recusado pelo servidor: fica na fila até alguém descartar
}

/** Vistoria na fila: o envio mais o erro, se o servidor recusou. */
export interface VistoriaFila extends VistoriaEnvio { erro?: string }

const BANCO = 'irrigacao-offline';
const LOJA = 'fila';
const VISTORIAS = 'vistorias';
const VERSAO = 2; // v2 (03/11/2026): loja `vistorias` do módulo de campo

function abrir(): Promise<IDBDatabase> {
  return new Promise((ok, falha) => {
    const r = indexedDB.open(BANCO, VERSAO);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(LOJA)) db.createObjectStore(LOJA, { keyPath: 'clientUuid' });
      if (!db.objectStoreNames.contains(VISTORIAS)) db.createObjectStore(VISTORIAS, { keyPath: 'clientUuid' });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => falha(r.error);
  });
}

async function txEm<T>(loja: string, modo: IDBTransactionMode, f: (l: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await abrir();
  return new Promise((ok, falha) => {
    const t = db.transaction(loja, modo);
    const req = f(t.objectStore(loja));
    t.oncomplete = () => { db.close(); ok(req.result); };
    t.onerror = () => { db.close(); falha(t.error); };
  });
}
const tx = <T,>(modo: IDBTransactionMode, f: (l: IDBObjectStore) => IDBRequest<T>) => txEm(LOJA, modo, f);

export const novoUuid = (): string =>
  crypto.randomUUID?.() ??
  '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));

export const enfileirar = (r: Registro) => tx('readwrite', (l) => l.put(r));
export const descartar = (uuid: string) => tx('readwrite', (l) => l.delete(uuid));
export const listarFila = () => tx<Registro[]>('readonly', (l) => l.getAll());

let enviando = false;
/** Envia a fila em ordem. Para na primeira falha de rede; erro 4xx do servidor marca o registro e segue. */
export async function sincronizarFila(): Promise<{ enviados: number; pendentes: number }> {
  if (enviando) return { enviados: 0, pendentes: (await listarFila()).length };
  enviando = true;
  let enviados = 0;
  try {
    const fila = (await listarFila()).filter((r) => !r.erro).sort((a, b) => a.ocorridoEm.localeCompare(b.ocorridoEm));
    for (const r of fila) {
      try {
        const { erro: _e, ...corpo } = r;
        await api('/movimentos', { method: 'POST', corpo });
        await descartar(r.clientUuid);
        enviados++;
      } catch (x) {
        if (x instanceof ErroApi && x.status !== 401 && x.status < 500) await enfileirar({ ...r, erro: x.message });
        else break; // sem rede, sessão vencida ou servidor fora: tenta de novo depois
      }
    }
  } finally {
    enviando = false;
  }
  return { enviados, pendentes: (await listarFila()).length };
}

// ---------- vistorias de campo ----------
export const enfileirarVistoria = (v: VistoriaFila) => txEm(VISTORIAS, 'readwrite', (l) => l.put(v));
export const descartarVistoria = (uuid: string) => txEm(VISTORIAS, 'readwrite', (l) => l.delete(uuid));
export const listarVistoriasFila = () => txEm<VistoriaFila[]>(VISTORIAS, 'readonly', (l) => l.getAll());

let enviandoVistorias = false;
export async function sincronizarVistorias(): Promise<{ enviados: number; pendentes: number }> {
  if (enviandoVistorias) return { enviados: 0, pendentes: (await listarVistoriasFila()).length };
  enviandoVistorias = true;
  let enviados = 0;
  try {
    const fila = (await listarVistoriasFila()).filter((v) => !v.erro).sort((a, b) => a.iniciadaEm.localeCompare(b.iniciadaEm));
    for (const v of fila) {
      try {
        const { erro: _e, ...corpo } = v;
        await api('/vistorias', { method: 'POST', corpo });
        await descartarVistoria(v.clientUuid);
        enviados++;
      } catch (x) {
        if (x instanceof ErroApi && x.status !== 401 && x.status < 500) await enfileirarVistoria({ ...v, erro: x.message });
        else break;
      }
    }
  } finally {
    enviandoVistorias = false;
  }
  return { enviados, pendentes: (await listarVistoriasFila()).length };
}

/** Reduz a foto para ~1280 px em JPEG: cabe na fila e sobe rápido no 4G. */
export async function reduzirFoto(arquivo: File, maxLado = 1280, qualidade = 0.72): Promise<string> {
  const bmp = await createImageBitmap(arquivo);
  const k = Math.min(1, maxLado / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL('image/jpeg', qualidade);
}

// cópia da última resposta de uma rota, para a tela abrir sem internet
export const guardarCache = (chave: string, dados: unknown) => { try { localStorage.setItem(chave, JSON.stringify(dados)); } catch { /* cheio */ } };
export const lerCache = <T,>(chave: string): T | undefined => { try { const s = localStorage.getItem(chave); return s ? (JSON.parse(s) as T) : undefined; } catch { return undefined; } };

const chaveCache = (fazendaId: number) => `irrigacao.piquetes.${fazendaId}`;
export const guardarPiquetes = (fazendaId: number, dados: unknown) => guardarCache(chaveCache(fazendaId), dados);
export const lerPiquetes = <T,>(fazendaId: number): T | undefined => lerCache<T>(chaveCache(fazendaId));
