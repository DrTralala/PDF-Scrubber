import {
  useCallback,
  useEffect,
  useSyncExternalStore,
} from 'react';

import type { EditorSnapshot } from '../model/editor-state';
import type { EditorController } from './editor-controller';

export function useEditor(controller: EditorController): EditorSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(
    () => controller.getSnapshot(),
    [controller],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const previewMissing = snapshot.selection?.kind === 'text'
      ? snapshot.richEditor !== null && snapshot.richEditor.preview === null
      : snapshot.preview === null;
    if (
      snapshot.phase !== 'ready'
      || snapshot.selection === null
      || snapshot.replacement.length === 0
      || !previewMissing
    ) return;
    const timer = window.setTimeout(() => {
      void controller.previewSelection();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    controller,
    snapshot.acceptSubstitution,
    snapshot.phase,
    snapshot.preview,
    snapshot.replacement,
    snapshot.richEditor,
    snapshot.selection,
  ]);

  return snapshot;
}
