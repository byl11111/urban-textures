import { clamp, mix, TAU } from './math.js'
import { facing, light, plane, point } from './projection.js'

export const ECHOES = ['auto', 'off', 'fan', 'linear', 'bilateral', 'radial', 'trace']
export const ECHO_AXES = ['auto', 'right', 'left', 'up', 'down']
const axes = { right: [1, 0], left: [-1, 0], up: [0, -1], down: [0, 1] }
const luma = ([r, g, b]) => r * 0.2126 + g * 0.7152 + b * 0.0722
const ink = values => 'rgb(' + values.map(v => Math.round(clamp(v, 0, 255))).join(',') + ')'
const vertex = {}
const rest = Object.freeze({ x: 0, y: 0, angle: 0, zoom: 0, stretch: 0, fold: 0 })

function outlines(c) {
  if (c.vertices) return Array.from({ length: c.layers ?? 1 }, (_, i) =>
    i ? c.vertices.map(([x, y]) => [x * (1 - i * 0.29), y * (1 - i * 0.29)]) : c.vertices)
  const w = c.w / 2, h = c.h / 2
  const circle = ['circle', 'ring', 'rings'].includes(c.form)
  const count = ['rings', 'squares'].includes(c.form) ? c.layers : 1
  return Array.from({ length: count }, (_, i) => {
    const scale = 1 - i * 0.26
    if (circle) {
      const vertices = c.tier === 'large' || c.form === 'rings' ? 64 : 28
      return Array.from({ length: vertices }, (_, j) =>
        [w * scale * Math.cos(j * TAU / vertices), h * scale * Math.sin(j * TAU / vertices)])
    }
    if (c.form === 'cross') return [[-0.12, -1], [0.12, -1], [0.12, -0.12], [1, -0.12], [1, 0.12], [0.12, 0.12],
      [0.12, 1], [-0.12, 1], [-0.12, 0.12], [-1, 0.12], [-1, -0.12], [-0.12, -0.12]].map(([x, y]) => [x * w, y * h])
    return [[-w * scale, -h * scale], [w * scale, -h * scale], [w * scale, h * scale], [-w * scale, h * scale]]
  })
}

function deform(state, cell, pose) {
  const { round, line, cross } = cell.rhythm
  const scale = clamp(1 + state.zoom * (round ? 1.26 : mix(0.96, 0.42, cell.scaleBand ?? 0.5)), 0.66, 1.39)
  const direction = line ? state.x * cell.axisX + state.y * cell.axisY : 0
  pose.x = cell.x + state.x * (line ? 0.74 : 1) + direction * cell.axisX * 0.33
  pose.y = cell.y + state.y * (line ? 0.74 : 1) + direction * cell.axisY * 0.33
  pose.angle = cell.angle + (state.groupTurn ?? 0) + state.angle * (cross ? 1.32 : line ? 1.03 : round ? 0.23 : 0.57)
  pose.sx = line ? scale + state.stretch * 0.27 : scale
  pose.sy = line ? 1 + (scale - 1) * 0.35 : scale
  pose.stretch = clamp(state.stretch, -0.48, 0.75)
  const face = round ? 0.58 : line ? 0.78 : 1
  pose.flipX = (state.flipX ?? 0) * face + state.fold * 0.30 * Math.sin(cell.phase * 9)
  pose.flipY = (state.flipY ?? 0) * face + state.fold * 0.32 * Math.cos(cell.phase * 7)
  pose.depth = state.depth ?? 0
  return pose
}

function autoEcho(motions) {
  if (motions.includes('flow')) return 'trace'
  if (motions.includes('spin') || motions.includes('sway')) return 'fan'
  if (motions.includes('gather') || motions.includes('ripple') || motions.includes('stretch') || motions.includes('breathe')) return 'radial'
  if (motions.includes('fold')) return 'bilateral'
  return motions.includes('bounce') ? 'linear' : 'radial'
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: false })
    this.quality = 1
    this.sample = {}
    this.past = {}
    this.echoPose = {}
    this.view = {}
  }

  setImage(image) {
    this.image = image
    this.canvas.width = image.original.width
    this.canvas.height = image.original.height
    this.sx = this.canvas.width / image.w
    this.sy = this.canvas.height / image.h
  }

  setScene(scene, settings) {
    this.scene = scene
    this.queue = scene.cells.map((cell, order) => {
      const dx = cell.x / this.image.w - 0.5, dy = cell.y / this.image.h - 0.5
      const direction = Math.hypot(dx, dy) < 0.04 ? cell.angle : Math.atan2(dy, dx)
      cell.ux = Math.cos(direction)
      cell.uy = Math.sin(direction)
      cell.axisX = Math.cos(cell.angle)
      cell.axisY = Math.sin(cell.angle)
      cell.rhythm = { round: ['circle', 'ring', 'rings'].includes(cell.form), line: cell.form === 'bar', cross: cell.form === 'cross' }
      cell.paths = outlines(cell)
      cell.outline ||= ['rings', 'ring', 'squares'].includes(cell.form)
      cell.stroke = cell.strokeWidth ?? clamp(Math.min(cell.w, cell.h) * 0.043, 0.32, 1.04)
      cell.thickness = cell.tier === 'large' ? clamp(cell.r * 0.018, 1.0, 3.5) : clamp(cell.r * 0.026, 0.34, 1.45)
      return { cell, order, pose: {}, z: 0 }
    })
    this.palette(settings)
  }

  palette({ colorfulness, palette, background }) {
    const paper = background.slice(1).match(/../g).map(v => Number.parseInt(v, 16))
    const base = luma(paper)
    for (const cell of this.scene.cells) {
      const l = luma(cell.color)
      const floor = base < 128 ? Math.max(0, 19 + base * 0.30 - l) : -Math.max(0, l - base + 18)
      const front = cell.color.map((v, i) => {
        const tone = palette === 'mono' ? l : mix(l, v, colorfulness)
        return tone + floor + (palette === 'warm' ? [8, 1, -10][i] : 0)
      })
      const back = front.map((v, i) => palette === 'mono' ? v * 0.76 + 24 : v * 0.75 + [18, 25, 46][i])
      cell.ink = ink(front)
      cell.backInk = Array.from({ length: 8 }, (_, j) => ink(back.map(v => v * mix(0.64, 1.12, j / 7))))
      cell.faceInk = Array.from({ length: 8 }, (_, j) => ink(front.map(v => v * mix(0.70, 1.08, j / 7))))
      cell.sideInk = ink(front.map(v => mix(v, base < 128 ? 215 : 35, 0.34)))
      cell.echoInk = ink(front.map(v => mix(v, base < 128 ? 227 : 38, 0.31)))
    }
  }

  projected(poly, thickness, view) {
    const ctx = this.ctx
    for (let i = 0; i < poly.length; i++) {
      const [x, y] = poly[i], p = point(x, y, thickness, view, vertex)
      if (i) ctx.lineTo(p.x, p.y)
      else ctx.moveTo(p.x, p.y)
    }
    ctx.closePath()
  }

  drawMotif(cell, pose, depth) {
    const { ctx, image } = this
    const view = plane(cell, pose, image.w, image.h, depth, this.view)
    const face = facing(view)
    const angle = Math.abs(view.normalX) + Math.abs(view.normalY)
    const thickness = angle > 0.065 && !cell.outline ? cell.thickness : 0
    const shade = Math.round(light(view, face) * 7)
    const color = face < 0 ? cell.backInk[shade] : angle < 0.065 ? cell.ink : cell.faceInk[shade]
    ctx.globalAlpha = cell.alpha
    if (thickness && this.quality > 0.55 && cell.r > 13) {
      const poly = cell.paths[0], half = thickness * 0.5 * face
      ctx.fillStyle = cell.sideInk
      ctx.beginPath()
      for (let i = 0; i < poly.length; i++) {
        const [x, y] = poly[i], [u, v] = poly[(i + 1) % poly.length]
        const p = point(x, y, half, view, vertex), ax = p.x, ay = p.y
        point(u, v, half, view, vertex)
        const bx = p.x, by = p.y
        point(u, v, -half, view, vertex)
        const dx = p.x, dy = p.y
        point(x, y, -half, view, vertex)
        if (((bx - ax) * (dy - ay) - (by - ay) * (dx - ax)) * face >= 0) continue
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(dx, dy); ctx.lineTo(p.x, p.y); ctx.closePath()
      }
      ctx.fill()
    }
    ctx.beginPath()
    for (const poly of cell.paths) this.projected(poly, thickness * 0.5 * face, view)
    if (cell.outline) {
      ctx.strokeStyle = color
      ctx.lineWidth = cell.stroke
      ctx.stroke()
    } else {
      ctx.fillStyle = color
      ctx.fill('evenodd')
    }
  }

  drawEchoes(cell, state, settings, motion, type, depth) {
    const { ctx, image } = this
    const level = clamp(state.detail + Math.abs(state.angle) * 0.12 + Math.abs(state.zoom) * 0.21 +
      Math.abs(state.flipX ?? 0) * 0.075 + Math.abs(state.flipY ?? 0) * 0.075 +
      Math.min(0.45, Math.hypot(state.vx, state.vy) / Math.max(1, cell.r) * 0.16))
    if (level < 0.02) return
    const spread = settings.echoSpacing * (0.38 + Math.sqrt(level) * 0.85)
    const speed = Math.hypot(state.vx, state.vy)
    const fixed = axes[settings.echoAxis]
    const [ux, uy] = fixed ?? (type === 'radial' ? [cell.ux, cell.uy] : speed > 0.12 ?
      [-state.vx / speed, -state.vy / speed] : [cell.ux, cell.uy])
    const gap = clamp(cell.r * 0.13, 1.3, 15) * spread
    const layers = this.quality < 0.78 ? Math.min(settings.echoLayers, 3) : settings.echoLayers
    ctx.strokeStyle = cell.echoInk
    ctx.lineWidth = cell.stroke * 0.84
    for (let i = layers; i >= 1; i--) {
      const lag = clamp(Math.round(i * (1 + settings.echoSpacing * 2)), 1, 15)
      const past = type === 'trace' ? motion.at(cell.x, cell.y, this.past, lag, cell.group) : null
      const p = deform(past ?? state, cell, this.echoPose)
      if (past) {
        if (!fixed && Math.abs(past.x - state.x) + Math.abs(past.y - state.y) + Math.abs(past.angle - state.angle) +
          Math.abs((past.flipX ?? 0) - (state.flipX ?? 0)) + Math.abs((past.flipY ?? 0) - (state.flipY ?? 0)) < 0.09) continue
        if (fixed) { p.x += ux * gap * i * 0.65; p.y += uy * gap * i * 0.65 }
      } else if (type === 'fan') {
        const sign = fixed ? (ux + uy >= 0 ? 1 : -1) : state.vp < 0 ? 1 : -1
        p.angle += sign * i * spread * 0.22
        p.x += ux * gap * i * 0.30
        p.y += uy * gap * i * 0.30
      } else if (type === 'radial') {
        const grow = 1 + i * spread * 0.13
        p.sx *= grow; p.sy *= grow
        p.x += ux * gap * i * 0.65
        p.y += uy * gap * i * 0.65
      } else {
        const index = type === 'bilateral' ? Math.ceil(i / 2) * (i % 2 ? 1 : -1) : i
        p.x += ux * gap * index
        p.y += uy * gap * index
      }
      ctx.globalAlpha = cell.alpha * settings.echoOpacity * Math.sqrt(level) * (1 - (i - 1) / (layers + 0.65)) * 0.68
      const view = plane(cell, p, image.w, image.h, depth, this.view)
      ctx.beginPath()
      this.projected(cell.paths[0], 0, view)
      ctx.stroke()
    }
  }

  draw(settings, motion) {
    const { ctx, canvas, image } = this
    ctx.resetTransform()
    ctx.globalAlpha = 1
    ctx.fillStyle = settings.background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.setTransform(this.sx, 0, 0, this.sy, 0, 0)
    const depth = settings.spatialDepth ?? 0.62
    const echo = settings.echo === 'auto' || (settings.echo === 'trace' && !settings.motions.length) ?
      autoEcho(settings.motions) : settings.echo
    const settled = motion.activity <= 0.0025
    const budget = Math.min(1, 820 / Math.max(1, this.scene.cells.length * settings.echoLayers)) * this.quality
    for (const item of this.queue) {
      const cell = item.cell
      const d = settled ? rest : motion.at(cell.x, cell.y, this.sample, 0, cell.group)
      deform(d, cell, item.pose)
      item.z = item.pose.depth
      if (motion.activity > 0.01 && settings.echoEnabled && echo !== 'off' && settings.echoOpacity > 0 && cell.rank <= budget) {
        this.drawEchoes(cell, d, settings, motion, echo, depth)
      }
    }
    this.queue.sort((a, b) => a.z - b.z || a.order - b.order)
    for (const item of this.queue) this.drawMotif(item.cell, item.pose, depth)
    ctx.restore()
  }
}

