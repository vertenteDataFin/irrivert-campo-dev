# IRRIVERT (antes "Projeto de Irrigação", nome provisório "AquaVert") — memória do projeto

Resumo das conversas anteriores do Claude Code para retomar sem perder contexto. Escrito em 2026-10-23 a partir das transcrições; o que não consta nas conversas está marcado como "não confirmado".

## Objetivo e contexto
- Nome do software: IRRIVERT (definido e publicado às 15:11 de 23/10/2026, backup irrigacao_20261023_1509.dump; aparece no título, no manifesto do PWA, no cabeçalho, no login e na mensagem de acesso por WhatsApp; os nomes de pacote `@irrigacao/*` e o banco offline `irrigacao-offline` não mudaram de propósito).
- Logo da Agropecuária Vertente (23/10): o arquivo original não ficou salvo no computador (veio só na conversa), então foi RECONSTRUÍDO em SVG em `apps/web/src/Logo.tsx` (o V em 14 faixas + textos, cor única #1d3330, currentColor no modo escuro). Usado no cabeçalho (só o V), no login (completo), no cabeçalho impresso do Relatório (completo, com IRRIVERT e data de emissão) e no ícone do PWA (`public/icone.svg`, V branco sobre verde). Cabeçalho e navegação do app não saem na impressão. Se a empresa fornecer o arquivo oficial, trocar o componente por <img>. Publicado às 15:16 de 23/10 (backup irrigacao_20261023_1514.dump).
- Sistema de gestão de irrigação por pivôs da Agropecuária Vertente (Fazenda Vertente, Água Clara/MS; a Fazenda Pedra ainda não foi cadastrada). O usuário é gestor/controller e fala português.
- Aplica o balanço hídrico FAO-56 (ETo Penman-Monteith, com Hargreaves como alternativa; ETc = ETo x Kc por fase).
- Inclui telemetria ao vivo dos pivôs (Irricontrol e AgSense 365), clima (WeatherLink), mapa georreferenciado, alertas e um app de campo para o manejo de animais nos piquetes.
- O usuário costuma trabalhar pelo celular e remotamente.

## Stack e estrutura (monorepo npm workspaces, TypeScript)
- `packages/core/src`: lógica pura e testada com vitest.
  - `fao56.ts`, `balanco.ts`, `datas.ts`.
  - `operacao.ts`: ordem de irrigação, sentido e ângulo de parada, janelas de energia.
  - Testes: `core.test.ts` e `operacao.test.ts` (34 testes passando). Na API, `icrop-parametros.test.ts` (32) roda com `npx vitest run` dentro de `apps/api`.
- `apps/api/src`: Fastify 5, zod, pg, JWT, scrypt.
  - `server.ts`, `rotas-operacao.ts`, `operacao.ts`, `servico.ts`, `schema.sql`, `db.ts`, `seed.ts`.
  - Conectores: `weatherlink.ts`, `irricontrol.ts`, `agsense.ts`.
  - Outros: `alertas.ts`, `comandos.ts`, `relatorio.ts`, `padroes.ts`.
  - Scripts: `importar-pasto.ts`, `criar-usuario.ts`, `verificar-*.ts`.
  - Dados do mapa: `apps/api/dados/vertente-mapa.json`.
- `apps/web/src`: React 18, Vite, Tailwind 3, TanStack Query, react-leaflet; PWA com `public/sw.js` e `manifest.webmanifest`.
  - `App.tsx`, `api.ts`, `hooks.ts`, `tipos.ts`, `ui.tsx`, `graficos.tsx`, `cores.ts`, `offline.ts`, `pivos.ts`, `index.css`.
  - Telas em `telas/`: Preciso, Analisar, Mapa, Lancamento, Clima, Cadastros, Telemetria, Alertas, Usuarios, Relatorios, Pastejo (aba Animais), Ordem, entre outras.
- Infra: `docker-compose.yml` (db PostGIS 16, api, web/nginx na porta 8080), `.env.example`. O `.env` exige DB_PASSWORD, JWT_SECRET, ADMIN_PASSWORD, ADMIN_EMAIL e WEB_PORT.
- `docs/COMANDOS.md`: roteiro para ligar os comandos Iniciar/Parar (captura de HAR).
- `.claude/launch.json`: abre o Vite (`npm run dev --workspace apps/web`, porta 5173) no navegador do Claude; sem banco local, as telas são conferidas com uma API simulada em Node na porta 3000.
- Banco local sem Docker (usado em 23/10): PGlite 0.5.11 + `@electric-sql/pglite-postgis` 0.2.11 + `pglite-socket` 0.2.14, instalados numa pasta de rascunho, servindo o protocolo do Postgres na porta 5433. A API real roda contra ele com `DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres PORT=3010`. Para ver as telas, sobe outro Vite na porta 5174 com o proxy para a 3010, porque a 5173 pode estar em uso por outra conversa.
- Não há repositório git na pasta.

## Servidor e deploy
- Servidor Ubuntu cedido pelo PRODAP (hostname `fazendairrigacao`), acesso só por SSH.
  - `ssh -i ~/.ssh/id_irrigacao -p 54778 -o BatchMode=yes -o IdentitiesOnly=yes faz@prodap.imktec.com.br`
  - A senha do SSH não é registrada aqui.
- O projeto fica em `~/irrigacao` no servidor e roda com `docker compose`. Os backups ficam em `~/backups/*.dump`.
- A porta 8080 não é exposta. O acesso externo é por túnel Cloudflare temporário (trycloudflare.com). O último endereço conhecido era `https://arthritis-welcome-concerts-comparison.trycloudflare.com/`, que muda se o túnel reiniciar. Domínio fixo ainda não foi feito.
- Procedimento de deploy usado, sempre com autorização explícita do usuário:
  1. Fazer `pg_dump` do banco no servidor.
  2. Empacotar o código sem `node_modules`, `.env` e `package-lock.json` e enviar por SSH, sem sobrescrever o `.env` do servidor.
  3. Extrair em `~/irrigacao` e rodar `docker compose up -d --build`.
  4. Conferir os logs da API.
- `scripts/publicar.sh` (23/10) automatiza esses passos no Git Bash. Use `--so-pacote` para só montar e listar o pacote, sem conectar. Sem argumento, o script publica e roda o importador do iCrop em `--simular`. Com `--aplicar-icrop`, faz backup e grava. Só rodar com autorização.
- O disco local já ficou com 0 bytes livres e chegou a esvaziar arquivos. Typecheck e testes também podem rodar em container `node:24-alpine` no servidor.
- Criar usuário: `printf '%s' "$SENHA" | docker compose run --rm -T api npx tsx src/criar-usuario.ts email "Nome" gestor`.

## Dados, relatórios e metodologia definidos
- Mapa real importado do programa local "Pasto 6.0", em `C:\Users\Jacson.Souza\Desktop\CONTROLA_PASTO`. A leitura é só leitura, via SQLite com `mode=ro`.
  - Resultado: 9 limites, 13 pivôs, 143 parcelas, 141 pastos e 59 cultivares.
  - A cultivar é cadastro por piquete e por parcela e define o cálculo de quanto irrigar.
  - Os padrões por gênero ficam em `padroes.ts`; os valores ainda estão marcados "a confirmar".
- Balanço hídrico:
  - Capacidade = raiz (cm) x AD do solo (mm/cm); limite de segurança = capacidade x (1 - p).
  - Desde 23/10 recomenda pela regra do iCrop: repor quando a falta até a capacidade passa da ETc do dia, ou sempre que a lâmina fica abaixo do limite. Ver "Regra de recomendação" nas pendências.
  - Tempo do pivô = ITN / eficiência / (lâmina por volta / horas por volta).
  - Fuso de exibição: Campo Grande.
- Clima: WeatherLink v2, conta Basic, só leitura atual, sem histórico. Amostras a cada 10 minutos. O resumo diário só vale com 100 ou mais amostras (primeiro dia fechado esperado em ~23/10). A aba Clima tem o painel "Ao vivo". A estação da Fazenda Pedra será usada depois de cadastrada a fazenda.
- Telemetria: Irricontrol (13 pivôs: 14-19 e 30-36) e AgSense 365 (P01-P13), 25 pivôs ligados ao mapa pela posição do centro.
  - Os conectores são só de leitura e não usam API pública, então são frágeis.
  - Hidráulica real (vazão, lâmina por volta, raio) substitui os padrões; a irrigação aplicada entra automática no balanço por parcela.
  - Estados do mapa no modo Operação: irrigando, movendo, aguardando/programado, parado, desligado, alarme e sem comunicação.
  - Alarme só para "Safety" e falhas desconhecidas; "SIS" e "Command" não são alarme.
  - A lâmina por fatia ainda não foi conferida com um pivô real.
- Alertas (checados a cada 2 minutos, sem repetir): alarme, ligado sem comunicação, precisa irrigar e está parado, irrigando fora do horário permitido, irrigando sobre piquete com animais. Envio por WhatsApp hoje é manual (botão que abre a conversa).
- Relatórios (aba redesenhada em 23/10):
  - Conteúdo: lâmina aplicada por pivô e por dia, chuva, ETo/consumo, balanço do período, ordem do dia com linha do tempo de 24 h e janela de energia, situação hídrica, pastejo, alertas e comandos.
  - Período em chips de 7, 15 e 30 dias, máximo 92 dias; exporta CSV e imprime em PDF.
- Operação de campo:
  - Entrada e saída de animais com foto, nota de 1 a 5 e observação, cabeças e lote. Funciona offline (PWA, fila sem duplicar).
  - A ordem de irrigação lista pivôs abaixo do limite por urgência, encaixados nas janelas de energia cadastradas.
  - O sentido e o ângulo de parada são calculados no servidor para evitar o piquete com animais (em lavoura não há ângulo).
  - Cada tentativa de comando é auditada e bloqueada por alarme, horário ou piquete ocupado.
  - Tabelas novas: `movimento_animal`, `janela_irrigacao`, `ordem_irrigacao`, `comando_pivo`.

## Preferências explícitas do usuário
- Visual mais tecnológico, dinâmico e surpreendente; não "engessado" nem "quadrado". Seguir pelas telas depois de Relatórios na ordem: Ordem de irrigação, Animais, Preciso irrigar.
- Escala de cores verde, amarelo e vermelho (irrigar) integrada ao resto do app.
- Na tela de mapa, ver o pivô inteiro, sem as repartições das parcelas.
- Tudo integrado em um só app (desktop e celular), incluindo comandos das plataformas de telemetria.
- Sempre fazer backup do banco antes de publicar e conferir os logs depois.
- Cadastro de usuários dentro do sistema, com botão para enviar link e usuário por WhatsApp.
- O usuário quer abrir o app pelo celular quando está remoto.
- Prefere que Claude trabalhe em segundo plano e que o login seja feito por ele nas plataformas (Claude não digita senhas).

## Entregue e estado atual (23/10/2026)
- Em produção, publicada às 12:04 do dia 23/10 (segundo backup do dia) Cadastros redesenhada às 13:10, Mapa às 13:36, Animais às 14:47, Ordem às 15:08, nome IRRIVERT às 15:11, logo às 15:16 Preciso irrigar às 15:24 e Clima às 17:41 (décimo backup do dia): FAO-56, Preciso irrigar, Analisar, Mapa, Lançamento, Clima (WeatherLink), Cadastros, Usuários, Telemetria (Irricontrol e AgSense), Alertas, Relatórios redesenhados, Animais, Ordem de irrigação.
- Verificado: rotas respondendo 200, logs sem erro, túnel público ativo.
- O Relatório novo foi testado em navegador só com dados simulados (desktop, celular e escuro). Com dados reais não foi testado.
- Há um usuário admin no servidor e dois usuários gestores criados a pedido do usuário (jederson.bezerra@ e josemar.santos@ fazendavertente.com.br). As senhas não são registradas aqui.

## Cópia do iCrop Vision (23/10/2026)
- O iCrop Vision (vision.icrop.online, conta do Gabriel) é o sistema de manejo que o IRRIVERT substitui; o contrato da Agropecuária Vertente - Agua Clara (id 2367) termina em 24/10/2026. Tudo o que era acessível foi copiado para `apps/api/dados/icrop/` (detalhes em `docs/ICROP-MIGRACAO.md`): 26 equipamentos com hidráulica real (raio, vazão, velocidade, uniformidade, área molhada), 96 parcelas ativas (cultura, solo, plantio, setor, polígono), balanço diário de 01/06 a 22/10/2026 com 38 variáveis por parcela (11.332 parcela-dia, em `historico/`), tabela "Preciso irrigar", catálogo de 2.017 cultivares e a especificação da API oficial (`api-openapi-v2.1.1.json`).
- `parametros-derivados-2026-10-23.json` resume o que o iCrop usa: Mombaça 3 com Kc 0,60→1,005 em 10 dias e depois 1,05 (raiz até 51,7 cm); amendoim IAC 677/503 com fase 1 de 10 dias (Kc 0,55) e fase 2 subindo 0,0167/dia; três solos (CC 23,9–25,7 %, PMP 15,0–15,7 %, densidade 1,29–1,32); eficiência de irrigação 0,86–0,91 por pivô.
- Banco: tabelas `icrop_equipamento`, `icrop_parcela` e `icrop_balanco_dia` (schema v0.3) e o script `apps/api/src/importar-icrop.ts` (upsert).
- Aplicação nos cadastros (escrita em 23/10, NÃO publicada): `importar-icrop.ts --simular` (mostra e desfaz) ou `--aplicar` (grava). Regras em `apps/api/src/icrop-parametros.ts` (teste `icrop-parametros.test.ts`, 32 casos contra o histórico do iCrop).
  - Ligação pela área, porque a numeração do iCrop não é a do mapa: Pivô 30 do iCrop = PIVÔ 04 do Pasto 6.0, e 34/35/36 = 05/06/07. O marcador das parcelas do iCrop fica no centro do pivô, então não serve para ligar ao piquete.
  - Cria as cultivares Mombaça 3, Amendoim IAC 677/503 e Preparo com Kc e profundidade de manejo por fase em linha reta (schema v0.4: `cultura_fase.kc_fim`, `raiz_mm`, `raiz_fim_mm`). No amendoim, médio e final vêm da FAO-56 (a confirmar).
  - Grava a hidráulica e a eficiência nos pivôs, e cultura, plantio, água do solo, capacidade, limite e a lâmina de 22/10 nos piquetes (`data_inicial` 23/10). Antes e depois ficam em `icrop_aplicacao`.
  - O balanço (`servico.ts`) segue a curva de raiz quando a cultura tem uma.
  - Testado num PostGIS local (PGlite, porque o Docker Desktop não iniciou) com o mapa real: 136 de 146 piquetes e 16 pivôs; reaplicar não muda nada.
- Não acessível para o Gabriel: cadastro de fases/Kc das culturas e cadastro de solo ("Permissão negada"); o histórico anterior a 01/06 e os lançamentos brutos só pela API oficial, que exige token gerado em Configurações > Integração APIs (o usuário decide se gera). O login no iCrop é feito pelo usuário no navegador integrado do Claude.

## Pendências
- Comandos Iniciar e Parar para Irricontrol e AgSense não enviam nada ao pivô: respondem "comando não configurado". Faltam HARs do painel web de cada plataforma (um por plataforma, num pivô de teste, sem animais e em horário seguro), sem senha e token. Roteiro em `docs/COMANDOS.md`. Pedir também API oficial à Bauer (Irricontrol) e à Valley.
- Testar o registro de entrada e saída com foto, inclusive offline, numa operação real (na produção não foi exercitado).
- Testar o SQL novo num Postgres local: feito em 23/10 para o importador do iCrop com PGlite + PostGIS (o Docker Desktop abre mas responde "Docker Desktop is unable to start"). As tabelas da v0.3 (pastejo, ordem, comandos) também sobem nesse banco, mas suas rotas não foram exercitadas.
- Quem pode comandar: hoje só gestor e admin. Liberar ao operador trocando `gestor` por `auth` nas duas rotas de comando em `rotas-operacao.ts`.
- Piquete com animais e sem geometria no mapa não calcula o sentido (só avisa).
- Preciso irrigar redesenhada em 23/10 (última das telas): barra de comando com clima do dia e chip "E se chover?", destaques (abaixo do limite com ha e horas de pivô, quem chega ao limite em até 3 dias, chuva prevista), KPIs clicáveis que filtram (Irrigar/Atenção/Ok) + chuva prevista e ETo com sparkline, faixa de previsão de 7 dias, cards por pivô ordenados por urgência (medidor com marca do limite, recomendação ou "chega ao limite em N dias", projeção em barras, telemetria, Ver no mapa) e a tabela antiga como visão alternativa. Só visual: API inalterada. Testada com API simulada; publicada às 15:24 de 23/10 (backup irrigacao_20261023_1522.dump). Rota real em 23/10: 155 parcelas, todas "ok" (lâmina inicial assumida em 80% da capacidade), 7 dias de previsão, clima do dia presente. Com isso todas as telas principais têm o visual novo.
- Clima redesenhada em 23/10: barra de comando com ponto vivo (verde se a leitura tem menos de 30 min), destaques (estação online/sem leitura, leituras de hoje de 100 para fechar o dia, último dia fechado, dias estimados), KPIs ao vivo com barra (temperatura, umidade, vento km/h, radiação, chuva hoje), barra "fechamento de hoje" (amostras/100), KPIs do histórico (dias fechados, ETo média, chuva, estimados), gráfico ETo (linha) + chuva (barras) com tooltip, faixa de temperaturas mín–máx por dia e tabela. Lançar leitura e Estação WeatherLink viram painéis que abrem por chips (a integração aparece aberta quando ainda não está configurada). Só visual: API inalterada. Testada com API simulada; publicada às 17:41 de 23/10 (backup irrigacao_20261023_1739.dump). Rotas reais em 23/10: estação WeatherLink com leitura às 17:33 (34,5 °C) e 86 amostras no dia; 19 dias fechados nos últimos 20 (o dia 21/10 não aparece na lista, conferir junto com o 17/10 zerado). Cadastros já foi redesenhada em 23/10 (central de cadastros com KPIs, cards de pivô, faixa de Kc por fase e barra limite/capacidade), publicada às 13:10 de 23/10 (backup irrigacao_20261023_1308.dump), testada antes só com API simulada; falta conferir com dados reais.
- Mapa redesenhado em 23/10 (barra de comando, chips, resumo flutuante no canto do mapa, bússola do pivô no painel lateral; nomes dos pivôs só a partir do zoom 14 para não empilhar; o balão de hover duplicado no CircleMarker foi removido). Testado só com API simulada (geometrias do vertente-mapa.json); publicado às 13:36 de 23/10 (backup irrigacao_20261023_1334.dump); falta conferir com a telemetria real.
- Animais redesenhada em 23/10: o pivô é a unidade (um lote por pivô). Cada card tem a miniatura do pivô com as fatias reais dos piquetes (roxo = com animais, laranja→verde = dias de descanso até 30, cinza = sem registro), chips dos piquetes, sugestão do mais descansado e ações Entrar / Mover (saída + entrada num formulário só, dois registros na fila offline) / Retirar. A API `/pastejo` passou a devolver `geom` simplificado por piquete (ST_SimplifyPreserveTopology 0,00003). Testado com API simulada; publicada às 14:47 de 23/10 (backup irrigacao_20261023_1445.dump). A rota real respondeu 155 piquetes, todos com geometria, 0 ocupados; falta usar numa operação real.
- Ordem de irrigação redesenhada em 23/10: barra de comando com o estado do horário, destaques, KPIs (na ordem, horas, enviados/concluídos, fora da ordem), linha do tempo de 24 h (mesma do Relatório), cards com bússola do plano (posição atual, arco no sentido do giro, marcador roxo no ângulo de parada por animais), prévia do comando e chips de status; painel de janelas com barra de 24 h por janela e botão "Voltar à ordem" para itens cancelados. Só visual: API inalterada. Testado com API simulada; publicada às 15:08 de 23/10 (backup irrigacao_20261023_1505.dump). Rota real da ordem: 0 itens e 0 janelas cadastradas em 23/10.
- Conferir no Relatório se o 17/10 zerado é falta de leitura.
- Envio automático de WhatsApp: o usuário ainda deve escolher o serviço (Z-API, Evolution ou n8n); depois configurar `WHATSAPP_WEBHOOK_URL` no servidor.
- Conferir a lâmina automática por fatia contra o painel da Irricontrol (pivôs 31, 32, 33 e 36 estavam irrigando).
- Decidir entre esperar acumular clima ou contratar o WeatherLink Pro para ter histórico.
- Cadastrar a Fazenda Pedra (e separar os pivôs por fazenda, se estiverem na mesma conta da telemetria). Não há CRUD de fazendas.
- Código publicado às 17:13 de 23/10 (backup `irrigacao_20261023_1713.dump`), com autorização: regra nova de recomendação, curvas por fase, schema v0.4, percentímetro nas telas e importador do iCrop. API, web e logs foram conferidos.
  - O `--simular` na produção liga 25 dos 26 equipamentos de Água Clara e 143 dos 155 piquetes: Mombaça 17, Amendoim IAC 677 47, Amendoim IAC 503 27 e Preparo 52.
  - Ficam de fora o PIVÔ 30 (sem cultura no iCrop), o PIVÔ 07 e o PIVÔ 08, que não têm parcela no iCrop, e a área de serviço do PIVÔ 01. Os nomes aqui já são os de depois da renomeação abaixo.
  - Os pivôs criados pela telemetria já tinham hidráulica igual à do iCrop, o que confirma a ligação por área. O PIVÔ 10 cai de 24 h para 11,6 h por volta.
  - Pivôs renomeados pela numeração do campo e PIVÔ 33 separado, às 18:00 de 23/10, com autorização (backup `irrigacao_20261023_1758_antes_renomear.dump`; SQL em transação, conferido antes com ROLLBACK).
    - O mapa do Pasto 6.0 numerava o setor VII como 01 a 07, e os pivôs 04 a 07 de verdade tinham entrado como "PIVÔ 0X (Retiro_...)".
    - Por número interno: 12 → PIVÔ 30, 30 → PIVÔ 31, 29 → PIVÔ 32, 13 → PIVÔ 34, 14 → PIVÔ 35, 15 → PIVÔ 36, 27 → PIVÔ 04, 26 → PIVÔ 05, 28 → PIVÔ 06, 31 → PIVÔ 07.
    - O PIVÔ 33 (número interno 37) foi criado com a parcela 44, que era o piquete "PIVÔ 01" dentro do PIVÔ 01 e virou "P01": 43,4 ha de Amendoim IAC 677, iCrop 33 A + B. Recebeu a hidráulica do iCrop (equipamento 15812): 3,68 mm por volta em 8,39 h e eficiência 0,881.
    - A telemetria Irricontrol "Pivô 33 - VII" (externo 3263) foi religada a ele. Antes ela estava presa ao PIVÔ 01 junto com a AgSense "Pivô 01". O PIVÔ 01 ficou com 80,3 ha e 10 parcelas.
    - A telemetria liga pelo `telemetria_pivo.pivo_id`, não pelo nome; a posição só é usada quando o vínculo está vazio. Depois da sincronização das 21:01 UTC, os 26 pivôs continuam com uma telemetria cada, sem nome repetido.
    - Não existe tela para renomear pivô: hoje é por SQL.
  - Em 23/10 choveu 24,6 mm, então nenhum pivô precisa de reposição hoje com os valores antigos.
  - APLICADO às 17:18 de 23/10, com autorização (backup `irrigacao_20261023_1717.dump`, lote `2026-10-23T20:18:01.633Z` em `icrop_aplicacao`): 4 cultivares, 25 pivôs e 143 piquetes, igual à simulação. Logs sem erro.
  - Balanço calculado no servidor logo depois: os 25 pivôs estão verdes e nenhum precisa de reposição, por causa da chuva de 24,6 mm em 23/10. Amendoim e preparo chegam ao limite em 5 a 7 dias sem irrigar; a Mombaça fica acima do limite por mais de 7 dias.
  - Para desfazer: restaurar o backup irrigacao_20261023_1717.dump ou usar os valores "antes" de `icrop_aplicacao`.
  - Telas conferidas na produção às 16:21 de 23/10, com o login feito pelo usuário. Preciso irrigar mostra 25 de 25 pivôs ok e "Nenhuma reposição necessária hoje". A Ordem abre vazia porque não foi gerada; o console e as rotas responderam sem erro. O túnel continua em `https://arthritis-welcome-concerts-comparison.trycloudflare.com/` (container `irrigacao-tunel`).
  - Textos da Ordem atualizados para a regra nova ("pivôs com reposição do dia" e "nenhuma reposição pendente"), publicados às 17:22 de 23/10 (backup `irrigacao_20261023_1722.dump`). Conferidos no navegador da produção; logs e console sem erro. O backup passou para 1,6 MB porque agora inclui as tabelas do iCrop. A simulação do script não gravou nada: continua um único lote em `icrop_aplicacao`.
- Menu congelado, a pedido do gestor. Publicado às 17:40 de 23/10 (backup `irrigacao_20261023_1740.dump`) e conferido na produção: desktop com 117 px de menu, celular com 102 px, troca de aba volta ao topo; logs e console sem erro. O service worker busca a rede primeiro, então o celular pega a versão nova ao abrir com internet. Cabeçalho e abas formam um bloco fixo no topo (`.menu-fixo` em `index.css`, montado em `App.tsx`).
  - A altura do bloco vai para `--menu-h`, e o `html` usa `scroll-padding-top`, para as âncoras e o `scrollIntoView` (seções da tela Cadastros) pararem abaixo dele.
  - Trocar de aba volta ao topo da página. No celular, o cabeçalho fica em uma linha só: o nome do usuário some e o da fazenda é encurtado.
  - Camadas: o menu fica em 1100, acima do mapa (o Leaflet vai até 1000) e abaixo da foto ampliada (2000).
  - Testado no banco local: desktop com 121 px de menu, celular de 375 px com 106 px e sem rolagem lateral, Mapa, Cadastros e troca de aba.
- O teste de saúde do script usava "localhost", que no alpine resolve para IPv6, onde a API não escuta. Foi corrigido para 127.0.0.1 em 23/10.
- Ordem montada a partir do Preciso irrigar, a pedido do gestor. Publicada às 18:33 de 23/10 (backup `irrigacao_20261023_1833.dump`) e conferida na produção: os 26 cartões têm o botão "+ Ordem", o campo de lâmina calcula com a hidráulica real (PIVÔ 01: 100 %, volta de 9h10) e a tela Ordem mostra "Montar pelas sugestões". Logs e console sem erro; o teste não enviou nenhuma ordem.
  - Nos cartões e na visão Tabela, cada pivô tem "+ Ordem" / "✓ Na ordem" e o selo "Sugerido" quando o balanço pede reposição. Ao marcar, aparece o campo "Lâmina a aplicar", com o percentímetro e a duração da volta calculados na hora.
  - A seleção começa pela ordem de hoje, se já existir; senão, pelas sugestões. Pivôs já enviados ou concluídos ficam travados.
  - Uma barra fixa no rodapé mostra quantos pivôs, as horas de pivô, "Marcar sugeridos" e "Enviar para a ordem". Só aparece para gestor e admin.
  - API: `POST /api/fazendas/:id/ordem/montar` com `{ itens: [{ pivoId, laminaMm }] }`. A lista substitui a ordem planejada do dia; o que foi enviado ou concluído fica.
  - `gerarOrdem(fazendaId, escolhas?)` em `operacao.ts` aceita pivôs que o balanço não pede, com aviso. Sem lâmina, usa a recomendada ou uma volta a 100 %.
  - O núcleo ganhou `aplicacaoNaVolta()`, que dá percentímetro e duração; o web tem a mesma conta em `pivos.ts`.
  - Na tela Ordem, o botão virou "Montar pelas sugestões" e pede confirmação antes de substituir uma ordem planejada.
  - Testado no banco local com janela 21h–16h: os pivôs começam às 21h, volta maior que a janela continua na seguinte, celular sem rolagem lateral.
- Horário de irrigação informado pelo gestor em 23/10: das 21h às 16h, ou seja, bloqueado das 16h às 21h (ponta). Cadastrado na produção às 17:35 de Campo Grande (18:35 de Brasília) de 23/10, com autorização, pela própria API do app: uma janela 21:00–16:00 em todos os dias, ou seja, 19 h por dia liberadas. A tela Ordem passou a mostrar "Fora do horário" entre 16h e 21h.
- `fazenda.max_pivos_simultaneos` na produção é 1, o padrão: a Ordem põe um pivô depois do outro. Perguntar quantos pivôs podem irrigar ao mesmo tempo.
- Próximo passo pedido pelo gestor: enviar a ordem automaticamente para a Irricontrol e a AgSense (iniciar com sentido, percentímetro e ângulo de parada). Depende dos HARs do painel de cada plataforma (`docs/COMANDOS.md`), porque hoje os comandos respondem "comando não configurado".
- Regra de recomendação adotada em 23/10, a pedido do gestor: a do iCrop.
  - Irrigar quando o déficit até a capacidade passa da ETc do dia, repondo esse déficit (`recomendar()` em `packages/core/src/balanco.ts`). Abaixo do limite, sempre. Explica 91 % dos dias do histórico do iCrop; o resto são dias de déficit pequeno, sem padrão encontrado.
  - Cores mudadas em 26/10, a pedido do gestor: "Irrigar 0" com 11 pivôs em reposição confundia. Agora a situação segue a pergunta do iCrop, "há reposição hoje?".
    - Irrigar (vermelho) = reposição hoje. Atenção (amarelo) = só amanhã, se não chover. Ok (verde) = nem amanhã.
    - O limite de segurança virou aviso de estresse à parte: campo `abaixoLimite` na parcela e no relatório, destaque "abaixo do limite de segurança (estresse)" e linha vermelha no cartão.
    - Núcleo: `situacaoIrrigacao(recHoje, recAmanha)` em `balanco.ts`. `statusHidrico()` ficou só para o estresse.
    - Web: `statusDoDia(repor, k)` e `statusParcelaNoDia()` em `cores.ts`. O agrupamento por pivô ganhou `repor[]`, `diasAteRepor`, `abaixoLimite` e `parcelasAbaixo`.
    - O medidor, as barras de projeção, a tabela, o Mapa e o Relatório seguem a mesma regra. O modo "Gradiente" do Mapa continua mostrando a folga até o limite.
    - O cartão sem reposição diz "precisa de reposição amanhã / em N dias (data)".
    - O alerta "precisa irrigar e está parado" continua só para quem está abaixo do limite, para não alertar todo pivô em reposição de rotina.
    - No iCrop, a cor do mapa era verde para todas as parcelas em 23/10, mesmo as 50 com lâmina a irrigar; a tabela "Preciso irrigar?" dele mostra mm por dia.
    - Testado no banco local: 6 parcelas com reposição = 6 "Irrigar", sem divergência. NÃO publicado.
  - A Ordem de irrigação usa a mesma regra na média do pivô. A urgência é a fração da água facilmente disponível já consumida.
  - As telas agora mostram o percentímetro (velocidade para aplicar a lâmina numa volta, como no iCrop) no lugar do antigo "% da volta".
- A previsão do tempo ainda é de exemplo. Os piquetes sem parcela do iCrop continuam com a lâmina inicial assumida em 80 % da capacidade: o PIVÔ 30 inteiro e os pivôs que o iCrop não cobre.
- Domínio e URL fixos (túnel Cloudflare nomeado ou HTTPS/porta externa via PRODAP).
- Trocar as senhas expostas nas conversas (SSH, WeatherLink, usuários do sistema, AgSense).
- Liberar espaço no disco do computador.

## Módulo de campo (03/11/2026, em desenvolvimento local, NÃO publicado)
- Objetivo: vistoria presencial dos pivôs da ordem do dia. Regra da fazenda: todo pivô com ordem recebe vistoria no local; o comando remoto só encurta a vistoria (roteiro rápido). Especificação visual e fluxograma em `docs/fluxo-decisao-irrigacao.html`.
- Aba "Campo" (`apps/web/src/telas/Campo.tsx`): Plano do dia (pivôs da ordem por cultura, telemetria, vistoria, fora da ordem por manejo, inoperantes com necessidade, ativos compartilhados), Roteiro (ordem de visita editável com hora prevista, salvo em `roteiro_dia`), formulário de vistoria (suspeita → passo de entrada da cadeia, integridade, leituras, configuração no painel com foto obrigatória, falha com origem e propagação ao ativo) e Registros do dia.
- Offline: `offline.ts` passou à versão 2 do IndexedDB com a loja `vistorias`; `sincronizarVistorias()` envia a fila para `POST /api/vistorias` (idempotente por `client_uuid`). O plano fica em cache no `localStorage` (`irrigacao.campo.<fazenda>`).
- API (`apps/api/src/campo.ts`, `rotas-campo.ts`): `GET /fazendas/:id/campo`, `PUT /fazendas/:id/campo/roteiro`, `POST /vistorias`, `GET /fazendas/:id/campo/vistorias`, `GET /vistorias/fotos/:id`, ativos (`GET/POST /fazendas/:id/ativos`, `PUT/DELETE /ativos/:id`), falhas (`POST /ativos/:id/falhas`, `PUT /falhas-ativo/:id/encerrar`), `PUT /pivos/:id/situacao` (inoperante, modelo do painel), `PUT /ordem/:id/manejo` (tira da ordem com motivo).
- Schema v0.5: tabelas `ativo_compartilhado`, `ativo_pivo`, `falha_ativo`, `roteiro_dia`, `vistoria`, `vistoria_foto`; colunas `pivo.painel_modelo/inoperante_desde/inoperante_motivo/reparo_previsto` e `ordem_irrigacao.motivo`. Vistoria com resultado `operando` ou `partida_local` avança a ordem de `planejada` para `enviada`.
- Ângulos em graus (0 a 360, a partir do norte, sentido horário), desde 03/11: `integridade.posicaoGraus`, `integridade.gadoPiquetes` (ids de parcela) e `config_painel.setorDe/setorAte`. O plano de campo devolve `pivo.piquetes` (todos os piquetes de pastagem com arco e se há animais). O formulário tem a miniatura do pivô (`MiniPivo`): toque na fatia marca animais, e o setor livre e o sentido são calculados no aparelho por `apps/web/src/setor.ts` (cópia de `planejarSetor` do núcleo, porque o web não importa o core). O seed local passou a criar a Pastagem com `tipo = 'forrageira'`.
- Guia de telas com fotos reais anotadas em `docs/guia-campo/` (gerado por script no Chrome headless; pode ser refeito quando as telas mudarem).
- Testado no banco local (PGlite) com dados de exemplo, por script na API, e as telas conferidas em Chrome headless (largura de celular); não testado em aparelho real. Pendente: cadastro real de casas de bomba × pivôs (o usuário traz), campos extras do painel que a equipe de irrigação confirmar, telas Água (não há dados de reservatório no Irrivert).
- Desenvolvimento local sem Docker: `tools/db-local` (PGlite + PostGIS, porta 5433, `maxConnections: 10`), API em 3010 e Vite com `API_URL=http://127.0.0.1:3010` (ver README.md).

## Ao iniciar
1. Ler este arquivo e retomar a partir de "Pendências". Se o usuário não indicar a prioridade, perguntar qual item seguir.
2. Não publicar nem conectar ao servidor sem autorização explícita; sempre backup antes e logs depois.
3. Nunca registrar senhas ou tokens em arquivos. O Claude não digita senhas: o usuário faz o login nas plataformas.
4. Histórico completo (consulta opcional):
   - `C:\Users\Jacson.Souza\.claude\projects\C--Users-Jacson-Souza-Desktop-ProjetoIrrigacao\*.jsonl` (relatórios, coleta de campo e deploy de 23/10).
   - `...\C--Users-Jacson-Souza-Desktop-ConfinaPLUS-confinamento-dashboard-vertente-confinamento-dashboard\939c3e07-9f75-439b-be52-d366e599c538.jsonl` (criação do projeto, servidor, mapa, WeatherLink, telemetria e alertas). Essas transcrições estão na conta/máquina anterior e podem não existir na nova.
