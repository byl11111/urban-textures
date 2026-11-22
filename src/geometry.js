import { clamp, mix, rng } from './math.js'

export const FORMS = ['square', 'rect', 'bar', 'cross', 'circle', 'ring', 'rings', 'squares']
const cache = new WeakMap()
const luminance = ([r, g, b]) => (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255
const norm = (r, g, b) => Math.hypot(r, g, b)
const linear = Array.from({ length: 256 }, (_, x) => x <= 10 ? x / 3294.6 : ((x / 255 + 0.055) / 1.055) ** 2.4)

function perceptual(rgb) {
  const [r, g, b] = rgb.map(v => linear[Math.round(clamp(v, 0, 255))])
  const a = Math.cbrt(0.41222 * r + 0.53633 * g + 0.05145 * b)
  const c = Math.cbrt(0.21190 * r + 0.68070 * g + 0.10740 * b)
  const d = Math.cbrt(0.08830 * r + 0.28172 * g + 0.62998 * b)
  return [0.21045 * a + 0.79362 * c - 0.00407 * d,
    1.97799 * a - 2.42859 * c + 0.45060 * d, 0.02590 * a + 0.78277 * c - 0.80867 * d]
}

function lattice(image) {
  if (cache.has(image)) return cache.get(image)
  const pitch = Math.max(image.w, image.h) / 70
  const nx = Math.max(2, Math.round(image.w / pitch)), ny = Math.max(2, Math.round(image.h / pitch))
  const sx = image.w / nx, sy = image.h / ny
  const points = [], links = []
  const link = (i, j) => {
    const a = points[i], b = points[j]
    if (a.alpha < 0.025 || b.alpha < 0.025) return
    const c = a.lab, d = b.lab
    const gap = norm((c[0] - d[0]) * 0.89, (c[1] - d[1]) * 1.45, (c[2] - d[2]) * 1.45)
    links.push({ i, j, gap, score: gap + Math.abs(a.alpha - b.alpha) * 0.10 + (a.edge + b.edge) * 0.023 })
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const f = image.region(i * sx, j * sy, (i + 1) * sx, (j + 1) * sy)
    points.push({ ...f, x: i, y: j, lab: perceptual(f.color) })
    const index = j * nx + i
    if (i) link(index, index - 1)
    if (j) link(index, index - nx)
  }
  links.sort((a, b) => a.score - b.score)
  const tones = points.filter(p => p.alpha >= 0.025).map(p => p.lab[0]).sort((a, b) => a - b)
  const percent = p => tones[Math.round((tones.length - 1) * p)] ?? 0.5
  const data = { nx, ny, sx, sy, points, links, black: percent(0.035), white: percent(0.975) }
  cache.set(image, data)
  return data
}

function regions(map, abstraction, scale) {
  const { points, links } = map
  const parent = points.map((_, i) => i)
  const size = points.map(() => 1)
  const mean = points.map(p => p.lab.slice())
  const root = i => {
    while (i !== parent[i]) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  function join(a, b) {
    if (size[b] > size[a]) [a, b] = [b, a]
    const t = size[b] / (size[a] + size[b])
    for (let k = 0; k < 3; k++) mean[a][k] = mix(mean[a][k], mean[b][k], t)
    size[a] += size[b]
    parent[b] = a
  }
  const limit = points.length * mix(0.13, 0.38, abstraction) * Math.sqrt(scale)
  const tolerance = mix(0.041, 0.106, abstraction)
  for (const { i, j, gap } of links) {
    if (gap > tolerance * 1.24) continue
    const a = root(i), b = root(j)
    if (a === b || size[a] + size[b] > limit) continue
    const c = mean[a], d = mean[b]
    const delta = norm(c[0] - d[0], (c[1] - d[1]) * 1.65, (c[2] - d[2]) * 1.65)
    if (delta <= tolerance * (0.75 + 0.25 * (1 - gap / (tolerance * 1.3)))) join(a, b)
  }

  const small = Math.max(4, Math.round(points.length * mix(0.002, 0.005, abstraction)))
  for (const { i, j, gap } of links) {
    const a = root(i), b = root(j)
    if (a === b || Math.min(size[a], size[b]) >= small || gap > tolerance * 1.7) continue
    const c = mean[a], d = mean[b]
    if (norm(c[0] - d[0], (c[1] - d[1]) * 1.5, (c[2] - d[2]) * 1.5) < tolerance * 1.13) join(a, b)
  }
  const components = new Map()
  for (let i = 0; i < points.length; i++) {
    if (points[i].alpha < 0.025) continue
    const label = root(i)
    if (!components.has(label)) components.set(label, [])
    components.get(label).push(i)
  }
  return [...components.values()].sort((a, b) => b.length - a.length)
}





const inked = new Set(['ring', 'rings', 'squares'])
const equalSides = new Set(['square', 'circle', 'ring', 'rings', 'squares', 'cross'])
const colorDistance = (a, b) => norm(a[0] - b[0], (a[1] - b[1]) * 1.3, (a[2] - b[2]) * 1.3)

function describe(ids, map) {
  let x = 0, y = 0, left = map.nx, right = 0, top = map.ny, bottom = 0
  let edge = 0, tx = 0, ty = 0
  const color = [0, 0, 0]
  const tiles = ids.map(i => map.points[i])
  for (const p of tiles) {
    x += (p.x + 0.5) * map.sx
    y += (p.y + 0.5) * map.sy
    left = Math.min(left, p.x)
    right = Math.max(right, p.x + 1)
    top = Math.min(top, p.y)
    bottom = Math.max(bottom, p.y + 1)
    edge += p.edge
    tx += Math.cos(p.angle * 2) * p.coherence * p.edge
    ty += Math.sin(p.angle * 2) * p.coherence * p.edge
    for (let c = 0; c < 3; c++) color[c] += p.color[c]
  }
  const n = ids.length
  for (let c = 0; c < 3; c++) color[c] /= n
  const w = (right - left) * map.sx, h = (bottom - top) * map.sy
  const angle = Math.hypot(tx, ty) > edge * 0.21 ? Math.atan2(ty, tx) * 0.5 : w >= h ? 0 : Math.PI / 2
  return { x: x / n, y: y / n, w, h, color, tone: luminance(color), lab: perceptual(color),
    angle, edge: edge / n, mass: n / map.points.length, tiles }
}



export const voxelFraction = value => 0.007 * (0.15 / 0.007) ** clamp(value)

function enrich(rgb, strength = 1) {
  const luminance255 = luminance(rgb) * 255
  const mid = Math.sin(Math.PI * luminance255 / 255)
  const lift = (7 + mid * 19) * strength
  const light = Math.min(253, luminance255 + lift)
  // Expand contrast around luminance, then fit the chroma vector into the display gamut.
  const chroma = rgb.map(v => (v - luminance255) * (1 + strength * 0.47))
  let gamut = 1
  for (const c of chroma) {
    if (c > 0) gamut = Math.min(gamut, (255 - light) / c)
    if (c < 0) gamut = Math.min(gamut, light / -c)
  }
  return chroma.map(v => clamp(light + v * clamp(gamut), 0, 255))
}

function subdivide(image, minimum, settings, random) {
  const { density, depth, scaleContrast: contrast, threshold, scale } = settings
  const { w, h, region } = image
  const short = Math.min(w, h)
  const target = Math.max(minimum * 1.25, minimum * mix(3.9, 2.85, density) * scale)
  const budget = clamp(Math.round(w * h / (target * target) * mix(0.86, 1.20, depth)), 5, 365)
  const horizontalBias = mix(-0.48, 0.48, random())
  const sourceTone = region(0, 0, w, h).lum
  const hotSpots = Array.from({ length: 3 }, () => ({ x: random() * w, y: random() * h }))
  const radius = short * mix(0.44, 0.27, contrast)
  const smallThreshold = mix(0.89, 0.64, contrast)
  const minGate = minimum * 1.98

  function leaf(x, y, width, height, level) {
    const f = region(x, y, x + width, y + height)
    const cx = x + width / 2, cy = y + height / 2
    const area = width * height
    const canX = width >= minGate, canY = height >= minGate
    const radial = Math.min(...hotSpots.map(p => Math.hypot(cx - p.x, cy - p.y)))
    const pattern = Math.exp(-((radial / radius) ** 2))
    const texture = clamp(f.edge * mix(4.8, 7.5, threshold) + f.contrast * 2.6)
    const darkQuiet = f.lum < sourceTone * 0.46 && texture < 0.24
    const coarse = level >= 2 && contrast > 0.20 && random() <
      contrast * mix(0.25, 0.055, pattern) * mix(1.1, 0.30, texture)
    const targetArea = target ** 2 * mix(1, mix(2.6, 0.38, pattern), contrast)
    const salience = mix(0.75, 1.42, texture) * (darkQuiet ? 0.53 : 1)
    const priority = (!canX && !canY) || level >= 14 || f.alpha < 0.035 || coarse ? 0 :
      area / targetArea * salience * mix(0.82, 1.22, random())
    return { x, y, w: width, h: height, cx, cy, f, area, canX, canY, level, texture, priority, darkQuiet }
  }

  const leaves = [leaf(0, 0, w, h, 0)]
  while (leaves.length < budget) {
    let next = -1, score = smallThreshold
    for (let i = 0; i < leaves.length; i++) {
      if (leaves[i].priority > score) { score = leaves[i].priority; next = i }
    }
    if (next === -1) break
    const parent = leaves[next]
    const ratio = parent.w / parent.h
    const structureBias = Math.cos(parent.f.angle * 2) * parent.f.coherence * parent.texture * 0.16
    const splitX = parent.canX && (!parent.canY ||
      random() < clamp(0.5 + Math.log(ratio) * mix(0.46, 0.30, contrast) + horizontalBias - structureBias, 0.06, 0.94))
    const length = splitX ? parent.w : parent.h
    const floor = Math.min(0.5, minimum / length)
    const spread = mix(0.075, 0.295, contrast)
    const cut = length * clamp(0.5 + (random() * 2 - 1) * spread, floor, 1 - floor)
    const { x, y, w, h, level } = parent
    const children = splitX ?
      [leaf(x, y, cut, h, level + 1), leaf(x + cut, y, w - cut, h, level + 1)] :
      [leaf(x, y, w, cut, level + 1), leaf(x, y + cut, w, h - cut, level + 1)]
    leaves.splice(next, 1, ...children)
  }
  return leaves.sort((a, b) => b.area - a.area)
}

function shuffle(list, random) {
  const result = [...list]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const value = result[i]
    result[i] = result[j]
    result[j] = value
  }
  return result
}

export function generate(image, settings) {
  const { density, scale, scaleContrast: contrast, seed, abstraction } = settings
  const forms = settings.forms ?? FORMS
  const cells = [], groups = []
  if (!forms.length) return { cells, groups }

  const random = rng(seed), map = lattice(image)
  const range = (a, b) => mix(a, b, random())
  const short = Math.min(image.w, image.h)
  const minimum = Math.max(1, short * voxelFraction(settings.voxelMin ?? 0.49))
  const zones = regions(map, abstraction, scale).slice(0, 14).map(ids => describe(ids, map))
  for (const zone of zones) groups.push({ id: groups.length, x: zone.x, y: zone.y, angle: zone.angle,
    color: zone.color, size: Math.sqrt(zone.mass * image.w * image.h), weight: zone.mass })
  if (!groups.length) return { cells, groups }

  const leaves = subdivide(image, minimum, settings, random).filter(cell => cell.f.alpha > 0.025)
  const draft = shuffle(forms, random)
  const outlineForms = draft.filter(form => inked.has(form) || form === 'cross' || form === 'bar')
  // The largest footprints draw from the same enabled forms as the smaller ones.
  const primary = outlineForms.length > 0 ? [outlineForms[0], ...draft.filter(form => form !== outlineForms[0])] : draft
  const used = new Map()
  const cap = Math.min(leaves.length + 20, 386)
  const primaryCount = Math.min(leaves.length, Math.round(mix(3, 6, contrast)), forms.length + 1)
  const detailStart = Math.min(leaves.length, primaryCount + Math.round(leaves.length * mix(0.52, 0.30, contrast)))

  function place(leaf, form, tier, x, y, w, h, color, angle = 0) {
    if (equalSides.has(form)) {
      const diameter = Math.min(w, h) * (tier === 'large' ? 1.09 : 1)
      w = h = diameter
    }
    if (form === 'bar') {
      if (h > w) [w, h] = [h, w]
      h = Math.max(short * 0.0017, Math.min(h, w * (tier === 'large' ? 0.073 : 0.12)))
    }
    const rx = (Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * h) * 0.5
    const ry = (Math.abs(Math.sin(angle)) * w + Math.abs(Math.cos(angle)) * h) * 0.5
    x = clamp(x, rx * 0.62, image.w - rx * 0.62)
    y = clamp(y, ry * 0.62, image.h - ry * 0.62)
    const group = groups.reduce((a, b) => Math.hypot(b.x - x, b.y - y) < Math.hypot(a.x - x, a.y - y) ? b : a)
    used.set(form, (used.get(form) ?? 0) + 1)
    cells.push({ form, x, y, w, h, r: Math.max(w, h), angle, color: enrich(color, leaf.darkQuiet ? 0.54 : 1),
      tier, group: group.id, layers: tier === 'large' ? 4 : tier === 'medium' ? 3 : 2, outline: inked.has(form),
      strokeWidth: clamp(short * (tier === 'large' ? 0.0068 : tier === 'medium' ? 0.0036 : 0.0022), 0.38, 2.2),
      alpha: leaf.darkQuiet ? 0.89 : 1, rank: random(), phase: random(), scaleBand: clamp(Math.max(w, h) / (short * 0.45)) })
  }

  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i]
    const tier = i < primaryCount ? 'large' : i < detailStart ? 'medium' : 'detail'
    if (tier === 'detail' && (leaf.darkQuiet ? random() < 0.48 : random() < mix(0.23, 0.055, density))) continue
    const elongated = Math.max(leaf.w, leaf.h) > Math.min(leaf.w, leaf.h) * 1.86
    const form = i < primaryCount ? primary[i % primary.length] :
      forms.find(value => !used.has(value)) ??
      (elongated && forms.includes('bar') && random() < 0.70 ? 'bar' : draft[Math.floor(random() * draft.length)])
    const size = tier === 'large' ? mix(0.87, 1.13, contrast) : mix(0.91, 0.79, contrast)
    const w = leaf.w * size * range(0.82, 1.10), h = leaf.h * size * range(0.82, 1.10)
    const x = leaf.cx + leaf.w * range(-0.095, 0.095), y = leaf.cy + leaf.h * range(-0.095, 0.095)
    const field = image.field(x, y, Math.max(1, Math.min(w, h) * 0.17))
    const color = field.color.map((v, j) => mix(leaf.f.color[j], v, field.alpha > 0.18 ? 0.68 : 0))
    const structural = form === 'bar' && leaf.f.coherence > 0.43 && leaf.texture > 0.21
    const lineAngle = structural ? Math.round(leaf.f.angle / (Math.PI / 8)) * (Math.PI / 8) : leaf.h > leaf.w ? Math.PI / 2 : 0
    const tilt = form === 'bar' ? lineAngle : 0
    place(leaf, form, tier, x, y, w, h, color, tilt)
  }

  if (forms.includes('bar')) {
    const linear = leaves.filter(leaf => leaf.texture > 0.19 && !leaf.darkQuiet)
    const limit = Math.min(linear.length, Math.round(mix(1, 14, density) * mix(0.45, 1, contrast)))
    for (const leaf of shuffle(linear, random).slice(0, limit)) {
      if (cells.length >= cap) break
      const length = Math.max(leaf.w, leaf.h) * range(0.46, 0.93)
      const x = leaf.cx + leaf.w * range(-0.36, 0.36), y = leaf.cy + leaf.h * range(-0.36, 0.36)
      const f = image.field(x, y, Math.max(1, length * 0.085))
      const angle = leaf.f.coherence > 0.38 ? Math.round(leaf.f.angle / (Math.PI / 8)) * (Math.PI / 8) :
        leaf.w > leaf.h ? 0 : Math.PI / 2
      place(leaf, 'bar', 'detail', x, y, length, short * range(0.0024, 0.005), f.color, angle)
    }
  }

  const layers = { large: 0, medium: 1, detail: 2 }
  cells.sort((a, b) => layers[a.tier] - layers[b.tier] || b.r - a.r)
  return { cells, groups }
}

