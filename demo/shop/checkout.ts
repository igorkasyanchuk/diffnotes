import { flags } from './flags'
import { charge } from './payments'

export type Item = { name: string; cents: number; qty: number }
export type Cart = { items: Item[]; card: string; express?: boolean }

export const EXPRESS_FEE = 990 // cents, flat per order

export const sum = (items: Item[]) => items.reduce((total, i) => total + i.cents * i.qty, 0)

// what the customer pays: the items, plus the express fee when they picked it and the flag is on
export const totalOf = (cart: Cart) => sum(cart.items) + (cart.express && flags.express ? EXPRESS_FEE : 0)

export async function checkout(cart: Cart) {
  if (!cart.items.length) return { status: 'empty', total: 0 }
  const total = totalOf(cart)
  await charge(cart.card, total)
  return { status: 'paid', total, express: !!(cart.express && flags.express) }
}
