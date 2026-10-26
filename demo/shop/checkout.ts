import { charge } from './payments'

export type Item = { name: string; cents: number; qty: number }
export type Cart = { items: Item[]; card: string }

export const sum = (items: Item[]) => items.reduce((total, i) => total + i.cents * i.qty, 0)

export async function checkout(cart: Cart) {
  const total = sum(cart.items)
  if (total > 0) await charge(cart.card, total)
  return { status: 'paid', total }
}
