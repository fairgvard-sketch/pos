import { describe, it, expect, vi } from 'vitest'
import { newPrintJobId, awaitPrintResult } from './printJobs'

/**
 * P6: результат печати не теряется. awaitPrintResult связывает jobId с
 * колбэком моста window.__kassaPrintResult и различает «принято» и «итог».
 */

describe('awaitPrintResult', () => {
  it('accepted=false → мгновенная ошибка', async () => {
    const r = await awaitPrintResult(newPrintJobId(), false)
    expect(r.ok).toBe(false)
    expect(r.status).toBe('error')
  })

  it('колбэк success → ok=true', async () => {
    const jobId = newPrintJobId()
    const p = awaitPrintResult(jobId, true)
    // Мост рапортует итог
    window.__kassaPrintResult!(jobId, 'success', null)
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.status).toBe('success')
  })

  it('колбэк no-paper → ok=false, status=no-paper', async () => {
    const jobId = newPrintJobId()
    const p = awaitPrintResult(jobId, true)
    window.__kassaPrintResult!(jobId, 'no-paper', 'no paper')
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.status).toBe('no-paper')
  })

  it('queued игнорируется, ждём финальный статус', async () => {
    const jobId = newPrintJobId()
    const p = awaitPrintResult(jobId, true)
    window.__kassaPrintResult!(jobId, 'queued', null) // не резолвит
    window.__kassaPrintResult!(jobId, 'success', null)
    const r = await p
    expect(r.ok).toBe(true)
  })

  it('v2 без колбэка → timeout, не ложный success', async () => {
    vi.useFakeTimers()
    const p = awaitPrintResult(newPrintJobId(), true)
    vi.advanceTimersByTime(15000)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.status).toBe('timeout')
    expect(r.message).toBe('callback-timeout')
    vi.useRealTimers()
  })

  it('старый мост без callback сохраняет accepted-only fallback', async () => {
    vi.useFakeTimers()
    const p = awaitPrintResult(newPrintJobId(), true, false)
    vi.advanceTimersByTime(15000)
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.message).toBe('legacy-no-callback')
    vi.useRealTimers()
  })
})
