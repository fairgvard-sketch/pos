package com.vandal.kassa

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
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
                emitPrintResult(jobId, "error", "disconnected")
                return false
            }
            val bytes = try {
                Base64.decode(data, Base64.DEFAULT)
            } catch (e: Exception) {
                emitPrintResult(jobId, "error", "bad-data")
                return false
            }
            return try {
                // Binder имеет лимит на размер транзакции — длинные чеки шлём
                // кусками. Итог задания рапортует колбэк последнего чанка.
                sendChunked(p, bytes, jobId)
                emitPrintResult(jobId, "queued", null)
                true
            } catch (e: Exception) {
                emitPrintResult(jobId, "error", e.message ?: "send-failed")
                false
            }
        }

        /** Устаревшая сигнатура (без jobId) — совместимость со старым фронтом */
        @JavascriptInterface
        fun printBase64(data: String): Boolean = printBase64(data, "legacy")
    }

    /** Порог одного чанка байтов ESC/POS (с запасом под лимит Binder ~1МБ) */
    private val CHUNK_SIZE = 100 * 1024

    /**
     * Отправка байтов принтеру кусками. Колбэк вешаем на ПОСЛЕДНИЙ чанк —
     * он и рапортует итог задания в JS. Промежуточные чанки без колбэка.
     */
    private fun sendChunked(p: SunmiPrinterService, bytes: ByteArray, jobId: String) {
        var offset = 0
        while (offset < bytes.size) {
            val end = minOf(offset + CHUNK_SIZE, bytes.size)
            val chunk = bytes.copyOfRange(offset, end)
            val isLast = end >= bytes.size
            val cb = if (isLast) resultCallbackFor(jobId) else null
            p.sendRAWData(chunk, cb)
            offset = end
        }
    }

    /** Колбэк принтера → результат задания в JS */
    private fun resultCallbackFor(jobId: String) = object : InnerResultCallback() {
        override fun onRunResult(isSuccess: Boolean) {
            emitPrintResult(jobId, if (isSuccess) "success" else "error", if (isSuccess) null else "run-failed")
        }
        override fun onReturnString(result: String?) { /* не используем */ }
        override fun onRaiseException(code: Int, msg: String?) {
            // Частые коды: нет бумаги / крышка открыта / перегрев
            val status = when {
                msg?.contains("paper", ignoreCase = true) == true -> "no-paper"
                else -> "error"
            }
            emitPrintResult(jobId, status, msg ?: "exception-$code")
        }
        override fun onPrintResult(code: Int, msg: String?) { /* итог даёт onRunResult */ }
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
