// The browser script an owner installs (or that a Website Studio site loads from its own address). It is delivered as a string so it can be served by a
// route handler on every deployment target; it is plain ES5-style JavaScript with no dependencies, and it never contains a secret: the only identifier it
// carries is the widget's public key, which names a widget and opens nothing by itself.
//
// Written as one String.raw block. Rules for editing it: no backticks and no template placeholders inside (use string concatenation), and keep it
// self-contained. tests/webchat-widget.test.tsx runs this exact text in a browser-like environment against the real server code.
//
// What it does: shows a launcher; on open it shows the welcome message; the visitor's session starts only when they send their first message or submit the
// details form (nothing is stored in the browser before that); the session token lives in localStorage (if the browser allows it) under a key for this
// widget; messages are shown as text only (never as markup); it polls while open and while a reply may arrive.
export const WIDGET_SCRIPT = String.raw`(function () {
  'use strict';
  if (window.__iacquireChat) return;
  window.__iacquireChat = true;

  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName('script');
    script = all[all.length - 1];
  }
  var key = script && script.getAttribute ? script.getAttribute('data-key') : null;
  if (!key) { return; }
  var origin = '';
  try { origin = new URL(script.src, location.href).origin; } catch (e) { return; }
  var base = origin + '/api/public/webchat/';
  var STORE = 'iacquire-chat:' + String(key).slice(0, 12);

  var state = { cfg: null, token: null, open: false, messages: [], mode: 'assistant', leadCaptured: false, busy: false, typing: false, unread: 0, lastCount: 0, started: false, form: false, notice: '' };
  var timer = null;

  function load() {
    try { var raw = window.localStorage.getItem(STORE); if (raw) { var o = JSON.parse(raw); if (o && typeof o.t === 'string') { state.token = o.t; } } } catch (e) { /* storage may be blocked */ }
  }
  function save() {
    try { if (state.token) { window.localStorage.setItem(STORE, JSON.stringify({ t: state.token })); } else { window.localStorage.removeItem(STORE); } } catch (e) { /* ignore */ }
  }

  function api(action, method, body, query) {
    var url = base + action + '?k=' + encodeURIComponent(key);
    if (query) { url += '&' + query; }
    var headers = { 'Accept': 'application/json' };
    if (body !== null && body !== undefined) { headers['Content-Type'] = 'application/json'; }
    if (state.token) { headers['Authorization'] = 'Bearer ' + state.token; }
    var init = { method: method, headers: headers, credentials: 'omit', cache: 'no-store', mode: 'cors' };
    if (body !== null && body !== undefined) { init.body = JSON.stringify(body); }
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: { code: 'invalid', message: 'Something went wrong.' } }; }).then(function (json) { json.__status = res.status; return json; });
    });
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) { for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) { if (k === 'text') { n.textContent = attrs[k]; } else if (k === 'class') { n.className = attrs[k]; } else if (k === 'style') { n.style.cssText = attrs[k]; } else { n.setAttribute(k, attrs[k]); } } } }
    if (children) { for (var i = 0; i < children.length; i++) { if (children[i]) { n.appendChild(children[i]); } } }
    return n;
  }
  function uid() {
    var a = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) { window.crypto.getRandomValues(a); } else { for (var i = 0; i < a.length; i++) { a[i] = Math.floor(Math.random() * 256); } }
    var s = '';
    for (var j = 0; j < a.length; j++) { s += ('0' + a[j].toString(16)).slice(-2); }
    return 'm' + s;
  }
  function readable(hex) {
    var h = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#2563eb';
    var r = parseInt(h.slice(1, 3), 16) / 255, g = parseInt(h.slice(3, 5), 16) / 255, b = parseInt(h.slice(5, 7), 16) / 255;
    function lin(c) { return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    var L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return { color: h, text: L > 0.4 ? '#0b1220' : '#ffffff' };
  }

  var host, root, launcher, panel, logEl, inputEl, sendBtn, noticeEl, formEl, handoffBtn, badge, leadBtn, typingEl, titleEl, privacyEl, offlineEl;

  function css(c) {
    var p = state.cfg.position === 'bottom-left' ? 'left:16px;' : 'right:16px;';
    return ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
      '.launcher{position:fixed;bottom:16px;' + p + 'z-index:2147483000;min-height:48px;min-width:48px;padding:0 18px;border-radius:999px;border:0;cursor:pointer;background:' + c.color + ';color:' + c.text + ';font-size:15px;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.25);display:flex;align-items:center;gap:8px}' +
      '.launcher:focus-visible,.btn:focus-visible,.close:focus-visible,textarea:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}' +
      '.badge{background:#dc2626;color:#fff;border-radius:999px;min-width:20px;height:20px;font-size:12px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px}' +
      '.panel{position:fixed;bottom:76px;' + p + 'z-index:2147483000;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 100px);background:#fff;color:#111827;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden}' +
      '.panel[hidden]{display:none}' +
      '.head{background:' + c.color + ';color:' + c.text + ';padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      '.head h2{margin:0;font-size:16px;font-weight:700}' +
      '.close{background:transparent;border:0;color:inherit;font-size:22px;line-height:1;cursor:pointer;min-width:44px;min-height:44px;border-radius:8px}' +
      '.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f6f7f9}' +
      '.msg{max-width:85%;padding:10px 12px;border-radius:14px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}' +
      '.msg .who,.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
      '.v{align-self:flex-end;background:' + c.color + ';color:' + c.text + ';border-bottom-right-radius:4px}' +
      '.a,.t{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}' +
      '.t{border-color:#bfdbfe;background:#eff6ff}' +
      '.s{align-self:center;background:#fef3c7;color:#78350f;border:1px solid #fde68a;font-size:13px;text-align:center}' +
      '.intro{align-self:flex-start;background:#fff;border:1px dashed #cbd5e1;color:#334155}' +
      '.typing{font-size:13px;color:#475569;padding:0 14px 6px;min-height:22px;background:#f6f7f9}' +
      '.tools{display:flex;flex-wrap:wrap;gap:8px;padding:8px 12px;border-top:1px solid #e5e7eb;background:#fff}' +
      '.btn{min-height:44px;padding:0 14px;border-radius:10px;border:1px solid #cbd5e1;background:#fff;color:#111827;font-size:14px;cursor:pointer}' +
      '.btn.primary{background:' + c.color + ';color:' + c.text + ';border-color:' + c.color + ';font-weight:600}' +
      '.btn[disabled]{opacity:.55;cursor:not-allowed}' +
      '.compose{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #e5e7eb;background:#fff;align-items:flex-end}' +
      'textarea{flex:1;min-height:44px;max-height:120px;resize:none;border:1px solid #94a3b8;border-radius:10px;padding:10px;font-size:15px;color:#111827;background:#fff}' +
      'label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}' +
      'input[type=text],input[type=email],input[type=tel],select{width:100%;min-height:44px;border:1px solid #94a3b8;border-radius:10px;padding:8px 10px;font-size:15px;background:#fff;color:#111827}' +
      '.check{display:flex;gap:10px;align-items:flex-start;font-size:13px;margin:12px 0}.check input{width:22px;height:22px;margin-top:1px}' +
      '.form{padding:12px 14px;overflow-y:auto;background:#fff;flex:1}' +
      '.foot{padding:8px 14px;font-size:12px;color:#475569;background:#fff;border-top:1px solid #e5e7eb}.foot a{color:#1d4ed8}' +
      '.note{padding:8px 14px;font-size:13px;background:#fff7ed;color:#7c2d12;border-top:1px solid #fed7aa}' +
      '.err{color:#b91c1c;font-size:13px;margin:8px 0}' +
      '@media (max-width:480px){.panel{inset:0;bottom:0;width:100vw;max-width:100vw;height:100vh;height:100dvh;max-height:100dvh;border-radius:0;padding-bottom:env(safe-area-inset-bottom)}textarea,input[type=text],input[type=email],input[type=tel],select{font-size:16px}}' +
      '@media (prefers-color-scheme:dark){.panel,.tools,.compose,.foot,.form{background:#111827;color:#e5e7eb;border-color:#374151}.log,.typing{background:#0b1220}.a,.t,.intro{background:#1f2937;color:#e5e7eb;border-color:#374151}.btn{background:#1f2937;color:#e5e7eb;border-color:#4b5563}textarea,input[type=text],input[type=email],input[type=tel],select{background:#0b1220;color:#e5e7eb;border-color:#6b7280}.foot a{color:#93c5fd}.s{background:#422006;color:#fde68a;border-color:#854d0e}.err{color:#fca5a5}}' +
      '@media (prefers-reduced-motion:no-preference){.panel{animation:iaqin .15s ease-out}@keyframes iaqin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}';
  }

  function build() {
    var c = readable(state.cfg.brandColor);
    host = document.createElement('div');
    host.setAttribute('data-iacquire-chat', '');
    root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    // A constructed stylesheet is not blocked by a page's style-src policy (an inline style element would be); older browsers fall back to one.
    var sheetText = css(c);
    var adopted = false;
    try {
      if (root.adoptedStyleSheets !== undefined && typeof CSSStyleSheet === 'function' && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(sheetText);
        root.adoptedStyleSheets = [sheet];
        adopted = true;
      }
    } catch (e) { adopted = false; }
    if (!adopted) {
      var style = document.createElement('style');
      style.textContent = sheetText;
      root.appendChild(style);
    }

    badge = el('span', { 'class': 'badge' });
    badge.style.display = 'none';
    launcher = el('button', { 'class': 'launcher', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'iaq-panel' }, [el('span', { text: state.cfg.launcherLabel }), badge]);
    launcher.addEventListener('click', function () { setOpen(!state.open); });

    titleEl = el('h2', { id: 'iaq-title', text: state.cfg.title });
    var closeBtn = el('button', { 'class': 'close', type: 'button', 'aria-label': 'Close chat', text: '×' });
    closeBtn.addEventListener('click', function () { setOpen(false); launcher.focus(); });
    var head = el('div', { 'class': 'head' }, [titleEl, closeBtn]);

    offlineEl = el('div', { 'class': 'note', role: 'status' });
    offlineEl.style.display = 'none';
    logEl = el('div', { 'class': 'log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Conversation', tabindex: '0' });
    typingEl = el('div', { 'class': 'typing', role: 'status', 'aria-live': 'polite' });
    noticeEl = el('div', { 'class': 'note', role: 'alert' });
    noticeEl.style.display = 'none';

    inputEl = el('textarea', { id: 'iaq-input', rows: '1', maxlength: String(state.cfg.messageMaxLength || 1000), placeholder: 'Type your message', 'aria-label': 'Your message' });
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    sendBtn = el('button', { 'class': 'btn primary', type: 'button', text: 'Send' });
    sendBtn.addEventListener('click', sendMessage);
    var compose = el('div', { 'class': 'compose' }, [inputEl, sendBtn]);

    handoffBtn = el('button', { 'class': 'btn', type: 'button', text: 'Talk to a person' });
    handoffBtn.addEventListener('click', askForPerson);
    leadBtn = el('button', { 'class': 'btn', type: 'button', text: 'Leave your details' });
    leadBtn.addEventListener('click', function () { state.form = true; renderBody(); });
    var tools = el('div', { 'class': 'tools' }, [handoffBtn, leadBtn]);

    privacyEl = el('div', { 'class': 'foot' });
    privacyEl.appendChild(document.createTextNode(state.cfg.privacyNotice + ' '));
    if (state.cfg.privacyUrl) { var a = el('a', { href: state.cfg.privacyUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Privacy policy' }); privacyEl.appendChild(a); }

    formEl = el('div', { 'class': 'form' });
    panel = el('section', { id: 'iaq-panel', 'class': 'panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'iaq-title', hidden: '' }, [head, offlineEl, logEl, typingEl, noticeEl, tools, compose, formEl, privacyEl]);
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { setOpen(false); launcher.focus(); } });

    root.appendChild(launcher);
    root.appendChild(panel);
    document.body.appendChild(host);
    renderBody();
  }

  function setOpen(v) {
    state.open = v;
    launcher.setAttribute('aria-expanded', v ? 'true' : 'false');
    if (v) {
      panel.removeAttribute('hidden');
      state.unread = 0;
      renderBadge();
      if (state.token && !state.started) { fetchMessages(true); }
      renderBody();
      var target = state.form ? formEl.querySelector('input') : inputEl;
      if (target) { target.focus(); }
    } else {
      panel.setAttribute('hidden', '');
    }
    schedule();
  }

  function renderBadge() {
    // The button's name comes from its own content ("Chat 2 new messages"), so what a sighted visitor reads is contained in what is announced.
    badge.textContent = String(state.unread);
    badge.appendChild(el('span', { 'class': 'vh', text: ' new message' + (state.unread === 1 ? '' : 's') }));
    badge.style.display = state.unread > 0 ? 'inline-flex' : 'none';
  }

  function bubble(m) {
    var cls = m.role === 'visitor' ? 'v' : m.role === 'assistant' ? 'a' : m.role === 'team' ? 't' : 's';
    var who = m.role === 'visitor' ? 'You: ' : m.role === 'assistant' ? 'Assistant: ' : m.role === 'team' ? 'Team member: ' : 'Notice: ';
    var n = el('div', { 'class': 'msg ' + cls });
    n.appendChild(el('span', { 'class': 'who', text: who }));
    n.appendChild(document.createTextNode(m.text));
    return n;
  }

  function renderBody() {
    if (!logEl) { return; }
    while (logEl.firstChild) { logEl.removeChild(logEl.firstChild); }
    var cfg = state.cfg;
    logEl.appendChild(el('div', { 'class': 'msg intro', text: cfg.welcomeMessage }));
    for (var i = 0; i < state.messages.length; i++) { logEl.appendChild(bubble(state.messages[i])); }
    logEl.scrollTop = logEl.scrollHeight;
    typingEl.textContent = state.typing ? 'The assistant is typing…' : '';
    var away = !cfg.aiAvailable;
    offlineEl.style.display = away ? 'block' : 'none';
    offlineEl.textContent = away ? cfg.offlineMessage : '';
    var waiting = state.mode === 'waiting' || state.mode === 'team';
    handoffBtn.style.display = state.mode === 'team' || !state.started ? 'none' : 'inline-block';
    handoffBtn.disabled = state.mode === 'waiting';
    handoffBtn.textContent = state.mode === 'waiting' ? 'A team member was asked to join' : 'Talk to a person';
    var canLead = cfg.leadForm !== 'never' && !state.leadCaptured;
    leadBtn.style.display = canLead || (away && !state.leadCaptured) ? 'inline-block' : 'none';
    var requireFirst = cfg.leadForm === 'required' && !state.leadCaptured && !state.started;
    formEl.style.display = state.form || requireFirst ? 'block' : 'none';
    inputEl.parentNode.style.display = state.form || requireFirst ? 'none' : 'flex';
    if (formEl.style.display === 'block') { renderForm(); }
    void waiting;
  }

  function field(id, label, type, extra) {
    var wrap = document.createDocumentFragment();
    wrap.appendChild(el('label', { 'for': id, text: label }));
    var attrs = { id: id, type: type, name: id };
    if (extra) { for (var k in extra) { attrs[k] = extra[k]; } }
    wrap.appendChild(el('input', attrs));
    return wrap;
  }

  function renderForm() {
    if (formEl.getAttribute('data-built') === '1') { return; }
    formEl.setAttribute('data-built', '1');
    var cfg = state.cfg;
    formEl.appendChild(el('p', { text: 'Leave your details and a team member can get back to you. We will use them only to reply about your enquiry.', style: 'margin:0 0 4px;font-size:14px' }));
    formEl.appendChild(field('iaq-name', 'Your name', 'text', { autocomplete: 'name', maxlength: '120' }));
    formEl.appendChild(field('iaq-email', 'Email address', 'email', { autocomplete: 'email', maxlength: '254' }));
    formEl.appendChild(field('iaq-phone', 'Phone, with country code (optional)', 'tel', { autocomplete: 'tel', maxlength: '32', placeholder: '+1 555 123 4567' }));
    var qs = cfg.questions || [];
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      if (q.kind === 'choice') {
        formEl.appendChild(el('label', { 'for': 'iaq-q-' + q.key, text: q.label + (q.required ? ' (required)' : '') }));
        var sel = el('select', { id: 'iaq-q-' + q.key, name: q.key });
        sel.appendChild(el('option', { value: '', text: 'Choose one' }));
        for (var j = 0; j < (q.choices || []).length; j++) { sel.appendChild(el('option', { value: q.choices[j], text: q.choices[j] })); }
        formEl.appendChild(sel);
      } else {
        formEl.appendChild(field('iaq-q-' + q.key, q.label + (q.required ? ' (required)' : ''), 'text', { maxlength: '300' }));
      }
    }
    var ack = el('input', { type: 'checkbox', id: 'iaq-ack' });
    formEl.appendChild(el('div', { 'class': 'check' }, [ack, el('label', { 'for': 'iaq-ack', style: 'margin:0;font-weight:400', text: 'I have read the privacy notice below and agree that the team may contact me about my enquiry.' })]));
    if (cfg.offerMarketingOptIn) {
      var mk = el('input', { type: 'checkbox', id: 'iaq-mk' });
      formEl.appendChild(el('div', { 'class': 'check' }, [mk, el('label', { 'for': 'iaq-mk', style: 'margin:0;font-weight:400', text: 'I would also like to receive occasional offers and news.' })]));
    }
    var err = el('div', { 'class': 'err', role: 'alert', id: 'iaq-form-err' });
    formEl.appendChild(err);
    var submit = el('button', { 'class': 'btn primary', type: 'button', text: 'Send my details' });
    var cancel = el('button', { 'class': 'btn', type: 'button', text: 'Back to chat', style: 'margin-left:8px' });
    submit.addEventListener('click', function () { submitLead(err, submit); });
    cancel.addEventListener('click', function () { state.form = false; formEl.removeAttribute('data-built'); while (formEl.firstChild) { formEl.removeChild(formEl.firstChild); } renderBody(); inputEl.focus(); });
    formEl.appendChild(submit);
    if (!(cfg.leadForm === 'required' && !state.started)) { formEl.appendChild(cancel); }
  }

  function notice(text) {
    state.notice = text || '';
    noticeEl.textContent = state.notice;
    noticeEl.style.display = state.notice ? 'block' : 'none';
  }

  function apply(view) {
    if (!view) { return; }
    var count = view.messages.length;
    if (!state.open && count > state.lastCount) {
      for (var i = state.lastCount; i < count; i++) { if (view.messages[i].role !== 'visitor') { state.unread++; } }
    }
    state.lastCount = count;
    state.messages = view.messages;
    state.mode = view.mode;
    state.leadCaptured = view.leadCaptured;
    if (count > 0) { state.started = true; }
    renderBadge();
    renderBody();
  }

  function failure(json) {
    if (json.__status === 401) { state.token = null; state.started = false; state.messages = []; state.lastCount = 0; save(); notice('This chat ended. Send a message to start a new one.'); renderBody(); return; }
    var msg = json && json.error && json.error.message ? json.error.message : 'The chat could not be reached. Please try again.';
    notice(msg);
  }

  function ensureSession() {
    if (state.token) { return Promise.resolve(true); }
    var body = { landing: location.pathname + location.search, referrer: document.referrer || '', timezone: '' };
    try { body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* ignore */ }
    return api('session', 'POST', body).then(function (json) {
      if (json.ok && json.token) { state.token = json.token; save(); return true; }
      if (json.ok) { return true; }
      failure(json);
      return false;
    });
  }

  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || state.busy) { return; }
    state.busy = true;
    sendBtn.disabled = true;
    notice('');
    var pending = { id: 'local-' + uid(), role: 'visitor', text: text, at: new Date().toISOString() };
    state.messages = state.messages.concat([pending]);
    state.started = true;
    state.typing = state.cfg.aiAvailable;
    inputEl.value = '';
    renderBody();
    ensureSession().then(function (ok) {
      if (!ok) { throw new Error('session'); }
      return api('send', 'POST', { text: text, clientMessageId: uid() });
    }).then(function (json) {
      state.busy = false; sendBtn.disabled = false; state.typing = false;
      if (json && json.ok) { apply(json.view); }
      else if (json) { state.messages = state.messages.filter(function (m) { return m.id !== pending.id; }); inputEl.value = text; failure(json); renderBody(); }
    }).catch(function () {
      state.busy = false; sendBtn.disabled = false; state.typing = false;
      state.messages = state.messages.filter(function (m) { return m.id !== pending.id; });
      inputEl.value = text;
      notice('Your message was not sent. Check your connection and try again.');
      renderBody();
    });
  }

  function askForPerson() {
    if (!state.token) { notice('Send a message first so the team knows what you need.'); return; }
    notice('');
    api('handoff', 'POST', {}).then(function (json) { if (json.ok) { apply(json.view); } else { failure(json); } }).catch(function () { notice('The chat could not be reached. Please try again.'); });
  }

  function submitLead(errEl, submit) {
    var get = function (id) { var e = root.getElementById ? root.getElementById(id) : root.querySelector('#' + id); return e; };
    var answers = {};
    var qs = state.cfg.questions || [];
    for (var i = 0; i < qs.length; i++) { var f = get('iaq-q-' + qs[i].key); if (f && f.value) { answers[qs[i].key] = f.value; } }
    var ack = get('iaq-ack');
    var mk = get('iaq-mk');
    errEl.textContent = '';
    if (!ack || !ack.checked) { errEl.textContent = 'Please confirm the privacy notice before sending your details.'; return; }
    submit.disabled = true;
    ensureSession().then(function (ok) {
      if (!ok) { submit.disabled = false; return null; }
      return api('lead', 'POST', { details: { name: get('iaq-name').value, email: get('iaq-email').value, phone: get('iaq-phone').value }, answers: answers, privacyAck: true, marketingOptIn: !!(mk && mk.checked) });
    }).then(function (json) {
      submit.disabled = false;
      if (!json) { return; }
      if (json.ok) {
        state.form = false; state.leadCaptured = true; formEl.removeAttribute('data-built'); while (formEl.firstChild) { formEl.removeChild(formEl.firstChild); }
        apply(json.view); notice(''); state.messages = state.messages.concat([{ id: 'local-thanks', role: 'system', text: 'Thanks, the team has your details.', at: new Date().toISOString() }]); renderBody();
      } else { errEl.textContent = (json.error && json.error.message) || 'Your details could not be sent.'; }
    }).catch(function () { submit.disabled = false; errEl.textContent = 'Your details could not be sent. Check your connection and try again.'; });
  }

  function fetchMessages(seen) {
    if (!state.token) { return Promise.resolve(); }
    return api('messages', 'GET', null, seen ? 'seen=1' : '').then(function (json) { if (json.ok) { apply(json.view); } else if (json.__status === 401) { failure(json); } }).catch(function () { /* the next poll tries again */ });
  }

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!state.token) { return; }
    var delay = state.open ? (state.mode === 'assistant' ? 8000 : 4000) : 30000;
    timer = setTimeout(function () {
      if (document.visibilityState === 'hidden') { schedule(); return; }
      fetchMessages(state.open).then(schedule);
    }, delay);
  }

  function start() {
    load();
    api('config', 'GET', null).then(function (json) {
      if (!json || !json.ok) { return; }
      state.cfg = json.config;
      build();
      if (state.token) { fetchMessages(false).then(schedule); }
    }).catch(function () { /* not available: the page is left alone */ });
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', start); } else { start(); }
})();`;
