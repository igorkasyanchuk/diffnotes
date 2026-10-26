import { useState } from 'react'
import type { Cart } from './checkout'
import { EXPRESS_FEE, totalOf } from './checkout'
import { flags } from './flags'
import { ShippingPicker } from './ShippingPicker'

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export function OrderSummary({ cart }: { cart: Cart }) {
  const [express, setExpress] = useState(false)
  const total = totalOf({ ...cart, express })
  return <section className="summary">
    {cart.items.map((i) => <div key={i.name} className="row"><span>{i.qty} × {i.name}</span><span>{money(i.cents * i.qty)}</span></div>)}
    {flags.express && <ShippingPicker express={express} onChange={setExpress} />}
    {express && <div className="row"><span>Express shipping</span><span>{money(EXPRESS_FEE)}</span></div>}
    <div className="row total"><span>Total</span><span>{money(total)}</span></div>
    <button className="pay">Pay {money(total)}</button>
  </section>
}
