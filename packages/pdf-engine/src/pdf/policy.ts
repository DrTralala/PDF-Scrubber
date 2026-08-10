import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFRawStream,
} from 'pdf-lib';

import {
  OBJECT_STORE_ANALYSIS_ACCESS,
  type ObjectStore,
} from './object-store';
import { decodeStreamBytes } from './stream-codecs';

export type PolicyConfidence = 'direct' | 'metadata' | 'notObserved';

export type PolicyObservation = Readonly<{
  observed: boolean;
  confidence: PolicyConfidence;
}>;

export type SignaturePolicyObservation = PolicyObservation & Readonly<{
  count: number;
}>;

export type StandardPolicyObservation = PolicyObservation & Readonly<{
  identifier: string | null;
}>;

export type DocumentPolicyEvidence = Readonly<{
  encryption: PolicyObservation;
  signatures: SignaturePolicyObservation;
  markedContent: PolicyObservation;
  structureTree: PolicyObservation;
  pdfA: StandardPolicyObservation;
  pdfUa: StandardPolicyObservation;
}>;

function observation(observed: boolean, confidence: PolicyConfidence): PolicyObservation {
  return Object.freeze({ observed, confidence });
}

function signatureObservation(count: number): SignaturePolicyObservation {
  return Object.freeze({
    observed: count > 0,
    confidence: count > 0 ? 'direct' : 'notObserved',
    count,
  });
}

function standardObservation(
  identifier: string | null,
  confidence: PolicyConfidence,
  observed = identifier !== null,
): StandardPolicyObservation {
  return Object.freeze({ observed, confidence, identifier });
}

export function inspectEncryptionEvidence(bytes: Uint8Array): PolicyObservation {
  const source = new TextDecoder('latin1').decode(bytes);
  return /\/Encrypt\s+(?:\d+\s+\d+\s+R|<<)/.test(source)
    ? observation(true, 'direct')
    : observation(false, 'notObserved');
}

function isName(dictionary: PDFDict, key: string, value: string): boolean {
  return dictionary.lookupMaybe(PDFName.of(key), PDFName)?.asString() === `/${value}`;
}

function signatureCount(document: ReturnType<ObjectStore[typeof OBJECT_STORE_ANALYSIS_ACCESS]>['document']): number {
  const signatures = new Set<PDFDict>();
  const inspect = (dictionary: PDFDict): void => {
    if (isName(dictionary, 'FT', 'Sig') || isName(dictionary, 'Type', 'Sig')) {
      signatures.add(dictionary);
    }
    const children = dictionary.lookupMaybe(PDFName.of('Kids'), PDFArray);
    children?.asArray().forEach((child) => {
      const resolved = document.context.lookup(child);
      if (resolved instanceof PDFDict) inspect(resolved);
    });
  };

  const acroForm = document.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  fields?.asArray().forEach((field) => {
    const resolved = document.context.lookup(field);
    if (resolved instanceof PDFDict) inspect(resolved);
  });
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) inspect(object);
  }
  return signatures.size;
}

function metadataIdentifier(
  xml: string,
  prefix: 'pdfaid' | 'pdfuaid',
): Readonly<{ part: string; conformance: string | null }> | null {
  const part = new RegExp(`${prefix}:part=(?:"([^"]+)"|'([^']+)')`, 'i').exec(xml) ??
    new RegExp(`<${prefix}:part>\\s*([^<]+)\\s*</${prefix}:part>`, 'i').exec(xml);
  if (part === null) return null;
  const conformance = new RegExp(
    `${prefix}:conformance=(?:"([^"]+)"|'([^']+)')`,
    'i',
  ).exec(xml) ?? new RegExp(
    `<${prefix}:conformance>\\s*([^<]+)\\s*</${prefix}:conformance>`,
    'i',
  ).exec(xml);
  return Object.freeze({
    part: (part[1] ?? part[2] ?? '').trim(),
    conformance: (conformance?.[1] ?? conformance?.[2] ?? null)?.trim() ?? null,
  });
}

function formatIdentifier(
  family: 'PDF/A' | 'PDF/UA',
  value: Readonly<{ part: string; conformance: string | null }> | null,
): string | null {
  if (value === null || value.part.length === 0) return null;
  return `${family}-${value.part}${value.conformance?.toUpperCase() ?? ''}`;
}

export async function detectDocumentPolicy(
  store: ObjectStore,
): Promise<DocumentPolicyEvidence> {
  const { document, limits } = store[OBJECT_STORE_ANALYSIS_ACCESS]();
  const markInfo = document.catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict);
  const marked = markInfo?.lookupMaybe(PDFName.of('Marked'), PDFBool)?.asBoolean() === true;
  const hasStructureTree = document.catalog.get(PDFName.of('StructTreeRoot')) !== undefined;
  const metadataObject = document.catalog.get(PDFName.of('Metadata'));
  const resolvedMetadata = metadataObject === undefined
    ? undefined
    : document.context.lookup(metadataObject);
  const metadata = resolvedMetadata instanceof PDFRawStream ? resolvedMetadata : undefined;
  const xml = metadata === undefined
    ? ''
    : new TextDecoder().decode(await decodeStreamBytes(metadata, limits.maxDecodedStreamBytes));
  const pdfAIdentifier = formatIdentifier('PDF/A', metadataIdentifier(xml, 'pdfaid'));
  const pdfUaIdentifier = formatIdentifier('PDF/UA', metadataIdentifier(xml, 'pdfuaid'));
  const pdfUaDirect = marked && hasStructureTree;

  return Object.freeze({
    encryption: observation(false, 'notObserved'),
    signatures: signatureObservation(signatureCount(document)),
    markedContent: observation(marked, marked ? 'direct' : 'notObserved'),
    structureTree: observation(
      hasStructureTree,
      hasStructureTree ? 'direct' : 'notObserved',
    ),
    pdfA: standardObservation(
      pdfAIdentifier,
      pdfAIdentifier === null ? 'notObserved' : 'metadata',
    ),
    pdfUa: pdfUaIdentifier !== null
      ? standardObservation(pdfUaIdentifier, 'metadata')
      : standardObservation(null, pdfUaDirect ? 'direct' : 'notObserved', pdfUaDirect),
  });
}
