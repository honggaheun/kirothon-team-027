// Counterexample record file name for a full requirement ID. // [guard-core:R4.1]

/** `signup:R2.3` -> `signup__R2.3.json`. */
export function runFileName(id: string): string {
  return id.replace(/:/g, '__') + '.json';
}
