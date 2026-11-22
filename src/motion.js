import { clamp, follow, mix, noise, TAU } from './math.js'
import { Choreography } from './choreography.js'

export const MOTIONS = ['flow', 'fold', 'gather', 'breathe', 'stretch', 'spin', 'ripple', 'sway', 'bounce']
const GRID = 15
const N = GRID * GRID
const HISTORY = 16
const STEP = 1 / 30
const CHANNELS = ['x', 'y', 'zoom', 'angle', 'stretch', 'fold', 'detail']
const LIMITS = [1, 1, 0.66, 2.8, 0.84, 0.93, 1]
const SPRINGS = [64, 64, 52, 87, 91, 76, 118]
const snapshot = () => CHANNELS.map(() => new Float32Array(N))

export class MotionField {
  constructor(image, seed, groups) {
    this.w = image.w
    this.h = image.h
    this.extent = Math.min(image.w, image.h)
    this.seed = seed
    this.groups = new Choreography(image.w, image.h, seed, groups)
    this.clock = this.activity = this.serial = this.lastPulse = this.historyTime = 0
    this.slow = this.impulse = 0
    this.phase = { breath: 0, spin: 0, flow: 0, sway: 0, wave: 0, fold: 0 }
    this.values = snapshot()
    this.velocity = snapshot()
    this.targets = new Float32Array(CHANNELS.length)
    this.history = Array.from({ length: HISTORY }, snapshot)
    this.historyIndex = -1
    this.pulses = []
    this.material = Array.from({ length: N }, (_, i) => {
      const u = (i % GRID) / (GRID - 1), v = Math.floor(i / GRID) / (GRID - 1)
      const f = image.field(u * image.w, v * image.h, Math.max(1, this.extent / GRID * 0.7))
      const weight = clamp(f.edge * 4.2 + f.contrast * 2.6)
      const direction = f.coherence > 0.22 ? f.angle : noise(u * 4, v * 4, seed) * TAU
      return { u, v, weight, tone: clamp(f.lum ?? 0.5), tx: Math.cos(direction), ty: Math.sin(direction),
        phase: noise(u * 4.3, v * 3.9, seed + 912) * TAU }
    })
  }

  emit(value) {
    const i = this.serial++
    let center, best = -1
    for (const m of this.material) {
      const score = (0.35 + m.weight) * noise(m.u * 6.4 + i * 8.17, m.v * 6.4, this.seed)
      if (score > best) { best = score; center = m }
    }
    this.pulses.push({ u: center.u, v: center.v, t: this.clock, value })
    if (this.pulses.length > 5) this.pulses.shift()
    this.lastPulse = this.clock
  }

  step(dt, audio, settings) {
    this.clock += dt
    const t = this.clock
    const enabled = settings.motions
    const drive = settings.energy ** 0.86 * settings.local
    const echoOnly = settings.echoEnabled && enabled.length === 0
    const gate = audio.level > 0.0001 && drive > 0 && (enabled.length > 0 || echoOnly)
    const body = gate ? Math.sqrt(audio.level) : 0
    const sustain = gate ? Math.sqrt(audio.sustain) : 0
    this.slow = follow(this.slow, sustain, dt, 0.20)
    this.impulse = Math.max(gate ? audio.hit : 0, this.impulse * Math.exp(-dt * 8.1))
    const gain = mode => enabled.includes(mode) ? settings.padGains?.[mode] ?? 1 : 0
    const [breathe, stretch, spin, flow, ripple, fold, sway, bounce] =
      ['breathe', 'stretch', 'spin', 'flow', 'ripple', 'fold', 'sway', 'bounce'].map(gain)
    const groupActivity = this.groups.step(dt, audio, settings, gain)
    const stageX = this.extent * (this.groups.groups.length ? 0.083 : 0.147)
    const low = audio.low, high = audio.high, flux = audio.flux
    const p = this.phase
    p.breath += dt * (2.7 + low * 3.3)
    p.spin += dt * (4.1 + high * 5.8 + flux * 3.1)
    p.flow += dt * (0.47 + sustain * 0.63 + audio.centroid * 0.39)
    p.sway += dt * (4.5 + high * 8.9)
    p.wave += dt * (3.1 + low * 4.4)
    p.fold += dt * (3.4 + low * 4.7)
    if (gate && (ripple || bounce)) {
      if (audio.hit > 0 && t - this.lastPulse > 0.15) this.emit(audio.hit * (0.56 + 0.44 * body))
      else if (ripple && t - this.lastPulse > 0.98 && sustain > 0.23) this.emit(0.42 + sustain * 0.37)
    }
    while (this.pulses.length && t - this.pulses[0].t > 1.64) this.pulses.shift()

    const forceMix = 1 / Math.sqrt(Math.max(1, flow + ripple + bounce + 0.33 * (sway + spin)))
    const damping = mix(1.68, 0.78, settings.persistence)
    const accel = SPRINGS.map((k, i) => k * settings.tension * (i === 0 && bounce && !flow ? 1.18 : 1))
    const decay = accel.map(k => Math.sqrt(k) * damping)
    let activity = 0
    for (let i = 0; i < N; i++) {
      const { u, v, weight, tone, tx, ty, phase } = this.material[i]
      const variation = 0.73 + 0.13 * weight + 0.14 * tone
      const acoustic = body * variation
      const continuous = 0.48 * acoustic + 0.52 * this.slow * variation
      let x = 0, y = 0, zoom = 0, angle = 0, elongate = 0, open = 0, flare = 0
      if (gate && breathe) {
        const cycle = 0.44 + 0.56 * Math.sin(p.breath + phase * 0.50)
        zoom += continuous * cycle * (0.60 + low * 0.23) * breathe
      }
      if (gate && stretch) {
        elongate = acoustic * (0.47 + low * 0.36 + flux * 0.36) * Math.sin(p.breath * 1.13 + phase + u * 1.2) * stretch
      }
      if (gate && spin) {
        const orbit = p.spin + phase * 0.88
        const pressure = acoustic * (0.77 + high * 0.32 + flux * 0.21) * spin
        angle += (Math.sin(orbit) + Math.sin(orbit * 0.51 + v) * 0.24) * pressure * 2.46
        x += Math.cos(orbit) * pressure * 0.17
        y += Math.sin(orbit) * pressure * 0.17
      }
      if (gate && flow) {
        const px = u * 2.68 - p.flow + audio.centroid * 0.74
        const py = v * 2.68 + p.flow * 0.46
        const du = noise(px + 0.23, py, this.seed) - noise(px - 0.23, py, this.seed)
        const dv = noise(px, py + 0.23, this.seed) - noise(px, py - 0.23, this.seed)
        x += continuous * (dv * 1.46 + Math.sin(p.flow * 2.3 + v * 3.0) * 0.28) * flow
        y += continuous * (-du * 1.46 + Math.cos(p.flow * 1.9 + u * 3.0) * 0.28) * flow
      }
      if (gate && sway) {
        const swing = Math.sin(p.sway + phase * 0.86) * acoustic * (0.53 + high * 0.34 + flux * 0.27) * sway
        angle += swing * 0.92
        x -= ty * swing * 0.21
        y += tx * swing * 0.21
      }
      if (gate && fold) {
        open = acoustic * (0.53 + low * 0.34 + this.impulse * 0.23) *
          (0.50 + 0.50 * Math.sin(p.fold + phase * 0.81)) * fold * (settings.flipAmount ?? 0.68)
      }
      if (gate && ripple) {
        const carrier = Math.sin(p.wave - u * 6.2 - v * 4.7 + phase * 0.25) * continuous * (0.31 + high * 0.25) * ripple
        x += carrier * 0.66
        y += carrier * 0.69
        zoom += carrier * 0.29
      }
      if (ripple || bounce) {
        for (const pulse of this.pulses) {
          const dx = u - pulse.u, dy = v - pulse.v
          const distance = Math.hypot(dx, dy)
          const since = t - pulse.t
          const age = since - distance * 0.94
          if (ripple && age > 0 && age < 0.58) {
            const wave = Math.sin(age / 0.58 * TAU) * Math.sin(age / 0.58 * Math.PI) *
              pulse.value * Math.exp(-distance * 1.28) * ripple
            x += dx / (0.14 + distance) * wave * 1.12
            y += dy / (0.14 + distance) * wave * 1.12
            zoom += wave * 0.33
            flare += Math.abs(wave)
          }
          if (bounce) {
            const jumpAge = since - distance * 0.22
            if (jumpAge > 0 && jumpAge < 0.46) {
              const kick = Math.sin(jumpAge * 17.1) * Math.exp(-jumpAge * 7.8) * pulse.value * Math.exp(-distance * 2.14) * bounce
              y -= kick * 1.26
              x += (dx * 0.5 + tx * 0.11) * kick
              zoom += kick * 0.21
              flare += Math.abs(kick)
            }
          }
        }
      }
      if (gate && bounce) {
        const rebound = acoustic * (0.17 + this.impulse * 0.24) * Math.sin(p.wave * 1.75 + phase * 0.61) * bounce
        y += rebound
        zoom += rebound * 0.30
      }

      const targets = this.targets
      const txGoal = x * drive * forceMix, tyGoal = y * drive * forceMix
      const cap = Math.max(1, Math.hypot(txGoal, tyGoal))
      targets[0] = txGoal / cap
      targets[1] = tyGoal / cap
      targets[2] = clamp(zoom * drive, -0.33, 0.66)
      targets[3] = clamp(angle * drive, -2.8, 2.8)
      targets[4] = clamp(elongate * drive, -0.54, 0.84)
      targets[5] = clamp(open * drive, 0, 0.93)
      const echoPulse = echoOnly ? acoustic * (0.16 * Math.sin(p.wave - phase) + this.impulse * 0.30) : 0
      targets[6] = clamp((0.39 * acoustic + echoPulse + flare * 0.54 + Math.abs(angle) * 0.23 +
        Math.abs(x) * 0.36 + Math.abs(y) * 0.36) * drive)
      for (let k = 0; k < CHANNELS.length; k++) {
        const a = this.values[k], velocity = this.velocity[k], limit = LIMITS[k]
        const v = velocity[i] + ((targets[k] - a[i]) * accel[k] - velocity[i] * decay[k]) * dt
        const next = a[i] + v * dt
        a[i] = clamp(next, k > 4 ? 0 : -limit, limit)
        velocity[i] = Math.abs(next - a[i]) > 0.000001 ? v * -0.14 : v
        activity = Math.max(activity, Math.abs(a[i]), Math.abs(velocity[i]) * 0.048)
      }
    }
    this.travel = stageX
    this.activity = Math.max(activity, groupActivity, this.pulses.length ? 0.003 : 0)

    this.historyTime += dt
    if (this.historyTime >= STEP) {
      this.historyTime %= STEP
      this.historyIndex = (this.historyIndex + 1) % HISTORY
      const sample = this.history[this.historyIndex]
      for (let k = 0; k < CHANNELS.length; k++) sample[k].set(this.values[k])
    }
  }

  at(x, y, out, lag = 0, group) {
    const u = clamp(x / this.w) * (GRID - 1), v = clamp(y / this.h) * (GRID - 1)
    const ix = Math.min(GRID - 2, Math.floor(u)), iy = Math.min(GRID - 2, Math.floor(v))
    const a = iy * GRID + ix, b = a + GRID
    const s = u - ix, t = v - iy
    const blend = values => mix(mix(values[a], values[a + 1], s), mix(values[b], values[b + 1], s), t)
    const values = lag ? this.history[(this.historyIndex + HISTORY * 2 - lag) % HISTORY] : this.values
    for (let k = 0; k < CHANNELS.length; k++) out[CHANNELS[k]] = blend(values[k])
    const travel = this.travel ?? 0
    // Taper only outward travel near an edge, leaving inward movement available.
    const edgeX = clamp((out.x < 0 ? x : this.w - x) / Math.max(1, this.w * 0.18))
    const edgeY = clamp((out.y < 0 ? y : this.h - y) / Math.max(1, this.h * 0.18))
    const cap = Math.max(1, Math.hypot(out.x, out.y))
    out.x *= travel * edgeX / cap
    out.y *= travel * edgeY / cap
    if (!lag) {
      out.vx = blend(this.velocity[0]) * travel * edgeX
      out.vy = blend(this.velocity[1]) * travel * edgeY
      out.vp = blend(this.velocity[3])
    }
    return this.groups.apply(x, y, out, group, lag)
  }
}

