import { fingerprint } from '../fingerprint';
import {
  OBJECT_STORE_ANALYSIS_ACCESS,
  type ObjectStore,
} from '../pdf/object-store';

export type DeterministicCandidate = Readonly<{
  bytes: Uint8Array;
  hash: string;
}>;

const FIXED_CREATOR = 'pdf-editor-browser-engine/m0';
const FIXED_PRODUCER = 'pdf-editor-browser-engine/m0';

export async function deterministicSave(
  store: ObjectStore,
): Promise<DeterministicCandidate> {
  const { document } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  if (document.getCreator() === undefined) document.setCreator(FIXED_CREATOR);
  if (document.getProducer() === undefined) document.setProducer(FIXED_PRODUCER);
  const bytes = await store.serialiseCandidate();
  return Object.freeze({ bytes, hash: await fingerprint(bytes) });
}
