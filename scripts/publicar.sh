#!/usr/bin/env bash
# Publica o IRRIVERT no servidor do PRODAP (procedimento do CLAUDE.md). SÓ RODAR COM AUTORIZAÇÃO DO GESTOR.
#
#   scripts/publicar.sh --so-pacote      monta o pacote local e mostra o conteúdo (não conecta)
#   scripts/publicar.sh                  backup → envio → build → logs → importador do iCrop em --simular
#   scripts/publicar.sh --aplicar-icrop  backup → importador do iCrop com --aplicar (grava nos cadastros) → logs
#
# O pacote leva o código sem node_modules, .env e package-lock.json: o .env e o lock do servidor ficam como estão.
set -euo pipefail

MODO="${1:-publicar}"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
CARIMBO="$(date +%Y%m%d_%H%M)"
PACOTE="${TMPDIR:-/tmp}/irrivert_${CARIMBO}.tgz"
# no Git Bash do Windows o tar entende "C:" como servidor remoto: usa o caminho /c/...
if command -v cygpath >/dev/null 2>&1; then PACOTE="$(cygpath -u "$PACOTE")"; fi
SSH=(ssh -i ~/.ssh/id_irrigacao -p 54778 -o BatchMode=yes -o IdentitiesOnly=yes faz@prodap.imktec.com.br)
remoto() { "${SSH[@]}" "cd ~/irrigacao && $1"; }
passo() { printf '\n== %s ==\n' "$1"; }

montar_pacote() {
  passo "Pacote local"
  tar -czf "$PACOTE" --exclude=node_modules --exclude=.env --exclude=package-lock.json --exclude=.claude --exclude='*.tgz' -C "$RAIZ" .
  ls -la "$PACOTE"
  tar -tzf "$PACOTE" | grep -E '^\./(apps/api/src|packages/core/src|apps/web/src/telas)/[^/]+$' | sort | head -80
  if tar -tzf "$PACOTE" | grep -qE '(^|/)(\.env|package-lock\.json)$|node_modules/'; then echo "ERRO: o pacote contém .env, package-lock.json ou node_modules"; exit 1; fi
}

backup() {
  passo "Backup do banco (~/backups/irrigacao_${CARIMBO}.dump)"
  remoto "mkdir -p ~/backups && docker compose exec -T db pg_dump -U irrigacao -Fc irrigacao > ~/backups/irrigacao_${CARIMBO}.dump && ls -la ~/backups/irrigacao_${CARIMBO}.dump"
  remoto "test -s ~/backups/irrigacao_${CARIMBO}.dump" || { echo "ERRO: backup vazio, nada foi publicado"; exit 1; }
}

logs() {
  passo "Logs da API"
  sleep 20
  remoto "docker compose ps && docker compose logs --tail=60 api"
  # 127.0.0.1, não localhost: no alpine o localhost resolve para ::1, onde a API não escuta
  remoto "docker compose exec -T api wget -qO- http://127.0.0.1:3000/api/saude" && echo
}

case "$MODO" in
  --so-pacote)
    montar_pacote
    ;;
  publicar)
    montar_pacote
    backup
    passo "Envio e extração em ~/irrigacao (sem sobrescrever o .env)"
    "${SSH[@]}" "cd ~/irrigacao && tar -xzf -" < "$PACOTE"
    passo "Build e subida"
    remoto "docker compose up -d --build"
    logs
    passo "Parâmetros do iCrop: SIMULAÇÃO (nada é gravado)"
    remoto "docker compose run --rm -T api npx tsx src/importar-icrop.ts --simular"
    echo; echo "Confira o resumo acima. Para gravar: scripts/publicar.sh --aplicar-icrop"
    ;;
  --aplicar-icrop)
    backup
    passo "Parâmetros do iCrop: APLICAR"
    remoto "docker compose run --rm -T api npx tsx src/importar-icrop.ts --aplicar"
    logs
    ;;
  *)
    echo "uso: scripts/publicar.sh [--so-pacote | --aplicar-icrop]"; exit 2
    ;;
esac
