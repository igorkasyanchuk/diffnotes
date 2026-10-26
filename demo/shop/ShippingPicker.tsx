import { EXPRESS_FEE } from './checkout'

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export function ShippingPicker({ express, onChange }: { express: boolean; onChange: (express: boolean) => void }) {
  return <fieldset className="shipping">
    <legend>Shipping</legend>
    <label><input type="radio" checked={!express} onChange={() => onChange(false)} /> Standard · 3–5 days · free</label>
    <label><input type="radio" checked={express} onChange={() => onChange(true)} /> Express · tomorrow · {money(EXPRESS_FEE)}</label>
  </fieldset>
}
