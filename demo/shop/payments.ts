// A stand-in for the payment provider's SDK.
export async function charge(card: string, cents: number) {
  if (!card) throw new Error('No card on file')
  return { id: `ch_${Date.now()}`, cents }
}
