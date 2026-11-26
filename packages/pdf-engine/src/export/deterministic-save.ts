import { fingerprint } from '../fingerprint';
import type { ObjectStore } from '../pdf/object-store';

export type DeterministicCandidate = Readonly<{
  bytes: Uint8Array;
  hash: string;
}>;

export async function deterministicSave(
  store: ObjectStore,
): Promise<DeterministicCandidate> {
  const bytes = await store.serialiseCandidate();
  return Object.freeze({ bytes, hash: await fingerprint(bytes) });
}
