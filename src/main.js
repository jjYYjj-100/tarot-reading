import * as THREE from 'three'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { drawCardFace, getDeckMeaning } from './deck.js'
import './style.css'

const MAX_DRAWS = 3
const FOLLOW_UP_DRAWS = 3
const FIST_HOLD_MS = 500
const FIST_MAX_FINGERS = 1
const AUTO_DRAW_AFTER_FREEZE_MS = 550
const OPEN_HOLD_MS = 300
const STOP_DECEL_MS = 50
const REVEAL_PAUSE_MS = 1000
const CARD_ASPECT = 1.48
const CARD_WIDTH = 1.05
const CARD_HEIGHT = CARD_WIDTH * CARD_ASPECT
const VISIBLE_SLOTS = 11
const CAROUSEL_SPEED = 0.022

const dom = {
  stage: document.querySelector('#stage'),
  question: document.querySelector('#question'),
  start: document.querySelector('#start'),
  reset: document.querySelector('#reset'),
  openHand: document.querySelector('#openHand'),
  fist: document.querySelector('#fist'),
  toggleGesture: document.querySelector('#toggleGesture'),
  gestureVideo: document.querySelector('#gestureVideo'),
  gestureStatus: document.querySelector('#gestureStatus'),
  status: document.querySelector('#status'),
  count: document.querySelector('#count'),
  selectedCards: document.querySelector('#selectedCards'),
  reading: document.querySelector('#reading'),
}

let readingKey = ''

const state = {
  cards: [],
  deck: [],
  selected: [],
  mode: 'idle',
  carouselOffset: 0,
  fistTimer: null,
  centerMesh: null,
  apiConnected: null,
  summaryText: '',
  followUpUsed: false,
  followUpQuestion: '',
  drawPhase: 'initial',
  targetDraws: MAX_DRAWS,
  carouselSpeed: 0,
  gestureEnabled: false,
  gestureBusy: false,
  handLandmarker: null,
  cameraStream: null,
  lastVideoTime: -1,
  stableGesture: null,
  stableSince: 0,
  openTriggered: false,
  frozenSince: 0,
  drawTriggered: false,
}

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x08060d)

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100)
camera.position.set(0, 0.05, 7.2)

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
dom.stage.appendChild(renderer.domElement)

const textureLoader = new THREE.TextureLoader()
const textureCache = new Map()
let backTexture = null
let slots = []
let selector = null

init()
animate()

async function init() {
  setStatus('正在加载塔罗牌')
  const response = await fetch('/cards.json')
  const data = await response.json()
  backTexture = textureLoader.load(drawCardFace())
  state.cards = data.cards.map((card) => {
    const entry = { ...card, displayName: card.name.replace(/^\d+_/, ''), orientation: null }
    return { ...entry, front: drawCardFace(entry) }
  })

  slots = createSlots()
  selector = createSelector()
  scene.add(selector)

  setStatus('输入问题后开始占卜')
  renderSelected()
}

function createSlots() {
  const group = []
  const geometry = new THREE.PlaneGeometry(CARD_WIDTH, CARD_HEIGHT)
  const spacing = CARD_WIDTH * 0.84
  const start = -Math.floor(VISIBLE_SLOTS / 2)

  for (let index = 0; index < VISIBLE_SLOTS; index += 1) {
    const material = new THREE.MeshBasicMaterial({
      map: backTexture,
      transparent: true,
      opacity: 0.96,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.x = (start + index) * spacing
    mesh.position.z = -Math.abs(start + index) * 0.035
    mesh.userData.baseX = mesh.position.x
    scene.add(mesh)
    group.push(mesh)
  }

  return group
}

function createSelector() {
  const geometry = new THREE.RingGeometry(0.72, 0.76, 72)
  const material = new THREE.MeshBasicMaterial({
    color: 0xf4d184,
    transparent: true,
    opacity: 0.68,
  })
  const ring = new THREE.Mesh(geometry, material)
  ring.scale.y = CARD_ASPECT
  ring.position.z = 0.11
  return ring
}

function startReading() {
  const question = dom.question.value.trim()
  if (!question) {
    setStatus('请先输入一个问题')
    dom.question.focus()
    return
  }

  state.deck = shuffle(state.cards).map((card) => ({
    ...card,
    orientation: Math.random() > 0.5 ? 'upright' : 'reversed',
  }))
  state.selected = []
  state.mode = 'ready'
  state.carouselOffset = 0
  state.summaryText = ''
  state.followUpUsed = false
  state.followUpQuestion = ''
  state.drawPhase = 'initial'
  state.targetDraws = MAX_DRAWS
  state.openTriggered = false
  state.frozenSince = 0
  state.drawTriggered = false
  state.carouselSpeed = 0

  clearSceneSelection()
  renderFollowUpPromptField()
  renderSelected()
  renderReadingIdle('牌组已洗好', '张手让牌缓慢流动，握拳锁定中心牌。')
  setStatus('牌序与正逆位已随机锁定')
}

function openHand() {
  if (!state.deck.length) {
    setStatus('请先开始占卜')
    return
  }
  if (state.selected.length >= state.targetDraws) {
    setStatus(state.followUpQuestion ? '追问三张牌已经抽完' : '本轮三张牌已经抽完')
    return
  }
  if (state.mode === 'stopping' || state.mode === 'revealing' || state.mode === 'moving') return

  clearTimeout(state.fistTimer)
  state.fistTimer = null
  state.mode = 'carousel'
  state.carouselSpeed = CAROUSEL_SPEED
  state.openTriggered = true
  state.drawTriggered = false
  setStatus('牌正在缓慢流动')
}

function freezeCarousel() {
  if (state.mode !== 'carousel') return
  state.mode = 'paused'
  state.carouselSpeed = 0
  state.frozenSince = performance.now()
  state.drawTriggered = false
  setStatus('已锁定当前中心牌，握拳确认抽取')
}

function fist() {
  if (state.mode !== 'carousel' && state.mode !== 'paused') {
    setStatus(state.deck.length ? '先张手让牌流动' : '请先开始占卜')
    return
  }
  if (state.fistTimer) return

  setStatus('握拳确认中')
  state.drawTriggered = true
  state.fistTimer = window.setTimeout(selectCenterCard, FIST_HOLD_MS)
}

async function selectCenterCard() {
  state.fistTimer = null
  if ((state.mode !== 'carousel' && state.mode !== 'paused') || !state.deck.length) return

  if (state.mode === 'carousel') {
    state.mode = 'stopping'
    setStatus('牌流正在减速，准备锁定')
    await slowCarouselToStop()
    if (state.mode !== 'stopping' || !state.deck.length) return
  }

  state.mode = 'revealing'
  const centerIndex = getCenterDeckIndex()
  const [card] = state.deck.splice(centerIndex, 1)

  setStatus('已锁定中心牌，正在取出')
  await revealCard(card)

  const meaning = await loadMeaning(card)
  const selectedCard = { ...card, meaning, drawPhase: state.drawPhase }

  setStatus('牌义读取完成')
  await pause(REVEAL_PAUSE_MS)

  state.mode = 'moving'
  setStatus('正在放入已选择区域')
  await moveRevealedCardAway()

  state.selected.push(selectedCard)
  clearSceneSelection()
  renderSelected()
  renderReading(card, meaning)

  if (state.selected.length >= state.targetDraws || !state.deck.length) {
    state.mode = 'complete'
    setStatus(state.followUpQuestion ? '六张牌已抽完，正在生成追问综合解读' : '三张牌已抽完，正在生成综合解读')
    await renderSummaryReading()
  } else {
    state.mode = 'ready'
    state.openTriggered = false
    state.frozenSince = 0
    state.drawTriggered = false
    setStatus(`已抽出 ${state.selected.length} 张，张手继续`)
  }
}

async function slowCarouselToStop() {
  const startSpeed = state.carouselSpeed || CAROUSEL_SPEED
  await tween(STOP_DECEL_MS, (progress) => {
    state.carouselSpeed = startSpeed * (1 - progress)
  })
  state.carouselSpeed = 0
}

async function revealCard(card) {
  clearSceneSelection()
  const geometry = new THREE.PlaneGeometry(CARD_WIDTH * 1.26, CARD_HEIGHT * 1.26)
  const material = new THREE.MeshBasicMaterial({
    map: backTexture,
    transparent: true,
    opacity: 1,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(0, 0, 0.34)
  mesh.userData.revealing = true
  scene.add(mesh)
  state.centerMesh = mesh

  await tween(820, (progress) => {
    mesh.position.y = progress * 0.36
    mesh.position.z = 0.34 + progress * 0.55
    mesh.scale.setScalar(1 + progress * 0.08)
  })

  await tween(900, (progress) => {
    mesh.rotation.y = progress < 0.5
      ? progress * Math.PI
      : (1 - progress) * Math.PI
    if (progress > 0.5 && material.map === backTexture) {
      material.map = getTexture(card.front)
      material.needsUpdate = true
    }
    mesh.rotation.z = card.orientation === 'reversed' ? Math.PI : 0
  })
}

async function moveRevealedCardAway() {
  const mesh = state.centerMesh
  if (!mesh) return

  await tween(720, (progress) => {
    mesh.position.x = progress * 3.6
    mesh.position.y = 0.36 + progress * 0.75
    mesh.position.z = 0.9 - progress * 0.25
    mesh.scale.setScalar(1.08 - progress * 0.42)
    mesh.material.opacity = 1 - progress * 0.78
  })
}

async function loadMeaning(card) {
  return {
    label: card.orientation === 'upright' ? '正位' : '逆位',
    text: getDeckMeaning(card)[card.orientation],
  }
}

async function renderSummaryReading() {
  const cardCountText = state.followUpQuestion ? '六张牌' : '三张牌'
  renderReadingIdle('正在生成综合解读', readingKey
    ? `正在把你的问题、${cardCountText}与对应牌义发送给 DeepSeek。`
    : `正在根据${cardCountText}的本地牌义整理提示。`)
  const result = await requestModelSummary()
  const cleanText = sanitizeModelText(result.text)
  state.summaryText = cleanText

  const sourceLabel = result.fromApi
    ? state.followUpQuestion ? '六张综合解读' : '综合解读'
    : state.followUpQuestion ? '本地兜底六张解读' : '本地兜底解读'
  const note = result.fromApi ? '已连接 DeepSeek' : '使用本地牌义'
  state.apiConnected = result.fromApi

  dom.reading.innerHTML = `
    <div class="reading-card-title">
      <span>${sourceLabel}</span>
      <strong>${escapeHtml(note)}</strong>
    </div>
    ${renderQuestionCopies()}
    <div class="spread ${state.selected.length > MAX_DRAWS ? 'spread-compact' : ''}">${state.selected.map(renderSpreadCard).join('')}</div>
    <div class="meaning summary">${escapeHtml(cleanText).replaceAll('\n', '<br>')}</div>
    ${renderFollowUpBox()}
  `
  bindFollowUpControls()
  setStatus(result.fromApi ? '大模型综合解读完成' : '本地兜底解读完成')
}

async function requestModelSummary() {
  const payload = {
    question: dom.question.value.trim(),
    followUpQuestion: state.followUpQuestion,
    previousReading: state.followUpQuestion ? state.summaryText : '',
    cards: state.selected.map((card) => ({
      name: card.displayName,
      orientation: card.meaning.label,
      meaning: card.meaning.text,
      phase: card.drawPhase === 'followup' ? '追问补牌' : '初始抽牌',
    })),
  }

  if (!readingKey) {
    return { fromApi: false, text: buildLocalSummary(payload) }
  }

  try {
    const response = await fetch('/api/tarot-reading', {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + readingKey },
      body: JSON.stringify(payload),
    })

    const data = await readApiResult(response)

    if (response.ok) {
      if (data?.text) return { fromApi: true, text: data.text }
      return {
        fromApi: false,
        text: buildLocalSummary(payload, {
          ...data,
          category: 'empty_response',
          advice: '本地 API 返回成功，但没有返回 text 字段，可能是 DeepSeek 返回结构异常或接口解析失败。',
        }),
        diagnostic: data,
      }
    }
    return { fromApi: false, text: buildLocalSummary(payload, data), diagnostic: data }
  } catch {
    // The local API bridge is optional.
  }

  return { fromApi: false, text: buildLocalSummary(payload, { category: 'network', advice: '浏览器无法连接本地 API 桥接服务，请确认 Vite 服务仍在运行。' }) }
}

async function readApiResult(response) {
  const raw = await response.text().catch(() => '')
  let parsed = {}

  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    parsed = {
      error: '本地 API 返回的不是 JSON',
      raw: raw.slice(0, 200),
    }
  }

  return {
    status: response.status,
    statusText: response.statusText,
    ...parsed,
  }
}

async function submitFollowUp() {
  const input = document.querySelector('#followUpQuestion')
  const button = document.querySelector('#followUpSubmit')
  const resultBox = document.querySelector('#followUpResult')
  const followUpQuestion = input?.value.trim()

  if (!followUpQuestion) {
    setStatus('请先输入追问内容')
    input?.focus()
    return
  }
  if (state.followUpUsed) {
    setStatus('本轮追问机会已使用')
    return
  }

  state.followUpUsed = true
  state.followUpQuestion = followUpQuestion
  state.drawPhase = 'followup'
  state.targetDraws = Math.min(MAX_DRAWS + FOLLOW_UP_DRAWS, state.selected.length + state.deck.length)
  state.mode = 'ready'
  state.openTriggered = false
  state.frozenSince = 0
  state.drawTriggered = false
  input.disabled = true
  button.disabled = true
  button.textContent = '继续抽牌'
  resultBox.innerHTML = '追问已记录，请继续张手抽取三张补牌。'
  renderFollowUpPromptField()
  renderSelected()
  renderReadingIdle('追问已记录', '继续张手让牌流动，再抽三张后会结合六张牌生成综合解读。')
  setStatus('追问已记录，继续抽第 4 张牌')
}

function buildLocalSummary(payload, diagnostic = {}) {
  const cards = payload.cards.map(compactCardForLocal)
  const initialCards = cards.slice(0, MAX_DRAWS)
  const followUpCards = cards.slice(MAX_DRAWS)
  const opening = payload.followUpQuestion
    ? `围绕原问题“${payload.question}”和追问“${payload.followUpQuestion}”，六张牌更像是在把第一轮的方向继续摊开：前面三张说明基本局面，后面三张补充细节、条件和下一步观察点。`
    : `围绕你的问题“${payload.question}”，这三张牌共同指向一个需要先看清局面、再判断阻力、最后决定行动节奏的过程。它不能替你给出绝对结论，但能提示你现在更适合观察什么。`

  const initialText = initialCards
    .map((card, index) => `${index + 1}. ${card.name}${card.orientation}落在原问题里，像是在说：${card.meaning}`)
    .join('\n')

  const followUpText = followUpCards.length
    ? followUpCards
      .map((card, index) => `${index + 4}. ${card.name}${card.orientation}回应追问的补充线索是：${card.meaning}`)
      .join('\n')
    : ''

  return [
    `本地解读：以下内容基于本地牌义整理。`,
    formatDiagnostic(diagnostic),
    opening,
    initialText,
    followUpText,
    payload.followUpQuestion
      ? `综合来看，追问的答案要以前三张的主线为底，再看后三张是否支持推进、等待或转向。你可以把重点放在现实里已经出现的信号上，而不是把某一个细节当成确定预言。`
      : `综合来看，先把最消耗你的部分看清，再检查自己是否因为情绪、偏见或不甘而做判断。等内在和现实条件更清楚后，再决定是否推进，会比现在硬往前走更稳。`,
  ].filter(Boolean).join('\n\n')
}

function formatDiagnostic(diagnostic) {
  const parts = []
  if (diagnostic.category) parts.push(`类型：${diagnostic.category}`)
  if (diagnostic.status) parts.push(`状态码：${diagnostic.status}`)
  if (diagnostic.code) parts.push(`错误码：${diagnostic.code}`)
  if (diagnostic.error) parts.push(`错误：${diagnostic.error}`)
  if (diagnostic.statusText) parts.push(`状态文本：${diagnostic.statusText}`)
  if (diagnostic.raw) parts.push(`响应片段：${diagnostic.raw}`)
  if (diagnostic.advice) parts.push(`建议：${diagnostic.advice}`)
  return parts.length ? `调用失败原因：${parts.join('；')}` : '调用失败原因：本地接口没有返回诊断信息，可能是旧页面缓存或开发服务尚未重启。'
}

function compactCardForLocal(card) {
  return {
    ...card,
    meaning: summarizeMeaning(card.meaning),
  }
}

function summarizeMeaning(text) {
  const sentences = String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？；])/)
    .map((line) => line.trim())
    .filter(Boolean)

  const meaningful = sentences.filter((line) => !/牌面解析|占星连结|生命树位置|关键牌义|元素：|数字编号/.test(line))
  return meaningful.slice(0, 3).join('') || String(text).slice(0, 160)
}

function renderFollowUpBox() {
  if (state.followUpUsed || state.selected.length !== MAX_DRAWS) return ''

  return `
    <div class="follow-up">
      <label for="followUpQuestion">追问一次</label>
      <textarea id="followUpQuestion" rows="3" placeholder="例如：我未来的那个人是什么样子的？"></textarea>
      <button id="followUpSubmit" type="button">记录追问并继续抽牌</button>
      <div id="followUpResult" class="follow-up-result"></div>
    </div>
  `
}

function renderQuestionCopies() {
  const followUp = state.followUpQuestion
    ? `<p class="question-copy follow-up-copy">追问：${escapeHtml(state.followUpQuestion)}</p>`
    : ''
  return `
    <p class="question-copy">原问题：${escapeHtml(dom.question.value.trim())}</p>
    ${followUp}
  `
}

function renderFollowUpPromptField() {
  const existing = document.querySelector('#followUpPromptField')
  if (!state.followUpQuestion) {
    existing?.remove()
    return
  }

  const markup = `
    <label id="followUpPromptField" class="question-field follow-up-question-field">
      <span>追问问题</span>
      <textarea rows="2" readonly>${escapeHtml(state.followUpQuestion)}</textarea>
    </label>
  `

  if (existing) {
    existing.outerHTML = markup
    return
  }

  document.querySelector('.question-field')?.insertAdjacentHTML('afterend', markup)
}

function bindFollowUpControls() {
  const button = document.querySelector('#followUpSubmit')
  button?.addEventListener('click', submitFollowUp)
}

function sanitizeModelText(text) {
  return String(text)
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function renderSpreadCard(card) {
  return `
    <div class="spread-card">
      <img src="${card.front}" alt="${card.displayName}" class="${card.orientation === 'reversed' ? 'reversed' : ''}">
      <span>${escapeHtml(card.displayName)}</span>
      <strong>${card.meaning.label}</strong>
    </div>
  `
}

function renderReading(card, meaning) {
  dom.reading.innerHTML = `
    <div class="reading-card-title">
      <span>${escapeHtml(card.displayName)}</span>
      <strong>${meaning.label}</strong>
    </div>
    <p class="question-copy">${escapeHtml(dom.question.value.trim())}</p>
    <div class="meaning">${escapeHtml(meaning.text).replaceAll('\n', '<br>')}</div>
  `
}

function renderReadingIdle(title, copy) {
  dom.reading.innerHTML = `
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(copy)}</p>
  `
}

async function toggleGestureCamera() {
  if (state.gestureEnabled) {
    stopGestureCamera()
    return
  }

  if (state.gestureBusy) return
  state.gestureBusy = true
  dom.toggleGesture.disabled = true
  setGestureStatus('正在加载手势识别')

  try {
    if (!state.handLandmarker) {
      const vision = await FilesetResolver.forVisionTasks('/wasm')
      state.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        },
        runningMode: 'VIDEO',
        numHands: 1,
      })
    }

    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        facingMode: 'user',
      },
      audio: false,
    })
    dom.gestureVideo.srcObject = state.cameraStream
    await dom.gestureVideo.play()

    state.gestureEnabled = true
    state.lastVideoTime = -1
    state.stableGesture = null
    state.stableSince = 0
    dom.toggleGesture.textContent = '关闭摄像头'
    setGestureStatus('摄像头已开启，张开五指开始，握拳抽牌')
    requestAnimationFrame(detectGestureFrame)
  } catch (error) {
    setGestureStatus(`手势识别开启失败：${error.message}`)
  } finally {
    state.gestureBusy = false
    dom.toggleGesture.disabled = false
  }
}

function stopGestureCamera() {
  state.gestureEnabled = false
  state.stableGesture = null
  state.stableSince = 0
  state.openTriggered = false
  state.frozenSince = 0
  state.drawTriggered = false
  dom.toggleGesture.textContent = '开启摄像头'
  dom.gestureVideo.srcObject = null

  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop())
    state.cameraStream = null
  }

  setGestureStatus('识别 5 指为张手，0 指为握拳')
}

function detectGestureFrame(now) {
  if (!state.gestureEnabled || !state.handLandmarker) return

  if (dom.gestureVideo.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = dom.gestureVideo.currentTime
    const result = state.handLandmarker.detectForVideo(dom.gestureVideo, now)
    const landmarks = result.landmarks?.[0]

    if (landmarks) {
      const count = countExtendedFingers(landmarks)
      updateGestureState(count, now)
    } else {
      state.stableGesture = null
      state.stableSince = 0
      setGestureStatus('未检测到手，请把手放在摄像头前')
    }
  }

  requestAnimationFrame(detectGestureFrame)
}

function updateGestureState(fingerCount, now) {
  const gesture = fingerCount === 5 ? 'open' : fingerCount <= FIST_MAX_FINGERS ? 'fist' : 'other'

  if (gesture !== state.stableGesture) {
    state.stableGesture = gesture
    state.stableSince = now
  }

  const held = now - state.stableSince
  setGestureStatus(`检测到 ${fingerCount} 指${gestureHint(gesture, held)}`)

  if (gesture === 'open' && held >= OPEN_HOLD_MS && !state.openTriggered) {
    openHand()
  }

  if (gesture !== 'open' && state.mode === 'carousel' && state.openTriggered) {
    freezeCarousel()
  }

  if (state.mode === 'paused' && state.frozenSince && !state.drawTriggered && now - state.frozenSince >= AUTO_DRAW_AFTER_FREEZE_MS) {
    fist()
  }

  if (gesture === 'fist' && held >= FIST_HOLD_MS && !state.drawTriggered) {
    fist()
  }

  if (gesture !== 'open' && state.mode !== 'carousel' && state.mode !== 'paused') {
    state.openTriggered = false
  }
}

function gestureHint(gesture, held) {
  if (gesture === 'open') return held >= OPEN_HOLD_MS ? '，已张手' : '，保持张手'
  if (gesture === 'fist') return held >= FIST_HOLD_MS ? '，确认抽牌' : '，保持握拳确认'
  return '，已离开 5 指则冻结，握拳确认'
}

function countExtendedFingers(landmarks) {
  const wrist = landmarks[0]
  const fingers = [
    { tip: 4, pip: 3, mcp: 2, thumb: true },
    { tip: 8, pip: 6, mcp: 5 },
    { tip: 12, pip: 10, mcp: 9 },
    { tip: 16, pip: 14, mcp: 13 },
    { tip: 20, pip: 18, mcp: 17 },
  ]

  return fingers.reduce((count, finger) => {
    const tip = landmarks[finger.tip]
    const pip = landmarks[finger.pip]
    const mcp = landmarks[finger.mcp]
    const tipDistance = distance(tip, wrist)
    const pipDistance = distance(pip, wrist)
    const mcpDistance = distance(mcp, wrist)

    const extended = finger.thumb
      ? tipDistance > pipDistance * 1.12 && tipDistance > mcpDistance * 1.32
      : tip.y < pip.y && tipDistance > pipDistance * 1.08

    return count + (extended ? 1 : 0)
  }, 0)
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0))
}

function setGestureStatus(text) {
  dom.gestureStatus.textContent = text
}

function renderSelected() {
  dom.count.textContent = `${state.selected.length} / ${state.targetDraws}`
  dom.selectedCards.classList.toggle('selected-cards-compact', state.targetDraws > MAX_DRAWS)
  dom.selectedCards.innerHTML = ''

  state.selected.forEach((card, index) => {
    const item = document.createElement('div')
    item.className = `selected-card ${card.drawPhase === 'followup' ? 'follow-up-card' : ''}`
    const phaseName = card.drawPhase === 'followup' ? '追问' : '初抽'
    item.innerHTML = `
      <img src="${card.front}" alt="${card.displayName}" class="${card.orientation === 'reversed' ? 'reversed' : ''}">
      <span>${index + 1}. ${card.displayName}<em>${phaseName}</em></span>
      <strong>${card.orientation === 'upright' ? '正位' : '逆位'}</strong>
    `
    dom.selectedCards.appendChild(item)
  })
}

function animate() {
  requestAnimationFrame(animate)

  if (state.mode === 'carousel' && state.deck.length) {
    state.carouselOffset += state.carouselSpeed
  }

  if (state.mode === 'stopping' && state.deck.length) {
    state.carouselOffset += state.carouselSpeed
  }

  updateSlots()
  if (selector) selector.rotation.z += 0.0018
  renderer.render(scene, camera)
}

function updateSlots() {
  if (!backTexture) return
  const spacing = CARD_WIDTH * 0.84
  slots.forEach((mesh, index) => {
    const raw = mesh.userData.baseX - (state.carouselOffset % spacing)
    const wrapped = wrap(raw, -spacing * 5.5, spacing * 5.5)
    const distance = Math.abs(wrapped)
    const centerGlow = Math.max(0, 1 - distance / 1.2)

    mesh.position.x = wrapped
    mesh.position.y = Math.sin(state.carouselOffset * 0.22 + index) * 0.025
    mesh.position.z = -distance * 0.035
    mesh.rotation.z = Math.sin(state.carouselOffset * 0.18 + index) * 0.025
    mesh.scale.setScalar(1 + centerGlow * 0.08)
    mesh.material.map = backTexture
    mesh.material.opacity = state.mode === 'revealing' || state.mode === 'moving' ? 0.2 : 0.92
    mesh.material.needsUpdate = true
  })
}

function getCenterDeckIndex() {
  const raw = Math.round(state.carouselOffset / 0.84)
  return ((raw % state.deck.length) + state.deck.length) % state.deck.length
}

function clearSceneSelection() {
  if (state.centerMesh) {
    scene.remove(state.centerMesh)
    state.centerMesh.geometry.dispose()
    state.centerMesh.material.dispose()
    state.centerMesh = null
  }
}

function getTexture(path) {
  if (!textureCache.has(path)) {
    textureCache.set(path, textureLoader.load(path))
  }
  return textureCache.get(path)
}

function shuffle(cards) {
  const copy = [...cards]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[target]] = [copy[target], copy[index]]
  }
  return copy
}

function tween(duration, update) {
  return new Promise((resolve) => {
    const start = performance.now()
    const step = (now) => {
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      update(eased)
      if (progress < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
}

function pause(duration) {
  return new Promise((resolve) => window.setTimeout(resolve, duration))
}

function setStatus(text) {
  dom.status.textContent = text
}

function wrap(value, min, max) {
  const range = max - min
  return ((((value - min) % range) + range) % range) + min
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

const aiForm = document.querySelector('#aiSettingsForm')
const aiKeyInput = document.querySelector('#aiKey')
const aiStatus = document.querySelector('#aiStatus')

aiForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const key = aiKeyInput.value.trim()
  if (!/^[\x21-\x7E]{1,512}$/.test(key)) {
    aiStatus.textContent = '请输入有效格式的 DeepSeek API 密钥。'
    return
  }
  readingKey = key
  aiForm.reset()
  aiStatus.textContent = '已启用 AI 解读，密钥只用于本次页面会话。'
})

document.querySelector('#clearAiKey').addEventListener('click', () => {
  readingKey = ''
  aiForm.reset()
  aiStatus.textContent = '已清除密钥，后续抽牌使用本地解读。'
})

dom.start.addEventListener('click', startReading)
dom.reset.addEventListener('click', () => {
  state.deck = []
  state.selected = []
  state.mode = 'idle'
  state.carouselOffset = 0
  state.carouselSpeed = 0
  state.openTriggered = false
  state.frozenSince = 0
  state.drawTriggered = false
  state.summaryText = ''
  state.followUpUsed = false
  state.followUpQuestion = ''
  state.drawPhase = 'initial'
  state.targetDraws = MAX_DRAWS
  clearTimeout(state.fistTimer)
  clearSceneSelection()
  renderFollowUpPromptField()
  renderSelected()
  renderReadingIdle('等待抽牌', '开始后，张手让牌流动，握拳锁定中心牌。')
  setStatus('输入问题后开始占卜')
})
dom.openHand.addEventListener('pointerdown', openHand)
dom.fist.addEventListener('pointerdown', fist)
dom.toggleGesture.addEventListener('click', toggleGestureCamera)

window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.target.closest?.('input, button, summary, #aiSettingsForm')) return
  const isTyping = ['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)
  if (event.code === 'Space' && !isTyping) {
    event.preventDefault()
    openHand()
  }
  if (event.code === 'Enter' && !isTyping) {
    event.preventDefault()
    fist()
  }
})
