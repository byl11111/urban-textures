import { clamp, follow, mix } from './math.js'

export const SILENCE = Object.freeze({ level: 0, sustain: 0, low: 0, mid: 0, high: 0, centroid: 0, flux: 0, hit: 0 })
const AUDIO_LIMIT = 120 * 1024 * 1024

export async function prepareAudio(file) {
  if (!file.size || file.size > AUDIO_LIMIT) throw Error('请选择 120 MB 以内的音频。')
  const url = URL.createObjectURL(file)
  const probe = new Audio()
  probe.preload = 'auto'
  try {
    await new Promise((resolve, reject) => {
      const fail = () => reject(Error('无法解码音频。请试用 WAV、MP3、M4A 或 Ogg。'))
      const timer = setTimeout(fail, 12000)
      probe.onloadeddata = () => {
        clearTimeout(timer)
        if (Number.isFinite(probe.duration) && probe.duration > 0) resolve()
        else fail()
      }
      probe.onerror = () => { clearTimeout(timer); fail() }
      probe.src = url
    })
    return url
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  } finally {
    probe.onloadeddata = probe.onerror = null
    probe.removeAttribute('src')
    probe.load()
  }
}

export class AudioEngine {
  constructor() {
    this.element = new Audio()
    this.element.preload = 'auto'
    this.url = null
    this.values = { ...SILENCE }
  }

  attach(url) {
    this.element.pause()
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = url
    this.element.src = url
    this.reset()
  }

  reset() {
    this.peak = 0.013
    this.floor = 0.00008
    this.slow = 0
    this.fast = 0
    this.fluxBase = 0
    this.cooldown = 0
    this.elapsed = 0
    this.previous?.fill(0)
    Object.assign(this.values, SILENCE)
  }

  init() {
    if (this.context) return
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) throw Error('当前浏览器不支持声音分析。请使用 Chrome 或 Edge。')
    this.context = new AudioContext()
    this.analyser = this.context.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0
    this.source = this.context.createMediaElementSource(this.element)
    this.source.connect(this.analyser)
    this.analyser.connect(this.context.destination)
    this.wave = new Float32Array(this.analyser.fftSize)
    this.spectrum = new Float32Array(this.analyser.frequencyBinCount)
    this.previous = new Float32Array(this.spectrum.length)
    this.reset()
  }

  async play(restart = false) {
    if (!this.url) return
    this.init()
    if (restart || this.element.ended) {
      this.element.currentTime = 0
      this.reset()
    }
    // Invoke both inside the playback gesture before awaiting either promise.
    await Promise.all([this.context.resume(), this.element.play()])
  }

  recordingAudio() {
    const destination = this.context.createMediaStreamDestination()
    this.analyser.connect(destination)
    return {
      track: destination.stream.getAudioTracks()[0],
      close: () => {
        this.analyser.disconnect(destination)
        destination.stream.getTracks().forEach(track => track.stop())
      }
    }
  }

  sample(dt) {
    const v = this.values
    if (!this.analyser || this.element.paused || this.element.ended || this.element.seeking ||
        this.element.readyState < 2 || this.context.state !== 'running') return SILENCE
    this.elapsed += dt
    this.analyser.getFloatTimeDomainData(this.wave)
    this.analyser.getFloatFrequencyData(this.spectrum)
    let squares = 0, mean = 0
    for (const value of this.wave) { squares += value * value; mean += value }
    const rms = Math.sqrt(Math.max(0, squares / this.wave.length - (mean / this.wave.length) ** 2))
    this.peak = Math.max(0.0015, follow(this.peak, rms * 1.12, dt, rms > this.peak ? 0.11 : 3.3))
    if (rms < this.peak * 0.34) this.floor = follow(this.floor, Math.min(rms, this.peak * 0.10), dt, rms < this.floor ? 0.15 : 1.55)
    const norm = clamp((rms - this.floor * 1.4 - 0.00008) / Math.max(0.001, this.peak - this.floor))
    const level = Math.pow(norm, 0.63)

    let low = 0, mid = 0, high = 0, total = 0, weighted = 0, growth = 0, magnitude = 0
    const hzPerBin = this.context.sampleRate / this.analyser.fftSize
    for (let i = 1; i < this.spectrum.length && i * hzPerBin <= 12000; i++) {
      const hz = i * hzPerBin
      const amp = 10 ** (Math.max(-120, this.spectrum[i]) / 20)
      const power = amp * amp
      if (hz <= 240) low += power
      else if (hz < 1700) mid += power
      else high += power
      total += power
      weighted += power * Math.log2(1 + hz / 70)
      magnitude += amp
      growth += Math.max(0, amp - this.previous[i])
      this.previous[i] = amp
    }
    const flux = clamp(growth / Math.max(0.005, magnitude) * Math.sqrt(1 / (60 * dt)))
    this.fast = follow(this.fast, level, dt, level > this.fast ? 0.025 : 0.085)
    this.slow = follow(this.slow, level, dt, 0.29)
    this.fluxBase = follow(this.fluxBase, flux, dt, 0.43)
    const rise = this.fast - this.slow
    const transient = Math.max(rise - 0.15, (flux - this.fluxBase - 0.14) * 0.9)
    this.cooldown -= dt
    v.hit = this.elapsed > 0.055 && this.cooldown <= 0 && level > 0.12 && transient > 0.095 ?
      clamp(transient * 2.25, 0.2, 1) : 0
    if (v.hit) this.cooldown = 0.16
    v.level = follow(v.level, level, dt, level > v.level ? 0.038 : 0.12)
    v.sustain = follow(v.sustain, level, dt, level > v.sustain ? 0.21 : 0.47)
    v.low = follow(v.low, total > 1e-12 ? Math.sqrt(low / total) * level : 0, dt, 0.12)
    v.mid = follow(v.mid, total > 1e-12 ? Math.sqrt(mid / total) * level : 0, dt, 0.095)
    v.high = follow(v.high, total > 1e-12 ? Math.sqrt(high / total) * level : 0, dt, 0.075)
    v.centroid = follow(v.centroid, total > 1e-12 ? clamp(weighted / (total * 7.5)) : 0, dt, 0.2)
    v.flux = follow(v.flux, clamp((flux - this.fluxBase * 0.5) * 2) * level, dt, 0.063)
    return v
  }
}

