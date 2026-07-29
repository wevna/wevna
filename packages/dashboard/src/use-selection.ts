import { useState, useSyncExternalStore } from "react";
import { SelectionStore } from "./selection-store.ts";

export interface UseSelectionResult {
  selectedId: string | undefined;
  select: (id: string) => void;
}

// Bridges the selection store into React, mirroring useLiveEvents for the
// event store. Its own store, its own hook — selection state never touches
// EventStore.
export function useSelection(): UseSelectionResult {
  const [store] = useState(() => new SelectionStore());
  const selectedId = useSyncExternalStore(store.subscribe, store.getSelectedId);

  return { selectedId, select: store.select };
}
