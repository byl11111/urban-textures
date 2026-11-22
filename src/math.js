export const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x))
export const mix = (a, b, t) => a + (b - a) * t
export const follow = (a, b, dt, tau) => mix(a, b, 1 - Math.exp(-dt / tau))
export const TAU = Math.PI * 2

export function hash(x) {
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

export function rng(seed) {
  let i = seed | 0
  return () => hash(++i)
}

export function noise(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const tx = x - ix, ty = y - iy
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
  const key = ix * 37871 + iy * 7723 + seed
  return mix(mix(hash(key), hash(key + 37871), sx), mix(hash(key + 7723), hash(key + 45594), sx), sy)
}

