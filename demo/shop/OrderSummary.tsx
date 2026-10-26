import type { Cart } from './checkout'
import { sum } from './checkout'

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export function OrderSummary({ cart }: { cart: Cart }) {
  return <section className="summary">
    {cart.items.map((i) => <div key={i.name} className="row"><span>{i.qty} × {i.name}</span><span>{money(i.cents * i.qty)}</span></div>)}
    <div className="row total"><span>Total</span><span>{money(sum(cart.items))}</span></div>
    <button className="pay">Pay {money(sum(cart.items))}</button>
  </section>
}
