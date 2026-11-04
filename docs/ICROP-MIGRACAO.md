# Migração do iCrop Vision para o IRRIVERT

Cópia feita em 23/10/2026 a partir do painel https://vision.icrop.online (conta do Gabriel, fazenda
"Agropecuária Vertente - Agua Clara", id 2367; Fazenda Pedra id 1833). O contrato da fazenda no iCrop
termina em **24/10/2026**, por isso tudo foi guardado em arquivo antes de perder o acesso.

## O que foi copiado (apps/api/dados/icrop/)

| Arquivo | Conteúdo | Origem no iCrop |
|---|---|---|
| `mapa-parcelas-2026-10-23.json` | 103 marcadores (96 parcelas ativas, 5 pivôs sem cultura, 2 estações) com o balanço do dia: ITN, ETc, CC, CRA, CTA, raiz, prof. de manejo, fase, dias, área, setor (ângulos), ids de parcela/equipamento | variável `XPTO` embutida em `master_home.php?item=mapa` |
| `mapa-geometrias-2026-10-23.json` | 126 polígonos (5.204 vértices) das parcelas e pivôs | idem |
| `equipamentos-2026-10-23.json` | 26 pivôs de Água Clara: raio, raio após a última torre, vazão, velocidade a 100 %, tempo máx./dia, uniformidade, pressão, potência, área, posição do centro | Cadastros > Fazendas > Equipamentos |
| `equipamentos-pedra-2026-10-23.json` | 2 pivôs da Fazenda Pedra | idem |
| `parcelas-cadastro-2026-10-23.json` | ficha das 96 parcelas: cultura (cultivar), solo, data de plantio, início/fim do manejo, setor, área, umidade inicial, equipamento | Cadastros > Parcelas (`item=40&view=ID`) |
| `culturas-catalogo-2026-10-23.json` | catálogo global do iCrop: 85 tipos e 2.017 cultivares (ids) | filtros do relatório |
| `preciso-irrigar-2026-10-23.json` | tabela "Preciso irrigar?": lâmina aplicada nos 3 dias anteriores, recomendação de hoje e projeção de 6 dias por parcela | Preciso irrigar? |
| `balanco-diario-2026-10-22_23.json` | 38 variáveis do balanço de 22/10 para as 96 parcelas (inclui a tabela com cabeçalhos legíveis) | Relatórios > Parcelas Atuais |
| `historico/equipamento-<id>.json` | séries diárias (01/06/2026 a 22/10/2026) das mesmas 38 variáveis, por parcela, um arquivo por pivô | Relatórios > Parcelas Atuais, um pivô por vez |
| `api-openapi-v2.1.1.json` | especificação da API oficial do iCrop (Swagger) | Configurações > Integração APIs |

Variáveis do relatório (chave → significado): `o_fase_atual` fase, `o_dias_passados` dias desde o plantio,
`o_kc` Kc, `o_kl`/`o_ks` coeficientes de localização e estresse, `o_tamanho_da_raiz` raiz (cm),
`o_profundidade_absorcao` profundidade de manejo (cm), `o_cc` CC (%), `o_pm` PMP (%), `o_dg` densidade (g/cm³),
`o_cta` CTA (mm), `o_cta_camada_1` CTA da camada 1, `o_cra` CRA (mm), `o_umidade_seguranca` (%), `o_umidade` (%),
`o_umidade_inicial`, `o_deficit_inicial`, `o_eto`, `o_etc`, `o_precipitacao` (**cm** no relatório), `o_irrigacao` (mm),
`o_lamina_disponivel`, `o_deficit`, `o_deficit_previsto`, `o_itn`, `o_percentimetro_recomendado`,
`o_tempo_de_irrigacao` (h), `o_tempo_volta_100` (h), `o_taxa_aplicacao_equipamento` (mm/h), `o_uniformidade`,
`o_eficiencia_de_irrigacao`, `x_lamina21` (lâmina bruta em 21 h), `x_laminareal`, `i_tempo`/`i_percentimetro` (lançado).

## Como o iCrop calcula (observado nos dados; resumo em `parametros-derivados-2026-10-23.json`)

Histórico completo: 96 parcelas, 11.332 parcela-dia (01/06 a 22/10/2026), 23 pivôs com parcela ativa.

| Cultura | Fase | Dias desde o plantio | Kc | Raiz (cm) |
|---|---|---|---|---|
| Pastagem - Mombaça 3 (72 piquetes, plantio 01/06) | 2 (desenvolvimento) | 1 a 10 | 0,60 → 1,005 (+0,045/dia) | 31 → 40 (+1/dia) |
| | 3 (média) | 11 a 144+ | **1,05** constante | 40 → 51,7 (lento) |
| Amendoim IAC 677 / IAC 503 (16 parcelas, plantio 21/09 e 29/09) | 1 (inicial) | 1 a 10 | 0,55 | 16 → 25 |
| | 2 (desenvolvimento) | 11 em diante | 0,5667 + 0,0167/dia (dia 37: 1,00) | 25 → 29,5 (dia 37) |
| Preparo do solo (4 pivôs) | 1 | — | 0,60 | 20 |

- A fase final não apareceu em nenhuma parcela no período. Profundidade de absorção (manejo) = raiz × 1,3.
- Solos (valores que o iCrop usa, por grupo de pivôs):

| Solo | CC (%) | PMP (%) | Densidade (g/cm³) | Umidade de segurança (%) | Parcelas |
|---|---|---|---|---|---|
| PIVOS 1 AO 6 | 23,95 | 15,31 | 1,285 | 19,63 | 61 |
| PIVOS 09 AO 15 | 24,55 | 14,96 | 1,316 | 21,20 | 11 |
| PIVOS 7, 8, 16 AO 18 | 25,75 | 15,67 | 1,300 | 20,71 | 24 |

- CTA (mm) = profundidade de absorção (cm) × água do solo efetiva (mm/cm). A água efetiva fica perto de
  (CC − PMP)/100 × densidade × 10 × 0,95 e varia por parcela (camadas do solo: no amendoim CC e PMP mudam conforme a
  raiz aprofunda), por isso o IRRIVERT usa CTA ÷ profundidade do último dia de cada parcela (1,03 a 1,31 mm/cm).
- CRA = p × CTA, com p = 0,50 na Mombaça 3 e 0,35 no amendoim (0,30 na fase 1) e no preparo. Exemplo Pivô 04
  (Mombaça) em 22/10: CTA 70,9 mm, CRA 35,4 mm, lâmina disponível 31,6 mm.
- "Lâmina disponível" do iCrop é a água acima do limite de segurança (0 a CRA), no fim do dia. Na escala do IRRIVERT
  (desde o ponto de murcha): lâmina = disponível + (CTA − CRA). Dia 1 do iCrop = dia do plantio.
- Regra de recomendação do iCrop, conferida nas 11.332 linhas do histórico:
  - déficit previsto = CRA − lâmina disponível, ou seja, o que falta até a capacidade de campo;
  - déficit = máx(0, déficit previsto − ETc do dia), em todas as linhas;
  - ITN = déficit previsto ÷ eficiência, em todos os 7.299 dias com ITN;
  - recomenda quando o déficit é maior que zero: isso bate em 91 % dos dias, e o resto são dias de déficit pequeno
    sem padrão encontrado;
  - percentímetro = lâmina da volta ÷ ITN × 100, por exemplo 98 % para 4,71 mm com volta de 4,59 mm.
- **Adotada no IRRIVERT em 23/10**, a pedido do gestor. Antes, o IRRIVERT esperava o limite de segurança e enchia até
  a capacidade, o que dava 30 a 160 h de pivô com a vazão real. Hoje `recomendar()` repõe o que falta quando passa
  de um dia de consumo, ou sempre que a lâmina fica abaixo do limite. As cores continuam medindo o estresse pelo
  limite. As telas mostram o percentímetro no lugar do "% da volta".
- Equipamento: eficiência de irrigação entre 0,86 e 0,91 por pivô (≈ uniformidade × área molhada); taxa de
  aplicação 0,50 mm/h no Pivô 01; tempo da volta a 100 % 9,14 h; lâmina bruta em 21 h 10,55 mm.
- ITN = déficit previsto / eficiência (4,18 / 0,8877 = 4,71 mm no Pivô 01); tempo recomendado = ITN / taxa de
  aplicação em horas (4,71 / 0,5025 = 9,4 h → percentímetro 98 %, 01:10 por fatia).

## Banco e importação

- `schema.sql` ganhou as tabelas `icrop_equipamento`, `icrop_parcela` e `icrop_balanco_dia` (colunas principais +
  `campos`/`variaveis` em jsonb com tudo que veio).
- `npx tsx src/importar-icrop.ts` carrega os arquivos acima (upsert, roda quantas vezes quiser). A ligação é pela
  **área**, não pelo número nem pelo marcador:
  - a numeração do iCrop não é a do mapa do Pasto 6.0: o Pivô 30 do iCrop é o PIVÔ 04 do mapa, e os Pivôs 34, 35 e
    36 são os PIVÔS 05, 06 e 07 (09–15 e 19 coincidem). Cada equipamento vai para o pivô que cobre ≥ 30 % do seu
    círculo irrigado; se dois caem no mesmo pivô, fica o de maior sobreposição;
  - o marcador das parcelas do iCrop fica no centro do pivô (cairia sempre na praça de alimentação), então cada
    parcela é ligada ao piquete que o seu polígono mais cobre.
- `--simular` importa, aplica, mostra o resumo e desfaz tudo; `--aplicar` grava. A aplicação (regras em
  `apps/api/src/icrop-parametros.ts`):
  - cultivares `Pastagem - Mombaça 3`, `Amendoim - IAC 677`, `Amendoim - IAC 503` e `Preparo - Preparo do solo`, com
    Kc e profundidade de manejo por fase em linha reta (colunas novas `cultura_fase.kc_fim`, `raiz_mm`,
    `raiz_fim_mm`). Mombaça e preparo iguais ao iCrop; amendoim igual até o dia 37 e com médio/final da FAO-56 (Kc
    1,15 por 40 dias, depois 1,15 → 0,60 em 25 dias), marcado "a confirmar";
  - pivôs ligados: vazão, volta a 100 % (2π × raio da última torre ÷ velocidade), lâmina da volta (vazão ÷ área do
    raio total × horas) e eficiência do iCrop, com `parametros_confirmados = true`;
  - piquetes: a cultura do iCrop que cobre ≥ 30 % do piquete; da parcela que mais o cobre vêm o plantio, a água do
    solo (CTA ÷ profundidade), capacidade e limite em 23/10 e a lâmina do fim de 22/10 como ponto de partida
    (`data_inicial` 23/10). Piquetes sem parcela do iCrop ficam como estão;
  - tudo que muda fica em `icrop_aplicacao` (lote, tabela, id, origem, antes, depois) para conferir ou desfazer.
- O balanço (`servico.ts`) passou a seguir a curva de raiz quando a cultura tem uma: capacidade do dia =
  profundidade × água do solo, limite = capacidade × (1 − p) e, quando a raiz aprofunda, a lâmina sobe junto
  (a camada nova entra sem déficit, como na FAO-56). Sem curva, vale o que está gravado na parcela, como antes.
- Teste em 23/10 num PostGIS local (PGlite 0.5.11 + pglite-postgis 0.2.11, porque o Docker Desktop não iniciou),
  com o mapa real do Pasto 6.0: 13 pivôs do mapa e 3 círculos de telemetria simulados receberam a hidráulica; 136 de
  146 piquetes receberam cultura e solo (Mombaça 12, Amendoim IAC 677 45, IAC 503 27, Preparo 52); ficam de fora o
  PIVÔ 04 (Pivô 30 sem cultura no iCrop) e uma área do PIVÔ 01. Reaplicar não muda nada. Editar a cultivar na tela
  Cadastros preserva as curvas.
- Com a regra nova, no mesmo banco local, em 24/10 o PIVÔ 01 (Mombaça) pede 9,5 mm, cerca de 21 h, mesmo estando
  verde. A Ordem de 23/10 tem só o PIVÔ 04: 11 mm, pivô a 29 %, 23 h. As telas Preciso irrigar e Cadastros foram
  abertas no navegador contra esse banco, sem erros no console.
- Publicação: `scripts/publicar.sh` (backup, deploy, logs e `--simular`) e depois `scripts/publicar.sh --aplicar-icrop`.

## O que não foi possível copiar

- Cadastro de fases/Kc da cultura e cadastro de solo: "Permissão negada" para o usuário Gabriel (as curvas foram
  reconstruídas pelo histórico diário).
- Histórico anterior a 01/06/2026 (safras passadas) e lançamentos de irrigação brutos: possíveis pela API oficial
  (`/manejo/{fazenda}/{parcela}`, `/clima_por_dia/{estacao}`), que exige token gerado em Configurações >
  Integração APIs. O token não foi gerado (é alteração na conta; decisão do usuário).
- Perímetro da fazenda em GeoJSON (`Perimetro_26_Pivos.geojson`): o download redireciona para o Google Storage e
  foi bloqueado no navegador; já temos os limites do Pasto 6.0.
