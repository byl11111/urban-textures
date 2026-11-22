import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('.', import.meta.url))
const file = path => new URL(path, import.meta.url)
const result = await build({
  absWorkingDir: root, entryPoints: ['src/app.js', 'src/style.css'], outdir: 'dist',
  target: 'es2022', platform: 'browser', format: 'iife', bundle: true, minify: true, write: false
})
const asset = suffix => result.outputFiles.find(item => item.path.endsWith(suffix)).text
const html = (await readFile(file('index.html'), 'utf8'))
  .replace('<link rel="stylesheet" href="./src/style.css">', () => '<style>' + asset('.css') + '</style>')
  .replace('<script type="module" src="./src/app.js"></script>', () => '<script>' + asset('.js').replace(/<\/script/gi, '<\\/script') + '</script>')
await mkdir(file('dist/'), { recursive: true })
await writeFile(file('dist/index.html'), html)
console.log('Built dist/index.html (' + Math.round(Buffer.byteLength(html) / 1024) + ' KB, standalone)')

