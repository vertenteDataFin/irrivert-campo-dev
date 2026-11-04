export type Status = 'irrigar' | 'atencao' | 'ok';

export interface Usuario { id: number; nome: string; email: string; papel: 'operador' | 'gestor' | 'admin' }
export interface Fazenda { id: number; nome: string; cidade: string | null; uf: string | null; lat: number | null; lon: number | null }

export interface Recomendacao { recomendaIrrigar: boolean; itnMm: number; itnBrutaMm: number; percentualVolta: number; tempoMin: number }
export interface DiaProjecao { data: string; chuvaMm: number; etoMm: number; etcMm: number; laminaMm: number; recomendacao: Recomendacao }

export interface Parcela {
  id: number; nome: string; pivoId: number; pivoNome: string; cultura: string; safra: string | null; areaHa: number; kc: number;
  capMm: number; limiteMm: number; laminaMm: number; etcHojeMm: number; status: Status; recomendacao: Recomendacao;
  /** ausente em respostas antigas da API */
  hidraulica?: { mmPorHora: number; eficiencia: number; laminaVoltaMm: number };
  ultimaIrrigacao: string | null; geom: GeoJSON.Polygon; projecao: DiaProjecao[]; estimados: number;
  /** risco de estresse: lâmina abaixo do limite de segurança (ausente em respostas antigas da API) */
  abaixoLimite?: boolean;
}

export interface Previsao { data: string; chuvaMm: number; chuvaProb: number | null; tmin: number | null; tmax: number | null; etoMm: number }

export interface Resultado {
  fazenda: { id: number; nome: string };
  data: string;
  comChuva: boolean;
  estacao: { id: number; nome: string } | null;
  climaHoje: { etoMm: number; chuvaMm: number; tmax: number | null; tmin: number | null; origem: string } | null;
  previsao: Previsao[];
  parcelas: Parcela[];
  resumo: { total: number; irrigar: number; atencao: number; ok: number; areaIrrigarHa: number; abaixoLimite?: number };
}

export const COR_STATUS: Record<Status, string> = { irrigar: '#dc2626', atencao: '#f59e0b', ok: '#059669' };
export const ROTULO_STATUS: Record<Status, string> = { irrigar: 'Irrigar', atencao: 'Atenção', ok: 'Ok' };

export type CategoriaTel = 'irrigando' | 'movendo' | 'aguardando' | 'parado' | 'desligado' | 'alarme' | 'sem_sinal';

export interface PivoTel {
  id: number; provedor: 'irricontrol' | 'agsense'; externoId: string; nome: string; pivoId: number | null; pivoNome: string | null;
  lat: number | null; lon: number | null; raioM: number | null; areaHa: number | null; vazaoM3h: number | null;
  angulo: number | null; destinoAngulo: number | null; statusCod: number | null; statusTxt: string; categoria: CategoriaTel;
  direcao: number | null; percentual: number | null; tensaoV: number | null; pressaoPonta: number | null;
  bomba: boolean | null; canhao: boolean | null; horasMolhado: number | null; atualizadoEm: string | null; coletadoEm: string | null;
}
export interface ContaTel { id: number; provedor: string; usuario: string; ativo: boolean; ultimaSincronizacao: string | null; ultimoErro: string | null; fazendas: string | null }
export interface Telemetria { contas: ContaTel[]; pivos: PivoTel[] }

export const COR_TEL: Record<CategoriaTel, string> = {
  irrigando: '#2563eb', movendo: '#92400e', aguardando: '#7c3aed', parado: '#eab308', desligado: '#f97316', alarme: '#dc2626', sem_sinal: '#94a3b8',
};
export const ROTULO_TEL: Record<CategoriaTel, string> = {
  irrigando: 'Irrigando', movendo: 'Movendo', aguardando: 'Aguardando', parado: 'Parado', desligado: 'Painel desligado', alarme: 'Alarme', sem_sinal: 'Sem sinal',
};

export type SeveridadeAlerta = 'alta' | 'media' | 'baixa';
export interface Alerta {
  id: number; tipo: string; severidade: SeveridadeAlerta; pivoNome: string | null; titulo: string; mensagem: string;
  criadoEm: string; resolvidoEm: string | null; dispensado: boolean; notificadoEm: string | null; erroEnvio: string | null;
}
export interface DestinatarioAlerta { id: number; nome: string; telefone: string; severidadeMin: SeveridadeAlerta; ativo: boolean }
export interface Alertas { abertos: Alerta[]; recentes: Alerta[]; destinatarios: DestinatarioAlerta[]; envioAutomatico: boolean }

// ---------- operação: pastejo, ordem de irrigação, relatórios ----------
export interface Piquete {
  parcelaId: number; nome: string; pivoId: number; pivoNome: string; areaHa: number; cultura: string;
  ocupado: boolean; desde: string | null; ultimaSaida: string | null; cabecas: number | null; lote: string | null;
  notaEntrada: number | null; notaSaida: number | null; ultimoMovimentoId: number | null; diasNoPiquete: number | null; diasDescanso: number | null;
  geom?: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
}
export interface MovimentoRecente {
  id: number; parcelaId?: number; piquete: string; pivoNome: string; tipo: 'entrada' | 'saida'; em: string; nota: number | null;
  cabecas: number | null; lote: string | null; observacao: string | null; temFoto: boolean; usuario?: string | null;
}
export interface Pastejo { piquetes: Piquete[]; recentes: MovimentoRecente[] }

export interface Janela { inicio: string; fim: string; dias: number[] }
export interface ItemOrdem {
  id: number; pivoId: number; pivoNome: string; sequencia: number; inicio: string | null; fim: string | null; duracaoMin: number; laminaMm: number | null;
  sentido: 0 | 1 | null; anguloParada: number | null; percentual: number | null; avisos: string[]; status: 'planejada' | 'enviada' | 'concluida' | 'cancelada';
  telemetriaId: number | null; categoria: CategoriaTel | null; angulo: number | null;
  /** por que saiu da ordem (orientação de manejo, inoperante…); ausente em respostas antigas */
  motivo?: string | null;
}
export interface Ordem { data: string; itens: ItemOrdem[]; janelas: Janela[]; permitidoAgora: boolean }
export interface PreviaComando { comando: { acao: string; sentido: 0 | 1 | null; anguloParada: number | null; percentual: number | null; avisos: string[] }; bloqueios: string[] }

// ---------- módulo de campo: vistoria presencial dos pivôs da ordem ----------
export type TipoAtivo = 'casa_bomba' | 'transformador' | 'rede' | 'usina' | 'captacao' | 'reservatorio' | 'adutora';
export const ROTULO_ATIVO: Record<TipoAtivo, string> = {
  casa_bomba: 'Casa de bomba', transformador: 'Transformador', rede: 'Rede da concessionária', usina: 'Usina fotovoltaica', captacao: 'Captação', reservatorio: 'Reservatório', adutora: 'Adutora',
};
export interface FalhaAtivo { id: number; descricao: string; previsao: string | null; abertaEm: string }
export interface Ativo { id: number; tipo: TipoAtivo; nome: string; observacao: string | null; ativo: boolean; pivos: number[]; falha: FalhaAtivo | null }

export type ResultadoVistoria = 'operando' | 'partida_local' | 'nao_iniciou';
export const ROTULO_RESULTADO: Record<ResultadoVistoria, string> = { operando: 'Em operação', partida_local: 'Partida no painel', nao_iniciou: 'Não iniciou' };

export interface PivoCampo {
  id: number; nome: string; culturas: string | null; painelModelo: string | null;
  inoperanteDesde: string | null; inoperanteMotivo: string | null; reparoPrevisto: string | null;
  telemetria: { id: number; provedor: string; categoria: CategoriaTel | null; statusTxt: string | null; angulo: number | null; atualizadoEm: string | null } | null;
  /** Piquetes de pastagem do pivô com o arco de cada um (graus a partir do norte, sentido horário) e se há animais agora. */
  piquetes: PiqueteCampo[];
  gado: { piquete: string; de: number | null; ate: number | null }[];
  vistoriaHoje: { id: number; tipo: 'rapida' | 'completa'; resultado: ResultadoVistoria; concluidaEm: string | null; usuario: string | null } | null;
}
export interface PiqueteCampo { id: number; nome: string; de: number | null; ate: number | null; ocupado: boolean }
export interface Parada { tipo: 'pivo' | 'ativo'; id: number; nota?: string | null }
export interface Roteiro { saida: string | null; paradas: Parada[]; atualizadoEm: string }
export interface PlanoCampo { data: string; ordem: Ordem; pivos: PivoCampo[]; ativos: Ativo[]; roteiro: Roteiro | null }

export interface Integridade { pneus?: boolean | null; bicos?: boolean | null; estrutura?: boolean | null; caminho?: boolean | null; posicaoGraus?: number | null; gadoPiquetes?: number[] | null }
export interface Leituras { pressaoBar?: number | null; fonteEnergia?: 'rede' | 'usina' | 'gerador' | null; tensaoV?: number | null; painelRespondeu?: boolean | null }
export interface ConfigPainel {
  modelo?: string | null; sentido?: 'horario' | 'anti_horario' | null; percentimetro?: number | null; laminaMm?: number | null;
  agua?: 'com_agua' | 'a_seco' | null; setorDe?: number | null; setorAte?: number | null; partidaEm?: string | null;
}
export interface FalhaVistoria { passo?: number | null; origem: 'pivo' | TipoAtivo; ativoId?: number | null; local?: string | null; descricao?: string | null; previsao?: string | null }
export type TipoFoto = 'painel' | 'ultima_torre' | 'quadro' | 'outro';

/** O que o app envia (e guarda na fila offline) ao concluir uma vistoria. */
export interface VistoriaEnvio {
  clientUuid: string; pivoId: number; ordemId: number | null; data: string; tipo: 'rapida' | 'completa';
  iniciadaEm: string; concluidaEm: string | null; suspeita: string | null; passoEntrada: number | null;
  integridade: Integridade; leituras: Leituras; configPainel: ConfigPainel | null; falha: FalhaVistoria | null;
  resolvidoLocal: boolean | null; resultado: ResultadoVistoria; observacao: string | null;
  fotos: { tipo: TipoFoto; dados: string }[];
}
export interface VistoriaRegistro extends Omit<VistoriaEnvio, 'fotos'> {
  id: number; pivoNome: string; usuario: string | null; fotos: { id: number; tipo: TipoFoto }[];
}

export interface Relatorio {
  periodo: { de: string; ate: string; hoje: string };
  resumo: { laminaMediaMm: number; chuvaMm: number; etoMm: number; pivosIrrigar: number; pivos: number; piquetesOcupados: number };
  irrigacao: { pivoNome: string; laminaMm: number; laminaTelemetriaMm: number; diasIrrigados: number; areaHa: number }[];
  clima: { data: string; chuvaMm: number | null; etoMm: number | null }[];
  dias: { data: string; chuvaMm: number; etoMm: number; irrigacaoMm: number }[];
  situacao: { pivoNome: string; laminaMm: number; limiteMm: number; capMm: number; irrigar: boolean; status?: Status; abaixoLimite?: boolean; culturas: string }[];
  ordem: Ordem;
  pastejo: { piquete: string; pivoNome: string; entradas: number; saidas: number; diasOcupado: number; notaEntrada: number | null; notaSaida: number | null }[];
  movimentos: MovimentoRecente[];
  alertas: { tipo: string; n: number }[];
  comandos: { id: number; em: string; pivoNome: string; acao: string; estado: string; detalhe: string | null; usuario: string | null }[];
}
