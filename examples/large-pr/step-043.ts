// Step 43 of a long checkout pipeline: one small discount rule per file, so this PR touches 100 files.
// Reviews42 test: notes on the first and the last files must still appear when GitHub loads the diff lazily.
export const STEP = 43

export function discountStep043(cents: number): number {
  if (!Number.isFinite(cents) || cents < 0) throw new Error('step 43: bad amount')
  return Math.round(cents * 1.043)
}
