export type ParsedToUnicodeCMap = Readonly<{
  codeLengths: readonly number[];
  decode(code: Uint8Array): string | null;
}>;

const MAX_MAPPINGS = 65_536;

function malformed(message: string): never {
  throw new Error(`Malformed ToUnicode CMap: ${message}`);
}

function normaliseHex(token: string): string {
  if (!token.startsWith('<') || !token.endsWith('>')) {
    malformed(`expected a hexadecimal string, received ${token}`);
  }
  const value = token.slice(1, -1).replaceAll(/\s/g, '').toUpperCase();
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9A-F]+$/.test(value)) {
    malformed(`invalid hexadecimal string ${token}`);
  }
  return value;
}

function parseSourceHex(token: string): string {
  const value = normaliseHex(token);
  if (value.length > 8) {
    malformed('source code must contain between one and four bytes');
  }
  return value;
}

function utf16(hex: string): string {
  if (hex.length % 4 !== 0) malformed(`UTF-16 value has an invalid length: ${hex}`);
  let result = '';
  for (let offset = 0; offset < hex.length; offset += 4) {
    const unit = Number.parseInt(hex.slice(offset, offset + 4), 16);
    if (offset === 0 && unit === 0xfeff) continue;
    result += String.fromCharCode(unit);
  }
  return result;
}

function incrementHex(hex: string, offset: bigint): string {
  const value = BigInt(`0x${hex}`) + offset;
  const maximum = 1n << BigInt(hex.length * 4);
  if (value >= maximum) malformed(`sequential destination overflows ${hex.length / 2} bytes`);
  return value.toString(16).padStart(hex.length, '0').toUpperCase();
}

function tokenize(source: string): string[] {
  const withoutComments = source.replaceAll(/%[^\r\n]*/g, ' ');
  return withoutComments.match(/<[^>]*>|\[|\]|-?\d+|[^\s<>\[\]]+/g) ?? [];
}

function bytesKey(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0').toUpperCase())
    .join('');
}

export function parseToUnicodeCMap(
  bytes: Uint8Array,
): ParsedToUnicodeCMap {
  const tokens = tokenize(new TextDecoder('ascii').decode(bytes));
  const mappings = new Map<string, string>();
  const codeLengths = new Set<number>();

  const addMapping = (sourceHex: string, destinationHex: string): void => {
    if (mappings.size >= MAX_MAPPINGS && !mappings.has(sourceHex)) {
      malformed(`mapping count exceeds ${MAX_MAPPINGS}`);
    }
    mappings.set(sourceHex, utf16(destinationHex));
    codeLengths.add(sourceHex.length / 2);
  };

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const countToken = tokens[index]!;
    const operator = tokens[index + 1]!;
    if (!/^\d+$/.test(countToken)) continue;
    const count = Number.parseInt(countToken, 10);
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_MAPPINGS) {
      malformed(`invalid entry count ${countToken}`);
    }
    let cursor = index + 2;

    if (operator === 'begincodespacerange') {
      for (let entry = 0; entry < count; entry += 1) {
        const first = parseSourceHex(tokens[cursor++] ?? '');
        const last = parseSourceHex(tokens[cursor++] ?? '');
        if (first.length !== last.length) malformed('codespace endpoints differ in length');
        codeLengths.add(first.length / 2);
      }
      if (tokens[cursor] !== 'endcodespacerange') malformed('missing endcodespacerange');
      index = cursor;
      continue;
    }

    if (operator === 'beginbfchar') {
      for (let entry = 0; entry < count; entry += 1) {
        const sourceHex = parseSourceHex(tokens[cursor++] ?? '');
        const destinationHex = normaliseHex(tokens[cursor++] ?? '');
        addMapping(sourceHex, destinationHex);
      }
      if (tokens[cursor] !== 'endbfchar') malformed('missing endbfchar');
      index = cursor;
      continue;
    }

    if (operator !== 'beginbfrange') continue;
    for (let entry = 0; entry < count; entry += 1) {
      const firstHex = parseSourceHex(tokens[cursor++] ?? '');
      const lastHex = parseSourceHex(tokens[cursor++] ?? '');
      if (firstHex.length !== lastHex.length) malformed('range endpoints differ in length');
      const first = BigInt(`0x${firstHex}`);
      const last = BigInt(`0x${lastHex}`);
      if (last < first) malformed('range endpoint precedes its start');
      const rangeLength = last - first + 1n;
      if (rangeLength > BigInt(MAX_MAPPINGS) || rangeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        malformed(`range exceeds ${MAX_MAPPINGS} mappings`);
      }
      const destination = tokens[cursor++] ?? '';
      if (destination === '[') {
        for (let offset = 0; offset < Number(rangeLength); offset += 1) {
          const destinationHex = normaliseHex(tokens[cursor++] ?? '');
          addMapping(incrementHex(firstHex, BigInt(offset)), destinationHex);
        }
        if (tokens[cursor++] !== ']') malformed('array bfrange length does not match source range');
      } else {
        const destinationHex = normaliseHex(destination);
        for (let offset = 0; offset < Number(rangeLength); offset += 1) {
          addMapping(
            incrementHex(firstHex, BigInt(offset)),
            incrementHex(destinationHex, BigInt(offset)),
          );
        }
      }
    }
    if (tokens[cursor] !== 'endbfrange') malformed('missing endbfrange');
    index = cursor;
  }

  const supportedLengths = Object.freeze([...codeLengths].sort((left, right) => left - right));
  return Object.freeze({
    codeLengths: supportedLengths,
    decode(code: Uint8Array): string | null {
      if (!supportedLengths.includes(code.length)) return null;
      return mappings.get(bytesKey(code)) ?? null;
    },
  });
}
