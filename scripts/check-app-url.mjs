#!/usr/bin/env node
/**
 * Guard app_url: перед выпуском APK проверяет, что зашитый в него origin
 * реально жив (был инцидент: pos-self-sigma.vercel.app отвязался от деплоя
 * и стал отдавать 404 DEPLOYMENT_NOT_FOUND — установленная касса осталась
 * без фронтенда, и починить это можно было только новой сборкой APK).
 *
 * Проверяет:
 *   1. app_url — https и НЕ автогенерённый *.vercel.app (такой адрес
 *      отвязывается при пересоздании деплоя);
 *   2. origin отвечает 200 на корне (сеть недоступна → warning, не падаем).
 *
 * Использование:
 *   node scripts/check-app-url.mjs
 *
 * Ненулевой код выхода → APK выпускать нельзя.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const STRINGS = join(root, 'android/app/src/main/res/values/strings.xml')

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exit(1)
}

const xml = readFileSync(STRINGS, 'utf8')
const match = xml.match(/<string name="app_url">([^<]+)<\/string>/)
if (!match) fail(`app_url не найден в ${STRINGS}`)

const appUrl = match[1].trim()
let url
try {
  url = new URL(appUrl)
} catch {
  fail(`app_url не является URL: ${appUrl}`)
}

if (url.protocol !== 'https:') {
  fail(`app_url должен быть https (usesCleartextTraffic=false): ${appUrl}`)
}

// Именно endsWith, а не includes: собственный домен может содержать слово
// vercel, и запрещать такой адрес незачем.
if (url.hostname.endsWith('.vercel.app')) {
  fail(
    `app_url указывает на автогенерённый ${url.hostname}. Такой адрес ` +
    'отвязывается от проекта при пересоздании деплоя и отдаёт 404 ' +
    'DEPLOYMENT_NOT_FOUND, а установленный APK остаётся без фронтенда. ' +
    'Используйте собственный домен.'
  )
}

const response = await fetch(url.origin, { redirect: 'follow' })
  .catch((error) => ({ error }))

if (response.error) {
  console.warn(`WARN ${url.origin} не проверен (сеть): ${response.error.message}`)
  console.log(`OK app_url: ${appUrl} (формат)`)
  process.exit(0)
}

if (!response.ok) {
  fail(
    `${url.origin} отвечает ${response.status}` +
    `${response.headers.get('x-vercel-error') ? ` (${response.headers.get('x-vercel-error')})` : ''}. ` +
    'Касса в APK останется без фронтенда — исправьте домен до выпуска.'
  )
}

console.log(`OK app_url: ${appUrl} (${response.status})`)
