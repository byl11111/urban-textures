import { clamp, hash, mix, noise, TAU } from './math.js'

export const imageDemos = ['粗粝墙面', '重复立面', '水面光影', '细密织物']
export const soundDemos = ['持续低频', '细碎噪声', '短促敲击', '缓慢起伏']

export function demoImage(id) {
  const canvas = document.createElement('canvas')
  const w = canvas.width = 768, h = canvas.height = 576
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h, i = y * w + x
      const cloud = noise(u * 8, v * 7, 51)
      const grit = (hash(i + 472) - 0.5) * 24
      let rgb, shade
      if (id === 0) {
        const rx = u + 0.23 * (v - 0.5)
        const fractures = noise(u * 11, v * 13, 661) * 0.13 + noise(u * 28, v * 25, 671) * 0.035
        const paint = rx + fractures
        const cut = v + 0.1 * u + 0.052 * Math.sin(u * 9)
        rgb = paint < 0.36 ? [25, 41, 84] : paint < 0.68 ? [52, 110, 181] : [135, 186, 168]
        if (cut < 0.29 && paint > 0.29 && paint < 0.81) rgb = [202, 216, 172]
        if (cut > 0.77 && paint > 0.48) rgb = paint < 0.82 ? [59, 77, 116] : [185, 173, 94]
        if (Math.abs(cut - 0.53 - 0.058 * Math.sin(u * 11)) < 0.007) rgb = [24, 36, 56]
        if (Math.abs(paint - 0.68) < 0.015 || (noise(u * 45, v * 39, 341) > 0.78 && paint > 0.36)) rgb = [191, 211, 176]
        shade = (cloud - 0.5) * 53 + (noise(u * 94, v * 78, 771) - 0.5) * 40 + grit
      } else if (id === 1) {
        const a = (u + 0.26 * v) * 11
        const b = (v - 0.08 * u) * 10 + 1
        const column = Math.floor(a), row = Math.floor(b)
        const ax = a - column, by = b - row
        rgb = ax < 0.12 || by < 0.13 ? [185, 176, 142] : ax < 0.21 || by < 0.21 ? [47, 53, 50] :
          hash(column + row * 33) > 0.69 ? [176, 116, 59] : [68, 93, 98]
        shade = (cloud - 0.5) * 27 + 19 * (0.5 - ax) + grit * 0.4
      } else if (id === 2) {
        const wave = Math.sin(v * 92 + 2.9 * Math.sin(u * 17 + v * 12) + 5 * cloud)
        const glint = Math.pow(clamp(wave), 7) * (0.15 + 0.85 * cloud)
        const current = noise(u * 9, v * 37, 43)
        rgb = [mix(18, 201, glint), mix(48, 197, glint), mix(57, 145, glint)]
        shade = (current - 0.55) * 43 + grit * 0.35
      } else {
        const warp = u * 103 + 2 * Math.sin(v * 7)
        const weft = v * 83 + 1.2 * Math.sin(u * 8)
        const top = (Math.floor(warp) + Math.floor(weft)) % 2 === 0
        const ridge = Math.sin(Math.PI * (top ? warp % 1 : weft % 1))
        rgb = u + 0.36 * v < 0.57 ? [146, 104, 123] : v < 0.48 ? [194, 168, 132] : [85, 100, 121]
        shade = 75 * (ridge - 0.6) + (cloud - 0.5) * 31 + grit * 0.6
      }
      const light = 0.88 + 0.15 * (1 - v) + 0.1 * Math.sin(u * 4)
      for (let k = 0; k < 3; k++) image.data[i * 4 + k] = rgb[k] * light + shade
      image.data[i * 4 + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

export function demoSound(id) {
  const rate = 24000, seconds = 10, length = rate * seconds
  const data = new DataView(new ArrayBuffer(44 + length * 2))
  const tag = (offset, value) => [...value].forEach((c, i) => data.setUint8(offset + i, c.charCodeAt(0)))
  const u32 = (i, n) => data.setUint32(i, n, true)
  const u16 = (i, n) => data.setUint16(i, n, true)
  tag(0, 'RIFF')
  u32(4, data.byteLength - 8)
  tag(8, 'WAVEfmt ')
  u32(16, 16)
  u16(20, 1)
  u16(22, 1)
  u32(24, rate)
  u32(28, rate * 2)
  u16(32, 2)
  u16(34, 16)
  tag(36, 'data')
  u32(40, length * 2)
  let previous = 0
  for (let i = 0; i < length; i++) {
    const t = i / rate
    const white = hash(i + 788) * 2 - 1
    const high = white - previous
    previous = white
    let value
    if (id === 0) value = 0.28 * Math.sin(t * TAU * 58) + 0.07 * Math.sin(t * TAU * 92)
    else if (id === 1) value = 0.24 * high * (0.23 + 0.77 * noise(t * 22, 0.4, 72))
    else if (id === 2) {
      const beat = Math.floor(t / 0.56), pulse = (t % 0.56)
      value = (0.2 + hash(beat + 87) * 0.8) * (0.53 * Math.sin(pulse * TAU * (140 - pulse * 125)) * Math.exp(-pulse * 22) +
        0.25 * white * Math.exp(-pulse * 95))
    } else {
      const swell = Math.pow(0.5 + 0.5 * Math.sin(t * 1.85 - 1), 1.6)
      value = (0.14 * Math.sin(t * TAU * 126) + 0.065 * Math.sin(t * TAU * 189) + 0.04 * white) * (0.07 + swell)
    }
    const fade = Math.min(1, t / 0.018, (seconds - t) / 0.09)
    data.setInt16(44 + i * 2, clamp(value * fade, -1, 1) * 32767, true)
  }
  return new Blob([data.buffer], { type: 'audio/wav' })
}

