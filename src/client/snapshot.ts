export const COPY_BYTES = 64 * 1024, COPY_LINES = 200;
export interface Snapshot { text: string; truncated: boolean; source: 'visible' | 'recent' | 'selection' }
export function boundedText(value: string, source: Snapshot['source']): Snapshot {
  // Bound characters before allocating a UTF-8 copy, then keep only whole scalars.
  let prefix = value.slice(0, COPY_BYTES).split('\n').slice(0, COPY_LINES).join('\n');
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  const bytes = new TextEncoder().encode(prefix);
  let end = Math.min(bytes.length, COPY_BYTES);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: prefix.length < value.length || end < bytes.length, source };
}
