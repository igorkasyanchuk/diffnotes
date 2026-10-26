// Feature flags, read once at boot.
export const flags = {
  express: process.env.EXPRESS_SHIPPING === '1',
}
