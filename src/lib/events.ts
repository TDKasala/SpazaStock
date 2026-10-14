/**
 * Tiny in-process event bus.
 * - 'local': the device wrote something (the sync engine schedules a push).
 * - 'remote': a sync pulled server changes into the local store (views reload).
 */
export type DataChangeSource = 'local' | 'remote';

type Listener = (source: DataChangeSource) => void;

const listeners = new Set<Listener>();

export function emitDataChanged(source: DataChangeSource): void {
  for (const listener of listeners) listener(source);
}

export function onDataChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
