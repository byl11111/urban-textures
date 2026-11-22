const RECORD_FORMATS = [
  'video/mp4;codecs=avc1.420034,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
]

export const RECORD_LIMIT = 90
export const recordingFormats = () => typeof MediaRecorder === 'undefined' ? [] :
  RECORD_FORMATS.filter(type => MediaRecorder.isTypeSupported(type))

export function download(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export async function exportPNG(canvas, name) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw Error('无法生成 PNG。请检查浏览器可用内存。')
  download(blob, name + '.png')
}

export function recordCanvas(canvas, audio, onFinish, onError, preferWebm = false) {
  const capture = canvas.captureStream(30)
  let sound, recorder, closed = false
  const close = () => {
    if (closed) return
    closed = true
    capture.getTracks().forEach(track => track.stop())
    sound?.close()
  }
  try {
    sound = audio.recordingAudio()
    const stream = new MediaStream([...capture.getVideoTracks(), sound.track])
    const chunks = []
    let failed = false
    const formats = recordingFormats()
    if (preferWebm) formats.sort((a, b) => Number(b.includes('webm')) - Number(a.includes('webm')))
    for (const mimeType of formats) {
      try {
        const attempt = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 })
        attempt.start(250)
        recorder = attempt
        break
      } catch { /* Try the next supported container. */ }
    }
    if (!recorder) throw Error('无法启动视频编码。请使用新版 Chrome 或 Edge。')
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
    recorder.onerror = () => {
      failed = true
      close()
      onError('录制中断。请重新录制。', recorder.mimeType.includes('mp4'))
    }
    recorder.onstop = () => {
      close()
      if (failed) return
      const mime = recorder.mimeType || chunks[0]?.type
      if (!chunks.length || !mime) { onError('录制没有获得画面，请录制至少一秒后停止。'); return }
      const extension = mime.includes('mp4') ? 'mp4' : 'webm'
      onFinish(new Blob(chunks, { type: 'video/' + extension }), extension)
    }
    return {
      format: recorder.mimeType.includes('mp4') ? 'MP4' : 'WebM',
      stop: () => { if (recorder.state !== 'inactive') recorder.stop() }
    }
  } catch (error) {
    close()
    throw error
  }
}

