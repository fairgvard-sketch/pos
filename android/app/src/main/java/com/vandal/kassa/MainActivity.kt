package com.vandal.kassa

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.sunmi.peripheral.printer.InnerPrinterCallback
import com.sunmi.peripheral.printer.InnerPrinterManager
import com.sunmi.peripheral.printer.SunmiPrinterService

/**
 * Тонкая обёртка Kassa для терминалов Sunmi (T2 mini и пр.):
 * WebView загружает боевой веб-POS (Vercel), а JS-мост window.KassaAndroid
 * даёт странице тихую печать на встроенный термопринтер (ESC/POS байты
 * через официальный printerlibrary). UI/логика остаются вебом —
 * обновления прилетают деплоем, APK менять не нужно.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView

    @Volatile
    private var printer: SunmiPrinterService? = null

    private val printerCallback = object : InnerPrinterCallback() {
        override fun onConnected(service: SunmiPrinterService) {
            printer = service
        }

        override fun onDisconnected() {
            printer = null
        }
    }

    /** Мост для веб-страницы: window.KassaAndroid */
    inner class Bridge {
        /** Есть ли связь со встроенным принтером */
        @JavascriptInterface
        fun isAvailable(): Boolean = printer != null

        /** Печать сырых ESC/POS байтов (base64). true = отправлено в принтер. */
        @JavascriptInterface
        fun printBase64(data: String): Boolean {
            val p = printer ?: return false
            return try {
                val bytes = Base64.decode(data, Base64.DEFAULT)
                p.sendRAWData(bytes, null)
                true
            } catch (e: Exception) {
                false
            }
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
            }
            webViewClient = WebViewClient()          // навигация внутри WebView
            addJavascriptInterface(Bridge(), "KassaAndroid")
        }

        setContentView(webView)
        webView.loadUrl(getString(R.string.app_url))
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
