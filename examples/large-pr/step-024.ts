// Step 24 of a long checkout pipeline: one small shipping rule per file, so this PR touches 100 files.
// Reviews42 test: notes on the first and the last files must still appear when GitHub loads the diff lazily.
export const STEP = 24

export function shippingStep024(cents: number): number {
  if (!Number.isFinite(cents) || cents < 0) throw new Error('step 24: bad amount')
  return Math.round(cents * 1.024)
}
