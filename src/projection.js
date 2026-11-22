import { clamp, mix } from './math.js'

export function plane(cell, pose, w, h, depth, out) {
  const x = pose.flipX, y = pose.flipY, z = pose.angle
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z)
  const stretch = pose.stretch, ux = cell.ux, uy = cell.uy
  const xx = 1 + stretch * (ux * ux - uy * uy * 0.40)
  const yy = 1 + stretch * (uy * uy - ux * ux * 0.40)
  const xy = stretch * ux * uy * 1.40
  const ax = cy * cz, ay = cy * sz, bx = sy * sx * cz - cx * sz, by = sy * sx * sz + cx * cz
  out.xx = (ax * xx + bx * xy) * pose.sx
  out.xy = (ax * xy + bx * yy) * pose.sy
  out.yx = (ay * xx + by * xy) * pose.sx
  out.yy = (ay * xy + by * yy) * pose.sy
  out.zx = (-sy * xx + cy * sx * xy) * pose.sx
  out.zy = (-sy * xy + cy * sx * yy) * pose.sy
  out.normalX = sy * cx * cz + sx * sz
  out.normalY = sy * cx * sz - sx * cz
  out.normalZ = cy * cx
  out.cx = pose.x
  out.cy = pose.y
  out.cz = pose.depth
  out.originX = w / 2
  out.originY = h / 2
  out.distance = Math.max(w, h) * mix(2.5, 0.93, depth)
  return out
}

export function point(x, y, z, view, out) {
  const px = view.cx + view.xx * x + view.xy * y + view.normalX * z
  const py = view.cy + view.yx * x + view.yy * y + view.normalY * z
  const pz = view.cz + view.zx * x + view.zy * y + view.normalZ * z
  const scale = view.distance / Math.max(view.distance * 0.34, view.distance - pz)
  out.x = view.originX + (px - view.originX) * scale
  out.y = view.originY + (py - view.originY) * scale
  return out
}

export function facing(view) {
  const x = view.originX - view.cx, y = view.originY - view.cy, z = view.distance - view.cz
  return view.normalX * x + view.normalY * y + view.normalZ * z > 0 ? 1 : -1
}

export function light(view, face) {
  return clamp(0.44 + 0.56 * face * (-0.37 * view.normalX - 0.45 * view.normalY + 0.81 * view.normalZ))
}

