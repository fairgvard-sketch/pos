/**
 * Короткий «дзынь» через Web Audio — без внешних файлов.
 * Звук нового заказа у бариста: экран часто вне поля зрения.
 */
let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  return ctx
}

/** Успешная оплата: короткое восходящее арпеджио (C6 → E6 → G6) */
export function playPaymentChime() {
  const ac = getCtx()
  if (!ac) return
  if (ac.state === 'suspended') ac.resume().catch(() => {})

  const now = ac.currentTime
  const notes = [
    { freq: 1046.5, at: 0 },     // C6
    { freq: 1318.5, at: 0.09 },  // E6
    { freq: 1568.0, at: 0.18 },  // G6
  ]
  for (const n of notes) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = n.freq
    gain.gain.setValueAtTime(0, now + n.at)
    gain.gain.linearRampToValueAtTime(0.15, now + n.at + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + n.at + 0.3)
    osc.connect(gain).connect(ac.destination)
    osc.start(now + n.at)
    osc.stop(now + n.at + 0.31)
  }
}

/** Двухнотный колокольчик (E6 → A6) */
export function playNewOrderChime() {
  const ac = getCtx()
  if (!ac) return
  // Браузер мог приостановить контекст до взаимодействия — пробуем возобновить
  if (ac.state === 'suspended') ac.resume().catch(() => {})

  const now = ac.currentTime
  const notes = [
    { freq: 1318.5, at: 0 },     // E6
    { freq: 1760.0, at: 0.12 },  // A6
  ]
  for (const n of notes) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = n.freq
    gain.gain.setValueAtTime(0, now + n.at)
    gain.gain.linearRampToValueAtTime(0.18, now + n.at + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + n.at + 0.35)
    osc.connect(gain).connect(ac.destination)
    osc.start(now + n.at)
    osc.stop(now + n.at + 0.36)
  }
}
