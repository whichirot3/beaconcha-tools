import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useDashboardData() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: api.getDashboard,
    refetchInterval: 12_000,
    staleTime: 6_000,
  });
}

export function useHealthData() {
  return useQuery({
    queryKey: ['health'],
    queryFn: api.getHealth,
    refetchInterval: 12_000,
    staleTime: 6_000,
  });
}

export function useIncidentsData() {
  return useQuery({
    queryKey: ['incidents'],
    queryFn: api.getIncidents,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

export function useDutiesData(enabled = true) {
  return useQuery({
    queryKey: ['duties'],
    queryFn: api.getDuties,
    enabled,
    refetchInterval: 12_000,
    staleTime: 6_000,
  });
}

export function useRewardsData(
  validatorIndex: number | null,
  windowHours: number,
  enabled = true
) {
  return useQuery({
    queryKey: ['rewards', validatorIndex, windowHours],
    queryFn: () => api.getRewards(validatorIndex ?? 0, windowHours),
    enabled: enabled && validatorIndex !== null,
    refetchInterval: 15_000,
    staleTime: 7_000,
  });
}
