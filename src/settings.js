import { clamp } from './math.js'
import { FORMS } from './geometry.js'
import { MOTIONS } from './motion.js'
import { ECHOES, ECHO_AXES } from './renderer.js'

export const DEFAULTS = Object.freeze({
  forms: Object.freeze([...FORMS]), motions: Object.freeze(['breathe', 'ripple', 'sway']), density: 0.49, energy: 0.62, persistence: 0.48,
  scale: 1, colorfulness: 1, local: 1, tension: 1, threshold: 0.41, depth: 0.43, abstraction: 0.56, voxelMin: 0.49, scaleContrast: 0.76,
  groupAmount: 0.48, flipAmount: 0.59, spatialDepth: 0.57, padGains: Object.freeze({ flow: 0.84, fold: 0.80, gather: 0.83 }),
  echoEnabled: true, echo: 'auto', echoAxis: 'auto', echoLayers: 3, echoOpacity: 0.31, echoSpacing: 0.60,
  background: '#131315', palette: 'original', seed: 24017
})

export const sliders = [
  ['density', '细节密度', 'DENSITY', 0, 1, '改变焦点附近的图形数量。'],
  ['abstraction', '色彩归纳', 'FORM', 0, 1, '调整相近色彩归并的程度。'],
  ['energy', '声音响应', 'RESPONSE', 0, 1, '改变声音施加的动力和局部影响范围。']
]
export const voxelSliders = [
  ['voxelMin', '最小基础体素', '', 0, 1, '以画布短边为基准。提高后，切分更早停止，画面中的元素会更少、更大。'],
  ['scaleContrast', '体素大小差异', '', 0, 1, '从大小接近的形体过渡到少量巨形与密集细形。']
]
export const advanced = [
  ['depth', '细节深度', '', 0, 1, '调整局部细分。'],
  ['scale', '基础大小', '', 0.65, 1.75, '调整基础元素的比例。'],
  ['persistence', '运动余韵', '', 0, 1, '从干脆回落过渡到较长的惯性与回弹。'],
  ['colorfulness', '色彩保留', '', 0, 1.35, '调整保留的原图色彩浓度。'],
  ['local', '局部振幅', '', 0.4, 1.4, '限制局部形变的幅度。'],
  ['tension', '回弹刚度', '', 0.55, 1.55, '改变运动回到平衡点的速度。'],
  ['threshold', '结构阈值', '', 0, 1, '调高后只突出更强的纹理和边缘。']
]
export const motionSliders = [
  ['groupAmount', '群组行程', '', 0, 1.20, '群组在画面中迁移与聚散的距离。'],
  ['flipAmount', '翻转角度', '', 0, 1.15, '提高后薄片可以越过侧面与背面。'],
  ['spatialDepth', '空间深度', '', 0, 1, '调整透视与前后层距。']
]
export const echoSliders = [
  ['echoLayers', '残像层数', '', 1, 5, '每个元素最多保留几层轮廓。', 1],
  ['echoOpacity', '残像强度', '', 0, 1, '调整残像轮廓透明度。'],
  ['echoSpacing', '残像间距', '', 0.15, 1.15, '调整轮廓的空间间距或轨迹取样间隔。']
]

export function readProject(text) {
  let data
  try { data = JSON.parse(text) }
  catch { throw Error('配置文件不是有效的 JSON。') }
  if (data?.format !== 'urban-textures' || ![1, 2, 3, 4, 5].includes(data.version) || !data.settings || typeof data.settings !== 'object') {
    throw Error('请选择本工具保存的作品配置。')
  }
  const source = data.settings, settings = { ...DEFAULTS }
  for (const [key, , , min, max] of [...sliders, ...voxelSliders, ...advanced, ...motionSliders, ...echoSliders, ['seed', '', '', 0, 4294967295]]) {
    if (Number.isFinite(source[key])) settings[key] = clamp(source[key], min, max)
  }
  settings.seed = Math.round(settings.seed)
  settings.echoLayers = Math.round(settings.echoLayers)
  for (const [key, choices] of [
    ['echo', ECHOES], ['echoAxis', ECHO_AXES], ['palette', ['original', 'warm', 'mono']]
  ]) {
    if (choices.includes(source[key])) settings[key] = source[key]
  }
  if (Array.isArray(source.forms)) settings.forms = FORMS.filter(form => source.forms.includes(form))
  if (typeof source.echoEnabled === 'boolean') settings.echoEnabled = source.echoEnabled
  if (settings.echo === 'off') { settings.echo = 'auto'; settings.echoEnabled = false }
  if (data.version < 3) {
    const mode = source.motion === 'tremble' ? 'sway' : source.motion
    if (MOTIONS.includes(mode)) settings.motions = [mode]
  } else if (Array.isArray(source.motions)) settings.motions = MOTIONS.filter(mode => source.motions.includes(mode))
  if (source.padGains && typeof source.padGains === 'object') {
    settings.padGains = { ...DEFAULTS.padGains }
    for (const mode of MOTIONS) if (Number.isFinite(source.padGains[mode])) settings.padGains[mode] = clamp(source.padGains[mode], 0, 1.25)
  }
  if (typeof source.background === 'string' && /^#[0-9a-f]{6}$/i.test(source.background)) settings.background = source.background
  const media = entry => entry && typeof entry.name === 'string' ?
    { name: entry.name.slice(0, 260), demo: Number.isInteger(entry.demo) && entry.demo >= 0 && entry.demo < 4 ? entry.demo : null } : null
  return { settings, image: media(data.image), audio: media(data.audio) }
}

