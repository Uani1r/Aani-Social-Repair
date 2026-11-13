/*
 * boot-guard.js — أداة كشف أسباب الشاشة البيضاء (ملف معزول تماماً).
 *
 * لا يستورد أي شيء، لا يعدّل App.tsx أو main.tsx، ولا يغلف fetch أو
 * console.error، ولا يمنع إقلاع React مهما حدث. دوره فقط:
 *   - يسجّل داخلياً الأخطاء الحقيقية الصادرة من نطاق التطبيق (يتجاهل
 *     «Script error.» المُقنَّعة بلا كائن خطأ أو من نطاق خارجي) وفشل تحميل
 *     وسوم <script>/<link>.
 *   - بعد 4 ثوانٍ من تحميل الصفحة يفحص #root:
 *       • غير فارغ → React أقلع، يتوقف فوراً بلا أي فعل.
 *       • فارغ → يعرض بطاقة تشخيص صغيرة أسفل الشاشة (زر × يغلقها فقط).
 */
(function () {
  'use strict';

  var realErrors = [];      // {kind:'js', message, file, line, col}
  var failedResources = []; // {kind:'resource', tag, src}
  var fired = false;

  function isCrossOrigin(url) {
    try {
      return new URL(url, window.location.href).origin !== window.location.origin;
    } catch (error) {
      return false;
    }
  }

  // مرحلة الالتقاط فقط لرصد فشل تحميل وسوم script/link؛ لا يعدّل أي سلوك.
  window.addEventListener('error', function (event) {
    try {
      var target = event.target;
      if (target && target !== window && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
        failedResources.push({ kind: 'resource', tag: target.tagName, src: target.src || target.href || '' });
        return;
      }
      if (target && target !== window && target.tagName) return; // مورد آخر — ليس خطأ JS

      // «Script error.» المُقنَّعة: بلا كائن خطأ أو بلا ملف أو من نطاق خارجي — تُتجاهل تماماً.
      var message = event.message || '';
      if (event.error === null || !event.filename || /^script error\.?$/i.test(message) || isCrossOrigin(event.filename)) {
        return;
      }
      realErrors.push({
        kind: 'js',
        message: message,
        file: event.filename,
        line: event.lineno,
        col: event.colno,
      });
    } catch (error) { /* هذه الأداة لا تفشل إطلاقاً */ }
  }, true);

  function formatFirstProblem() {
    if (realErrors.length > 0) {
      var first = realErrors[0];
      return 'أول خطأ برمجي: ' + first.message + '\nالملف: ' + first.file + ':' + first.line + ':' + first.col;
    }
    if (failedResources.length > 0) {
      var resource = failedResources[0];
      return 'أول ملف فشل تحميله: <' + resource.tag + '> ' + resource.src;
    }
    return 'لا أخطاء حقيقية مسجلة من نطاق التطبيق.';
  }

  function probeHealth() {
    try {
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = controller ? window.setTimeout(function () { controller.abort(); }, 4000) : 0;
      fetch('/api/health', { cache: 'no-store', signal: controller ? controller.signal : undefined })
        .then(function (response) {
          var ok = response.status >= 200 && response.status < 300;
          healthLine.textContent = 'الخادم الخلفي /api/health: HTTP ' + response.status + (ok ? ' — يستجيب' : ' — استجابة غير سليمة');
        })
        .catch(function () {
          healthLine.textContent = 'الخادم الخلفي /api/health: لا استجابة (غير مستجيب أو متوقف)';
        })
        .finally(function () { if (timer) window.clearTimeout(timer); });
    } catch (error) {
      healthLine.textContent = 'الخادم الخلفي /api/health: تعذر الفحص';
    }
  }

  var healthLine = null;

  function buildCard() {
    var card = document.createElement('div');
    card.id = 'boot-guard-card';
    card.setAttribute('dir', 'rtl');
    card.style.cssText = 'position:fixed;bottom:max(10px,env(safe-area-inset-bottom));left:10px;right:10px;margin:0 auto;max-width:560px;z-index:2147483647;'
      + 'background:#18181b;color:#e4e4e7;border:1px solid rgba(255,255,255,0.18);border-radius:12px;padding:12px 14px;'
      + 'font:12px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,0.45);';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;';
    var title = document.createElement('strong');
    title.textContent = 'كشف أسباب الشاشة البيضاء';
    header.appendChild(title);
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'إغلاق');
    close.textContent = '×';
    close.style.cssText = 'border:0;background:transparent;color:#a1a1aa;font-size:18px;line-height:1;cursor:pointer;padding:0 4px;';
    close.addEventListener('click', function () {
      if (card.parentNode) card.parentNode.removeChild(card);
    });
    header.appendChild(close);
    card.appendChild(header);

    var rootLine = document.createElement('div');
    rootLine.textContent = 'حالة #root: فارغ — لم يُركّب React بعد 4 ثوانٍ.';
    card.appendChild(rootLine);

    var problemLine = document.createElement('pre');
    problemLine.style.cssText = 'margin:6px 0 0;white-space:pre-wrap;word-break:break-word;color:#fca5a5;font:11px/1.6 ui-monospace,Menlo,monospace;';
    problemLine.textContent = formatFirstProblem();
    card.appendChild(problemLine);

    healthLine = document.createElement('div');
    healthLine.textContent = 'الخادم الخلفي /api/health: جارٍ الفحص…';
    card.appendChild(healthLine);

    document.body.appendChild(card);
    probeHealth();
  }

  function check() {
    if (fired) return;
    fired = true;
    try {
      var root = document.getElementById('root');
      if (root && root.childElementCount > 0) return; // React أقلع — لا فعل إطلاقاً
      if (!document.body) return;
      buildCard();
    } catch (error) { /* هذه الأداة لا تفشل إطلاقاً */ }
  }

  function schedule() {
    window.setTimeout(check, 4000);
  }

  if (document.readyState === 'complete') {
    schedule();
  } else {
    window.addEventListener('load', schedule);
  }
})();
