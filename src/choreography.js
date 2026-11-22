import { clamp, follow, mix, noise, TAU } from './math.js'

const RATE = 1 / 30, MEMORY = 18
const COLUMNS = 7
const frame = count => new Float32Array(count * COLUMNS)

export class Choreography {
  constructor(width, height, seed, groups = []) {
    this.w = width
    this.h = height
    this.short = Math.min(width, height)
    this.seed = seed
    this.groups = groups
    this.states = groups.map((g, i) => ({
      ...g, x0: g.x, y0: g.y, lane: noise(g.x / width * 4, g.y / height * 4, seed + 203),
      wait: i / Math.max(1, groups.length) * 0.72, beat: 0, gate: 0, low: 0, mid: 0, high: 0,
      clock: 0, roll: 0, flipClock: 0,
      x: 0, y: 0, scale: 0, turn: 0, z: 0, angleX: 0, angleY: 0,
      vx: 0, vy: 0, vs: 0, vr: 0
    }))
    this.frames = Array.from({ length: MEMORY }, () => frame(groups.length))
    this.cursor = -1
    this.elapsed = 0
  }

  step(dt, audio, settings, gain) {
    const flow = gain('flow'), gather = gain('gather'), flip = gain('fold')
    const depth = settings.spatialDepth ?? 0.62, groupAmount = settings.groupAmount ?? 0.73
    const level = Math.sqrt(audio.level), sustained = Math.sqrt(audio.sustain)
    const low = audio.low || 0, mid = audio.mid || 0, high = audio.high || 0
    const response = Math.pow(settings.energy, 0.84)
    let activity = 0
    for (const g of this.states) {
      const speed = 0.74 + 0.45 * g.lane
      g.gate = follow(g.gate, level, dt, level > g.gate ? 0.15 + g.wait * 0.25 : 0.26 + g.wait * 0.26)
      g.low = follow(g.low, low, dt, 0.22 + g.wait * 0.33)
      g.mid = follow(g.mid, mid, dt, 0.11 + g.wait * 0.25)
      g.high = follow(g.high, high, dt, 0.052 + g.wait * 0.08)
      g.beat = Math.max(audio.hit || 0, g.beat * Math.exp(-dt * (3.2 + g.wait * 3.1)))
      const pressure = (g.gate * 0.51 + sustained * 0.25 + g.low * 0.24) * response
      const punch = (g.low * 0.46 + g.mid * 0.25 + g.beat * 0.29)
      const drift = pressure * flow * groupAmount
      const spread = pressure * gather * groupAmount
      g.clock += dt * (0.36 + g.low * 0.75 + g.mid * 0.33) * speed
      g.roll += dt * (0.92 + g.mid * 1.3 + g.beat * 0.42) * speed
      g.flipClock += dt * (0.61 + g.mid * 1.85 + g.high * 0.38 + g.beat * 0.65) * speed

      // Adjacent parts of a region use a single pivot and travel together.
      const path = g.clock - g.wait * 1.6
      const nx = g.x0 / this.w, ny = g.y0 / this.h
      const sweep = Math.sin(path * 2.33 + ny * 2.24 - nx * 0.92)
      const returnLane = Math.sin(path * 1.49 + nx * 2.52 + 0.47)
      const curl = noise(nx * 3.7 - path, ny * 3.1 + path * 0.35, this.seed + 551) - 0.5
      let tx = (0.74 * sweep + curl * 0.43) * this.w * 0.91 * drift
      let ty = (0.75 * returnLane - curl * 0.56) * this.h * 0.70 * drift

      // Expansion changes distances between groups as well as spacing inside them.
      const pulse = Math.sin(g.roll - g.wait * 2.8) * (0.78 + punch * 0.45)
      const radius = pulse * 1.28 * spread
      const armX = g.x0 - this.w / 2, armY = g.y0 - this.h / 2
      const orbital = spread * (g.mid * 1.65 + 0.28) * Math.sin(g.roll * 0.69 + g.lane * 2.4)
      tx += armX * radius - armY * orbital
      ty += armY * radius + armX * orbital
      tx = clamp(tx, Math.min(0, this.w * 0.045 - g.x0), Math.max(0, this.w * 0.955 - g.x0))
      ty = clamp(ty, Math.min(0, this.h * 0.045 - g.y0), Math.max(0, this.h * 0.955 - g.y0))
      const stiffness = 8 + 8 * g.mid + g.beat * 9
      const damping = mix(6.3, 3.3, settings.persistence)
      g.vx += ((tx - g.x) * stiffness - g.vx * damping) * dt
      g.vy += ((ty - g.y) * stiffness - g.vy * damping) * dt
      g.x = clamp(g.x + g.vx * dt, Math.min(0, this.w * 0.01 - g.x0), Math.max(0, this.w * 0.99 - g.x0))
      g.y = clamp(g.y + g.vy * dt, Math.min(0, this.h * 0.01 - g.y0), Math.max(0, this.h * 0.99 - g.y0))
      if (Math.abs(g.x - tx) > this.w * 0.8) g.vx *= 0.5
      if (Math.abs(g.y - ty) > this.h * 0.8) g.vy *= 0.5

      const scale = clamp(radius * 0.93, -0.61, 0.85)
      const turn = orbital * 2.6
      g.vs += ((scale - g.scale) * 19 - g.vs * damping * 1.07) * dt
      g.vr += ((turn - g.turn) * 20 - g.vr * damping * 1.05) * dt
      g.scale = clamp(g.scale + g.vs * dt, -0.67, 0.90)
      g.turn = clamp(g.turn + g.vr * dt, -1.52, 1.52)

      const phase = ((g.flipClock + 4 - g.wait * 1.87 + g.lane * 0.34) % 2.2) / 2.2
      const window = clamp(phase / 0.79)
      const foldPath = Math.sin(window * Math.PI) ** 1.42
      const flipPressure = clamp(g.gate * (0.87 + g.mid * 0.28 + g.beat * 0.22) * Math.pow(settings.energy, 0.61))
      const amp = TAU * (settings.flipAmount ?? 0.68) * flip * flipPressure
      const yAxis = Math.abs(Math.cos(g.angle)) > 0.57
      const lean = foldPath * amp * (g.id % 3 === 1 ? -1 : 1)
      g.angleX = follow(g.angleX, lean * (yAxis ? 0.19 : 1), dt, 0.065 + g.wait * 0.049)
      g.angleY = follow(g.angleY, lean * (yAxis ? 1 : 0.16), dt, 0.065 + g.wait * 0.049)
      g.z = follow(g.z, depth * this.short * (spread * pulse * 0.22 +
        drift * (curl + ny - 0.5) * 0.26 + foldPath * flipPressure * flip * 0.094), dt, 0.15)
      activity = Math.max(activity, Math.abs(g.x) / this.w, Math.abs(g.y) / this.h, Math.abs(g.scale),
        Math.abs(g.turn), Math.abs(g.angleX), Math.abs(g.angleY), Math.abs(g.z) / this.short)
    }
    this.elapsed += dt
    if (this.elapsed >= RATE) {
      this.elapsed %= RATE
      this.cursor = (this.cursor + 1) % MEMORY
      const history = this.frames[this.cursor]
      for (let i = 0; i < this.states.length; i++) {
        const g = this.states[i], j = i * COLUMNS
        history[j] = g.x; history[j + 1] = g.y; history[j + 2] = g.scale; history[j + 3] = g.turn
        history[j + 4] = g.z; history[j + 5] = g.angleX; history[j + 6] = g.angleY
      }
    }
    return activity
  }

  apply(x, y, state, group, lag) {
    const g = this.states[group]
    state.depth = state.flipX = state.flipY = state.groupTurn = 0
    if (!g) return state
    const j = group * COLUMNS
    const f = lag ? this.frames[(this.cursor + MEMORY * 2 - lag) % MEMORY] : null
    const dx = f ? f[j] : g.x, dy = f ? f[j + 1] : g.y
    const scale = 1 + (f ? f[j + 2] : g.scale), angle = f ? f[j + 3] : g.turn
    const rx = x - g.x0, ry = y - g.y0
    const c = Math.cos(angle), s = Math.sin(angle)
    state.x += dx + (rx * c - ry * s) * scale - rx
    state.y += dy + (rx * s + ry * c) * scale - ry
    state.groupTurn = angle
    state.depth = f ? f[j + 4] : g.z
    state.flipX = f ? f[j + 5] : g.angleX
    state.flipY = f ? f[j + 6] : g.angleY
    if (!lag) { state.vx += g.vx; state.vy += g.vy }
    return state
  }
}

