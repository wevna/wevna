import { useState, useSyncExternalStore } from "react";
import { SelectionStore } from "./selection-store.ts";

export interface UseRequestSelectionResult {
  selectedRequestId: string | undefined;
  selectRequest: (id: string) => void;
  clearRequestSelection: () => void;
}

// Its own SelectionStore instance, entirely separate from the one
// use-selection.ts uses for the raw event list — selecting a request never
// touches, and is never touched by, selecting an event, even though both
// happen to reuse the same generic store implementation. Neither store
// knows about EventStore or RequestStore: selection is UI state (what's
// being looked at), independent of what the app actually produced.
export function useRequestSelection(): UseRequestSelectionResult {
  const [store] = useState(() => new SelectionStore());
  const selectedRequestId = useSyncExternalStore(store.subscribe, store.getSelectedId);

  return {
    selectedRequestId,
    selectRequest: store.select,
    clearRequestSelection: store.clear,
  };
}
