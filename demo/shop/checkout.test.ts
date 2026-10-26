import { expect, it } from 'vitest'
import { EXPRESS_FEE, sum, totalOf } from './checkout'

it('adds the express fee only when picked', () => {
  const cart = { items: [{ name: 'mug', cents: 1200, qty: 2 }], card: 'tok' }
  expect(sum(cart.items)).toBe(2400)
  expect(totalOf({ ...cart, express: false })).toBe(2400)
  expect(totalOf({ ...cart, express: true })).toBe(2400 + (process.env.EXPRESS_SHIPPING === '1' ? EXPRESS_FEE : 0))
})
