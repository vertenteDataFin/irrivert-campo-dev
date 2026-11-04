import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ErroApi, token } from './api';
import { useAlertas } from './hooks';
import Alertas from './telas/Alertas';
import Analisar from './telas/Analisar';
import Cadastros from './telas/Cadastros';
import Campo from './telas/Campo';
import Clima from './telas/Clima';
import Lancamento from './telas/Lancamento';
import Mapa from './telas/Mapa';
import Ordem from './telas/Ordem';
import Pastejo from './telas/Pastejo';
import Preciso from './telas/Preciso';
import Relatorios from './telas/Relatorios';
import Telemetria from './telas/Telemetria';
import Usuarios from './telas/Usuarios';
import type { Fazenda, Usuario } from './tipos';
import { LogoVertente, MarcaVertente } from './Logo';

const ABAS = [
  { id: 'preciso', rotulo: 'Preciso irrigar?' },
  { id: 'ordem', rotulo: 'Ordem de irrigação' },
  { id: 'campo', rotulo: 'Campo' },
  { id: 'pastejo', rotulo: 'Animais' },
  { id: 'relatorios', rotulo: 'Relatórios' },
  { id: 'analisar', rotulo: 'Analisar' },
  { id: 'mapa', rotulo: 'Mapa' },
  { id: 'telemetria', rotulo: 'Telemetria' },
  { id: 'alertas', rotulo: 'Alertas' },
  { id: 'lancar', rotulo: 'Lançamento' },
  { id: 'clima', rotulo: 'Clima' },
  { id: 'cadastros', rotulo: 'Cadastros' },
  { id: 'usuarios', rotulo: 'Usuários' },
] as const;
type Aba = (typeof ABAS)[number]['id'];

function Login({ aoEntrar }: { aoEntrar: () => void }) {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    setEnviando(true);
    try {
      const r = await api<{ token: string }>('/auth/login', { corpo: { email, senha } });
      token.set(r.token);
      aoEntrar();
    } catch (x) {
      setErro(x instanceof ErroApi ? x.message : 'Não foi possível conectar ao servidor');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={enviar} className="card w-full max-w-sm space-y-4">
        <div className="flex flex-col items-center text-center">
          <LogoVertente className="h-36 w-auto text-[#1d3330] dark:text-slate-100" />
          <h1 className="marca mt-3 text-2xl font-bold tracking-wide">IRRIVERT</h1>
          <p className="text-sm text-slate-500">Entre para ver a recomendação do dia.</p>
        </div>
        <div>
          <label className="rotulo" htmlFor="email">E-mail</label>
          <input id="email" className="campo" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="rotulo" htmlFor="senha">Senha</label>
          <input id="senha" className="campo" type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} required />
        </div>
        {erro && <p role="alert" className="text-sm text-red-600">{erro}</p>}
        <button className="btn w-full" disabled={enviando}>{enviando ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  );
}

function Painel({ aoSair }: { aoSair: () => void }) {
  const qc = useQueryClient();
  const [aba, setAba] = useState<Aba>('preciso');
  const [fazendaId, setFazendaId] = useState<number | null>(null);
  const [foco, setFoco] = useState<number | null>(null);
  const nAlertas = useAlertas(fazendaId ?? 0).data?.abertos.length ?? 0;
  const eu = useQuery({ queryKey: ['eu'], queryFn: () => api<Usuario>('/auth/me') });
  const fazendas = useQuery({ queryKey: ['fazendas'], queryFn: () => api<Fazenda[]>('/fazendas') });

  useEffect(() => {
    if (fazendaId == null && fazendas.data?.length) setFazendaId(fazendas.data[0].id);
  }, [fazendas.data, fazendaId]);

  const fazenda = fazendas.data?.find((f) => f.id === fazendaId) ?? null;

  // altura do menu congelado → --menu-h (scroll-padding do html, para âncoras e scrollIntoView pararem abaixo dele)
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = menuRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--menu-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // com o menu fixo, trocar de aba volta ao topo da nova tela
  const irPara = (a: Aba) => {
    setAba(a);
    window.scrollTo({ top: 0 });
  };

  function sair() {
    token.limpar();
    qc.clear();
    aoSair();
  }

  return (
    <div className="mx-auto max-w-7xl px-3 pb-10 sm:px-6">
      {/* menu congelado: cabeçalho + abas ficam no topo ao rolar (altura em --menu-h para as âncoras não ficarem por baixo) */}
      <div ref={menuRef} className="menu-fixo -mx-3 mb-4 px-3 pb-2 print:hidden sm:-mx-6 sm:px-6">
      <header className="flex items-center gap-2 py-2 sm:gap-3 sm:py-3">
        <h1 className="marca mr-auto flex shrink-0 items-center gap-2 text-lg font-bold">
          <MarcaVertente className="h-7 w-auto text-[#1d3330] dark:text-slate-100" /> IRRIVERT
        </h1>
        {fazendas.data && fazendas.data.length > 1 && (
          <select className="campo !w-auto min-w-0 max-w-[45vw] truncate sm:max-w-none" value={fazendaId ?? ''} onChange={(e) => setFazendaId(Number(e.target.value))} aria-label="Fazenda">
            {fazendas.data.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
          </select>
        )}
        {fazendas.data?.length === 1 && <span className="min-w-0 truncate text-sm text-slate-500">{fazendas.data[0].nome}</span>}
        <span className="hidden text-sm text-slate-500 sm:inline">{eu.data?.nome}</span>
        <button className="btn-sec shrink-0" onClick={sair}>Sair</button>
      </header>

      <nav className="flex gap-1 overflow-x-auto rounded-xl bg-slate-200/60 p-1 dark:bg-slate-800" aria-label="Seções">
        {ABAS.filter((a) => a.id !== 'usuarios' || (eu.data && eu.data.papel !== 'operador')).map((a) => (
          <button
            key={a.id}
            onClick={() => irPara(a.id)}
            aria-current={aba === a.id ? 'page' : undefined}
            className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 ${aba === a.id ? 'bg-white text-agua-600 shadow dark:bg-slate-700 dark:text-cyan-300' : 'text-slate-500 hover:bg-white/60 hover:text-slate-800 dark:hover:bg-slate-700/50 dark:hover:text-slate-200'}`}
          >
            {a.rotulo}
            {a.id === 'alertas' && nAlertas > 0 && <span className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">{nAlertas}</span>}
          </button>
        ))}
      </nav>
      </div>

      {fazendas.isLoading && <p>Carregando…</p>}
      {fazendas.data?.length === 0 && <p className="card">Seu usuário não tem acesso a nenhuma fazenda.</p>}
      {fazenda && eu.data && (
        <main key={aba} className="animate-entrar">
          {aba === 'preciso' && <Preciso fazenda={fazenda} usuario={eu.data} aoIrParaOrdem={() => irPara('ordem')} aoVerNoMapa={(id) => { setFoco(id); irPara('mapa'); }} />}
          {aba === 'ordem' && <Ordem fazenda={fazenda} usuario={eu.data} />}
          {aba === 'campo' && <Campo fazenda={fazenda} usuario={eu.data} />}
          {aba === 'pastejo' && <Pastejo fazenda={fazenda} />}
          {aba === 'relatorios' && <Relatorios fazenda={fazenda} />}
          {aba === 'analisar' && <Analisar fazenda={fazenda} />}
          {aba === 'mapa' && <Mapa fazenda={fazenda} foco={foco} aoFocar={setFoco} usuario={eu.data} />}
          {aba === 'telemetria' && <Telemetria fazenda={fazenda} usuario={eu.data} />}
          {aba === 'alertas' && <Alertas fazenda={fazenda} usuario={eu.data} />}
          {aba === 'lancar' && <Lancamento fazenda={fazenda} usuario={eu.data} />}
          {aba === 'clima' && <Clima fazenda={fazenda} usuario={eu.data} />}
          {aba === 'cadastros' && <Cadastros fazenda={fazenda} usuario={eu.data} />}
          {aba === 'usuarios' && <Usuarios usuario={eu.data} />}
        </main>
      )}
    </div>
  );
}

export default function App() {
  const [logado, setLogado] = useState(() => token.get() != null);
  useEffect(() => {
    const sair = () => setLogado(false);
    window.addEventListener('irrigacao:sair', sair);
    return () => window.removeEventListener('irrigacao:sair', sair);
  }, []);
  return logado ? <Painel aoSair={() => setLogado(false)} /> : <Login aoEntrar={() => setLogado(true)} />;
}
