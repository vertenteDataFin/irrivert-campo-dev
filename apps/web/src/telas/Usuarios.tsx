import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ErroApi } from '../api';
import type { Usuario } from '../tipos';

type Papel = Usuario['papel'];
interface Linha { id: number; nome: string; email: string; papel: Papel; ativo: boolean; criadoEm: string; fazendaIds: number[] }
interface FazendaOpcao { id: number; nome: string }

const ROTULO_PAPEL: Record<Papel, string> = { operador: 'Operador (lança e consulta)', gestor: 'Gestor (edita cadastros)', admin: 'Administrador' };

function Seletor({ fazendas, valor, aoMudar }: { fazendas: FazendaOpcao[]; valor: number[]; aoMudar: (v: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-3">
      {fazendas.map((f) => (
        <label key={f.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={valor.includes(f.id)}
            onChange={(e) => aoMudar(e.target.checked ? [...valor, f.id] : valor.filter((x) => x !== f.id))}
          />
          {f.nome}
        </label>
      ))}
    </div>
  );
}

const soDigitos = (t: string) => t.replace(/\D/g, '');
/** Telefone brasileiro: com DDD (10–11 dígitos) ganha o 55 na frente. */
const telefoneWa = (t: string) => {
  const d = soDigitos(t);
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
};

function EnviarZap({ nome, email, senhaInicial = '' }: { nome: string; email: string; senhaInicial?: string }) {
  const [tel, setTel] = useState('');
  const [senha, setSenha] = useState(senhaInicial);
  const valido = telefoneWa(tel).length >= 12;

  function abrir() {
    const linhas = [
      `Olá, ${nome.split(' ')[0]}! Seu acesso ao IRRIVERT (Fazenda Vertente):`,
      '',
      `Link: ${window.location.origin}`,
      `Usuário: ${email}`,
      ...(senha ? [`Senha: ${senha}`] : ['Senha: a que combinamos (peça ao gestor se precisar redefinir)']),
    ];
    window.open(`https://wa.me/${telefoneWa(tel)}?text=${encodeURIComponent(linhas.join('\n'))}`, '_blank', 'noopener');
  }

  return (
    <div className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end dark:bg-slate-800/50">
      <div>
        <label className="rotulo">WhatsApp (com DDD)</label>
        <input className="campo" inputMode="tel" placeholder="(67) 99999-9999" value={tel} onChange={(e) => setTel(e.target.value)} />
      </div>
      <div>
        <label className="rotulo">Incluir senha na mensagem (opcional)</label>
        <input className="campo" autoComplete="off" value={senha} onChange={(e) => setSenha(e.target.value)} />
      </div>
      <button type="button" className="btn" disabled={!valido} onClick={abrir}>Enviar no WhatsApp</button>
    </div>
  );
}

function Novo({ fazendas, papeis, aoCriar }: { fazendas: FazendaOpcao[]; papeis: Papel[]; aoCriar: () => void }) {
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [papel, setPapel] = useState<Papel>('operador');
  const [ids, setIds] = useState<number[]>(fazendas.map((f) => f.id));
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [criado, setCriado] = useState<{ nome: string; email: string; senha: string } | null>(null);

  const criar = useMutation({
    mutationFn: () => api('/usuarios', { corpo: { nome, email, senha, papel, fazendaIds: ids } }),
    onSuccess: () => {
      setMsg({ ok: true, texto: `Usuário ${email} criado.` });
      setCriado({ nome, email, senha });
      setNome(''); setEmail(''); setSenha('');
      aoCriar();
    },
    onError: (x) => setMsg({ ok: false, texto: x instanceof ErroApi ? x.message : 'Falha ao criar usuário' }),
  });

  function enviar(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setCriado(null);
    criar.mutate();
  }

  return (
    <form onSubmit={enviar} className="card space-y-3">
      <h2 className="font-semibold">Novo usuário</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="rotulo" htmlFor="u-nome">Nome</label>
          <input id="u-nome" className="campo" value={nome} onChange={(e) => setNome(e.target.value)} required minLength={2} />
        </div>
        <div>
          <label className="rotulo" htmlFor="u-email">E-mail (login)</label>
          <input id="u-email" className="campo" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="rotulo" htmlFor="u-senha">Senha inicial (mín. 6 caracteres)</label>
          <input id="u-senha" className="campo" type="password" autoComplete="new-password" value={senha} onChange={(e) => setSenha(e.target.value)} required minLength={6} />
        </div>
        <div>
          <label className="rotulo" htmlFor="u-papel">Papel</label>
          <select id="u-papel" className="campo" value={papel} onChange={(e) => setPapel(e.target.value as Papel)}>
            {papeis.map((p) => <option key={p} value={p}>{ROTULO_PAPEL[p]}</option>)}
          </select>
        </div>
      </div>
      <div>
        <span className="rotulo">Fazendas com acesso</span>
        <Seletor fazendas={fazendas} valor={ids} aoMudar={setIds} />
      </div>
      {msg && <p role="alert" className={`text-sm ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{msg.texto}</p>}
      {criado && <EnviarZap key={criado.email} nome={criado.nome} email={criado.email} senhaInicial={criado.senha} />}
      <button className="btn" disabled={criar.isPending}>{criar.isPending ? 'Criando…' : 'Criar usuário'}</button>
    </form>
  );
}

function Edita({ u, eu, fazendas, papeis, aoFechar }: { u: Linha; eu: Usuario; fazendas: FazendaOpcao[]; papeis: Papel[]; aoFechar: () => void }) {
  const qc = useQueryClient();
  const [nome, setNome] = useState(u.nome);
  const [papel, setPapel] = useState<Papel>(u.papel);
  const [ids, setIds] = useState(u.fazendaIds);
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const souEu = u.id === eu.id;

  const salvar = useMutation({
    mutationFn: (corpo: Record<string, unknown>) => api(`/usuarios/${u.id}`, { method: 'PUT', corpo }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['usuarios'] }); aoFechar(); },
    onError: (x) => setErro(x instanceof ErroApi ? x.message : 'Falha ao salvar'),
  });

  function enviar(e: FormEvent) {
    e.preventDefault();
    setErro('');
    salvar.mutate({ nome, papel, fazendaIds: ids, ...(senha ? { senha } : {}) });
  }

  return (
    <form onSubmit={enviar} className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-700">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="rotulo">Nome</label>
          <input className="campo" value={nome} onChange={(e) => setNome(e.target.value)} required minLength={2} />
        </div>
        <div>
          <label className="rotulo">Papel</label>
          <select className="campo" value={papel} disabled={souEu} onChange={(e) => setPapel(e.target.value as Papel)}>
            {papeis.map((p) => <option key={p} value={p}>{ROTULO_PAPEL[p]}</option>)}
          </select>
        </div>
        <div>
          <label className="rotulo">Nova senha (deixe vazio para manter)</label>
          <input className="campo" type="password" autoComplete="new-password" value={senha} onChange={(e) => setSenha(e.target.value)} minLength={6} />
        </div>
      </div>
      <div>
        <span className="rotulo">Fazendas com acesso</span>
        <Seletor fazendas={fazendas} valor={ids} aoMudar={setIds} />
      </div>
      {erro && <p role="alert" className="text-sm text-red-600">{erro}</p>}
      <div className="flex gap-2">
        <button className="btn" disabled={salvar.isPending}>Salvar</button>
        <button type="button" className="btn-sec" onClick={aoFechar}>Cancelar</button>
        {!souEu && (
          <button type="button" className="btn-sec ml-auto" disabled={salvar.isPending} onClick={() => salvar.mutate({ ativo: !u.ativo })}>
            {u.ativo ? 'Desativar acesso' : 'Reativar acesso'}
          </button>
        )}
      </div>
    </form>
  );
}

export default function Usuarios({ usuario }: { usuario: Usuario }) {
  const qc = useQueryClient();
  const [editando, setEditando] = useState<number | null>(null);
  const [zap, setZap] = useState<number | null>(null);
  const lista = useQuery({ queryKey: ['usuarios'], queryFn: () => api<Linha[]>('/usuarios') });
  const fazendas = useQuery({ queryKey: ['usuarios-fazendas'], queryFn: () => api<FazendaOpcao[]>('/usuarios/fazendas') });

  if (usuario.papel === 'operador') return <p className="card">Apenas gestor ou administrador gerencia usuários.</p>;
  const papeis: Papel[] = usuario.papel === 'admin' ? ['operador', 'gestor', 'admin'] : ['operador', 'gestor'];
  const nomeFazenda = (id: number) => fazendas.data?.find((f) => f.id === id)?.nome ?? `#${id}`;

  return (
    <div className="space-y-4">
      {fazendas.data && <Novo fazendas={fazendas.data} papeis={papeis} aoCriar={() => qc.invalidateQueries({ queryKey: ['usuarios'] })} />}

      <div className="card space-y-3">
        <h2 className="font-semibold">Usuários cadastrados</h2>
        {lista.isLoading && <p>Carregando…</p>}
        {lista.error && <p className="text-sm text-red-600">Não foi possível carregar a lista.</p>}
        <ul className="divide-y divide-slate-200 dark:divide-slate-700">
          {lista.data?.map((u) => {
            const bloqueado = u.papel === 'admin' && usuario.papel !== 'admin';
            return (
              <li key={u.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <div className="mr-auto">
                    <p className={`font-medium ${u.ativo ? '' : 'text-slate-400 line-through'}`}>{u.nome}</p>
                    <p className="text-sm text-slate-500">{u.email}</p>
                  </div>
                  <span className="text-sm">{u.papel}</span>
                  <span className="text-sm text-slate-500">{u.papel === 'admin' ? 'todas as fazendas' : u.fazendaIds.map(nomeFazenda).join(', ') || 'sem fazenda'}</span>
                  {!u.ativo && <span className="text-sm text-red-600">desativado</span>}
                  {u.ativo && (
                    <button className="btn-sec" onClick={() => setZap(zap === u.id ? null : u.id)}>WhatsApp</button>
                  )}
                  {!bloqueado && (
                    <button className="btn-sec" onClick={() => setEditando(editando === u.id ? null : u.id)}>
                      {editando === u.id ? 'Fechar' : 'Editar'}
                    </button>
                  )}
                </div>
                {zap === u.id && <EnviarZap nome={u.nome} email={u.email} />}
                {editando === u.id && fazendas.data && (
                  <Edita u={u} eu={usuario} fazendas={fazendas.data} papeis={papeis} aoFechar={() => setEditando(null)} />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
