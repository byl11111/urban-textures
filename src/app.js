import { clamp, hash } from './math.js'
import { analyzeImage, decodeImage } from './image.js'
import { FORMS, generate, voxelFraction } from './geometry.js'
import { MotionField, MOTIONS } from './motion.js'
import { AudioEngine, prepareAudio, SILENCE } from './audio.js'
import { Renderer } from './renderer.js'
import { demoImage, demoSound, imageDemos, soundDemos } from './demos.js'
import { advanced, DEFAULTS, echoSliders, motionSliders, readProject, sliders, voxelSliders } from './settings.js'
import { download, exportPNG, recordCanvas, recordingFormats, RECORD_LIMIT } from './export.js'
import { icon } from './icons.js'

const $ = id => document.getElementById(id)
const canvas = $('art'), stage = $('stage')
const renderer = new Renderer(canvas)
const audio = new AudioEngine()
const element = audio.element
const formNames = ['方形', '长方形', '长线', '十字', '圆形', '圆环', '同心圆', '同心方']
const motionCards = [
  ['flow', '群组迁移', 'TRAVEL', '低频与包络驱动色区跨画面迁移'],
  ['fold', '三维翻转', 'FLIP', '薄片沿空间轴转过侧面与背面'],
  ['gather', '聚散重组', 'GATHER', '改变群组间距与各组内部的相对位置'],
  ['breathe', '呼吸缩放', 'BREATHE', '声压包络带动局部缓慢扩张'],
  ['stretch', '径向拉伸', 'STRETCH', '沿单元的径向伸缩'],
  ['spin', '几何自转', 'SPIN', '随声音旋转与局部绕行'],
  ['ripple', '局部波动', 'RIPPLE', '波峰从局部出发并向外传播'],
  ['sway', '方向摆动', 'SWAY', '高频和节奏带动轴向偏转'],
  ['bounce', '弹性跳动', 'BOUNCE', '敲击推动单元弹出与回弹']
]
const sliderMeta = [...sliders, ...voxelSliders, ...motionSliders, ...echoSliders, ...advanced]
const meter = []
const imageCache = new Map(), soundCache = new Map()
const canRecord = typeof canvas.captureStream === 'function' && recordingFormats().length > 0
let settings = { ...DEFAULTS }, image, field, imageSource, soundSource
let imageVersion = 0, soundVersion = 0, imageBusy = false, soundBusy = false, projectBusy = false
let recording, recorded, stopping = false, starting = false, playPending = false
let recordStarted = 0, recordTimer, preferWebm = false
let frame = 0, lastFrame = 0, displayTick = 0, generation = 0, noticeTimer
let averageCost = 0, pressure = 0

function label(node, glyph, value = '') {
  node.innerHTML = icon(glyph, glyph === 'brand' ? 23 : 15)
  if (value) {
    const span = document.createElement('span')
    span.textContent = value
    node.append(span)
  }
}

for (const node of document.querySelectorAll('[data-icon]')) label(node, node.dataset.icon, node.dataset.label)
function populatePads(id, options, key) {
  for (const [value, name] of options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'pad'
    button.dataset.mode = value
    button.title = name
    button.setAttribute('aria-label', name)
    button.innerHTML = icon(value, 24)
    button.onclick = () => {
      if (value === 'echo') settings.echoEnabled = !settings.echoEnabled
      else settings[key] = (key === 'forms' ? FORMS : MOTIONS).filter(mode =>
        mode === value ? !settings[key].includes(mode) : settings[key].includes(mode))
      if (key === 'forms') rebuild()
      else wake()
      syncSettings()
    }
    $(id).append(button)
  }
}
populatePads('form-options', FORMS.map((form, index) => [form, formNames[index]]), 'forms')
populatePads('motion-options', [...motionCards, ['echo', '重影']], 'motions')

function rangeFill(input) {
  const percent = 100 * (+input.value - +input.min) / Math.max(0.001, +input.max - +input.min)
  input.style.setProperty('--pct', percent + '%')
}
function sliderText(key) {
  if (key === 'echoLayers') return settings[key] + ' 层'
  if (key === 'voxelMin') return (voxelFraction(settings.voxelMin) * 100).toFixed(1) + '% 短边'
  return ['scale', 'local', 'tension'].includes(key) ? settings[key].toFixed(2) + '×' : Math.round(settings[key] * 100) + '%'
}
function buildSliders(id, entries) {
  for (const [key, name, , min, max, help, step = 0.01] of entries) {
    const wrap = document.createElement('div')
    wrap.className = 'slider'
    wrap.title = help
    wrap.innerHTML = '<label class="slider-head" for="' + key + '">' + name +
      '<output id="' + key + '-value"></output></label><input type="range" id="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '">'
    $(id).append(wrap)
    $(key).oninput = () => {
      settings[key] = +$(key).value
      $(key + '-value').textContent = sliderText(key)
      rangeFill($(key))
      if (['density', 'scale', 'threshold', 'depth', 'abstraction', 'scaleContrast', 'voxelMin'].includes(key)) {
        clearTimeout(generation)
        generation = setTimeout(() => rebuild(), 110)
      } else if (key === 'colorfulness') renderer.palette(settings)
      wake()
    }
  }
}
buildSliders('sliders', sliders)
buildSliders('voxel-sliders', voxelSliders)
buildSliders('motion-sliders', motionSliders)
buildSliders('echo-sliders', echoSliders)
buildSliders('advanced', advanced)
for (const [value, name] of motionCards) $('pad-mode').add(new Option(name, value))
function syncGain() {
  const input = $('pad-gain')
  input.value = settings.padGains[$('pad-mode').value] ?? 1
  $('pad-gain-value').textContent = Math.round(+input.value * 100) + '%'
  rangeFill(input)
}
$('pad-mode').onchange = syncGain
$('pad-gain').oninput = () => {
  settings.padGains = { ...settings.padGains, [$('pad-mode').value]: +$('pad-gain').value }
  syncGain()
  wake()
}
for (let i = 0; i < 16; i++) {
  const bar = document.createElement('i')
  bar.style.setProperty('--h', 0.16 + hash(i + 77) * 0.84)
  meter.push(bar)
  $('meter').append(bar)
}

function demoOptions(id, items, empty) {
  $(id).add(new Option(empty, ''))
  items.forEach((name, index) => $(id).add(new Option(name, String(index))))
}
demoOptions('image-demo', imageDemos, '选择样本')
demoOptions('audio-demo', soundDemos, '示例声音')
function notice(text, error = false) {
  $('feedback').textContent = text
  $('feedback').setAttribute('role', error ? 'alert' : 'status')
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { $('feedback').textContent = '' }, error ? 6500 : 4200)
}
const report = error => notice(error instanceof Error ? error.message : String(error), true)
const time = value => {
  const n = Math.max(0, Math.floor(value || 0))
  return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0')
}
const fileTitle = name => name.replace(/\.[^./]+$/, '').trim() || name
const mediaLocked = () => Boolean(recording || stopping || starting || projectBusy)
const filename = () => 'urban-textures-' + settings.seed + '-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-')
const staticImage = id => {
  if (!imageCache.has(id)) imageCache.set(id, analyzeImage(demoImage(id)))
  return imageCache.get(id)
}
const staticSound = id => {
  if (!soundCache.has(id)) soundCache.set(id, demoSound(id))
  return soundCache.get(id)
}

function fit() {
  if (!image) return
  const presentation = $('plate').parentElement
  const ratio = canvas.width / canvas.height
  const margin = document.fullscreenElement ? 2 : presentation.clientWidth < 600 ? 24 : 56
  const h = Math.max(1, presentation.clientHeight - margin)
  const available = Math.max(1, presentation.clientWidth - margin)
  const width = Math.max(1, Math.min(available, h * ratio))
  $('plate').style.width = Math.min(available, Math.max(212, width)) + 'px'
  const wrap = canvas.parentElement
  wrap.style.width = width + 'px'
  wrap.style.height = Math.max(1, width / ratio) + 'px'
  wrap.style.justifySelf = 'center'
}
new ResizeObserver(fit).observe($('plate').parentElement)

function resetMotion() {
  field = new MotionField(image, settings.seed, renderer.scene?.groups)
}

function rebuild() {
  clearTimeout(generation)
  if (!image) return
  const scene = generate(image, settings)
  renderer.setScene(scene, settings)
  resetMotion()
  $('cell-count').textContent = scene.cells.length.toLocaleString('zh-CN') + ' 单元'
  wake()
}

function setImage(next, source) {
  image = next
  imageSource = source
  renderer.setImage(image)
  $('image-name').textContent = fileTitle(source.name)
  $('image-name').title = source.name
  $('image-demo').value = source.demo ?? ''
  $('work-title').textContent = fileTitle(source.name)
  $('work-title').title = source.name
  $('work-subtitle').textContent = source.demo === null ? '本地图像' : '示例图像'
  $('dimensions').textContent = canvas.width + ' × ' + canvas.height + ' PX'
  rebuild()
  fit()
}

async function setSound(blob, source, force = false) {
  if (mediaLocked() && !force) return
  const ticket = ++soundVersion
  soundBusy = true
  syncMedia()
  let url
  try {
    url = await prepareAudio(blob)
    if (ticket !== soundVersion) { URL.revokeObjectURL(url); return }
    audio.attach(url)
    soundSource = source
    $('audio-name').textContent = fileTitle(source.name)
    $('audio-name').title = source.name
    $('audio-demo').value = source.demo ?? ''
    resetMotion()
    wake()
  } catch (error) {
    if (ticket === soundVersion) {
      $('audio-demo').value = soundSource?.demo ?? ''
      report(error)
    }
  } finally {
    if (ticket === soundVersion) { soundBusy = false; syncMedia() }
  }
}

async function importImage(file) {
  if (!file || mediaLocked()) return
  const ticket = ++imageVersion
  imageBusy = true
  syncMedia()
  $('image-name').textContent = '正在读取图像…'
  try {
    const decoded = await decodeImage(file)
    if (ticket !== imageVersion) return
    setImage(analyzeImage(decoded), { name: file.name, demo: null })
    notice('图像已转译。')
  } catch (error) {
    if (ticket !== imageVersion) return
    $('image-name').textContent = fileTitle(imageSource.name)
    report(error)
  } finally {
    if (ticket === imageVersion) { imageBusy = false; syncMedia() }
  }
}
function importSound(file) {
  if (file) void setSound(file, { name: file.name, demo: null })
}
function fileInput(id, button, handler) {
  $(button).onclick = () => $(id).click()
  $(id).onchange = () => {
    const file = $(id).files[0]
    $(id).value = ''
    if (file) handler(file)
  }
}
fileInput('image-file', 'image-drop', importImage)
fileInput('audio-file', 'audio-drop', importSound)
$('image-demo').onchange = () => {
  if (mediaLocked() || !$('image-demo').value) { $('image-demo').value = imageSource.demo ?? ''; return }
  const id = +$('image-demo').value
  imageVersion++
  imageBusy = false
  setImage(staticImage(id), { name: imageDemos[id], demo: id })
  syncMedia()
}
$('audio-demo').onchange = () => {
  if (!$('audio-demo').value) { $('audio-demo').value = soundSource?.demo ?? ''; return }
  const id = +$('audio-demo').value
  void setSound(staticSound(id), { name: soundDemos[id], demo: id })
}
const dragging = event => Array.from(event.dataTransfer?.types ?? []).includes('Files')
for (const target of [$('image-drop'), $('audio-drop'), stage]) {
  target.ondragover = event => {
    if (!dragging(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = mediaLocked() ? 'none' : 'copy'
    if (!mediaLocked()) target.classList.add('dragging')
  }
  target.ondragleave = event => { if (!target.contains(event.relatedTarget)) target.classList.remove('dragging') }
  target.ondrop = event => {
    event.preventDefault()
    target.classList.remove('dragging')
    if (mediaLocked()) { notice('请在当前操作结束后更换素材。'); return }
    const files = [...event.dataTransfer.files]
    if (!files.length) return
    if (target.id === 'image-drop') return void importImage(files[0])
    if (target.id === 'audio-drop') return importSound(files[0])
    const imageFile = files.find(f => f.type.startsWith('image/') || /\.(png|jpe?g|webp|avif|gif|bmp|heic|heif|svg)$/i.test(f.name))
    const audioFile = files.find(f => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|aac|opus|mp4|webm)$/i.test(f.name))
    if (imageFile) void importImage(imageFile)
    if (audioFile) importSound(audioFile)
    if (!imageFile && !audioFile) notice('请选择浏览器可解码的图像或声音文件。', true)
  }
}
window.addEventListener('dragover', event => { if (dragging(event)) event.preventDefault() })
window.addEventListener('drop', event => { if (dragging(event)) event.preventDefault() })

function syncSettings() {
  syncGain()
  for (const [key] of sliderMeta) {
    $(key).value = settings[key]
    $(key + '-value').textContent = sliderText(key)
    rangeFill($(key))
  }
  for (const button of $('form-options').children) button.setAttribute('aria-pressed', settings.forms.includes(button.dataset.mode))
  for (const button of $('motion-options').children) button.setAttribute('aria-pressed',
    button.dataset.mode === 'echo' ? settings.echoEnabled : settings.motions.includes(button.dataset.mode))
  $('form-count').textContent = settings.forms.length + ' / ' + FORMS.length
  $('active-count').textContent = (settings.motions.length + Number(settings.echoEnabled)) + ' / ' + (MOTIONS.length + 1)
  for (const key of ['palette', 'background', 'seed', 'echo', 'echoAxis']) $(key).value = settings[key]
}

function syncMedia() {
  const locked = mediaLocked(), playing = !element.paused && !element.ended
  $('image-drop').disabled = $('image-demo').disabled = $('audio-drop').disabled = $('audio-demo').disabled = locked
  $('open-project').disabled = locked || imageBusy || soundBusy
  $('play').disabled = $('replay').disabled = $('seek').disabled = !audio.url || soundBusy || starting || playPending || projectBusy
  label($('play'), playing ? 'pause' : 'play', playing ? '暂停' : '播放')
  $('play').title = playing ? '暂停' : '播放'
  $('play').setAttribute('aria-label', $('play').title)
  $('record').disabled = !canRecord || !audio.url || imageBusy || soundBusy || projectBusy || starting || stopping || playPending
  $('record').classList.toggle('active', Boolean(recording))
  $('record').title = !canRecord ? '浏览器未提供画布视频录制。请使用 Chrome 或 Edge。' :
    recording ? '停止录制' : !audio.url ? '导入音频后开始录制' : '录制当前画布和声音 · 最长 90 秒'
  label($('record'), recording ? 'stop' : 'record', recording ? '停止录制' :
    stopping ? '正在封装…' : starting ? '正在启动…' : canRecord ? '录制视频' : '录制不可用')
  $('video').hidden = !recorded || Boolean(recording || stopping || starting)
  if (recorded) label($('video'), 'download', '下载 ' + recorded.extension.toUpperCase())
  syncTime()
}

function syncTime() {
  const duration = Number.isFinite(element.duration) ? element.duration : 0
  $('time').textContent = time(element.currentTime) + ' / ' + time(duration)
  $('seek').max = duration || 1
  $('seek').value = element.currentTime || 0
  rangeFill($('seek'))
  const elapsed = Math.max(0, (performance.now() - recordStarted) / 1000)
  $('audio-state').textContent = recording ? '● 录制中 ' + time(elapsed) + ' · ' + recording.format :
    stopping ? '正在封装' : element.ended ? '播放结束' : element.paused ? (element.currentTime > 0 ? '已暂停' : '静态预览') : '播放中'
}

function wake() {
  if (!frame) frame = requestAnimationFrame(tick)
}
function tick(now) {
  frame = 0
  if (!field) return
  const dt = lastFrame ? clamp((now - lastFrame) / 1000, 0.001, 0.05) : 1 / 60
  const started = performance.now()
  const playing = !element.paused && !element.ended
  const values = playing ? audio.sample(dt) : SILENCE
  const steps = Math.ceil(dt * 120 - 0.000001)
  for (let i = 0; i < steps; i++) field.step(dt / steps, i === 0 || !values.hit ? values : { ...values, hit: 0 }, settings)
  const active = playing || Boolean(recording) || field.activity > 0.0025
  renderer.draw(settings, field)
  if (active) {
    averageCost += ((performance.now() - started) - averageCost) * 0.05
    if (averageCost > 14) pressure = Math.min(100, pressure + 2)
    else if (averageCost < 8) pressure = Math.max(0, pressure - 1)
    if (pressure > 70) renderer.quality = 0.7
    if (pressure < 8) renderer.quality = 1
  }
  if (!active || now - displayTick > 100) {
    syncTime()
    const signal = Math.round(Math.min(1, values.level) * meter.length)
    meter.forEach((bar, i) => bar.classList.toggle('lit', i < signal))
    $('runtime').textContent = renderer.quality < 1 ? '自适应渲染' : '画布就绪'
    displayTick = now
  }
  lastFrame = active ? now : 0
  if (active) wake()
}

async function play(restart) {
  if (soundBusy || projectBusy || playPending || starting || !audio.url) return
  if (!element.paused && !element.ended && !restart) { element.pause(); return }
  playPending = true
  if (restart || element.ended) resetMotion()
  syncMedia()
  try { await audio.play(restart) }
  catch { notice('播放失败。请重新选择可解码的音频，再点播放。', true) }
  finally { playPending = false; syncMedia(); wake() }
}
$('play').onclick = () => void play(false)
$('replay').onclick = () => void play(true)
$('seek').oninput = () => {
  if (!Number.isFinite(element.duration)) return
  element.currentTime = +$('seek').value
  audio.reset()
  resetMotion()
  wake()
}
for (const event of ['play', 'pause', 'ended', 'loadedmetadata', 'durationchange']) {
  element.addEventListener(event, () => { syncMedia(); wake() })
}
element.addEventListener('error', () => { if (audio.url) notice('播放时无法解码此音频。请替换文件。', true) })

$('palette').onchange = () => { settings.palette = $('palette').value; renderer.palette(settings); wake() }
$('background').oninput = () => { settings.background = $('background').value; renderer.palette(settings); wake() }
for (const key of ['echo', 'echoAxis']) $(key).onchange = () => { settings[key] = $(key).value; wake() }
$('seed').onchange = () => {
  settings.seed = Math.round(clamp(Number($('seed').value) || 0, 0, 4294967295))
  $('seed').value = settings.seed
  rebuild()
}
$('reseed').onclick = () => {
  settings.seed = crypto.getRandomValues(new Uint32Array(1))[0]
  $('seed').value = settings.seed
  rebuild()
  notice('已刷新布局。种子 ' + settings.seed)
}
$('reset').onclick = () => {
  settings = { ...DEFAULTS }
  syncSettings()
  rebuild()
  notice('已恢复默认参数。')
}

$('fullscreen').disabled = !document.fullscreenEnabled
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await stage.requestFullscreen()
  } catch { notice('当前浏览器或窗口无法进入全屏。', true) }
}
document.addEventListener('fullscreenchange', fit)
$('png').onclick = async () => {
  try {
    renderer.draw(settings, field)
    await exportPNG(canvas, filename())
    notice('PNG 已生成。')
  } catch (error) { report(error) }
}

function stopRecording() {
  if (!recording) return
  clearTimeout(recordTimer)
  const take = recording
  recording = null
  stopping = true
  take.stop()
  syncMedia()
}
$('record').onclick = async () => {
  if (recording) { stopRecording(); return }
  if ($('record').disabled) return
  starting = true
  syncMedia()
  const shouldPlay = element.paused || element.ended
  try {
    audio.init()
    // Connect the recorder before playback, so a new take includes the first transient.
    const resumed = audio.context.resume()
    void resumed.catch(() => {})
    if (element.ended || element.currentTime >= element.duration - 0.035) {
      element.currentTime = 0
      audio.reset()
      resetMotion()
    }
    renderer.draw(settings, field)
    const name = filename()
    recording = recordCanvas(canvas, audio, (blob, extension) => {
      recorded = { blob, extension, name }
      stopping = false
      syncMedia()
      notice('录制完成 · 点击下载 ' + extension.toUpperCase() + '。')
    }, (error, mp4Failed) => {
      clearTimeout(recordTimer)
      recording = null
      stopping = false
      if (mp4Failed) preferWebm = true
      syncMedia()
      report(mp4Failed ? 'MP4 编码中断。再次录制将优先尝试 WebM。' : error)
    }, preferWebm)
    recordStarted = performance.now()
    recordTimer = setTimeout(stopRecording, RECORD_LIMIT * 1000)
    const playing = shouldPlay ? audio.play() : Promise.resolve()
    await Promise.all([resumed, playing])
    if (recording) notice('开始录制 ' + recording.format + ' · 最长 ' + RECORD_LIMIT + ' 秒。')
  } catch (error) {
    stopRecording()
    report(error)
  } finally {
    starting = false
    syncMedia()
    wake()
  }
}
$('video').onclick = () => {
  if (recorded) download(recorded.blob, recorded.name + '.' + recorded.extension)
}
$('save-project').onclick = () => {
  const project = { format: 'urban-textures', version: 5, settings, image: imageSource, audio: soundSource }
  download(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), filename() + '.json')
  notice('配置已保存。个人图片与声音请一起保留。')
}
fileInput('project-file', 'open-project', async file => {
  if (mediaLocked() || imageBusy || soundBusy) return
  projectBusy = true
  syncMedia()
  try {
    if (file.size > 64000) throw Error('配置文件过大。')
    const project = readProject(await file.text())
    const missing = []
    element.pause()
    settings = project.settings
    if (project.image?.demo != null) setImage(staticImage(project.image.demo), project.image)
    else if (project.image?.name !== imageSource?.name) {
      if (project.image) missing.push('图像「' + project.image.name + '」')
      setImage(staticImage(0), { name: imageDemos[0], demo: 0 })
    } else rebuild()
    if (project.audio?.demo != null) await setSound(staticSound(project.audio.demo), project.audio, true)
    else if (project.audio?.name !== soundSource?.name) {
      if (project.audio) missing.push('声音「' + project.audio.name + '」')
      await setSound(staticSound(3), { name: soundDemos[3], demo: 3 }, true)
    } else {
      if (audio.url) element.currentTime = 0
      audio.reset()
    }
    syncSettings()
    notice(missing.length ? '参数已恢复。请重新导入 ' + missing.join('、') + '。' : '作品配置已恢复。', Boolean(missing.length))
  } catch (error) { report(error) }
  finally { projectBusy = false; syncMedia(); wake() }
})

setImage(staticImage(0), { name: imageDemos[0], demo: 0 })
syncSettings()
syncMedia()
void setSound(staticSound(3), { name: soundDemos[3], demo: 3 })

