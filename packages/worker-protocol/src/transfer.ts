import type { EngineRequest, EngineResponse } from './messages';

export function transferListForRequest(request: EngineRequest): Transferable[] {
  if (request.operation === 'openDocument' || request.operation === 'registerFont') {
    return [request.payload.bytes];
  }
  if (request.operation === 'exportPositionedImages') {
    return [...new Set(request.payload.images.flatMap(({ bytes }) =>
      bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? [bytes.buffer]
        : []))];
  }
  return [];
}

export function transferListForResponse(
  response: EngineResponse,
): Transferable[] {
  return response.ok && (
    response.operation === 'exportDocument' ||
    response.operation === 'exportPositionedImages'
  )
    ? [response.value.bytes]
    : [];
}
