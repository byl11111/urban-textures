import { clamp } from './math.js'

export const IMAGE_LIMIT = 36 * 1024 * 1024
export const MAX_PIXELS = 48_000_000
const ANALYSIS_EDGE = 440
const OUTPUT_EDGE = 1536

export async function decodeImage(file) {
  if (!file.size || file.size > IMAGE_LIMIT) throw Error('请选择 36 MB 以内的图片。')
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    try { await image.decode() }
    catch { throw Error('无法读取图片。请试用 JPEG、PNG、WebP 或 AVIF。') }
    if (image.naturalWidth * image.naturalHeight > MAX_PIXELS) throw Error('图片像素超过 4800 万。请缩小后再导入。')
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

function resized(source, edge) {
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height
  const scale = Math.min(edge / Math.max(sw, sh), source instanceof HTMLImageElement ? 1 : 2)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: edge === ANALYSIS_EDGE })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return { canvas, ctx }
}

function integral(values, width, height) {
  const stride = width + 1, sum = new Float64Array(stride * (height + 1))
  for (let y = 0; y < height; y++) {
    let row = 0
    for (let x = 0; x < width; x++) {
      row += values[y * width + x]
      const p = (y + 1) * stride + x + 1
      sum[p] = row + sum[p - stride]
    }
  }
  return sum
}

export function analyzeImage(source) {
  const original = resized(source, OUTPUT_EDGE).canvas
  const { canvas, ctx } = resized(original, ANALYSIS_EDGE)
  const { width: w, height: h } = canvas
  const { data } = ctx.getImageData(0, 0, w, h)
  const n = w * h, stride = w + 1
  const luma = new Float32Array(n), red = new Float32Array(n), green = new Float32Array(n), blue = new Float32Array(n)
  const alpha = new Float32Array(n), detail = new Float32Array(n)
  const xx = new Float32Array(n), yy = new Float32Array(n), xy = new Float32Array(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    const p = i * 4, a = data[p + 3] / 255
    alpha[i] = a
    red[i] = data[p] * a
    green[i] = data[p + 1] * a
    blue[i] = data[p + 2] * a
    luma[i] = (0.2126 * red[i] + 0.7152 * green[i] + 0.0722 * blue[i]) / 255
    total += a
  }
  if (total <= 0) throw Error('图片完全透明。请选择含有可见内容的图片。')
  const at = (x, y) => luma[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const topL = at(x - 1, y - 1), topR = at(x + 1, y - 1)
      const bottomL = at(x - 1, y + 1), bottomR = at(x + 1, y + 1)
      const gx = (topR + bottomR - topL - bottomL + 2 * (at(x + 1, y) - at(x - 1, y))) / 4
      const gy = (bottomR + bottomL - topR - topL + 2 * (at(x, y + 1) - at(x, y - 1))) / 4
      const left = y * w + Math.max(0, x - 1), right = y * w + Math.min(w - 1, x + 1)
      const top = Math.max(0, y - 1) * w + x, bottom = Math.min(h - 1, y + 1) * w + x
      const greenX = green[right] - green[left], greenY = green[bottom] - green[top]
      const rx = (red[right] - red[left] - greenX) / 680, ry = (red[bottom] - red[top] - greenY) / 680
      const bx = (blue[right] - blue[left] - greenX) / 680, by = (blue[bottom] - blue[top] - greenY) / 680
      xx[i] = gx * gx + rx * rx + bx * bx
      yy[i] = gy * gy + ry * ry + by * by
      xy[i] = gx * gy + rx * ry + bx * by
      detail[i] = Math.sqrt(xx[i] + yy[i])
    }
  }
  const [R, G, B, A, L, L2, E, X, Y, Z] = [red, green, blue, alpha, luma, luma.map(v => v * v), detail, xx, yy, xy]
    .map(values => integral(values, w, h))
  function region(x0, y0, x1, y1) {
    const left = clamp(Math.floor(x0), 0, w - 1), top = clamp(Math.floor(y0), 0, h - 1)
    const right = clamp(Math.ceil(x1), left + 1, w), bottom = clamp(Math.ceil(y1), top + 1, h)
    const lt = top * stride + left, rt = top * stride + right
    const lb = bottom * stride + left, rb = bottom * stride + right
    const sum = m => m[rb] - m[lb] - m[rt] + m[lt]
    const size = (bottom - top) * (right - left)
    const opacity = sum(A), weight = Math.max(opacity, 0.0001)
    const lum = sum(L) / weight
    const contrast = Math.sqrt(Math.max(0, sum(L2) / size - (sum(L) / size) ** 2))
    const jx = sum(X), jy = sum(Y), cross = 2 * sum(Z)
    const coherence = Math.hypot(jx - jy, cross) / (jx + jy + 0.000001)
    const edge = sum(E) / size
    return { color: [sum(R) / weight, sum(G) / weight, sum(B) / weight], alpha: opacity / size, lum,
      contrast, edge, coherence, angle: 0.5 * Math.atan2(cross, jx - jy) + Math.PI / 2 }
  }
  const field = (x, y, r = 2) => region(x - r, y - r, x + r, y + r)
  return { w, h, original, region, field }
}

