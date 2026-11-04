/**
 * Casca do app de campo: só a aba Campo, sem o cabeçalho e as abas do sistema de gestão.
 * Em modo demonstração (VITE_DEMO=1) roda com o simulador de API do navegador e sem login.
 */
import { useQuery } from '@tanstack/react-query';
import { api, token } from './api';
import { DEMO_FAZENDA, DEMO_USUARIO, reiniciarDemo } from './demo';
import Campo from './telas/Campo';
import type { Fazenda, Usuario } from './tipos';

const DEMO = import.meta.env.VITE_DEMO === '1';

export default function AppCampo() {
  if (DEMO && !token.get()) token.set('demo');
  const eu = useQuery({ queryKey: ['eu'], queryFn: () => api<Usuario>('/auth/me'), initialData: DEMO ? DEMO_USUARIO : undefined });
  const fazendas = useQuery({ queryKey: ['fazendas'], queryFn: () => api<Fazenda[]>('/fazendas'), initialData: DEMO ? [DEMO_FAZENDA] : undefined });
  const fazenda = fazendas.data?.[0];

  return (
    <div className="mx-auto max-w-3xl px-3 pb-10 sm:px-6">
      {DEMO && (
        <div className="-mx-3 mb-3 flex items-center gap-3 bg-amber-100 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100 sm:-mx-6 sm:px-6">
          <span className="min-w-0 flex-1">Demonstração com dados de exemplo. Nada é enviado ao Irrivert; o que você registrar fica neste aparelho.</span>
          <button type="button" className="shrink-0 rounded-md border border-amber-400 px-2 py-1 font-medium" onClick={() => { if (confirm('Apagar tudo o que foi registrado na demonstração?')) reiniciarDemo(); }}>Reiniciar</button>
        </div>
      )}
      {fazenda && eu.data
        ? <Campo fazenda={fazenda} usuario={eu.data} />
        : <p className="p-4 text-sm text-slate-500">{fazendas.isError || eu.isError ? 'Não foi possível carregar.' : 'Carregando…'}</p>}
    </div>
  );
}
