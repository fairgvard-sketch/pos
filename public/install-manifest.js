(function () {
  var guestMatch = window.location.pathname.match(
    /^\/order\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i
  )
  var href = '/manifest.webmanifest'

  if (guestMatch) {
    var incoming = new URLSearchParams(window.location.search)
    var manifestParams = new URLSearchParams()
    manifestParams.set('loc', guestMatch[1])

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
