import { cp, mkdir } from 'node:fs/promises'
const visionPackage = import.meta.resolve('@mediapipe/tasks-vision')
const source = new URL('./wasm/', visionPackage)
const target = new URL('../public/wasm/', import.meta.url)
await mkdir(target, { recursive: true })
await cp(source, target, { recursive: true })
