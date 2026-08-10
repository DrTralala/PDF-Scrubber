import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export type SuiteNumber = 1 | 2 | 3;
export type SuiteLanguage = 'en' | 'zh-Hans';

export type CommittedFontSource =
  | Readonly<{
      kind: 'npm';
      package: string;
      version: '5.3.0';
      file: string;
      sha256: string;
    }>
  | Readonly<{
      kind: 'committed';
      path: 'tests/fonts/mplus-1c-regular.ttf';
      version: '1.047';
      sha256: string;
    }>;

export type CommittedPdfFont = Readonly<{
  inventoryName: string;
  reason: 'embedded-not-reusable';
  weight: number;
  italic: boolean;
  source: CommittedFontSource;
  licence: string;
  fonts2uPage: string;
  searchUrl: string;
}>;

export type CommittedPdfEdit = Readonly<{
  language: SuiteLanguage;
  pageIndex: number;
  sourceText: string;
  replacementText: string;
  fontInventoryName: string;
  verifyAfterReopen: boolean;
}>;

export type CommittedPdfSuiteManifest = Readonly<{
  schemaVersion: 1;
  suite: SuiteNumber;
  pdf: 'document.pdf';
  sha256: string;
  byteLength: number;
  sizePolicy: Readonly<{ minimumBytes: number; maximumBytes: number }>;
  languages: readonly SuiteLanguage[];
  fonts: readonly CommittedPdfFont[];
  edits: readonly CommittedPdfEdit[];
  contentAssertions: readonly string[];
  generation: Readonly<{
    synthetic: true;
    oneTime: true;
    seed: 'pdf-scrubber-committed-pdf-suites-v1';
    runtime: 'Node.js 24.18.0';
    libraries: Readonly<Record<string, string>>;
    createdOn: string;
  }>;
}>;

export type LoadedCommittedPdfSuite = Readonly<{
  manifest: CommittedPdfSuiteManifest;
  pdfPath: string;
  pdfBytes: Uint8Array;
}>;

const EXPECTED_BOUNDS = Object.freeze({
  1: Object.freeze({ minimumBytes: 1, maximumBytes: 5_242_879 }),
  2: Object.freeze({ minimumBytes: 1, maximumBytes: 5_242_879 }),
  3: Object.freeze({ minimumBytes: 9_961_472, maximumBytes: 11_010_048 }),
} satisfies Record<SuiteNumber, Readonly<{ minimumBytes: number; maximumBytes: number }>>);

const APPROVED_NPM_FONT_FILES = Object.freeze(new Set([
  '@fontsource/open-sans/files/open-sans-latin-400-normal.woff',
  '@fontsource/open-sans/files/open-sans-latin-700-normal.woff',
  '@fontsource/open-sans/files/open-sans-latin-400-italic.woff',
  '@fontsource/merriweather/files/merriweather-latin-400-normal.woff',
  '@fontsource/source-code-pro/files/source-code-pro-latin-400-normal.woff',
]));

const APPROVED_COMMITTED_FONT_PATH = 'tests/fonts/mplus-1c-regular.ttf';
const APPROVED_COMMITTED_FONT_VERSION = '1.047';
const APPROVED_COMMITTED_FONT_SHA256 =
  '4e37946cb7290be6ecf0af041b76353d1654a8f98b22ced2d6304b136abc3ec8';

type ApprovedFontTuple = Readonly<{
  reason: CommittedPdfFont['reason'];
  weight: number;
  italic: boolean;
  source: CommittedFontSource;
  licence: string;
  fonts2uPage: string;
  searchUrl: string;
}>;

const APPROVED_FONT_TUPLES = Object.freeze({
  'Open Sans': Object.freeze({
    reason: 'embedded-not-reusable',
    weight: 400,
    italic: false,
    source: Object.freeze({
      kind: 'npm',
      package: '@fontsource/open-sans',
      version: '5.3.0',
      file: 'files/open-sans-latin-400-normal.woff',
      sha256: '8b3c81a3240d7c8cc9877cf5233d97051aa07730947217db840e500470a4d44a',
    }),
    licence: 'OFL-1.1',
    fonts2uPage: 'https://fonts2u.com/open-sans.font',
    searchUrl: 'https://fonts2u.com/search.html?q=Open+Sans',
  }),
  'Open Sans Bold': Object.freeze({
    reason: 'embedded-not-reusable',
    weight: 700,
    italic: false,
    source: Object.freeze({
      kind: 'npm',
      package: '@fontsource/open-sans',
      version: '5.3.0',
      file: 'files/open-sans-latin-700-normal.woff',
      sha256: '397ccaf840827f6c84ebadf664b6494338d4ea39440ab22811829868014c43f5',
    }),
    licence: 'OFL-1.1',
    fonts2uPage: 'https://fonts2u.com/open-sans-bold.font',
    searchUrl: 'https://fonts2u.com/search.html?q=Open+Sans+Bold',
  }),
  'Open Sans Italic': Object.freeze({
    reason: 'embedded-not-reusable',
    weight: 400,
    italic: true,
    source: Object.freeze({
      kind: 'npm',
      package: '@fontsource/open-sans',
      version: '5.3.0',
      file: 'files/open-sans-latin-400-italic.woff',
      sha256: 'fa8383f26e60a89f4eb956d2997b416d22023427100151438b42372718ca8231',
    }),
    licence: 'OFL-1.1',
    fonts2uPage: 'https://fonts2u.com/open-sans-italic.font',
    searchUrl: 'https://fonts2u.com/search.html?q=Open+Sans+Italic',
  }),
  'M+ 1c regular': Object.freeze({
    reason: 'embedded-not-reusable',
    weight: 400,
    italic: false,
    source: Object.freeze({
      kind: 'committed',
      path: APPROVED_COMMITTED_FONT_PATH,
      version: APPROVED_COMMITTED_FONT_VERSION,
      sha256: APPROVED_COMMITTED_FONT_SHA256,
    }),
    licence: 'M+ permissive font licence',
    fonts2uPage: 'https://fonts2u.com/m-1c-regular.font',
    searchUrl: 'https://fonts2u.com/search.html?q=M%2B+1c+regular',
  }),
  Merriweather: Object.freeze({
    reason: 'embedded-not-reusable',
    weight: 400,
    italic: false,
    source: Object.freeze({
      kind: 'npm',
      package: '@fontsource/merriweather',
      version: '5.3.0',
      file: 'files/merriweather-latin-400-normal.woff',
      sha256: '68f5bdf7a1f608fbcbdef6d9d9311491e79b3e39f94fc16b5798b805db67d89b',
    }),
    licence: 'OFL-1.1',
    fonts2uPage: 'https://fonts2u.com/merriweather.font',
    searchUrl: 'https://fonts2u.com/search.html?q=Merriweather',
  }),
  'Source Code Pro': Object.freeze({
    reason: 'embedded-not-reusable',
    weight: 400,
    italic: false,
    source: Object.freeze({
      kind: 'npm',
      package: '@fontsource/source-code-pro',
      version: '5.3.0',
      file: 'files/source-code-pro-latin-400-normal.woff',
      sha256: 'dec1d76f7d39a16026ab85376c3712c4a8182b4d9bca7a8ee1229ce8e43cf49a',
    }),
    licence: 'OFL-1.1',
    fonts2uPage: 'https://fonts2u.com/source-code-pro.font',
    searchUrl: 'https://fonts2u.com/search.html?q=Source+Code+Pro',
  }),
} satisfies Readonly<Record<string, ApprovedFontTuple>>);

const MANIFEST_KEYS = [
  'schemaVersion',
  'suite',
  'pdf',
  'sha256',
  'byteLength',
  'sizePolicy',
  'languages',
  'fonts',
  'edits',
  'contentAssertions',
  'generation',
] as const;

const FONT_KEYS = [
  'inventoryName',
  'reason',
  'weight',
  'italic',
  'source',
  'licence',
  'fonts2uPage',
  'searchUrl',
] as const;

const NPM_SOURCE_KEYS = ['kind', 'package', 'version', 'file', 'sha256'] as const;
const COMMITTED_SOURCE_KEYS = ['kind', 'path', 'version', 'sha256'] as const;
const EDIT_KEYS = [
  'language',
  'pageIndex',
  'sourceText',
  'replacementText',
  'fontInventoryName',
  'verifyAfterReopen',
] as const;
const SIZE_POLICY_KEYS = ['minimumBytes', 'maximumBytes'] as const;
const GENERATION_KEYS = [
  'synthetic',
  'oneTime',
  'seed',
  'runtime',
  'libraries',
  'createdOn',
] as const;

const ROUTINE_SUITES = Object.freeze([1] as const);
const FULL_SUITES = Object.freeze([1, 2, 3] as const);

function fail(suite: SuiteNumber | string | number, field: string, message: string): never {
  throw new Error(`Suite ${suite}: ${field} ${message}`);
}

function requireRecord(
  value: unknown,
  field: string,
  suite: SuiteNumber | string | number,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(suite, field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function requireArray(
  value: unknown,
  field: string,
  suite: SuiteNumber | string | number,
): unknown[] {
  if (!Array.isArray(value)) fail(suite, field, 'must be an array');
  return value as unknown[];
}

function requireString(
  value: unknown,
  field: string,
  suite: SuiteNumber | string | number,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(suite, field, 'must be a non-empty string');
  }
  return value;
}

function requireInteger(
  value: unknown,
  field: string,
  suite: SuiteNumber | string | number,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(suite, field, `must be an integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function requireBoolean(
  value: unknown,
  field: string,
  suite: SuiteNumber | string | number,
): boolean {
  if (typeof value !== 'boolean') fail(suite, field, 'must be a boolean');
  return value;
}

function requireSha256(
  value: unknown,
  field: string,
  suite: SuiteNumber | string | number,
): string {
  const hash = requireString(value, field, suite);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    fail(suite, field, 'must be 64 lowercase hexadecimal characters');
  }
  return hash;
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
  suite: SuiteNumber | string | number,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(suite, `${field}.${key}`, 'is an unknown field');
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail(suite, `${field}.${key}`, 'is required');
    }
  }
}

function isSuiteNumber(value: unknown): value is SuiteNumber {
  return value === 1 || value === 2 || value === 3;
}

function requireLanguage(
  value: unknown,
  field: string,
  suite: SuiteNumber | string | number,
): SuiteLanguage {
  if (value !== 'en' && value !== 'zh-Hans') fail(suite, field, 'must be en or zh-Hans');
  return value;
}

function hasUnsafePath(value: string): boolean {
  return value.includes('\\') || isAbsolute(value) || value.split('/').includes('..');
}

function requireFonts2uFacePage(value: unknown, field: string, suite: SuiteNumber): string {
  const text = requireString(value, field, suite);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    fail(suite, field, 'must be a valid Fonts2u URL');
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'fonts2u.com'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.pathname === '/search.html'
    || !url.pathname.endsWith('.font')
    || url.search !== ''
    || url.hash !== ''
  ) {
    fail(suite, field, 'must be an HTTPS Fonts2u face page');
  }
  return text;
}

function requireFonts2uSearchUrl(value: unknown, field: string, suite: SuiteNumber): string {
  const text = requireString(value, field, suite);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    fail(suite, field, 'must be a valid Fonts2u URL');
  }
  const queryKeys = [...url.searchParams.keys()];
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'fonts2u.com'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/search.html'
    || queryKeys.length !== 1
    || queryKeys[0] !== 'q'
    || url.searchParams.get('q') === ''
    || url.hash !== ''
  ) {
    fail(suite, field, 'must be an HTTPS Fonts2u search URL');
  }
  return text;
}

function parseFontSource(value: unknown, field: string, suite: SuiteNumber): CommittedFontSource {
  const source = requireRecord(value, field, suite);
  const kind = requireString(source.kind, `${field}.kind`, suite);

  if (kind === 'npm') {
    requireExactKeys(source, NPM_SOURCE_KEYS, field, suite);
    const packageName = requireString(source.package, `${field}.package`, suite);
    const version = requireString(source.version, `${field}.version`, suite);
    const file = requireString(source.file, `${field}.file`, suite);
    const sha256 = requireSha256(source.sha256, `${field}.sha256`, suite);
    if (version !== '5.3.0') fail(suite, `${field}.version`, 'must be 5.3.0');
    if (hasUnsafePath(file)) fail(suite, `${field}.file`, 'must be a safe relative path');
    if (!APPROVED_NPM_FONT_FILES.has(`${packageName}/${file}`)) {
      fail(suite, field, 'has an unapproved npm package/file pair');
    }
    return Object.freeze({
      kind: 'npm',
      package: packageName,
      version: '5.3.0',
      file,
      sha256,
    });
  }

  if (kind === 'committed') {
    requireExactKeys(source, COMMITTED_SOURCE_KEYS, field, suite);
    const path = requireString(source.path, `${field}.path`, suite);
    const version = requireString(source.version, `${field}.version`, suite);
    const sha256 = requireSha256(source.sha256, `${field}.sha256`, suite);
    if (hasUnsafePath(path)) fail(suite, `${field}.path`, 'must be a safe relative path');
    if (path !== APPROVED_COMMITTED_FONT_PATH) {
      fail(suite, `${field}.path`, `must be ${APPROVED_COMMITTED_FONT_PATH}`);
    }
    if (version !== APPROVED_COMMITTED_FONT_VERSION) {
      fail(suite, `${field}.version`, `must be ${APPROVED_COMMITTED_FONT_VERSION}`);
    }
    if (sha256 !== APPROVED_COMMITTED_FONT_SHA256) {
      fail(suite, `${field}.sha256`, 'does not match the approved committed font');
    }
    return Object.freeze({
      kind: 'committed',
      path: APPROVED_COMMITTED_FONT_PATH,
      version: APPROVED_COMMITTED_FONT_VERSION,
      sha256,
    });
  }

  fail(suite, `${field}.kind`, 'must be npm or committed');
}

function fontSourcesMatch(actual: CommittedFontSource, expected: CommittedFontSource): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === 'npm' && expected.kind === 'npm') {
    return actual.package === expected.package
      && actual.version === expected.version
      && actual.file === expected.file
      && actual.sha256 === expected.sha256;
  }
  if (actual.kind === 'committed' && expected.kind === 'committed') {
    return actual.path === expected.path
      && actual.version === expected.version
      && actual.sha256 === expected.sha256;
  }
  return false;
}

function parseFont(value: unknown, field: string, suite: SuiteNumber): CommittedPdfFont {
  const font = requireRecord(value, field, suite);
  requireExactKeys(font, FONT_KEYS, field, suite);
  const inventoryName = requireString(font.inventoryName, `${field}.inventoryName`, suite);
  const reason = requireString(font.reason, `${field}.reason`, suite);
  const weight = requireInteger(font.weight, `${field}.weight`, suite);
  const italic = requireBoolean(font.italic, `${field}.italic`, suite);
  const source = parseFontSource(font.source, `${field}.source`, suite);
  const licence = requireString(font.licence, `${field}.licence`, suite);
  const fonts2uPage = requireFonts2uFacePage(font.fonts2uPage, `${field}.fonts2uPage`, suite);
  const searchUrl = requireFonts2uSearchUrl(font.searchUrl, `${field}.searchUrl`, suite);

  if (reason !== 'embedded-not-reusable') {
    fail(suite, `${field}.reason`, 'must be embedded-not-reusable');
  }
  const approved = (APPROVED_FONT_TUPLES as Readonly<Record<string, ApprovedFontTuple>>)[
    inventoryName
  ];
  if (approved === undefined) {
    fail(suite, `${field}.inventoryName`, 'is not an approved inventory name');
  }
  if (
    reason !== approved.reason
    || weight !== approved.weight
    || italic !== approved.italic
    || !fontSourcesMatch(source, approved.source)
    || licence !== approved.licence
    || fonts2uPage !== approved.fonts2uPage
    || searchUrl !== approved.searchUrl
  ) {
    fail(suite, field, `must match the complete approved tuple for ${inventoryName}`);
  }

  return Object.freeze({
    inventoryName,
    reason: 'embedded-not-reusable',
    weight,
    italic,
    source,
    licence,
    fonts2uPage,
    searchUrl,
  });
}

function parseEdit(
  value: unknown,
  field: string,
  suite: SuiteNumber,
  languages: ReadonlySet<SuiteLanguage>,
  fontNames: ReadonlySet<string>,
  sourceTexts: Set<string>,
): CommittedPdfEdit {
  const edit = requireRecord(value, field, suite);
  requireExactKeys(edit, EDIT_KEYS, field, suite);
  const language = requireLanguage(edit.language, `${field}.language`, suite);
  const pageIndex = requireInteger(edit.pageIndex, `${field}.pageIndex`, suite);
  const sourceText = requireString(edit.sourceText, `${field}.sourceText`, suite);
  const replacementText = requireString(
    edit.replacementText,
    `${field}.replacementText`,
    suite,
  );
  const fontInventoryName = requireString(
    edit.fontInventoryName,
    `${field}.fontInventoryName`,
    suite,
  );
  const verifyAfterReopen = requireBoolean(
    edit.verifyAfterReopen,
    `${field}.verifyAfterReopen`,
    suite,
  );

  if (!languages.has(language)) fail(suite, `${field}.language`, 'is not declared in languages');
  if (sourceText === replacementText) {
    fail(suite, field, 'sourceText and replacementText must differ');
  }
  if (!fontNames.has(fontInventoryName)) {
    fail(suite, `${field}.fontInventoryName`, 'is not declared in fonts');
  }
  if (sourceTexts.has(sourceText)) fail(suite, `${field}.sourceText`, 'is duplicated');
  sourceTexts.add(sourceText);

  return Object.freeze({
    language,
    pageIndex,
    sourceText,
    replacementText,
    fontInventoryName,
    verifyAfterReopen,
  });
}

function parseGeneration(value: unknown, suite: SuiteNumber): CommittedPdfSuiteManifest['generation'] {
  const generation = requireRecord(value, 'generation', suite);
  requireExactKeys(generation, GENERATION_KEYS, 'generation', suite);
  const synthetic = requireBoolean(generation.synthetic, 'generation.synthetic', suite);
  const oneTime = requireBoolean(generation.oneTime, 'generation.oneTime', suite);
  const seed = requireString(generation.seed, 'generation.seed', suite);
  const runtime = requireString(generation.runtime, 'generation.runtime', suite);
  const librariesRecord = requireRecord(generation.libraries, 'generation.libraries', suite);
  const createdOn = requireString(generation.createdOn, 'generation.createdOn', suite);

  if (!synthetic) fail(suite, 'generation.synthetic', 'must be true');
  if (!oneTime) fail(suite, 'generation.oneTime', 'must be true');
  if (seed !== 'pdf-scrubber-committed-pdf-suites-v1') {
    fail(suite, 'generation.seed', 'must be pdf-scrubber-committed-pdf-suites-v1');
  }
  if (runtime !== 'Node.js 24.18.0') {
    fail(suite, 'generation.runtime', 'must be Node.js 24.18.0');
  }
  const createdDate = /^\d{4}-\d{2}-\d{2}$/.test(createdOn)
    ? new Date(`${createdOn}T00:00:00.000Z`)
    : null;
  if (
    createdDate === null
    || Number.isNaN(createdDate.getTime())
    || createdDate.toISOString().slice(0, 10) !== createdOn
  ) {
    fail(suite, 'generation.createdOn', 'must be an ISO calendar date');
  }

  const libraries: Record<string, string> = {};
  for (const [name, version] of Object.entries(librariesRecord)) {
    libraries[name] = requireString(version, `generation.libraries.${name}`, suite);
  }
  if (Object.keys(libraries).length === 0) fail(suite, 'generation.libraries', 'must not be empty');

  return Object.freeze({
    synthetic: true,
    oneTime: true,
    seed: 'pdf-scrubber-committed-pdf-suites-v1',
    runtime: 'Node.js 24.18.0',
    libraries: Object.freeze(libraries),
    createdOn,
  });
}

export function parseCommittedPdfManifest(
  value: unknown,
  expectedSuite: SuiteNumber,
): CommittedPdfSuiteManifest {
  if (!isSuiteNumber(expectedSuite)) {
    throw new Error(`Suite ${String(expectedSuite)}: expectedSuite must be 1, 2, or 3`);
  }

  const manifest = requireRecord(value, 'manifest', expectedSuite);
  requireExactKeys(manifest, MANIFEST_KEYS, 'manifest', expectedSuite);

  const schemaVersion = requireInteger(manifest.schemaVersion, 'schemaVersion', expectedSuite);
  const suite = requireInteger(manifest.suite, 'suite', expectedSuite);
  const pdf = requireString(manifest.pdf, 'pdf', expectedSuite);
  const sha256 = requireSha256(manifest.sha256, 'sha256', expectedSuite);
  const byteLength = requireInteger(manifest.byteLength, 'byteLength', expectedSuite, 1);
  const sizePolicy = requireRecord(manifest.sizePolicy, 'sizePolicy', expectedSuite);
  requireExactKeys(sizePolicy, SIZE_POLICY_KEYS, 'sizePolicy', expectedSuite);
  const minimumBytes = requireInteger(
    sizePolicy.minimumBytes,
    'sizePolicy.minimumBytes',
    expectedSuite,
    1,
  );
  const maximumBytes = requireInteger(
    sizePolicy.maximumBytes,
    'sizePolicy.maximumBytes',
    expectedSuite,
    1,
  );
  const languagesValue = requireArray(manifest.languages, 'languages', expectedSuite);
  const fontsValue = requireArray(manifest.fonts, 'fonts', expectedSuite);
  const editsValue = requireArray(manifest.edits, 'edits', expectedSuite);
  const contentAssertionsValue = requireArray(
    manifest.contentAssertions,
    'contentAssertions',
    expectedSuite,
  );

  if (schemaVersion !== 1) fail(expectedSuite, 'schemaVersion', 'must be 1');
  if (suite !== expectedSuite) fail(expectedSuite, 'suite', `must be ${expectedSuite}`);
  if (pdf !== 'document.pdf') fail(expectedSuite, 'pdf', 'must be document.pdf');

  const expectedBounds = EXPECTED_BOUNDS[expectedSuite];
  if (
    minimumBytes !== expectedBounds.minimumBytes
    || maximumBytes !== expectedBounds.maximumBytes
  ) {
    fail(
      expectedSuite,
      'sizePolicy',
      `must be ${expectedBounds.minimumBytes}..${expectedBounds.maximumBytes}`,
    );
  }
  if (byteLength < minimumBytes || byteLength > maximumBytes) {
    fail(expectedSuite, 'byteLength', 'must be within sizePolicy');
  }

  if (languagesValue.length === 0) fail(expectedSuite, 'languages', 'must not be empty');
  const languageValues: SuiteLanguage[] = [];
  const languages = new Set<SuiteLanguage>();
  for (const [index, languageValue] of languagesValue.entries()) {
    const language = requireLanguage(languageValue, `languages[${index}]`, expectedSuite);
    if (languages.has(language)) fail(expectedSuite, `languages[${index}]`, 'is duplicated');
    languages.add(language);
    languageValues.push(language);
  }

  if (fontsValue.length === 0) fail(expectedSuite, 'fonts', 'must not be empty');
  const fonts: CommittedPdfFont[] = [];
  const fontNames = new Set<string>();
  for (const [index, fontValue] of fontsValue.entries()) {
    const font = parseFont(fontValue, `fonts[${index}]`, expectedSuite);
    if (fontNames.has(font.inventoryName)) {
      fail(expectedSuite, `fonts[${index}].inventoryName`, 'is duplicated');
    }
    fontNames.add(font.inventoryName);
    fonts.push(font);
  }

  if (editsValue.length === 0) fail(expectedSuite, 'edits', 'must not be empty');
  const edits: CommittedPdfEdit[] = [];
  const sourceTexts = new Set<string>();
  for (const [index, editValue] of editsValue.entries()) {
    edits.push(parseEdit(
      editValue,
      `edits[${index}]`,
      expectedSuite,
      languages,
      fontNames,
      sourceTexts,
    ));
  }

  if (expectedSuite === 3) {
    if (!languages.has('en') || !languages.has('zh-Hans')) {
      fail(expectedSuite, 'languages', 'must include en and zh-Hans');
    }
    if (!edits.some(({ language }) => language === 'en')) {
      fail(expectedSuite, 'edits', 'must include an English edit');
    }
    if (!edits.some(({ language }) => language === 'zh-Hans')) {
      fail(expectedSuite, 'edits', 'must include a zh-Hans edit');
    }
  }

  const contentAssertions: string[] = [];
  for (const [index, assertionValue] of contentAssertionsValue.entries()) {
    contentAssertions.push(requireString(
      assertionValue,
      `contentAssertions[${index}]`,
      expectedSuite,
    ));
  }
  if (contentAssertions.length === 0) {
    fail(expectedSuite, 'contentAssertions', 'must not be empty');
  }

  const generation = parseGeneration(manifest.generation, expectedSuite);

  const parsedSizePolicy = Object.freeze({ minimumBytes, maximumBytes });
  return Object.freeze({
    schemaVersion: 1,
    suite: expectedSuite,
    pdf: 'document.pdf',
    sha256,
    byteLength,
    sizePolicy: parsedSizePolicy,
    languages: Object.freeze(languageValues),
    fonts: Object.freeze(fonts),
    edits: Object.freeze(edits),
    contentAssertions: Object.freeze(contentAssertions),
    generation,
  });
}

export function verifyCommittedPdfBytes(
  bytes: Uint8Array,
  manifest: CommittedPdfSuiteManifest,
): void {
  const signature = new TextDecoder().decode(bytes.subarray(0, 5));
  if (signature !== '%PDF-') {
    fail(manifest.suite, 'PDF signature', 'must begin with %PDF-');
  }
  if (bytes.byteLength !== manifest.byteLength) {
    fail(
      manifest.suite,
      'byte length',
      `expected ${manifest.byteLength}, received ${bytes.byteLength}`,
    );
  }
  if (
    bytes.byteLength < manifest.sizePolicy.minimumBytes
    || bytes.byteLength > manifest.sizePolicy.maximumBytes
  ) {
    fail(
      manifest.suite,
      'size policy',
      `requires ${manifest.sizePolicy.minimumBytes}..${manifest.sizePolicy.maximumBytes} bytes`,
    );
  }
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== manifest.sha256) {
    fail(manifest.suite, 'SHA-256', `expected ${manifest.sha256}, received ${actualSha256}`);
  }
}

export function loadCommittedPdfSuite(suite: SuiteNumber): LoadedCommittedPdfSuite {
  if (!isSuiteNumber(suite)) throw new Error(`Suite ${String(suite)}: invalid suite number`);
  const directory = resolve(`tests/${suite}`);
  const manifestPath = resolve(directory, 'manifest.json');
  const pdfPath = resolve(directory, 'document.pdf');
  const manifestText = readFileSync(manifestPath, 'utf8');
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText) as unknown;
  } catch (error) {
    throw new Error(`Suite ${suite}: manifest JSON is invalid`, { cause: error });
  }
  const manifest = parseCommittedPdfManifest(manifestValue, suite);
  const sourceBytes = readFileSync(pdfPath);
  verifyCommittedPdfBytes(sourceBytes, manifest);
  const pdfBytes = new Uint8Array(sourceBytes);

  return Object.freeze({ manifest, pdfPath, pdfBytes });
}

function resolveFontSource(font: CommittedPdfFont): { path: string; sha256: string } {
  const source = font.source;
  if (source.kind === 'npm') {
    if (source.version !== '5.3.0' || hasUnsafePath(source.file)) {
      throw new Error('Font source path is not safe');
    }
    if (!APPROVED_NPM_FONT_FILES.has(`${source.package}/${source.file}`)) {
      throw new Error('Font source package/file pair is not approved');
    }
    return {
      path: resolve('node_modules', source.package, source.file),
      sha256: source.sha256,
    };
  }
  if (source.kind === 'committed') {
    if (
      source.path !== APPROVED_COMMITTED_FONT_PATH
      || source.version !== APPROVED_COMMITTED_FONT_VERSION
      || source.sha256 !== APPROVED_COMMITTED_FONT_SHA256
      || hasUnsafePath(source.path)
    ) {
      throw new Error('Committed font source is not approved');
    }
    return { path: resolve(source.path), sha256: source.sha256 };
  }
  throw new Error('Font source kind is not approved');
}

export function resolveCommittedFontPath(font: CommittedPdfFont): string {
  const { path, sha256 } = resolveFontSource(font);
  const actualSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actualSha256 !== sha256) {
    throw new Error(`Font source SHA-256 mismatch for ${path}`);
  }
  return path;
}

export function selectedCommittedPdfSuites(mode: string | undefined): readonly SuiteNumber[] {
  return mode === 'full' ? FULL_SUITES : ROUTINE_SUITES;
}
