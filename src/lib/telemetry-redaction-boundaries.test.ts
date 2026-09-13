import { describe, expect, it } from 'vitest'
import { LIMITS, sanitizeMessage } from './telemetry-sanitize'

describe('secret redaction at input and quoting boundaries', () => {
  for (const [open, close] of [['"', '"'], ["'", "'"], ['[', ']']]) {
    it(`redacts an unfinished ${open} value`, () => {
      const raw = `Error: pin=${open}9137`
      expect(raw).toContain('9137')
      const clean = sanitizeMessage(raw)
      expect(clean).not.toContain('9137')
      expect(sanitizeMessage(clean)).toBe(clean)
    })
    it(`redacts a ${open} value whose terminator lies beyond the input limit`, () => {
      const raw = `Error: pin=${open}9137 ${'padding '.repeat(LIMITS.rawMessage)}${close}`
      expect(raw.slice(0, LIMITS.rawMessage)).toContain('9137')
      const clean = sanitizeMessage(raw)
      expect(clean).not.toContain('9137')
      expect(sanitizeMessage(clean)).toBe(clean)
    })
  }
  for (const raw of [String.raw`Error: password="a\"FakeQaPass9"`, String.raw`Error: password='a\'FakeQaPass9'`]) {
    it(`escaped quotes do not expose the remaining secret: ${raw}`, () => {
      expect(raw).toContain('FakeQaPass9')
      const clean = sanitizeMessage(raw)
      expect(clean).not.toContain('FakeQaPass9')
      expect(sanitizeMessage(clean)).toBe(clean)
    })
  }
  it('keeps useful ordinary diagnostics', () => {
    const raw = "TypeError: Cannot read properties of undefined (reading 'items')"
    expect(sanitizeMessage(raw)).toBe(raw)
  })
})
