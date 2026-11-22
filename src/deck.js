const major = [
  ['尝试与开放', '先看清风险'],
  ['主动与创造', '把注意力收回来'],
  ['直觉与沉静', '给疑问多一点证据'],
  ['滋养与成长', '留意过度付出'],
  ['秩序与担当', '检查控制是否过多'],
  ['求教与传承', '重新审视惯例'],
  ['价值与选择', '说清彼此分歧'],
  ['方向与坚持', '调整用力的方式'],
  ['温和与勇气', '觉察疲惫和自责'],
  ['独处与反思', '为沟通留出入口'],
  ['转折与机会', '为变化留出余地'],
  ['公平与责任', '补足遗漏的事实'],
  ['暂停与换位', '检查等待是否有用'],
  ['告别与更新', '看见迟迟没处理的告别'],
  ['节奏与平衡', '校准投入和恢复'],
  ['欲望与牵绊', '从惯性里找回选择权'],
  ['拆解与重建', '及早面对已有裂缝'],
  ['希望与恢复', '把期待变成可行小步'],
  ['不确定与直觉', '用事实检验心中的推测'],
  ['清晰与活力', '给结果和能力留出尺度'],
  ['醒悟与回应', '把反省落到下一步'],
  ['完成与整合', '为未收尾的部分留时间'],
]

const suits = {
  圣杯: { name: 'CUPS', theme: '感受与关系', color: '#83caca' },
  宝剑: { name: 'SWORDS', theme: '事实与沟通', color: '#a8bce7' },
  星币: { name: 'PENTACLES', theme: '资源与积累', color: '#a8cf9a' },
  权杖: { name: 'WANDS', theme: '行动与动力', color: '#efab87' },
}

const ranks = {
  一: ['初见机会，做一次小尝试', '先确认机会是否成熟'],
  二: ['看清选择及双方的配合', '缩小范围，重新排定优先级'],
  三: ['把已有的起点向外延伸', '检查合作或过程哪里脱节'],
  四: ['稳住眼下已有的基础', '区分安稳和停滞'],
  五: ['面对摩擦、损失或变化', '评估哪些负担还值得承担'],
  六: ['检视支持如何流动', '留意付出和回报是否失衡'],
  七: ['给计划一次现实检验', '收回消耗过多的尝试'],
  八: ['保持练习或集中推进', '辨别忙碌和进展'],
  九: ['看到已经积累的成果', '给压力和期待留出缓冲'],
  十: ['总结一个阶段的影响', '处理累积的负担和尾项'],
  侍从: ['用好奇心开始学习', '确认消息再行动'],
  骑士: ['把想法推进成一次行动', '放慢承诺和判断的速度'],
  王后: ['稳住内在并照顾过程', '理解自己的需要再付出'],
  国王: ['承担选择带来的责任', '检查权力边界和反馈'],
}

export function getDeckMeaning(card) {
  const suit = suits[card.displayName.slice(0, 2)]
  const theme = suit?.theme
  const [upright, reversed] = (suit ? ranks[card.displayName.slice(2)] : major[card.id]) ?? ['观察已有线索', '重新核对条件']
  return { upright: theme ? theme + '。' + upright + '。' : upright + '。', reversed: theme ? theme + '。' + reversed + '。' : reversed + '。' }
}

export function drawCardFace(card) {
  const suit = card && suits[card.displayName.slice(0, 2)]
  const accent = suit?.color || '#efd19a'
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 474
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 320, 474)
  gradient.addColorStop(0, '#302343')
  gradient.addColorStop(1, '#100d1a')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 320, 474)
  ctx.strokeStyle = accent
  ctx.lineWidth = 1
  ctx.strokeRect(14, 14, 292, 446)
  ctx.globalAlpha = 0.45
  ctx.strokeRect(22, 22, 276, 430)
  ctx.globalAlpha = 1

  const centerY = 218
  ctx.beginPath()
  ctx.arc(160, centerY, 81, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(160, centerY, 65, 0, Math.PI * 2)
  ctx.stroke()
  const points = card ? 3 + card.id % 7 : 8
  ctx.beginPath()
  for (let index = 0; index < points * 2; index++) {
    const angle = -Math.PI / 2 + Math.PI * index / points
    const radius = index % 2 ? 26 : 55
    const x = 160 + Math.cos(angle) * radius
    const y = centerY + Math.sin(angle) * radius
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.stroke()

  ctx.fillStyle = accent
  ctx.textAlign = 'center'
  ctx.font = '16px system-ui, sans-serif'
  ctx.fillText(card ? suit?.name || 'MAJOR ARCANA' : 'AI TAROT', 160, 68)
  ctx.font = '600 31px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
  ctx.fillText(card?.displayName || '塔罗', 160, 367)
  ctx.font = '16px system-ui, sans-serif'
  ctx.fillText(card ? String(card.id + 1).padStart(2, '0') : '✦', 160, 415)
  return canvas.toDataURL('image/png')
}
