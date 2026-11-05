-- Modelo de dados (doc 03). Idempotente: roda a cada subida da API.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS organizacao (
  id serial PRIMARY KEY,
  nome text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usuario (
  id serial PRIMARY KEY,
  nome text NOT NULL,
  email text NOT NULL UNIQUE,
  senha_hash text NOT NULL,
  papel text NOT NULL CHECK (papel IN ('operador', 'gestor', 'admin')),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fazenda (
  id serial PRIMARY KEY,
  organizacao_id int REFERENCES organizacao(id),
  nome text NOT NULL,
  endereco text,
  cidade text,
  uf text,
  pais text NOT NULL DEFAULT 'BR',
  responsavel text,
  telefone text,
  email text,
  altitude_m numeric NOT NULL DEFAULT 0,
  geom geometry(Point, 4326),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usuario_fazenda (
  usuario_id int NOT NULL REFERENCES usuario(id) ON DELETE CASCADE,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, fazenda_id)
);

CREATE TABLE IF NOT EXISTS estacao (
  id serial PRIMARY KEY,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  nome text NOT NULL,
  tipo text NOT NULL DEFAULT 'propria',
  identificador_externo text,
  altitude_m numeric,
  geom geometry(Point, 4326),
  online boolean NOT NULL DEFAULT false,
  ultima_leitura_em timestamptz
);

-- v1: leitura diária (1 por estação/dia). Radiação em MJ/m²/dia, vento a 2 m.
CREATE TABLE IF NOT EXISTS leitura_clima (
  id serial PRIMARY KEY,
  estacao_id int NOT NULL REFERENCES estacao(id) ON DELETE CASCADE,
  data date NOT NULL,
  temp_min numeric,
  temp_med numeric,
  temp_max numeric,
  umidade numeric,
  chuva_mm numeric NOT NULL DEFAULT 0,
  vento_ms numeric,
  radiacao_mj numeric,
  eto_mm numeric,
  metodo_eto text,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('estacao', 'api', 'manual')),
  qualidade text NOT NULL DEFAULT 'ok',
  UNIQUE (estacao_id, data)
);

CREATE TABLE IF NOT EXISTS previsao_dia (
  id serial PRIMARY KEY,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  data date NOT NULL,
  chuva_mm numeric NOT NULL DEFAULT 0,
  chuva_prob numeric,
  temp_min numeric,
  temp_max numeric,
  vento_ms numeric,
  nebulosidade numeric,
  eto_mm numeric,
  fonte text NOT NULL DEFAULT 'manual',
  obtido_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fazenda_id, data)
);

CREATE TABLE IF NOT EXISTS cultura (
  id serial PRIMARY KEY,
  nome text NOT NULL UNIQUE,
  prof_raiz_mm numeric NOT NULL,
  fracao_agua_disponivel_p numeric NOT NULL
);

CREATE TABLE IF NOT EXISTS cultura_fase (
  id serial PRIMARY KEY,
  cultura_id int NOT NULL REFERENCES cultura(id) ON DELETE CASCADE,
  ordem int NOT NULL,
  fase text NOT NULL,
  kc numeric NOT NULL,
  duracao_dias int NOT NULL,
  UNIQUE (cultura_id, ordem)
);

CREATE TABLE IF NOT EXISTS pivo (
  id serial PRIMARY KEY,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  nome text NOT NULL,
  area_ha numeric NOT NULL,
  vazao_m3h numeric,
  lamina_volta_100_mm numeric NOT NULL,   -- lâmina bruta de uma volta a 100%
  horas_volta_100 numeric NOT NULL,       -- horas de uma volta a 100%
  eficiencia numeric NOT NULL DEFAULT 0.85,
  identificador_telemetria text,
  ativo boolean NOT NULL DEFAULT true,
  geom geometry(Polygon, 4326),
  UNIQUE (fazenda_id, nome)
);

CREATE TABLE IF NOT EXISTS parcela (
  id serial PRIMARY KEY,
  pivo_id int NOT NULL REFERENCES pivo(id) ON DELETE CASCADE,
  cultura_id int NOT NULL REFERENCES cultura(id),
  nome text NOT NULL,
  safra text,
  area_ha numeric NOT NULL,
  data_plantio date,
  cap_campo_mm numeric NOT NULL,          -- água disponível total (mm úteis)
  lamina_seguranca_mm numeric NOT NULL,
  data_inicial date NOT NULL,             -- início do balanço
  lamina_inicial_mm numeric NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  geom geometry(Polygon, 4326),
  UNIQUE (pivo_id, nome)
);

CREATE TABLE IF NOT EXISTS balanco_hidrico_dia (
  parcela_id int NOT NULL REFERENCES parcela(id) ON DELETE CASCADE,
  data date NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('historico', 'projecao')),
  chuva_mm numeric NOT NULL,
  irrigacao_mm numeric NOT NULL,
  etc_mm numeric NOT NULL,
  lamina_disponivel_mm numeric NOT NULL,
  itn_mm numeric NOT NULL,
  tempo_recomendado_min numeric NOT NULL,
  recomenda_irrigar boolean NOT NULL,
  PRIMARY KEY (parcela_id, data, tipo)
);

CREATE TABLE IF NOT EXISTS lancamento_irrigacao (
  id serial PRIMARY KEY,
  parcela_id int NOT NULL REFERENCES parcela(id) ON DELETE CASCADE,
  data date NOT NULL,
  lamina_mm numeric,                      -- lâmina bruta aplicada
  tempo_min numeric,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual', 'telemetria')),
  usuario_id int REFERENCES usuario(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (lamina_mm IS NOT NULL OR tempo_min IS NOT NULL)
);
-- v0.2: cultivar como cadastro (cultura por cultivar), mapa real e parâmetros "a confirmar".
ALTER TABLE pivo ALTER COLUMN geom TYPE geometry(Geometry, 4326);
ALTER TABLE parcela ALTER COLUMN geom TYPE geometry(Geometry, 4326);
ALTER TABLE pivo ADD COLUMN IF NOT EXISTS parametros_confirmados boolean NOT NULL DEFAULT true;
ALTER TABLE cultura ADD COLUMN IF NOT EXISTS nome_cientifico text;
ALTER TABLE cultura ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'cultura';
ALTER TABLE cultura ADD COLUMN IF NOT EXISTS parametros_confirmados boolean NOT NULL DEFAULT true;
-- água disponível do solo por cm de raiz (mm/cm): capacidade = raiz(cm) × ad_mm_por_cm
ALTER TABLE parcela ADD COLUMN IF NOT EXISTS ad_mm_por_cm numeric NOT NULL DEFAULT 1.2;

CREATE TABLE IF NOT EXISTS limite_fazenda (
  id serial PRIMARY KEY,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  nome text NOT NULL,
  geom geometry(Geometry, 4326) NOT NULL
);

-- Pastos de sequeiro (não irrigados): só camada de mapa/cadastro.
CREATE TABLE IF NOT EXISTS pasto (
  id serial PRIMARY KEY,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  grupo text NOT NULL,
  nome text NOT NULL,
  cultura_id int REFERENCES cultura(id),
  area_ha numeric,
  geom geometry(Geometry, 4326) NOT NULL
);

-- Integração com estação (conector isolado, RF-80/89). O segredo é guardado cifrado (AES-256-GCM).
CREATE TABLE IF NOT EXISTS estacao_integracao (
  estacao_id int PRIMARY KEY REFERENCES estacao(id) ON DELETE CASCADE,
  provedor text NOT NULL DEFAULT 'weatherlink',
  api_key text NOT NULL,
  api_secret_cifrado text NOT NULL,
  station_id text,
  altura_vento_m numeric NOT NULL DEFAULT 2,
  ativo boolean NOT NULL DEFAULT true,
  ultima_sincronizacao timestamptz,
  ultimo_erro text
);

-- null = ainda não testado; false = plano sem /historic (Basic) → usa amostras da leitura atual
ALTER TABLE estacao_integracao ADD COLUMN IF NOT EXISTS historico_ok boolean;

-- Leituras atuais coletadas a cada ~10 min (modo Basic). Temperatura em °C, vento em m/s.
CREATE TABLE IF NOT EXISTS estacao_amostra (
  estacao_id int NOT NULL REFERENCES estacao(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  temp_c numeric,
  umidade numeric,
  vento_ms numeric,
  radiacao_wm2 numeric,
  chuva_dia_mm numeric,
  PRIMARY KEY (estacao_id, ts)
);

CREATE INDEX IF NOT EXISTS ix_lancamento_parcela_data ON lancamento_irrigacao (parcela_id, data);
CREATE INDEX IF NOT EXISTS ix_leitura_estacao_data ON leitura_clima (estacao_id, data);

-- ---------- Telemetria de pivôs (Irricontrol, AgSense…): conector somente leitura ----------
CREATE TABLE IF NOT EXISTS telemetria_conta (
  id serial PRIMARY KEY,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  provedor text NOT NULL DEFAULT 'irricontrol',
  usuario text NOT NULL,
  senha_cifrada text NOT NULL,
  token_cifrado text,
  farm_externo text,
  ativo boolean NOT NULL DEFAULT true,
  ultima_sincronizacao timestamptz,
  ultimo_erro text,
  UNIQUE (fazenda_id, provedor)
);

CREATE TABLE IF NOT EXISTS telemetria_pivo (
  id serial PRIMARY KEY,
  conta_id int NOT NULL REFERENCES telemetria_conta(id) ON DELETE CASCADE,
  externo_id text NOT NULL,
  nome text NOT NULL,
  pivo_id int REFERENCES pivo(id) ON DELETE SET NULL,
  lat numeric, lon numeric, raio_m numeric, area_ha numeric, vazao_m3h numeric, velocidade_m_h numeric,
  angulo numeric, destino_angulo numeric, status_cod int, status_txt text, categoria text,
  direcao int, percentual numeric, tensao_v numeric, pressao_ponta numeric,
  bomba boolean, canhao boolean, horas_molhado numeric,
  atualizado_em timestamptz, coletado_em timestamptz,
  UNIQUE (conta_id, externo_id)
);

CREATE TABLE IF NOT EXISTS telemetria_leitura (
  telemetria_pivo_id int NOT NULL REFERENCES telemetria_pivo(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  angulo numeric, status_cod int, percentual numeric, horas_molhado numeric,
  PRIMARY KEY (telemetria_pivo_id, ts)
);

-- lançamento automático: uma linha por parcela/dia, somada a cada leitura
CREATE UNIQUE INDEX IF NOT EXISTS ux_lancamento_telemetria ON lancamento_irrigacao (parcela_id, data) WHERE origem = 'telemetria';

-- ---------- Alertas (telemetria x balanço hídrico) e destinatários de WhatsApp ----------
CREATE TABLE IF NOT EXISTS alerta (
  id serial PRIMARY KEY,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  tipo text NOT NULL,
  chave text NOT NULL,
  severidade text NOT NULL CHECK (severidade IN ('alta', 'media', 'baixa')),
  pivo_nome text,
  titulo text NOT NULL,
  mensagem text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  resolvido_em timestamptz,
  dispensado boolean NOT NULL DEFAULT false,
  notificado_em timestamptz,
  erro_envio text
);
-- só um alerta aberto por condição: não repete enquanto o problema durar
CREATE UNIQUE INDEX IF NOT EXISTS ux_alerta_aberto ON alerta (fazenda_id, chave) WHERE resolvido_em IS NULL;

CREATE TABLE IF NOT EXISTS alerta_destinatario (
  id serial PRIMARY KEY,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  nome text NOT NULL,
  telefone text NOT NULL,
  severidade_min text NOT NULL DEFAULT 'media' CHECK (severidade_min IN ('alta', 'media', 'baixa')),
  ativo boolean NOT NULL DEFAULT true
);

-- ---------- v0.3: pastejo (entrada/saída de animais), janelas de energia, ordem de irrigação, comandos ----------
-- Cada piquete é uma parcela com cultura forrageira. client_uuid torna o envio offline idempotente.
CREATE TABLE IF NOT EXISTS movimento_animal (
  id serial PRIMARY KEY,
  client_uuid uuid NOT NULL UNIQUE,
  parcela_id int NOT NULL REFERENCES parcela(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('entrada', 'saida')),
  ocorrido_em timestamptz NOT NULL,          -- quando aconteceu (relógio do celular)
  recebido_em timestamptz NOT NULL DEFAULT now(),
  lote text,
  cabecas int CHECK (cabecas IS NULL OR cabecas >= 0),
  nota smallint CHECK (nota IS NULL OR nota BETWEEN 1 AND 5),   -- qualidade do pasto nesse momento
  observacao text,
  foto bytea,
  foto_tipo text,
  usuario_id int REFERENCES usuario(id)
);
CREATE INDEX IF NOT EXISTS ix_movimento_parcela ON movimento_animal (parcela_id, ocorrido_em DESC);

-- Janelas em que a irrigação é permitida (custo de energia). Sem linhas = sem restrição.
CREATE TABLE IF NOT EXISTS janela_irrigacao (
  id serial PRIMARY KEY,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  inicio time NOT NULL,
  fim time NOT NULL,                          -- fim < início = atravessa a meia-noite
  dias smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  ativo boolean NOT NULL DEFAULT true
);
ALTER TABLE fazenda ADD COLUMN IF NOT EXISTS max_pivos_simultaneos int NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS ordem_irrigacao (
  id serial PRIMARY KEY,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  data date NOT NULL,
  pivo_id int NOT NULL REFERENCES pivo(id) ON DELETE CASCADE,
  sequencia int NOT NULL,
  inicio_previsto timestamptz,
  fim_previsto timestamptz,
  duracao_min int NOT NULL,
  lamina_mm numeric,
  sentido smallint,                           -- 0 frente, 1 reverso, null = tanto faz (lavoura / sem animais)
  angulo_parada numeric,
  percentual numeric,
  avisos text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'planejada' CHECK (status IN ('planejada', 'enviada', 'concluida', 'cancelada')),
  gerada_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ordem_dia ON ordem_irrigacao (fazenda_id, data);

-- Trilha de auditoria de TODO comando a pivô (inclusive os bloqueados).
CREATE TABLE IF NOT EXISTS comando_pivo (
  id serial PRIMARY KEY,
  telemetria_pivo_id int NOT NULL REFERENCES telemetria_pivo(id) ON DELETE CASCADE,
  usuario_id int REFERENCES usuario(id),
  acao text NOT NULL CHECK (acao IN ('iniciar', 'parar')),
  parametros jsonb NOT NULL DEFAULT '{}',
  estado text NOT NULL CHECK (estado IN ('enviado', 'bloqueado', 'erro')),
  detalhe text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- v0.3 (23/10/2026): dados copiados do iCrop Vision para a migração (fonte: apps/api/dados/icrop/*.json,
-- importados por importar-icrop.ts). Ficam separados dos cadastros do IRRIVERT para não sobrescrever nada;
-- a conciliação com pivo/parcela/cultura é feita pelo nome do pivô e pela posição.
CREATE TABLE IF NOT EXISTS icrop_equipamento (
  id int PRIMARY KEY,                         -- id do equipamento no iCrop (eqp)
  fazenda_icrop int NOT NULL,                 -- 2367 Vertente - Agua Clara, 1833 Vertente - Pedra
  nome text NOT NULL,
  marca_modelo text,
  raio_ultima_torre_m numeric,
  raio_apos_ultima_torre_m numeric,
  vazao_m3h numeric,
  velocidade_100_mh numeric,
  tempo_max_dia_h numeric,
  uniformidade_pct numeric,
  pressao_servico_mca numeric,
  potencia_cv numeric,
  area_molhada_pct numeric,
  area_ha numeric,
  lat numeric,
  lng numeric,
  campos jsonb NOT NULL DEFAULT '{}',          -- todas as colunas originais da tabela do iCrop
  pivo_id int REFERENCES pivo(id) ON DELETE SET NULL,
  capturado_em date NOT NULL
);

CREATE TABLE IF NOT EXISTS icrop_parcela (
  id int PRIMARY KEY,                         -- id da parcela no iCrop (parc)
  equipamento_id int REFERENCES icrop_equipamento(id),
  nome text NOT NULL,
  cultura text,                               -- "Pastagem - Mombaça 3", "Amendoim - IAC 677"...
  solo text,                                  -- nome do solo no iCrop ("PIVOS 1 AO 6")
  data_plantio date,
  inicio_manejo date,
  fim_manejo date,
  area_ha numeric,
  angulo_inicio numeric,                      -- setor do pivô (graus, convenção do iCrop)
  angulo_fim numeric,
  umidade_inicial text,                       -- "Umidade Plena I/II"
  lat numeric,
  lng numeric,
  geom geometry(Geometry, 4326),              -- polígono desenhado no mapa do iCrop
  campos jsonb NOT NULL DEFAULT '{}',
  parcela_id int REFERENCES parcela(id) ON DELETE SET NULL,
  capturado_em date NOT NULL
);

-- Balanço diário calculado pelo iCrop (relatório Parcelas Atuais): Kc, fase, raiz, CC, PMP, CTA, CRA,
-- ETo, ETc, irrigação, chuva, lâmina disponível, déficit, ITN etc. Uma linha por parcela e dia.
CREATE TABLE IF NOT EXISTS icrop_balanco_dia (
  parcela_icrop_id int NOT NULL REFERENCES icrop_parcela(id) ON DELETE CASCADE,
  data date NOT NULL,
  fase int,
  dias_passados int,
  kc numeric,
  raiz_cm numeric,
  prof_absorcao_cm numeric,
  cc_pct numeric,
  pmp_pct numeric,
  densidade_g_cm3 numeric,
  cta_mm numeric,
  cra_mm numeric,
  umidade_seguranca_pct numeric,
  umidade_pct numeric,
  eto_mm numeric,
  etc_mm numeric,
  chuva_mm numeric,
  irrigacao_mm numeric,
  lamina_disponivel_mm numeric,
  deficit_mm numeric,
  deficit_previsto_mm numeric,
  itn_mm numeric,
  tempo_irrigacao_h numeric,
  percentimetro_recomendado numeric,
  variaveis jsonb NOT NULL DEFAULT '{}',       -- todas as séries originais (o_kc, o_cta...)
  PRIMARY KEY (parcela_icrop_id, data)
);

-- v0.4 (23/10/2026): parâmetros do iCrop aplicados nos cadastros (importar-icrop.ts --aplicar).
-- Curvas por fase: o Kc e a profundidade de manejo seguem em linha reta do 1º ao último dia da fase.
-- Nulos = comportamento anterior (Kc constante na fase, profundidade fixa da cultura).
ALTER TABLE cultura_fase ADD COLUMN IF NOT EXISTS kc_fim numeric;
ALTER TABLE cultura_fase ADD COLUMN IF NOT EXISTS raiz_mm numeric;       -- profundidade de manejo (raiz × 1,3 no iCrop)
ALTER TABLE cultura_fase ADD COLUMN IF NOT EXISTS raiz_fim_mm numeric;

-- Trilha do que a aplicação mudou (valores antes/depois), para conferir ou desfazer à mão.
CREATE TABLE IF NOT EXISTS icrop_aplicacao (
  id serial PRIMARY KEY,
  lote timestamptz NOT NULL,                  -- mesmo valor para todas as linhas de uma execução
  tabela text NOT NULL,                       -- pivo, cultura, parcela
  registro_id int NOT NULL,
  origem text,                                -- equipamento/parcela do iCrop usado
  antes jsonb,
  depois jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_icrop_aplicacao_lote ON icrop_aplicacao (lote, tabela);

-- ---------- v0.5 (03/11/2026): módulo de campo — vistoria presencial dos pivôs da ordem do dia ----------
-- Todo pivô com ordem recebe vistoria no local; o comando remoto só encurta a vistoria (roteiro rápido).
ALTER TABLE pivo ADD COLUMN IF NOT EXISTS painel_modelo text;              -- "Valley ICON10", "Bauer SmartTouch"…
ALTER TABLE pivo ADD COLUMN IF NOT EXISTS inoperante_desde date;           -- pivô que não pode irrigar (defeito); nulo = operante
ALTER TABLE pivo ADD COLUMN IF NOT EXISTS inoperante_motivo text;
ALTER TABLE pivo ADD COLUMN IF NOT EXISTS reparo_previsto date;
ALTER TABLE ordem_irrigacao ADD COLUMN IF NOT EXISTS motivo text;          -- por que saiu da ordem (orientação de manejo, inoperante…)

-- Ativos que alimentam vários pivôs: uma falha aqui derruba todos eles (e a rota de vistoria agrupa por eles).
CREATE TABLE IF NOT EXISTS ativo_compartilhado (
  id serial PRIMARY KEY,
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('casa_bomba', 'transformador', 'rede', 'usina', 'captacao', 'reservatorio', 'adutora')),
  nome text NOT NULL,
  observacao text,
  geom geometry(Point, 4326),
  ativo boolean NOT NULL DEFAULT true,
  UNIQUE (fazenda_id, nome)
);
CREATE TABLE IF NOT EXISTS ativo_pivo (
  ativo_id int NOT NULL REFERENCES ativo_compartilhado(id) ON DELETE CASCADE,
  pivo_id int NOT NULL REFERENCES pivo(id) ON DELETE CASCADE,
  PRIMARY KEY (ativo_id, pivo_id)
);
-- Falha aberta num ativo compartilhado: registrada uma vez na vistoria e aplicada a todos os pivôs que ele alimenta.
CREATE TABLE IF NOT EXISTS falha_ativo (
  id serial PRIMARY KEY,
  ativo_id int NOT NULL REFERENCES ativo_compartilhado(id) ON DELETE CASCADE,
  descricao text NOT NULL,
  previsao text,
  aberta_em timestamptz NOT NULL DEFAULT now(),
  encerrada_em timestamptz,
  usuario_id int REFERENCES usuario(id)
);
CREATE INDEX IF NOT EXISTS ix_falha_ativo_aberta ON falha_ativo (ativo_id) WHERE encerrada_em IS NULL;

-- Ordem de visita do dia, editada pela equipe antes de sair. paradas = [{tipo:'pivo'|'ativo', id, nota}] na sequência.
CREATE TABLE IF NOT EXISTS roteiro_dia (
  fazenda_id int NOT NULL REFERENCES fazenda(id) ON DELETE CASCADE,
  data date NOT NULL,
  saida time,
  paradas jsonb NOT NULL DEFAULT '[]',
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  usuario_id int REFERENCES usuario(id),
  PRIMARY KEY (fazenda_id, data)
);

-- Vistoria presencial de um pivô. client_uuid torna o envio offline idempotente (fila no aparelho).
-- integridade: {pneus, bicos, estrutura, caminho, posicaoGraus (0-360), gadoPiquetes: [parcela_id] (um só piquete por vez), observacao}; config_painel.setorDe/setorAte em graus; leituras: {pressaoBar, fonteEnergia, tensaoV, painelRespondeu}
-- config_painel (só quando a equipe programou direto no painel): {modelo, sentido, percentimetro, laminaMm, agua, setorDe, setorAte, partidaEm}
-- falha: {passo, origem, ativoId, local, descricao, previsao}; passo = etapa da cadeia (1 comunicação … 6 painel)
CREATE TABLE IF NOT EXISTS vistoria (
  id serial PRIMARY KEY,
  client_uuid uuid NOT NULL UNIQUE,
  pivo_id int NOT NULL REFERENCES pivo(id) ON DELETE CASCADE,
  ordem_id int REFERENCES ordem_irrigacao(id) ON DELETE SET NULL,
  data date NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('rapida', 'completa')),
  iniciada_em timestamptz NOT NULL,
  concluida_em timestamptz,
  recebido_em timestamptz NOT NULL DEFAULT now(),
  usuario_id int REFERENCES usuario(id),
  suspeita text,
  passo_entrada smallint,
  integridade jsonb NOT NULL DEFAULT '{}',
  leituras jsonb NOT NULL DEFAULT '{}',
  config_painel jsonb,
  falha jsonb,
  resolvido_local boolean,
  resultado text NOT NULL CHECK (resultado IN ('operando', 'partida_local', 'nao_iniciou')),
  observacao text
);
CREATE INDEX IF NOT EXISTS ix_vistoria_pivo_data ON vistoria (pivo_id, data);

CREATE TABLE IF NOT EXISTS vistoria_foto (
  id serial PRIMARY KEY,
  vistoria_id int NOT NULL REFERENCES vistoria(id) ON DELETE CASCADE,
  tipo text NOT NULL DEFAULT 'painel' CHECK (tipo IN ('painel', 'ultima_torre', 'quadro', 'outro')),
  foto bytea NOT NULL,
  foto_tipo text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
