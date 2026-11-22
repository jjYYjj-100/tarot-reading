import { defineConfig } from 'vite'

const endpoint = 'https://api.deepseek.com/chat/completions'
const model = 'deepseek-flash'
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
const requestLimit = 64 * 1024

export default defineConfig({
  server: { host: 'localhost' },
  preview: { host: 'localhost' },
  plugins: [tarotApiPlugin()],
})

function tarotApiPlugin() {
  const register = (server) => {
    server.middlewares.use('/api/tarot-reading', async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        sendJson(res, 405, { error: '只接受 POST 请求。' })
        return
      }

      const origin = 'http://' + (req.headers.host || '')
      let allowed = false
      try {
        allowed = allowedHosts.has(new URL(origin).hostname) && req.headers.origin === origin
      } catch {
        // A malformed host is rejected below.
      }
      if (!allowed || req.headers['sec-fetch-site'] === 'cross-site') {
        sendJson(res, 403, { error: '仅允许从本机塔罗牌页面发起解读。' })
        return
      }

      const credential = /^Bearer ([\x21-\x7E]{1,512})$/.exec(req.headers.authorization || '')?.[1]
      if (!credential) {
        sendJson(res, 401, { error: '请在 AI 解读设置中填写自己的 DeepSeek API 密钥。' })
        return
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        sendJson(res, 415, { error: '请求需要使用 JSON。' })
        return
      }

      let body
      try {
        body = await readJson(req)
        if (!body || !Array.isArray(body.cards) || body.cards.length > 6 ||
          body.cards.some(card => !card ||
            ['name', 'orientation', 'meaning'].some(field => typeof card[field] !== 'string'))) {
          throw new Error('Invalid cards')
        }
      } catch (error) {
        const status = error.code === 'BODY_LIMIT' ? 413 : 400
        sendJson(res, status, { error: status === 413 ? '解读内容太长。' : '解读请求格式不正确。' })
        return
      }

      try {
        const response = await fetchWithTimeout(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            thinking: { type: 'disabled' },
            messages: [
              { role: 'system', content: '你是一位克制、启发式的塔罗解读助手。仅根据用户给出的抽牌结果和牌义，用中文自然段回答。' },
              { role: 'user', content: buildPrompt(body) },
            ],
            temperature: 0.7,
            max_tokens: 2300,
          }),
        })
        if (!response.ok) {
          sendJson(res, response.status, buildApiError(response.status, 'DeepSeek API 返回异常。'))
          return
        }

        const data = await response.json()
        const text = extractResponseText(data)
        if (!text) {
          sendJson(res, 502, { error: 'DeepSeek 未返回正文。', category: 'empty_model_response' })
          return
        }
        sendJson(res, 200, { text })
      } catch (error) {
        sendJson(res, 502, buildNetworkError(error))
      }
    })
  }
  return { name: 'tarot-api', configureServer: register, configurePreviewServer: register }
}

function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size <= requestLimit) chunks.push(chunk)
    })
    req.on('end', () => {
      if (size > requestLimit) {
        reject(Object.assign(new Error('Request too large'), { code: 'BODY_LIMIT' }))
        return
      }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

async function fetchWithTimeout(url, options, timeoutMs = 45000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

function buildApiError(status, message) {
  return {
    error: message,
    category: classifyHttpStatus(status),
    status,
    advice: adviceForHttpStatus(status),
  }
}

function buildNetworkError(error) {
  const code = error?.code || error?.cause?.code || error?.name || 'NETWORK_ERROR'
  const message = '连接 DeepSeek 时发生错误。'
  const isTimeout = error?.name === 'AbortError'

  return {
    error: message,
    category: isTimeout ? 'timeout' : classifyNetworkCode(code),
    code,
    advice: isTimeout
      ? '请求超过 45 秒没有响应，可能是 DeepSeek 服务繁忙、VPN/代理不稳定或网络延迟过高。'
      : adviceForNetworkCode(code),
  }
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'billing'
  if (status === 404) return 'model'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'provider'
  return 'api'
}

function adviceForHttpStatus(status) {
  if (status === 401 || status === 403) return 'API key 可能无效、权限不足，或当前网络/VPN 出口被 DeepSeek 拒绝。'
  if (status === 402) return '账号余额或计费状态可能异常，请检查 DeepSeek 控制台。'
  if (status === 404) return '模型名可能不可用，请确认 deepseek-flash 是否对当前账号开放。'
  if (status === 429) return '请求过快或触发限流，稍等一会儿再试。'
  if (status === 408 || status === 504) return '请求超时，可能是网络、VPN/代理或 DeepSeek 网关临时波动。'
  if (status >= 500) return 'DeepSeek 服务端临时异常，可以稍后重试。'
  return 'DeepSeek API 返回异常，请查看状态码和错误消息。'
}

function classifyNetworkCode(code) {
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns'
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return 'network'
  if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) return 'tls'
  return 'network'
}

function adviceForNetworkCode(code) {
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'DNS 解析失败或不稳定，常见于 VPN/代理切换、网络抖动。'
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return '连接被重置、拒绝或超时，常见于 VPN/代理不稳定或 DeepSeek 网关波动。'
  if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) return 'TLS 证书校验失败，可能是代理软件拦截 HTTPS。'
  return '本地 Node 服务无法稳定连接 DeepSeek，建议检查 VPN/代理、DNS 和网络连通性。'
}

function buildPrompt(body) {
  const cards = Array.isArray(body.cards) ? body.cards : []
  const cardText = cards
    .map((card, index) => [
      `${index + 1}. ${card.name} / ${card.orientation}${card.phase ? ` / ${card.phase}` : ''}`,
      `牌义：${card.meaning}`,
    ].join('\n'))
    .join('\n\n')

  if (body.followUpQuestion) {
    return [
      '你是一位克制、启发式的塔罗解读助手。',
      '这是同一轮占卜的唯一一次追问，用户已经在原三张牌基础上又抽了三张补牌。',
      '下面每张牌的牌义都来自当前牌组对应正逆位的参考文本。',
      '请把第 1 到第 3 张视为原问题的主线，把第 4 到第 6 张视为追问补牌。',
      '请基于原问题、追问、六张牌参考牌义、上一轮综合解读，回答用户追问并给出最终综合判断。',
      '必须把追问代入用户的具体场景，不要只复述牌义。每个判断都要说明它对应到用户问题里的什么情境、行为或信号。',
      '如果用户问时间、地点、对象特征、对方想法、关系走向等细节，只能给“倾向、线索、观察点”，不能编造确定事实。',
      '不要声称能预测命运，不要使用未提供的相反方向牌义。',
      '不要输出 Markdown 标题符号，不要输出 ###，不要输出粗体标记。',
      '请用自然中文回答，重点补充细节、澄清模糊点，并给出可观察的具体线索。',
      '输出结构为四段纯文本：追问的核心答案、前三张如何构成原问题主线、后三张如何补充追问细节、接下来可以观察或行动的具体建议。',
      '每段控制在 130 到 190 个中文字符，必须把句子写完整，不要在半句中结束。',
      '',
      `原问题：${body.question || ''}`,
      `追问：${body.followUpQuestion || ''}`,
      '',
      '六张抽牌结果与参考牌义：',
      cardText,
      '',
      '上一轮综合解读：',
      body.previousReading || '',
    ].join('\n')
  }

  return [
    '你是一位克制、启发式的塔罗解读助手。',
    '下面每张牌的牌义都来自当前牌组对应正逆位的参考文本。',
    '请逐张借鉴这些参考牌义，再结合用户问题做综合分析。',
    '重要：不要把回答写成牌义解释或百科介绍。你必须先理解用户问的具体场景，然后把每张牌义翻译成这个场景里的含义。',
    '每张牌至少要完成一次“牌义 -> 用户问题中的具体对应”的映射，例如对应到关系状态、对方行为、用户内心、沟通节奏、现实阻碍或下一步选择。',
    '如果用户问“何时、何地、是谁、会不会、怎么发展”，不要给绝对结论；请给倾向、条件、可观察信号和更稳妥的行动建议。',
    '不要声称能预测命运，不要使用未提供的相反方向牌义。',
    '不要输出 Markdown 标题符号，不要输出 ###，不要输出粗体标记。',
    '请用自然中文分成四段：直接回应用户问题、三张牌分别如何落到这个问题、三张牌合起来的关系、必须给用户的具体建议和意向指示。',
    '回答要完整、贴合用户问题，少讲抽象牌义，多讲这对用户当前处境意味着什么。',
    '每段控制在 120 到 180 个中文字符，必须把句子写完整，不要在半句中结束。',
    '',
    `用户问题：${body.question || ''}`,
    '',
    '抽牌结果：',
    cardText,
  ].join('\n')
}

function extractResponseText(data) {
  const chatText = data?.choices?.[0]?.message?.content
  const finishReason = data?.choices?.[0]?.finish_reason
  if (typeof chatText === 'string') {
    return appendTruncationNotice(chatText.trim(), finishReason)
  }
  if (typeof data.output_text === 'string') return data.output_text
  const parts = []
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) parts.push(content.text)
      if (content.type === 'text' && content.text) parts.push(content.text)
    }
  }
  return parts.join('\n').trim() || ''
}

function appendTruncationNotice(text, finishReason) {
  if (!text) return ''
  if (finishReason === 'length') {
    return `${text}\n\n提示：本次回答触达模型长度上限，内容可能被截断。可以使用追问功能让它继续补全。`
  }
  return text
}
