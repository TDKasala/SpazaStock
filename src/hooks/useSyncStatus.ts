import { useSyncContext } from '../context/SyncContext';

/** Pending/failed outbox counts, last sync time and manual sync controls for the active shop. */
export function useSyncStatus() {
  return useSyncContext();
}
