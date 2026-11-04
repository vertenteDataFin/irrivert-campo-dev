# IRRIVERT

Gestão de irrigação por pivôs da Agropecuária Vertente. Monorepo TypeScript (npm workspaces).

| Pasta | O que é |
|---|---|
| `packages/core` | Lógica pura (FAO-56, balanço hídrico, ordem de irrigação), testada com vitest |
| `apps/api` | API Fastify 5 (zod, pg, JWT), porta 3000 |
| `apps/web` | Front React 18 + Vite + Tailwind, PWA instalável em iOS e Android, offline com fila |
| `docs/` | `fluxo-decisao-irrigacao.html` (fluxograma e protótipos do módulo de campo), COMANDOS, ICROP |
| `tools/db-local` | Postgres local sem Docker (PGlite + PostGIS) para desenvolvimento |
| `scripts/publicar.sh` | Publicação no servidor (só com autorização; faz backup antes) |

Leia `CLAUDE.md` antes de mexer: regras do projeto, servidor e pendências.

## Desenvolvimento local (Windows, sem Docker)

```powershell
npm ci                                   # dependências do monorepo
npm install --prefix tools/db-local      # dependências do banco local (uma vez)

# 1. banco local em 127.0.0.1:5433 (deixe rodando)
npm start --prefix tools/db-local

# 2. API em 3010 contra o banco local (outro terminal)
cd apps/api
$env:DATABASE_URL='postgres://postgres@127.0.0.1:5433/postgres'; $env:PORT='3010'
$env:JWT_SECRET='dev-local'; $env:ADMIN_EMAIL='admin@local.dev'; $env:ADMIN_PASSWORD='admin-local-dev'
npx tsx src/server.ts

# 3. web em 5173 com proxy para a API (outro terminal)
npm run dev:web
```

Testes e verificação de tipos:

```powershell
npm test                                 # packages/core
npm run typecheck --workspace apps/api
npm run typecheck --workspace apps/web
```

## Módulo de campo (em desenvolvimento)

Vistoria presencial dos pivôs com ordem do dia: roteiro editável, formulário de vistoria com leituras e configuração no painel, origem da falha em ativos compartilhados, registro de execução. Especificação visual em `docs/fluxo-decisao-irrigacao.html`.
