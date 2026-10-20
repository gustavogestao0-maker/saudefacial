(function () {
  var script = document.currentScript || document.getElementsByTagName('script')[document.getElementsByTagName('script').length - 1];
  var dataSet = (script && script.dataset) || {};
  var origin = script && script.src ? new URL(script.src, location.href).origin : location.origin;
  var endpoint = origin + '/api/pixel';
  var trackingId = dataSet.trackingId || '';
  var diagnostic = trackingId ? new URLSearchParams(location.search).get('trackerfy_test') || '' : '';
  var legacyDashboard = dataSet.dashboard || '';
  var storeKey = '__trackerfy_' + (trackingId || legacyDashboard || 'default');
  var attributionKeys = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','src','sck'];
  var clickKeys = ['fbclid','gclid','ttclid'];
  var paidWindowMs = 7 * 24 * 60 * 60 * 1000;
  var checkoutHosts = ['hotmart.com','pay.hotmart.com','wiapy.com','pay.wiapy.com','cakto.com.br','pay.cakto.com.br'];
  var inMemoryVisitorId = '';
  var automaticRouting = false;

  function withoutRoutingMarkers(value) {
    return typeof value === 'string' ? value.replace(/~tfy:[A-Za-z0-9_-]{1,80}~/g, '') : value;
  }

  function readStore() {
    try {
      var saved = JSON.parse(localStorage.getItem(storeKey) || '{}');
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
      attributionKeys.forEach(function (key) { if (saved[key]) saved[key] = withoutRoutingMarkers(saved[key]); });
      return saved;
    } catch (_) { return {}; }
  }
  function saveStore(value) { try { localStorage.setItem(storeKey, JSON.stringify(value)); } catch (_) {} }
  function visitorId() {
    var key = storeKey + '_visitor', value = inMemoryVisitorId;
    try { value = localStorage.getItem(key) || value; } catch (_) {}
    if (!value) {
      value = 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    }
    // Alguns navegadores bloqueiam localStorage. Mesmo assim, PageView e o
    // clique no checkout da mesma página precisam compartilhar o visitante.
    inMemoryVisitorId = value;
    try { localStorage.setItem(key, value); } catch (_) {}
    return value;
  }
  function eventId() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return 'ev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
  }
  function cookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\/+^]/g, '\$&') + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }
  function internal(name) {
    return ({ PageView:'page_view', ViewContent:'view_content', Lead:'lead', InitiateCheckout:'initiate_checkout', Purchase:'purchase' })[name] || name;
  }
  function normalized(value) {
    return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  }
  function lastNumericId(value) {
    var matches = String(value || '').match(/\d{6,}/g);
    return matches && matches.length ? matches[matches.length - 1] : '';
  }
  function isPaidAttribution(value) {
    if (value.fbclid || value.gclid || value.ttclid) return true;
    var medium = normalized(value.utm_medium);
    if (['cpc','ppc','paid','paid_media','paid_search','paid_social','social_paid','display','retargeting','remarketing'].indexOf(medium) > -1) return true;
    var source = normalized(value.utm_source || value.src);
    var metaSource = ['fb','facebook','facebook_ads','fb_ads','instagram','ig','meta','meta_ads'].indexOf(source) > -1 ||
      source.indexOf('facebook') > -1 || source.indexOf('instagram') > -1 || source.indexOf('meta_') === 0;
    return metaSource && Boolean(lastNumericId(value.utm_campaign) || lastNumericId(value.utm_medium) || lastNumericId(value.utm_content) || lastNumericId(value.utm_term));
  }
  function captureAttribution() {
    var params = new URLSearchParams(location.search), saved = readStore(), current = {};
    attributionKeys.concat(clickKeys).forEach(function (key) {
      var value = params.get(key);
      if (value) current[key] = withoutRoutingMarkers(value);
    });
    if (isPaidAttribution(current)) {
      // Um novo clique pago inicia uma jornada nova. Não misture IDs/UTMs da
      // campanha anterior quando o novo anúncio enviar menos parâmetros.
      saved = {};
      attributionKeys.concat(clickKeys).forEach(function (key) {
        if (current[key]) saved[key] = current[key];
      });
      saved.__paid_at = Date.now();
    } else if (!saved.__paid_at || Date.now() - Number(saved.__paid_at) > paidWindowMs) {
      saved = {};
    }
    if (saved.fbclid && !saved.fbc) saved.fbc = 'fb.1.' + Date.now() + '.' + saved.fbclid;
    saveStore(saved);
    return saved;
  }
  function hasRecentPaidAttribution(value) {
    return isPaidAttribution(value) && Number(value.__paid_at) > 0 && Date.now() - Number(value.__paid_at) <= paidWindowMs;
  }
  // Um teste não reutiliza atribuição paga guardada no navegador nem a envia
  // ao checkout; assim ele não contamina uma futura venda de teste.
  var attribution = diagnostic ? {} : captureAttribution();

  function initMeta(pixelId) {
    if (!pixelId) return;
    if (!window.fbq) {
      var fbq = window.fbq = function () { fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments); };
      if (!window._fbq) window._fbq = fbq;
      fbq.push = fbq; fbq.loaded = true; fbq.version = '2.0'; fbq.queue = [];
      var tag = document.createElement('script'); tag.async = true; tag.src = 'https://connect.facebook.net/en_US/fbevents.js';
      var first = document.getElementsByTagName('script')[0]; first.parentNode.insertBefore(tag, first);
    }
    var initialized = window.__trackerfyMetaPixels || (window.__trackerfyMetaPixels = {});
    if (!initialized[pixelId]) {
      window.fbq('init', pixelId);
      initialized[pixelId] = true;
    }
  }
  function send(name, extra, config) {
    var id = eventId();
    if (!diagnostic && config && config.provider === 'meta' && window.fbq) {
      var metaData = {};
      if (extra && typeof extra.value === 'number') { metaData.value = extra.value / 100; metaData.currency = extra.currency || 'BRL'; }
      // track enviaria também aos outros Pixels Meta instalados no mesmo site.
      window.fbq('trackSingle', config.pixelId, name, metaData, { eventID: id });
    }
    var payload = {
      v: visitorId(), id: id, e: internal(name), t: trackingId || undefined, d: legacyDashboard || undefined,
      diagnostic: diagnostic || undefined,
      u: location.href, r: document.referrer || '', title: document.title || '',
      fbp: cookie('_fbp') || undefined, fbc: attribution.fbc || cookie('_fbc') || undefined,
      utm: {
        utm_source: attribution.utm_source, utm_medium: attribution.utm_medium,
        utm_campaign: attribution.utm_campaign, utm_content: attribution.utm_content,
        utm_term: attribution.utm_term, src: attribution.src, sck: attribution.sck,
        fbclid: attribution.fbclid, gclid: attribution.gclid, ttclid: attribution.ttclid
      }
    };
    if (extra) {
      if (typeof extra.value === 'number') payload.val = extra.value;
      if (extra.metadata) payload.meta = extra.metadata;
    }
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        // text/plain evita preflight CORS num beacon entre o site e o app.
        // A API valida o JSON do corpo independentemente do Content-Type.
        if (navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return;
      }
    } catch (_) {}
    fetch(endpoint, { method:'POST', headers:{'content-type':'application/json'}, body:body, keepalive:true }).catch(function () {});
  }
  function compactAttribution(value) {
    if (!value) return '';
    var matches = String(value).match(/\d{6,}/g);
    if (matches && matches.length) return matches[matches.length - 1];
    return String(value).replace(/[|\r\n]/g, '-').slice(0, 48);
  }
  function hotmartXcod() {
    var values = [
      attribution.utm_source || attribution.src || '',
      compactAttribution(attribution.utm_campaign),
      compactAttribution(attribution.utm_medium),
      compactAttribution(attribution.utm_content),
      compactAttribution(attribution.utm_term)
    ];
    return values.some(Boolean) ? values.join('|').slice(0, 240) : '';
  }
  function isHotmartHost(hostname) {
    return hostname === 'hotmart.com' || hostname.endsWith('.hotmart.com');
  }
  function isCheckoutUrl(url) {
    return (url.protocol === 'https:' || url.protocol === 'http:') && checkoutHosts.some(function (host) {
      return url.hostname === host || url.hostname.endsWith('.' + host);
    });
  }
  function isCheckoutDestination(href) {
    try { return isCheckoutUrl(new URL(href, location.href)); } catch (_) { return false; }
  }
  function isHttpDestination(href) {
    try {
      var url = new URL(href, location.href);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch (_) { return false; }
  }
  function withRoutingMarker(value, limit) {
    var original = String(value || ''), marker = '~tfy:' + trackingId + '~';
    if (original.indexOf(marker) > -1 || original.length + marker.length > limit) return original;
    // Dois códigos instalados no mesmo site preservam ambos os marcadores.
    // O servidor pode detectar a ambiguidade, sem um script sobrescrever o outro.
    return original + marker;
  }
  function routedHotmartXcod(original) {
    var value = String(original || '');
    if (value.indexOf('=') > -1) {
      var query = new URLSearchParams(value);
      query.set('utm_content', withRoutingMarker(query.get('utm_content'), 240));
      var nextQuery = query.toString();
      return nextQuery.length <= 240 ? nextQuery : value;
    }
    if (value && value.indexOf('|') === -1) return withRoutingMarker(value, 240);
    var values = value ? value.split('|') : ['', '', '', '', ''];
    while (values.length < 5) values.push('');
    values[3] = withRoutingMarker(values[3], 240);
    var next = values.join('|');
    return next.length <= 240 ? next : value;
  }
  function decorateCheckoutLinks() {
    if (diagnostic) return;
    var params = new URLSearchParams();
    attributionKeys.concat(clickKeys).forEach(function (key) { if (attribution[key]) params.set(key, attribution[key]); });
    if (!params.toString() && !automaticRouting) return;
    function decorate(current, explicitCheckout) {
      try {
        var url = new URL(current, location.href);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return current;
        var checkout = isCheckoutUrl(url) || explicitCheckout === true;
        // Preserva a atribuição também entre páginas do próprio site. Links
        // externos que não são checkouts conhecidos permanecem intocados.
        if (!checkout && url.origin !== location.origin) return current;
        params.forEach(function (value, key) { if (!url.searchParams.has(key)) url.searchParams.set(key, value); });
        // A Hotmart não devolve UTMs estruturadas no webhook. O xcod compacto
        // carrega os IDs necessários sem substituir UTMs, SRC ou SCK existentes.
        var xcod = isHotmartHost(url.hostname) ? hotmartXcod() : '';
        if (xcod && !url.searchParams.has('xcod')) url.searchParams.set('xcod', xcod);
        if (automaticRouting && checkout && url.origin !== location.origin) {
          url.searchParams.set('utm_content', withRoutingMarker(url.searchParams.get('utm_content'), 500));
          if (isHotmartHost(url.hostname)) {
            var existingXcod = url.searchParams.get('xcod') || '';
            var routedXcod = routedHotmartXcod(existingXcod);
            if (routedXcod) url.searchParams.set('xcod', routedXcod);
          }
        }
        return url.toString();
      } catch (_) { return current; }
    }
    document.querySelectorAll('a[href]').forEach(function (link) {
      var next = decorate(link.href);
      if (next !== link.href) link.href = next;
    });
    document.querySelectorAll('form[action]').forEach(function (form) {
      var next = decorate(form.action);
      if (next !== form.action) form.action = next;
    });
    if (automaticRouting) document.querySelectorAll('[data-trackerfy-checkout-url]').forEach(function (element) {
      var current = element.getAttribute('data-trackerfy-checkout-url');
      if (!current) return;
      var next = decorate(current, true);
      if (next !== current) element.setAttribute('data-trackerfy-checkout-url', next);
    });
  }
  function watchCheckoutLinks() {
    document.addEventListener('click', decorateCheckoutLinks, true);
    document.addEventListener('submit', decorateCheckoutLinks, true);
    decorateCheckoutLinks();
    try {
      new MutationObserver(decorateCheckoutLinks).observe(document.documentElement, {
        childList:true, subtree:true, attributes:true,
        attributeFilter:automaticRouting ? ['href','action','data-trackerfy-checkout-url'] : ['href','action']
      });
    } catch (_) {}
  }
  function matchesDestination(ruleValue, href) {
    var expected = String(ruleValue || '').trim();
    if (!expected) return false;
    try {
      var destination = new URL(href, location.href);
      if (destination.protocol !== 'https:' && destination.protocol !== 'http:') return false;
      // Uma URL completa corresponde ao início do caminho do destino, não a
      // texto em parâmetros (?redirect=...) ou a um domínio parecido.
      if (expected.toLowerCase().indexOf('https://') === 0 || expected.toLowerCase().indexOf('http://') === 0) {
        var configured = new URL(expected);
        if (destination.origin !== configured.origin) return false;
        return destination.pathname.startsWith(configured.pathname);
      }
      return (destination.origin + destination.pathname).toLowerCase().indexOf(expected.toLowerCase()) > -1;
    } catch (_) { return false; }
  }
  function configure(config) {
    // Instale a biblioteca e inicialize o Pixel da Meta em qualquer visita.
    // O filtro de tráfego pago controla os eventos, não a presença do Pixel
    // no site. Assim o Meta Pixel Helper consegue reconhecer a instalação.
    if (config.provider === 'meta') initMeta(config.pixelId);
    automaticRouting = config.automaticRouting === true && /^[A-Za-z0-9_-]{1,80}$/.test(trackingId) && !diagnostic;
    // Compras orgânicas também precisam identificar o código do site. O filtro
    // pago continua valendo para os eventos enviados ao Pixel da Meta.
    if (automaticRouting) watchCheckoutLinks();
    if (config.paidTrafficOnly && !diagnostic && !hasRecentPaidAttribution(attribution)) {
      window.trackerfy = window.tfy = { track: function () {} };
      return;
    }
    var fired = {};
    function fireOnce(rule) {
      if (fired[rule.eventName]) return;
      fired[rule.eventName] = true;
      send(rule.eventName, null, config);
    }
    (config.rules || []).forEach(function (rule) {
      if (rule.triggerType === 'page_load') fireOnce(rule);
      if (rule.triggerType === 'url_contains' && rule.eventName !== 'InitiateCheckout' && rule.triggerValue && location.href.indexOf(rule.triggerValue) > -1) fireOnce(rule);
      if (rule.triggerType === 'css_selector' && rule.eventName !== 'InitiateCheckout' && rule.triggerValue) {
        var check = function () { try { if (document.querySelector(rule.triggerValue)) fireOnce(rule); } catch (_) {} };
        check();
        try { new MutationObserver(check).observe(document.documentElement, { childList:true, subtree:true }); } catch (_) {}
      }
    });
    if (!automaticRouting) watchCheckoutLinks();
    document.addEventListener('click', function (event) {
      decorateCheckoutLinks();
      var target = event.target;
      var anchor = null;
      var destination = null;
      for (var hops = 0; target && hops < 5; hops++, target = target.parentElement) {
        if (!anchor && target.tagName && target.tagName.toLowerCase() === 'a' && target.href) anchor = target;
        if (!destination && target.getAttribute) destination = target.getAttribute('data-trackerfy-checkout-url');
        var text = (target.innerText || target.textContent || target.value || '').trim().toLowerCase();
        (config.rules || []).forEach(function (rule) {
          if (rule.triggerType === 'click_text' && text && (rule.triggerValue || '').toLowerCase().split(',').some(function (part) { return part.trim() && text.indexOf(part.trim()) > -1; })) fireOnce(rule);
          if (rule.eventName === 'InitiateCheckout' && rule.triggerType === 'css_selector' && rule.triggerValue && target.matches) {
            try { if (target.matches(rule.triggerValue)) fireOnce(rule); } catch (_) {}
          }
        });
      }
      if (anchor || destination) (config.rules || []).forEach(function (rule) {
        if (rule.eventName === 'InitiateCheckout' && rule.triggerType === 'url_contains' && matchesDestination(rule.triggerValue, anchor ? anchor.href : destination)) fireOnce(rule);
        if (rule.eventName === 'InitiateCheckout' && rule.triggerType === 'checkout_link' &&
          ((destination && isHttpDestination(destination)) || (anchor && isCheckoutDestination(anchor.href)))) fireOnce(rule);
      });
    }, true);
    document.addEventListener('submit', function (event) {
      decorateCheckoutLinks();
      var form = event.target;
      if (!form || !form.action) return;
      (config.rules || []).forEach(function (rule) {
        if (rule.eventName === 'InitiateCheckout' && rule.triggerType === 'url_contains' && matchesDestination(rule.triggerValue, form.action)) fireOnce(rule);
        if (rule.eventName === 'InitiateCheckout' && rule.triggerType === 'checkout_link' && isCheckoutDestination(form.action)) fireOnce(rule);
      });
    }, true);
    window.trackerfy = window.tfy = { track: function (name, options) { send(name, options || null, config); } };
  }
  function start() {
    if (!trackingId) {
      configure({ provider:'legacy', paidTrafficOnly:true, rules:[
        { eventName:'PageView', triggerType:'page_load' },
        { eventName:'InitiateCheckout', triggerType:'click_text', triggerValue:dataSet.buyText || 'comprar agora,quero comprar' }
      ]});
      return;
    }
    fetch(origin + '/api/pixel/config?t=' + encodeURIComponent(trackingId), { mode:'cors', credentials:'omit' })
      .then(function (response) { if (!response.ok) throw new Error('config'); return response.json(); })
      .then(configure).catch(function () {});
  }
  // A configuração pode chegar antes de o visitante clicar num CTA acima da
  // dobra. O observer cuida dos links adicionados depois pelo site/SPA.
  start();
})();