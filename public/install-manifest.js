(function () {
  // Точка адресуется UUID или человекочитаемым слагом (106). Формат слага —
  // как в CHECK location_slugs_format; строгая проверка и здесь, и в
  // buildMenuManifest, иначе в start_url установленного приложения попадёт
  // произвольный путь.
  var guestMatch = window.location.pathname.match(
    /^\/order\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/?$/i
  )
  var href = window.__ANGLE_APP_SURFACE__ === 'menu'
    ? '/menu.webmanifest'
    : '/manifest.webmanifest'

  if (guestMatch) {
    var incoming = new URLSearchParams(window.location.search)
    var manifestParams = new URLSearchParams()
    // Слаг в БД всегда строчный, а путь регистронезависим: нормализуем,
    // иначе /order/BULOCHKA не пройдёт валидацию на стороне манифеста.
    manifestParams.set('loc', guestMatch[1].toLowerCase())

    ;['table', 'mode', 'source'].forEach(function (key) {
      var value = incoming.get(key)
      if (value) manifestParams.set(key, value)
    })

    href = '/api/menu-manifest?' + manifestParams.toString()
  }

  var link = document.createElement('link')
  link.id = 'app-manifest'
  link.rel = 'manifest'
  link.href = href
  document.head.appendChild(link)
})()
