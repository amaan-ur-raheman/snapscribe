/**
 * Base64-encode bytes for a data URL. Chunked so large captures don't blow
 * the call stack building one giant String.fromCharCode(...) argument list.
 * Works in service workers and pages alike (no DOM needed).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
