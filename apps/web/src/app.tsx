import { useEffect, useRef, useState, type JSX } from 'react';

import { EditorShell } from './components/editor-shell';
import { OpenDocumentScreen } from './components/open-document-screen';
import {
  createDefaultEditorController,
  type EditorController,
} from './session/editor-controller';
import { useEditor } from './session/use-editor';

export function App({
  controller,
}: Readonly<{ controller?: EditorController }>): JSX.Element {
  const ownsController = useRef(controller === undefined).current;
  const [activeController] = useState(
    () => controller ?? createDefaultEditorController(),
  );
  const snapshot = useEditor(activeController);

  useEffect(() => () => {
    if (ownsController) void activeController.close();
  }, [activeController, ownsController]);

  return snapshot.fileName === null
    ? <OpenDocumentScreen controller={activeController} snapshot={snapshot} />
    : <EditorShell controller={activeController} snapshot={snapshot} />;
}
