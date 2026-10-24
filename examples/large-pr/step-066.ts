// Step 66 of a long checkout pipeline: one small refund rule per file, so this PR touches 100 files.
// Reviews42 test: notes on the first and the last files must still appear when GitHub loads the diff lazily.
export const STEP = 66

export function refundStep066(cents: number): number {
  if (!Number.isFinite(cents) || cents < 0) throw new Error('step 66: bad amount')
  return Math.round(cents * 1.066)
}
