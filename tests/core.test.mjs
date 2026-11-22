import test from 'node:test'
import assert from 'node:assert/strict'
import { MotionField, MOTIONS } from '../src/motion.js'
import { generate, FORMS } from '../src/geometry.js'
import { readProject, DEFAULTS } from '../src/settings.js'
import { plane, point, facing } from '../src/projection.js'
import { SILENCE } from '../src/audio.js'

const features = (x, y) => {
  const color = Math.hypot(x - 344, y - 44) < 15 ? [255, 234, 107] :
    y < 95 ? [224, 159 + x / 11, 123] : y < 107 ? [46, 64, 80] :
    x > 340 && x < 364 ? [255, 191, 54] : x > 75 && x < 181 && y > 173 ? [23, 24, 40] :
      [105 + y / 9, 114 + y / 14, 155 - y / 15]
  return { alpha: 1, color, edge: 0.11 + 0.11 * Math.abs(Math.sin(x / 43)), contrast: 0.12, angle: 0,
    coherence: 0.70, lum: color.reduce((a, b) => a + b, 0) / 765 }
}
const image = { w: 440, h: 300, region: features, field: features }
const acoustic = { level: 0.98, sustain: 0.91, high: 0.46, mid: 0.78, low: 0.76, centroid: 0.59, flux: 0.36, hit: 0 }

test('source positions, overlap, scale hierarchy and form filters survive layout changes', () => {
  const settings = { ...DEFAULTS, density: 0.72, depth: 0.76 }
  const { cells, groups } = generate(image, settings)
  assert.ok(groups.some(g => g.x > image.w * 0.70 && g.color[0] > 200 && g.color[2] < 130))
  assert.ok(groups.some(g => g.x < image.w * 0.45 && g.y > image.h * 0.65 && g.color[0] < 50))
  assert.deepEqual(new Set(cells.map(c => c.tier)), new Set(['large', 'medium', 'detail']))
  assert.deepEqual(new Set(cells.map(c => c.form)), new Set(FORMS))
  assert.ok(Math.max(...cells.map(c => c.r)) / Math.min(...cells.map(c => c.r)) > 8)
  const overlaps = cells.some((a, i) => cells.slice(0, i).some(b =>
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2))
  assert.ok(overlaps)
  assert.deepEqual(generate(image, settings).cells, cells)
  assert.notDeepEqual(generate(image, { ...settings, seed: 24018 }).cells, cells)
  for (const form of FORMS) {
    const limited = generate(image, { ...settings, forms: [form] }).cells
    assert.ok(limited.length >= 3)
    assert.ok(limited.every(c => c.form === form))
  }
  assert.equal(generate(image, { ...settings, forms: [] }).cells.length, 0)
})

test('voxel controls change count and scale spread; reseeding rotates the dominant forms', () => {
  const scene = (voxelMin, scaleContrast, seed = 24017) =>
    generate(image, { ...DEFAULTS, voxelMin, scaleContrast, seed }).cells
  const fine = scene(0, 1), coarse = scene(1, 1), even = scene(0, 0)
  const spread = cells => {
    const sizes = cells.map(cell => cell.r).sort((a, b) => a - b)
    return sizes[Math.floor(sizes.length * 0.95)] / sizes[Math.floor(sizes.length * 0.05)]
  }
  assert.ok(fine.length > coarse.length * 8)
  assert.ok(spread(fine) > spread(even) * 2)
  const dominant = [24017, 38122, 60981].map(seed => scene(0.49, 0.76, seed).filter(cell => cell.tier === 'large'))
  assert.equal(new Set(dominant.map(cells => cells.map(cell => cell.form).join(','))).size, 3)
  for (const form of ['cross', 'ring', 'rings', 'squares', 'bar']) {
    assert.ok(dominant.some(cells => cells.some(cell => cell.form === form)), form)
  }
})

test('group travel, reassembly and flip are distinct, layer safely, and settle on silence', () => {
  const { groups } = generate(image, DEFAULTS)
  groups.push({ id: groups.length, x: 3, y: image.h - 3, angle: 0 })
  const focus = groups.find(g => g.x > 90 && g.x < 350 && g.y > 60 && g.y < 230) ?? groups[0]
  const signatures = new Set()
  for (const motions of [...MOTIONS.map(mode => [mode]), MOTIONS]) {
    const settings = { ...DEFAULTS, motions, energy: 1, persistence: 0.53, local: 1, groupAmount: 1.18, flipAmount: 1.1,
      padGains: { flow: 1, fold: 1, gather: 1 } }
    const field = new MotionField(image, 33, groups)
    const samples = []
    let x = 0, angle = 0, regroup = 0, activity = 0
    for (let i = 0; i < 680; i++) {
      field.step(1 / 120, { ...acoustic, hit: i % 81 === 0 ? 0.77 : 0 }, settings)
      const d = field.at(focus.x, focus.y, {}, 0, focus.id)
      assert.ok(Object.values(d).every(Number.isFinite))
      assert.ok(Math.abs(d.x) < image.w && Math.abs(d.y) < image.h)
      const b = field.at(focus.x + 48, focus.y, {}, 0, focus.id)
      regroup = Math.max(regroup, Math.abs(d.x - b.x) + Math.abs(d.y - b.y))
      x = Math.max(x, Math.abs(d.x))
      angle = Math.max(angle, Math.abs(d.flipX), Math.abs(d.flipY))
      activity = Math.max(activity, field.activity)
      if (i % 20 === 0) samples.push([d.x, d.y, d.zoom, d.angle, d.stretch, d.flipX, d.flipY, d.groupTurn].map(v => v.toFixed(3)).join(','))
    }
    if (motions.length === 1 && motions[0] === 'flow') assert.ok(x > image.w * 0.30, 'group crosses a substantial part of the canvas')
    if (motions.length === 1 && motions[0] === 'fold') assert.ok(angle > Math.PI, 'passes through a full back face')
    if (motions.length === 1 && motions[0] === 'gather') assert.ok(regroup > 15, 'changes internal group spacing')
    assert.ok(activity > 0.04, motions.join(','))
    signatures.add(samples.join('|'))
    for (let i = 0; i < 1000; i++) field.step(1 / 120, SILENCE, settings)
    assert.ok(field.activity < 0.0025, motions.join(',') + ' should settle')
  }
  assert.equal(signatures.size, MOTIONS.length + 1)
})

test('perspective rotates a plane through edge-on and changes visible side', () => {
  const cell = { ux: 1, uy: 0 }
  const pose = { x: 200, y: 150, angle: 0, sx: 1, sy: 1, stretch: 0, depth: 0, flipX: 0, flipY: 0 }
  const view = () => plane(cell, pose, 400, 300, 0.9, {})
  const front = view()
  assert.equal(facing(front), 1)
  pose.flipY = Math.PI / 4
  const tilted = view()
  const near = Math.abs(point(-70, -40, 0, tilted, {}).y - point(-70, 40, 0, tilted, {}).y)
  const far = Math.abs(point(70, -40, 0, tilted, {}).y - point(70, 40, 0, tilted, {}).y)
  assert.ok(near > far * 1.18)
  pose.flipY = Math.PI / 2
  const edge = view()
  assert.ok(Math.abs(point(-70, 0, 0, edge, {}).x - point(70, 0, 0, edge, {}).x) < 0.001)
  pose.flipY = Math.PI
  assert.equal(facing(view()), -1)
})

test('old projects migrate; layered pad gains are validated', () => {
  const old = readProject(JSON.stringify({ format: 'urban-textures', version: 1,
    settings: { geometry: 'filament', motion: 'tremble', density: 200, seed: -2, background: '<x>' } }))
  assert.deepEqual(old.settings.forms, FORMS)
  assert.deepEqual(old.settings.motions, ['sway'])
  assert.equal(old.settings.density, 1)
  assert.equal(old.settings.seed, 0)
  assert.equal(old.settings.background, DEFAULTS.background)
  assert.throws(() => readProject('{"settings":{}}'))
  const layered = readProject(JSON.stringify({ format: 'urban-textures', version: 5, settings: {
    forms: ['ring', 'rect', 'ring', 'unknown'], echoEnabled: false, motions: ['breathe', 'flow', 'breathe', 'unknown'], padGains: { flow: 8, fold: -1, gather: 0.57 }
  } }))
  assert.deepEqual(layered.settings.forms, ['rect', 'ring'])
  assert.equal(layered.settings.echoEnabled, false)
  assert.deepEqual(layered.settings.motions, ['flow', 'breathe'])
  assert.deepEqual(layered.settings.padGains, { flow: 1.25, fold: 0, gather: 0.57 })
})



