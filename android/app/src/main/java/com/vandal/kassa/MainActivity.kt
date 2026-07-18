package com.vandal.kassa

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.sunmi.peripheral.printer.InnerPrinterCallback
import com.sunmi.peripheral.printer.InnerPrinterManager
import com.sunmi.peripheral.printer.InnerResultCallback
import com.sunmi.peripheral.printer.SunmiPrinterService
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Тонкая обёртка Kassa для терминалов Sunmi (T2 mini и пр.):
 * WebView загружает боевой веб-POS (Vercel), а JS-мост window.KassaAndroid
 * даёт странице тихую печать на встроенный термопринтер (ESC/POS байты).
 *
 * Безопасность (P6):
 *  • навигация ВНУТРИ WebView разрешена только на точный production-origin;
 *  • внешние http(s)-ссылки уходят во внешний браузер (Intent), а не в кассу;
 *  • rawbt: (печать через RawBT) — отдельная разрешённая схема;
 *  • file:/content:/прочие схемы заблокированы;
 *  • file/content-доступ и mixed content выключены в WebSettings;
 *  • мост KassaAndroid активен, только пока открыт разрешённый origin
 *    (иначе произвольный сайт получил бы доступ к принтеру).
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView

    @Volatile
    private var printer: SunmiPrinterService? = null

    /** Точный origin, которому доверяем (схема+хост, без пути) */
    private val allowedOrigin: Uri by lazy { Uri.parse(getString(R.string.app_url)) }

    private val printerCallback = object : InnerPrinterCallback() {
        override fun onConnected(service: SunmiPrinterService) {
            printer = service
        }

        override fun onDisconnected() {
            printer = null
        }
    }

    /** URL принадлежит доверенному origin? (схема+хост совпадают) */
    private fun isAllowedOrigin(uri: Uri?): Boolean {
        if (uri == null) return false
        return uri.scheme.equals(allowedOrigin.scheme, ignoreCase = true) &&
            uri.host.equals(allowedOrigin.host, ignoreCase = true)
    }

    /** Мы сейчас на доверенной странице? Мост работает только там. */
    private fun onAllowedPage(): Boolean = isAllowedOrigin(Uri.parse(webView.url ?: ""))

    /** Экранировать строку для безопасной вставки в JS-литерал */
    private fun jsString(s: String): String = JSONObject.quote(s)

    /** Мост для веб-страницы: window.KassaAndroid */
    inner class Bridge {
        /**
         * v2: printBase64(jobId) гарантирует финальный callback результата.
         * v3: setOrientation(mode) — ориентация интерфейса из настроек кассы.
         */
        @JavascriptInterface
        fun bridgeVersion(): Int = 3

        /**
         * Ориентация интерфейса (Настройки → Устройство): auto|landscape|portrait.
         * Источник истины — настройка кассы в вебе: страница вызывает мост при
         * старте и при смене, отдельно в APK ничего не сохраняем. SENSOR_*
         * разрешает оба разворота выбранной оси (экран не «вверх ногами»).
         */
        @JavascriptInterface
        fun setOrientation(mode: String): Boolean {
            if (!onAllowedPage()) return false
            val value = when (mode) {
                "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
                "auto" -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                else -> return false
            }
            runOnUiThread { requestedOrientation = value }
            return true
        }

        /** Есть ли связь со встроенным принтером (и мы на доверенной странице) */
        @JavascriptInterface
        fun isAvailable(): Boolean = onAllowedPage() && printer != null

        /**
         * Печать сырых ESC/POS байтов (base64). Возвращает, ПРИНЯТО ли задание
         * в очередь (не результат печати!). Реальный итог приходит асинхронно
         * колбэком в window.__kassaPrintResult(jobId, status, message).
         *
         * status: 'queued' — принято; далее 'success' | 'error' с деталями.
         * Если принтер недоступен/не наша страница — сразу 'error'.
         */
        @JavascriptInterface
        fun printBase64(data: String, jobId: String): Boolean {
            if (!onAllowedPage()) {
                emitPrintResult(jobId, "error", "not-allowed-origin")
                return false
            }
            val p = printer
            if (p == null) {
                emitPrintResult(jobId, "disconnected", "printer-disconnected")
                return false
            }
            val bytes = try {
                Base64.decode(data, Base64.DEFAULT)
            } catch (e: Exception) {
                emitPrintResult(jobId, "error", "bad-data")
                return false
            }
            return try {
                // Только transaction printing даёт реальный onPrintResult.
                // ESC/POS payload внутри буфера всё равно шлём кусками из-за
                // лимита Binder; commit выполняется один раз после всех chunks.
                sendTransaction(p, bytes, jobId)
                emitPrintResult(jobId, "queued", null)
                true
            } catch (e: Exception) {
                // Старый сервис печати без transaction mode: буфер уже
                // сброшен без печати — шлём напрямую, итог рапортует колбэк
                // последнего чанка (семантика моста v1).
                try {
                    sendChunked(p, bytes, jobId)
                    emitPrintResult(jobId, "queued", null)
                    true
                } catch (e2: Exception) {
                    emitPrintResult(jobId, "error", e2.message ?: "send-failed")
                    false
                }
            }
        }

        /** Устаревшая сигнатура (без jobId) — совместимость со старым фронтом */
        @JavascriptInterface
        fun printBase64(data: String): Boolean = printBase64(data, "legacy")
    }

    /** Порог одного чанка байтов ESC/POS (с запасом под лимит Binder ~1МБ) */
    private val CHUNK_SIZE = 100 * 1024

    /**
     * Transaction printing: enter → chunked RAW data → commit с callback.
     * Обычный callback sendRAWData подтверждает выполнение RPC, но не факт
     * физической печати; реальный итог приходит в onPrintResult commit-а.
     */
    private fun sendTransaction(p: SunmiPrinterService, bytes: ByteArray, jobId: String) {
        p.enterPrinterBuffer(true)
        try {
            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(offset + CHUNK_SIZE, bytes.size)
                val chunk = bytes.copyOfRange(offset, end)
                p.sendRAWData(chunk, null)
                offset = end
            }
            p.exitPrinterBufferWithCallback(true, resultCallbackFor(jobId))
        } catch (e: Exception) {
            // Не оставляем сервис в transaction mode после ошибки чанка.
            try { p.exitPrinterBuffer(false) } catch (_: Exception) { /* best effort */ }
            throw e
        }
    }

    /**
     * Прямая отправка без transaction mode — fallback для прошивок, где
     * transaction API бросает. Колбэк вешаем на последний чанк: его
     * onRunResult(true) через RESULT_GRACE_MS подтвердит успех.
     */
    private fun sendChunked(p: SunmiPrinterService, bytes: ByteArray, jobId: String) {
        var offset = 0
        while (offset < bytes.size) {
            val end = minOf(offset + CHUNK_SIZE, bytes.size)
            val chunk = bytes.copyOfRange(offset, end)
            val isLast = end >= bytes.size
            p.sendRAWData(chunk, if (isLast) resultCallbackFor(jobId) else null)
            offset = end
        }
    }

    /**
     * Не все прошивки шлют onPrintResult после commit: после успешного
     * onRunResult ждём финал это время и, если его нет, подтверждаем успех
     * сами (иначе web-часть считает печать проваленной по своему timeout).
     */
    private val RESULT_GRACE_MS = 5000L

    private val mainHandler by lazy { Handler(mainLooper) }

    /**
     * Колбэк принтера → результат задания в JS. Финал шлём один раз: реальный
     * onPrintResult/onRaiseException выигрывает у отложенного подтверждения,
     * опоздавший дубль игнорируется и здесь, и в web-части.
     */
    private fun resultCallbackFor(jobId: String) = object : InnerResultCallback() {
        private val done = AtomicBoolean(false)
        private fun emitOnce(status: String, message: String?) {
            if (done.compareAndSet(false, true)) emitPrintResult(jobId, status, message)
        }
        override fun onRunResult(isSuccess: Boolean) {
            // Это результат выполнения binder-команды, не физической печати.
            // Явный отказ сообщаем сразу, не дожидаясь timeout web-части.
            if (!isSuccess) {
                emitOnce("error", "run-failed")
                return
            }
            // Команда выполнена; если прошивка так и не пришлёт onPrintResult,
            // считаем задание напечатанным (поведение моста v1).
            mainHandler.postDelayed({ emitOnce("success", "run-result-only") }, RESULT_GRACE_MS)
        }
        override fun onReturnString(result: String?) { /* не используем */ }
        override fun onRaiseException(code: Int, msg: String?) {
            // Частые коды: нет бумаги / крышка открыта / перегрев
            val status = when {
                msg?.contains("paper", ignoreCase = true) == true -> "no-paper"
                else -> "error"
            }
            emitOnce(status, msg ?: "exception-$code")
        }
        override fun onPrintResult(code: Int, msg: String?) {
            val status = when {
                code == 0 -> "success"
                msg?.contains("paper", ignoreCase = true) == true -> "no-paper"
                else -> "error"
            }
            emitOnce(status, msg ?: if (code == 0) null else "print-result-$code")
        }
    }

    /** Позвать window.__kassaPrintResult(jobId, status, message) на UI-потоке */
    private fun emitPrintResult(jobId: String, status: String, message: String?) {
        val js = "window.__kassaPrintResult && window.__kassaPrintResult(" +
            "${jsString(jobId)}, ${jsString(status)}, ${if (message == null) "null" else jsString(message)});"
        runOnUiThread {
            if (::webView.isInitialized) webView.evaluateJavascript(js, null)
        }
    }

    /** Открыть URL во внешнем приложении (браузер/RawBT), не в кассе */
    private fun openExternally(uri: Uri): Boolean {
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Касса не должна гаснуть
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Связь со встроенным принтером Sunmi
        try {
            InnerPrinterManager.getInstance().bindService(this, printerCallback)
        } catch (e: Exception) {
            // Не Sunmi-устройство — мост просто скажет isAvailable=false
        }

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true            // localStorage (настройки кассы)
                databaseEnabled = true
                cacheMode = WebSettings.LOAD_DEFAULT // SW/PWA-кэш работает
                mediaPlaybackRequiresUserGesture = false // звук оплаты
                setSupportZoom(false)
                // Безопасность: никакого доступа к file:// и content://,
                // никакого mixed content (https-страница не грузит http-ресурсы)
                allowFileAccess = false
                allowContentAccess = false
                @Suppress("DEPRECATION")
                allowFileAccessFromFileURLs = false
                @Suppress("DEPRECATION")
                allowUniversalAccessFromFileURLs = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    return handleUrl(uri)
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
                    AlertDialog.Builder(this@MainActivity)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                        .setOnCancelListener { result.cancel() }
                        .show()
                    return true
                }

                override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                    AlertDialog.Builder(this@MainActivity)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                        .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                        .setOnCancelListener { result.cancel() }
                        .show()
                    return true
                }
            }
            addJavascriptInterface(Bridge(), "KassaAndroid")
        }

        setContentView(webView)
        webView.loadUrl(getString(R.string.app_url))
    }

    /**
     * Решение по навигации:
     *  • доверенный origin → грузим внутри (return false);
     *  • rawbt: → отдаём RawBT (внешнему приложению печати);
     *  • http(s) на чужой хост → внешний браузер;
     *  • всё прочее (file:, content:, intent:, tel: и т.п.) — блок.
     */
    private fun handleUrl(uri: Uri): Boolean {
        if (isAllowedOrigin(uri)) return false // грузим в кассе
        when (uri.scheme?.lowercase()) {
            "rawbt" -> { openExternally(uri); return true }
            "http", "https" -> { openExternally(uri); return true }
            else -> return true // блокируем небезопасные/неизвестные схемы
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // Назад по истории кассы; из приложения случайно не выходим
        if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
    }

    override fun onDestroy() {
        try {
            InnerPrinterManager.getInstance().unBindService(this, printerCallback)
        } catch (e: Exception) {
            // уже отвязан
        }
        super.onDestroy()
    }
}
