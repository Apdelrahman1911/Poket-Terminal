export class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function assertValue(condition: unknown, status: number, code: string): asserts condition {
  if (!condition) throw new HttpError(status, code);
}
