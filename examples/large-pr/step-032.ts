// Step 32 of a long checkout pipeline: one small tax rule per file, so this PR touches 100 files.
// Reviews42 test: notes on the first and the last files must still appear when GitHub loads the diff lazily.
export const STEP = 32

export function taxStep032(cents: number): number {
  if (!Number.isFinite(cents) || cents < 0) throw new Error('step 32: bad amount')
  return Math.round(cents * 1.032)
}
