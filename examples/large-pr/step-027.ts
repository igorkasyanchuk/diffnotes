// Step 27 of a long checkout pipeline: one small invoice rule per file, so this PR touches 100 files.
// Reviews42 test: notes on the first and the last files must still appear when GitHub loads the diff lazily.
export const STEP = 27

export function invoiceStep027(cents: number): number {
  if (!Number.isFinite(cents) || cents < 0) throw new Error('step 27: bad amount')
  return Math.round(cents * 1.027)
}
