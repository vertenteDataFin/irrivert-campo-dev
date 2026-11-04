/**
 * Cria ou atualiza um usuário. A senha vem pela entrada padrão (não fica em histórico/argumentos).
 * Uso: printf '%s' "$SENHA" | docker compose run --rm -T api npx tsx src/criar-usuario.ts email "Nome" gestor
 */
import { pool } from './db';
import { hashSenha } from './senha';

const [email, nome, papel = 'gestor'] = process.argv.slice(2);
if (!email || !nome || !['operador', 'gestor', 'admin'].includes(papel)) {
  console.error('Uso: criar-usuario.ts <email> <nome> [operador|gestor|admin]  (senha pela stdin)');
  process.exit(1);
}

let senha = '';
for await (const parte of process.stdin) senha += parte;
senha = senha.replace(/\r?\n$/, '');
if (senha.length < 6) {
  console.error('Senha muito curta (mínimo 6 caracteres)');
  process.exit(1);
}

const u = await pool.query(
  `INSERT INTO usuario (nome, email, senha_hash, papel) VALUES ($1, lower($2), $3, $4)
   ON CONFLICT (email) DO UPDATE SET nome = EXCLUDED.nome, senha_hash = EXCLUDED.senha_hash, papel = EXCLUDED.papel, ativo = true
   RETURNING id`,
  [nome, email, await hashSenha(senha), papel],
);
await pool.query(
  `INSERT INTO usuario_fazenda (usuario_id, fazenda_id) SELECT $1, id FROM fazenda ON CONFLICT DO NOTHING`,
  [u.rows[0].id],
);
console.log(`Usuário ${email} (${papel}) pronto, com acesso às fazendas.`);
await pool.end();
