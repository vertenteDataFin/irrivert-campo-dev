import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Alertas, Resultado, Telemetria } from './tipos';

export function usePreciso(fazendaId: number, comChuva: boolean) {
  return useQuery({
    queryKey: ['preciso', fazendaId, comChuva],
    queryFn: () => api<Resultado>(`/fazendas/${fazendaId}/preciso-irrigar?comChuva=${comChuva ? 1 : 0}`),
    refetchInterval: 120_000,
    placeholderData: (anterior) => anterior,
  });
}

export function useTelemetria(fazendaId: number) {
  return useQuery({
    queryKey: ['telemetria', fazendaId],
    queryFn: () => api<Telemetria>(`/fazendas/${fazendaId}/telemetria`),
    refetchInterval: 30_000,
    placeholderData: (anterior) => anterior,
  });
}

/** "há 5 min", "há 3 h", "há 2 d" */
export function haQuanto(iso: string | null): string {
  if (!iso) return '—';
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 1440) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} d`;
}

export function useAlertas(fazendaId: number) {
  return useQuery({
    queryKey: ['alertas', fazendaId],
    queryFn: () => api<Alertas>(`/fazendas/${fazendaId}/alertas`),
    enabled: fazendaId > 0,
    refetchInterval: 30_000,
    placeholderData: (anterior) => anterior,
  });
}
