import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { demoSound } from '../src/demos.js'

const browser = await chromium.launch(process.env.URBAN_BROWSER_PATH ?
  { executablePath: process.env.URBAN_BROWSER_PATH } : { channel: 'msedge' })
const pageUrl = new URL('../dist/index.html', import.meta.url).href
const errors = [], external = []
const prepare = async (forceWebm = false) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  page.setDefaultTimeout(7000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()) })
  if (forceWebm) await page.addInitScript(() => {
    const supported = MediaRecorder.isTypeSupported.bind(MediaRecorder)
    MediaRecorder.isTypeSupported = type => !type.includes('mp4') && supported(type)
  })
  await page.goto(pageUrl)
  await page.waitForFunction(() => document.querySelector('#time').textContent.endsWith('00:10'))
  return page
}
const sample = async page => page.evaluate(() => {
  const src = document.querySelector('#art')
  const small = document.createElement('canvas')
  small.width = 72
  small.height = 54
  const ctx = small.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(src, 0, 0, 72, 54)
  return Array.from(ctx.getImageData(0, 0, 72, 54).data)
})
const difference = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const pad = (page, id) => page.locator('[data-mode="' + id + '"]')
const tune = page => page.locator('.panel > details').evaluate(el => { el.open = true })
async function setMotions(page, modes) {
  const buttons = page.locator('#motion-options button:not([data-mode="echo"])')
  for (const button of await buttons.all()) {
    const enabled = await button.getAttribute('aria-pressed') === 'true'
    if (enabled !== modes.includes(await button.getAttribute('data-mode'))) await button.click()
  }
  assert.equal(await page.locator('#motion-options [aria-pressed="true"]:not([data-mode="echo"])').count(), modes.length)
}
const download = async (page, selector) => {
  const pending = page.waitForEvent('download')
  await page.locator(selector).click()
  const artifact = await pending
  return { name: artifact.suggestedFilename(), bytes: await readFile(await artifact.path()) }
}

async function validateAudioFeatures(page) {
  const { outputFiles } = await build({
    stdin: {
      contents: "export { AudioEngine, prepareAudio } from './audio.js'; export { demoSound } from './demos.js'",
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url))
    },
    format: 'iife', globalName: 'UrbanAudioTest', bundle: true, write: false
  })
  await page.addScriptTag({ content: outputFiles[0].text })
  const stats = await page.evaluate(async () => {
    const { AudioEngine, prepareAudio, demoSound } = UrbanAudioTest
    const engine = new AudioEngine()
    const results = []
    for (let id = 0; id < 6; id++) {
      let sound = demoSound(Math.min(id, 3))
      if (id >= 4) {
        const samples = await sound.arrayBuffer()
        const pcm = new Int16Array(samples, 44)
        if (id === 4) pcm.fill(0)
        else for (let i = 0; i < pcm.length; i++) pcm[i] *= 0.018
        sound = new Blob([samples], { type: 'audio/wav' })
      }
      engine.attach(await prepareAudio(sound))
      await engine.play(true)
      let last = performance.now(), n = 0, hits = 0, low = 0, high = 0, flux = 0, min = 1, max = 0
      while (engine.element.currentTime < 2.8) {
        const now = await new Promise(resolve => requestAnimationFrame(resolve))
        const f = engine.sample(Math.max(0.001, (now - last) / 1000))
        last = now
        if (engine.element.currentTime < 0.4) continue
        n++
        hits += Number(f.hit > 0)
        low += f.low
        high += f.high
        flux += f.flux
        min = Math.min(min, f.sustain)
        max = Math.max(max, f.sustain)
      }
      results.push({ low: low / n, high: high / n, flux: flux / n, hits, swell: max - min, max })
      engine.element.pause()
    }
    URL.revokeObjectURL(engine.url)
    await engine.context.close()
    return results
  })
  assert.ok(stats[0].low > stats[1].low + 0.3)
  assert.ok(stats[1].high > stats[0].high + 0.3)
  assert.ok(stats[2].hits >= 2 && stats[0].hits <= 1)
  assert.ok(stats[3].swell > stats[0].swell + 0.14)
  assert.equal(stats[4].max, 0)
  assert.ok(stats[5].max > 0.13)
  console.log('Low / noise / knocks / swell / silence / quiet analysis:', stats)
}

async function validateEchoes(page) {
  const { outputFiles } = await build({
    stdin: {
      contents: "export { Renderer } from './renderer.js'; export { MotionField } from './motion.js'; export { DEFAULTS } from './settings.js'",
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url))
    },
    format: 'iife', globalName: 'UrbanEchoTest', bundle: true, write: false
  })
  await page.addScriptTag({ content: outputFiles[0].text })
  const results = await page.evaluate(() => {
    const { Renderer, MotionField, DEFAULTS } = UrbanEchoTest
    const original = document.createElement('canvas')
    original.width = 260
    original.height = 180
    const image = { w: 260, h: 180, original, field: () => ({ edge: 0.24, contrast: 0.1, coherence: 0.7, angle: 0.31 }) }
    const renderer = new Renderer(document.createElement('canvas'))
    renderer.setImage(image)
    const settings = { ...DEFAULTS, motions: ['sway'], energy: 0.95, echoOpacity: 0.72 }
    const cells = ['bar', 'squares', 'rings', 'cross'].map((form, i) => ({
      x: 37 + i * 60, y: 80 + (i % 2) * 24, r: 36, w: 34, h: form === 'bar' ? 5 : 34, angle: 0,
      color: [211, 151, 97], alpha: 1, form, layers: 3, outline: false, rank: 0.1, phase: 0.5
    }))
    renderer.setScene({ cells }, settings)
    const motion = new MotionField(image, 71)
    const imageKey = options => {
      renderer.draw({ ...settings, ...options }, motion)
      return renderer.canvas.toDataURL()
    }
    const silent = imageKey({ echo: 'off' }) === imageKey({ echo: 'fan' })
    for (let i = 0; i < 130; i++) motion.step(1 / 120,
      { level: 0.85, low: 0.33, high: 0.76, sustain: 0.63, flux: 0.54, centroid: 0.57, hit: 0 }, settings)
    const types = ['off', 'fan', 'linear', 'bilateral', 'radial', 'trace']
    const distinct = new Set(types.map(echo => imageKey({ echo }))).size
    const auto = imageKey({ echo: 'auto' }) === imageKey({ echo: 'fan' })
    const fan = imageKey({ echo: 'fan', echoLayers: 3, echoAxis: 'right' })
    const adjustments = [
      { echoLayers: 5 }, { echoAxis: 'left' }, { echoSpacing: 1.1 }, { echoOpacity: 0.2 }
    ].map(change => fan !== imageKey({ echo: 'fan', echoLayers: 3, echoAxis: 'right', ...change }))
    const zero = imageKey({ echo: 'trace', echoOpacity: 0 }) === imageKey({ echo: 'off' })
    return { silent, distinct, auto, adjustments, zero }
  })
  assert.deepEqual(results, { silent: true, distinct: 6, auto: true, adjustments: [true, true, true, true], zero: true })
  console.log('Five echo patterns, automatic mapping, silence and all four echo adjustments verified')
}

async function validateVideo(page, forceWebm) {
  await page.locator('#seek').fill('0')
  await page.locator('#record').click()
  await page.waitForFunction(() => document.querySelector('#audio-state').textContent.includes('录制中'))
  await page.waitForTimeout(1800)
  await page.locator('#record').click()
  const { name, bytes } = await download(page, '#video')
  assert.ok(bytes.length > 18000)
  if (forceWebm) assert.ok(name.endsWith('.webm'))
  if (name.endsWith('.mp4')) assert.equal(bytes.subarray(4, 8).toString(), 'ftyp')
  else assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3')
  const info = await page.evaluate(async ({ encoded, type }) => {
    const video = document.createElement('video')
    const data = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([data], { type }))
    video.src = url
    const context = new AudioContext()
    const source = context.createMediaElementSource(video)
    const analyser = context.createAnalyser()
    source.connect(analyser)
    const sink = context.createGain()
    sink.gain.value = 0
    analyser.connect(sink).connect(context.destination)
    const wave = new Float32Array(analyser.fftSize)
    let rms = 0, frameCount = 0
    const onFrame = () => { frameCount++; video.requestVideoFrameCallback(onFrame) }
    video.requestVideoFrameCallback(onFrame)
    try {
      await Promise.all([context.resume(), video.play()])
      for (let i = 0; i < 24; i++) {
        await new Promise(resolve => setTimeout(resolve, 60))
        analyser.getFloatTimeDomainData(wave)
        rms = Math.max(rms, Math.sqrt(wave.reduce((sum, v) => sum + v * v, 0) / wave.length))
      }
      return { width: video.videoWidth, height: video.videoHeight, clock: video.currentTime, frameCount, rms }
    } finally {
      video.pause()
      URL.revokeObjectURL(url)
      await context.close()
    }
  }, { encoded: bytes.toString('base64'), type: name.endsWith('.mp4') ? 'video/mp4' : 'video/webm' })
  assert.ok(info.width > 0 && info.height > 0 && info.clock > 0.6 && info.frameCount > 7, JSON.stringify(info))
  assert.ok(info.rms > 0.004, 'decoded recording must contain actual audio: ' + JSON.stringify(info))
  console.log(name.split('.').at(-1).toUpperCase(), info, bytes.length + ' bytes')
}

async function samplePerformance(page) {
  await page.locator('#reset').click()
  await page.locator('#replay').click()
  const countFrames = () => page.evaluate(() => new Promise(resolve => {
    const started = performance.now()
    let count = 0
    function next(now) {
      count++
      if (now - started >= 1000) resolve(Math.round(count * 1000 / (now - started)))
      else requestAnimationFrame(next)
    }
    requestAnimationFrame(next)
  }))
  const normal = await countFrames()
  const large = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 3000
    canvas.height = 5000
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#bbccb0'
    ctx.fillRect(0, 0, 3000, 5000)
    for (let x = 0; x < 3000; x += 27) {
      ctx.fillStyle = x % 4 ? '#b04d2d' : '#385866'
      ctx.fillRect(x, x / 2, 13, 5000 - x / 2)
    }
    return canvas.toDataURL('image/jpeg', 0.86).split(',')[1]
  })
  await page.locator('#image-file').setInputFiles({
    name: 'large-portrait.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(large, 'base64')
  })
  await page.waitForFunction(() => document.querySelector('#dimensions').textContent === '922 × 1536 PX')
  await setMotions(page, ['breathe', 'stretch', 'spin', 'flow', 'ripple', 'fold', 'sway', 'bounce', 'gather'])
  await tune(page)
  await page.locator('#density').fill('1')
  await page.waitForTimeout(220)
  const dense = await countFrames()
  await page.locator('#play').click()
  console.log('Animation frame pacing (headless Edge, 1440 × 900):', { normal, dense, largePortrait: '3000 × 5000 → 922 × 1536' })
}

async function validateReference(page) {
  const file = process.env.URBAN_REFERENCE
  if (!file) return
  await page.locator('#image-file').setInputFiles(file)
  await page.waitForFunction(() => document.querySelector('#work-subtitle').textContent === '本地图像')
  await frames(page)
  const staticFrame = await sample(page)
  const screenshot = suffix => process.env.URBAN_SCREENSHOT ?
    page.screenshot({ path: process.env.URBAN_SCREENSHOT.replace(/\.png$/, '-' + suffix + '.png') }) : Promise.resolve()
  await screenshot('sunset')
  const regions = await page.evaluate(() => {
    const src = document.querySelector('#art'), probe = document.createElement('canvas')
    probe.width = 96; probe.height = 128
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(src, 0, 0, 96, 128)
    const { data } = ctx.getImageData(0, 0, 96, 128)
    let empty = 0, gold = 0, goldX = 0, shadow = 0, water = 0
    const colors = new Set()
    for (let y = 0; y < 128; y++) for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2]
      if (r === 19 && g === 19 && b === 21) empty++
      if (y > 50 && y < 118 && r > 187 && g > 93 && r - b > 48) { gold++; goldX += x }
      if (x < 59 && y > 74 && r < 62 && r + g + b > 64) shadow++
      if (y > 51 && y < 96 && x > 28 && x < 75 && r > 85 && g > 63) water++
      colors.add([r >> 4, g >> 4, b >> 4].join(':'))
    }
    return { empty, gold, center: goldX / gold, shadow, water, colors: colors.size }
  })
  assert.ok(regions.empty > 2600 && regions.gold > 100 && regions.center > 61 && regions.shadow > 270 && regions.water > 350 && regions.colors > 10,
    JSON.stringify(regions))
  await page.locator('#voxelMin').fill('0')
  await page.locator('#scaleContrast').fill('0')
  await page.waitForTimeout(180)
  const fine = parseInt(await page.locator('#cell-count').textContent())
  const fineFrame = await sample(page)
  await page.locator('#scaleContrast').fill('1')
  await page.waitForTimeout(180)
  assert.ok(difference(await sample(page), fineFrame) > 9)
  await page.locator('#voxelMin').fill('1')
  await page.waitForTimeout(180)
  const coarse = parseInt(await page.locator('#cell-count').textContent())
  assert.ok(fine > coarse * 8, JSON.stringify({ fine, coarse }))
  await page.locator('#reset').click()
  await frames(page)
  await setMotions(page, ['flow', 'fold', 'gather', 'ripple'])
  await tune(page)
  await page.locator('#motion-sliders').locator('..').locator('summary').click()
  await page.locator('#groupAmount').fill('1.1')
  await page.locator('#flipAmount').fill('1.08')
  await page.locator('#spatialDepth').fill('0.88')
  await page.locator('#replay').click()
  let peak = 0
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(420)
    peak = Math.max(peak, difference(await sample(page), staticFrame))
    if (i === 2) await screenshot('sunset-layered')
  }
  assert.ok(peak > 10, 'layered actual-photo motion: ' + peak)
  await page.locator('#play').click()
  await page.waitForTimeout(5600)
  const rest = difference(await sample(page), staticFrame)
  assert.ok(rest < 0.11, 'paused composition must return to rest: ' + rest)
  await page.locator('#reset').click()
  console.log('Actual sunset upload: spatial relationships, voxel limits and playback', regions, { fine, coarse, peak, rest })
}
try {
  const page = await prepare()
  await validateEchoes(page)
  await validateReference(page)
  if (process.env.URBAN_SCREENSHOT) {
    await page.screenshot({ path: process.env.URBAN_SCREENSHOT })
    await page.locator('#replay').click()
    await page.waitForTimeout(1150)
    await page.screenshot({ path: process.env.URBAN_SCREENSHOT.replace(/\.png$/, '-live.png') })
    await page.locator('#play').click()
  }
  const motions = ['breathe', 'stretch', 'spin', 'flow', 'ripple', 'fold', 'sway', 'bounce', 'gather']
  const sounds = [3, 0, 1, 3, 2, 0, 1, 2, 3]
  await tune(page)
  const baselines = []
  for (let i = 0; i < 4; i++) {
    await page.locator('#image-demo').selectOption(String(i))
    await frames(page)
    baselines.push(await sample(page))
  }
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) assert.ok(difference(baselines[i], baselines[j]) > 4)
  await page.locator('#image-demo').selectOption('0')
  await frames(page)
  assert.ok(difference(await sample(page), baselines[0]) < 0.08, 'same seed must reproduce the rendered composition')
  console.log('4 image types produce distinct compositions with the same generator')
  assert.equal(await page.locator('[data-view], [role="tab"], #reference, #split').count(), 0)
  assert.equal(await page.locator('#form-options button').count(), 8)
  const initial = await sample(page)
  for (const button of await page.locator('#form-options button:not([data-mode="circle"])').all()) await button.click()
  assert.equal(await page.locator('#form-options [aria-pressed="true"]').count(), 1)
  await frames(page)
  assert.ok(difference(await sample(page), initial) > 5)
  await pad(page, 'circle').click()
  await frames(page)
  assert.ok((await sample(page)).every((value, i) => value === [19, 19, 21, 255][i % 4]))
  await pad(page, 'circle').click()
  await frames(page)
  const single = await sample(page)
  await page.locator('#reseed').click()
  await frames(page)
  assert.ok(difference(await sample(page), single) > 0.1)

  await page.locator('#reset').click()
  await frames(page)
  const baseline = await sample(page)
  await setMotions(page, [])
  await page.locator('#replay').click()
  await page.waitForTimeout(1150)
  assert.ok(difference(await sample(page), baseline) > 0.10, 'echo alone is visible')
  await pad(page, 'echo').click()
  await frames(page)
  assert.ok(difference(await sample(page), baseline) < 0.15)
  await page.locator('#play').click()
  for (let j = 0; j < motions.length; j++) {
    await setMotions(page, [motions[j]])
    await page.locator('#audio-demo').selectOption(String(sounds[j]))
    await page.locator('#replay').click()
    let peak = 0
    for (let f = 0; f < 3; f++) {
      await page.waitForTimeout(230)
      peak = Math.max(peak, difference(await sample(page), baseline))
    }
    assert.ok(peak > 0.55, motions[j] + ' showed insufficient motion: ' + peak)
    await page.locator('#play').click()
  }
  await setMotions(page, motions)
  await page.locator('#replay').click()
  await page.waitForTimeout(650)
  assert.ok(difference(await sample(page), baseline) > 2)
  await page.locator('#play').click()
  console.log('Icon-only pad groups, all-off canvas, seed reroll, echo alone, individual and layered motion passed')

  await page.locator('#reset').click()
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 840
    canvas.height = 280
    const ctx = canvas.getContext('2d')
    const paint = ctx.createLinearGradient(0, 0, 840, 280)
    paint.addColorStop(0, '#a54722')
    paint.addColorStop(1, '#103d54')
    ctx.fillStyle = paint
    ctx.fillRect(0, 0, 840, 280)
    ctx.fillStyle = '#eee0ab'
    for (let x = 11; x < 840; x += 38) ctx.fillRect(x, 10, 8, 260)
    return canvas.toDataURL().split(',')[1]
  })
  await page.locator('#image-file').setInputFiles({ name: 'test-panorama.png', mimeType: 'image/png', buffer: Buffer.from(imageData, 'base64') })
  await page.waitForFunction(() => document.querySelector('#work-title').textContent === 'test-panorama')
  assert.equal(await page.locator('#dimensions').textContent(), '840 × 280 PX')
  await page.evaluate(async encoded => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], 'drop-wall.png', { type: 'image/png' }))
    document.querySelector('#stage').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  }, imageData)
  await page.waitForFunction(() => document.querySelector('#work-title').textContent === 'drop-wall')
  await page.locator('#image-file').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('bad') })
  await page.waitForFunction(() => document.querySelector('#feedback').textContent.includes('无法读取图片'))
  assert.equal(await page.locator('#work-title').textContent(), 'drop-wall')

  const wav = Buffer.from(await demoSound(2).arrayBuffer())
  await page.locator('#audio-file').setInputFiles({ name: 'test-knocks.wav', mimeType: 'audio/wav', buffer: wav })
  await page.waitForFunction(() => document.querySelector('#audio-name').textContent === 'test-knocks')
  await page.locator('#replay').click()
  await page.waitForFunction(() => document.querySelector('#meter .lit'))
  await page.locator('#play').click()
  await page.waitForFunction(() => document.querySelector('#audio-state').textContent === '已暂停')
  await page.locator('#play').click()
  await page.waitForFunction(() => document.querySelector('#audio-state').textContent === '播放中')
  await page.locator('#play').click()
  await page.locator('#seek').fill('9.85')
  await page.locator('#play').click()
  await page.waitForFunction(() => document.querySelector('#audio-state').textContent === '播放结束')
  await page.locator('#replay').click()
  await page.waitForFunction(() => document.querySelector('#audio-state').textContent === '播放中')
  await page.locator('#play').click()

  await tune(page)
  await pad(page, 'square').click()
  await pad(page, 'cross').click()
  await pad(page, 'echo').click()
  await page.locator('#density').fill('0.83')
  await page.locator('#abstraction').fill('0.68')
  await page.locator('#voxelMin').fill('0.58')
  await page.locator('#scaleContrast').fill('0.91')
  await setMotions(page, ['breathe', 'flow', 'fold'])
  await page.locator('#energy').fill('0.91')
  await page.locator('#echo-details summary').click()
  await page.locator('#echo').selectOption('fan')
  await page.locator('#echoLayers').fill('4')
  await page.locator('#echoOpacity').fill('0.73')
  await page.locator('#echoSpacing').fill('0.88')
  await page.locator('#echoAxis').selectOption('up')
  await page.locator('#persistence').fill('0.61')
  const oldSeed = await page.locator('#seed').inputValue()
  await page.locator('#reseed').click()
  assert.notEqual(await page.locator('#seed').inputValue(), oldSeed)
  const png = await download(page, '#png')
  assert.equal(png.bytes.readUInt32BE(16), 840)
  assert.equal(png.bytes.readUInt32BE(20), 280)
  await page.locator('#fullscreen').click()
  await page.waitForFunction(() => document.fullscreenElement?.id === 'stage')
  await page.evaluate(() => document.exitFullscreen())

  const config = await download(page, '#save-project')
  const settings = JSON.parse(config.bytes).settings
  assert.equal(settings.density, 0.83)
  assert.equal(settings.abstraction, 0.68)
  assert.equal(settings.voxelMin, 0.58)
  assert.equal(settings.scaleContrast, 0.91)
  assert.equal(settings.energy, 0.91)
  assert.equal(settings.persistence, 0.61)
  assert.equal(settings.echoLayers, 4)
  assert.equal(settings.echoOpacity, 0.73)
  assert.equal(settings.echoSpacing, 0.88)
  assert.equal(settings.echoAxis, 'up')
  assert.equal(settings.echoEnabled, false)
  assert.equal(settings.forms.length, 6)
  assert.deepEqual(settings.motions, ['flow', 'fold', 'breathe'])
  await page.locator('#reset').click()
  await page.locator('#project-file').setInputFiles({ name: config.name, mimeType: 'application/json', buffer: config.bytes })
  await page.waitForFunction(() => document.querySelector('#density').value === '0.83')
  assert.equal(await page.locator('#voxelMin').inputValue(), '0.58')
  assert.equal(await page.locator('#scaleContrast').inputValue(), '0.91')
  assert.equal(await page.locator('#energy').inputValue(), '0.91')
  assert.equal(await pad(page, 'square').getAttribute('aria-pressed'), 'false')
  assert.equal(await pad(page, 'cross').getAttribute('aria-pressed'), 'false')
  assert.equal(await pad(page, 'echo').getAttribute('aria-pressed'), 'false')
  assert.equal(await page.locator('#echo').inputValue(), 'fan')
  assert.equal(await page.locator('#motion-options [aria-pressed="true"]').count(), 3)
  await validateVideo(page, false)
  await validateAudioFeatures(page)
  const webm = await prepare(true)
  await validateVideo(webm, true)
  await samplePerformance(webm)
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  console.log('Upload, drag-and-drop, errors, play/pause/seek/replay/end, sliders, fullscreen, PNG, project roundtrip and local recording passed.')
} finally {
  await browser.close()
}



