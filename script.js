(() => {
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];
  const header = $('#header'), links = $('#links'), burger = $('#burger');
  const totop = $('#totop'), progress = $('#progress');

  // Mobile menu
  const setMenu = open => {
    links.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', open);
  };
  burger.addEventListener('click', () => setMenu(!links.classList.contains('open')));
  $$('a', links).forEach(a => a.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', e => e.key === 'Escape' && setMenu(false));

  // Scroll state: header, progress bar, back-to-top
  const onScroll = () => {
    const y = window.scrollY, max = document.documentElement.scrollHeight - innerHeight;
    header.classList.toggle('scrolled', y > 30);
    totop.classList.toggle('show', y > 600);
    progress.style.width = (max > 0 ? (y / max) * 100 : 0) + '%';
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  totop.addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));

  // Reveal on scroll and animated skill bars
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const el = en.target;
      el.classList.add('in');
      $$('[data-level]', el).forEach(b => (b.style.width = b.dataset.level + '%'));
      io.unobserve(el);
    });
  }, { threshold: 0.15 });
  $$('.reveal').forEach((el, i) => {
    el.style.transitionDelay = (i % 4) * 90 + 'ms';
    io.observe(el);
  });

  // Active nav link
  const secs = $$('main section[id]');
  const spy = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        $$('a', links).forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + en.target.id));
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  secs.forEach(s => spy.observe(s));

  // Typing animation
  const words = ['video editing', 'graphic design', 'photography', 'videography', 'social media content'];
  const out = $('#typed');
  let w = 0, c = 0, del = false;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const type = () => {
    const word = words[w];
    if (reduce) { out.textContent = words.join(', '); return; }
    out.textContent = word.slice(0, c);
    if (!del && c === word.length) { del = true; return setTimeout(type, 1500); }
    if (del && c === 0) { del = false; w = (w + 1) % words.length; }
    c += del ? -1 : 1;
    setTimeout(type, del ? 45 : 90);
  };
  type();

  // Contact form: opens the visitor's email app with the message filled in
  const form = $('#form'), note = $('#note');
  const EMAIL = 'nyriqbal1@gmail.com';
  form.addEventListener('submit', e => {
    e.preventDefault();
    let ok = true;
    $$('input,textarea', form).forEach(f => {
      const bad = !f.value.trim() || (f.type === 'email' && !/^\S+@\S+\.\S+$/.test(f.value));
      f.classList.toggle('invalid', bad);
      if (bad) ok = false;
    });
    note.classList.toggle('err', !ok);
    if (!ok) { note.textContent = 'Please fill in every field with valid details.'; return; }
    const d = Object.fromEntries(new FormData(form));
    const body = `${d.message}\n\nFrom: ${d.name} (${d.email})`;
    location.href = `mailto:${EMAIL}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(body)}`;
    note.textContent = 'Opening your email app to send the message.';
    form.reset();
  });
})();

/* =====================================================================
   NYR Assistant chatbot (separate from the code above, so a problem here
   can never break the rest of the portfolio).
   The browser only talks to YOUR backend (/api/chat). The OpenRouter key
   stays on the server.
   ===================================================================== */
(() => {
  'use strict';
  const root = document.getElementById('nyrWindow');
  if (!root) return;

  // ---- Where is the backend? -------------------------------------------
  // 1) Deployed separately? Add before script.js in index.html:
  //      <script>window.NYR_CHAT_API = "https://your-backend.example.com";</script>
  // 2) Opened via Live Server / file:  -> http://127.0.0.1:5000
  // 3) Served by the Flask app itself or a same-domain host -> same origin
  const defaultApi = () => {
    const { hostname, port, protocol } = location;
    if (protocol === 'file:') return 'http://127.0.0.1:5000';
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    return local && port !== '5000' ? 'http://127.0.0.1:5000' : '';
  };
  const API = String(window.NYR_CHAT_API ?? defaultApi()).replace(/\/+$/, '');

  const $ = id => document.getElementById(id);
  const launcher = $('nyrLauncher'), msgs = $('nyrMessages'), form = $('nyrForm');
  const input = $('nyrInput'), sendBtn = $('nyrSend'), head = $('nyrHead');
  const minBtn = $('nyrMin'), closeBtn = $('nyrClose'), clearBtn = $('nyrClear');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const phone = matchMedia('(max-width: 520px)');
  const STORE = 'nyr_chat_v1', MAX_STORED = 40, MAX_SENT = 12;

  const WELCOME = "Hi! I'm NYR Assistant, your AI portfolio guide. Ask me anything about Nayyar Iqbal's skills, services, projects, experience, or professional background!";
  const WELCOME_2 = "You can ask about his services, software, work experience, education, or how to hire him, in English or اردو.";
  const SUGGESTIONS = [
    'Who is Nayyar Iqbal?',
    'What services does he offer?',
    'What are his professional skills?',
    'Which software does he use?',
    'Tell me about his experience.',
    'How can I contact him?'
  ];
  const WA = 'https://wa.me/923253909355', MAIL = 'mailto:nyriqbal1@gmail.com';

  let history = [];       // [{role:'user'|'assistant', content}] for this browser session
  let state = 'closed';   // closed | open | min
  let busy = false, ctrl = null, cleared = false;

  // ---- Safe mini-markdown (escape first, then add bold/links/lists) -------
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SAFE_URL = /^(https?:\/\/|mailto:|tel:)[^\s<>"']+$/i;

  function renderMarkdown(text) {
    const links = [];
    const stash = (label, url) => {
      if (!SAFE_URL.test(url)) return label;
      links.push({ label, url });
      return '\u0000' + (links.length - 1) + '\u0000';
    };
    let s = String(text).replace(/\r/g, '');
    // [label](url)
    s = s.replace(/\[([^\]\n]{1,120})\]\(((?:https?:\/\/|mailto:|tel:)[^\s)]+)\)/gi, (m, l, u) => stash(l, u));
    // bare URLs
    s = s.replace(/(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/gi, u => stash(u.length > 40 ? u.slice(0, 38) + '…' : u, u));
    // bare e-mail addresses
    s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, e => stash(e, 'mailto:' + e));
    // bare local phone number
    s = s.replace(/(^|[^\d])(0\d{10})(?!\d)/g, (m, pre, n) => pre + stash(n, 'tel:' + n));

    s = esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => {
      const l = links[+i];
      const ext = /^https?:/i.test(l.url) ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${esc(l.url)}"${ext}>${esc(l.label)}</a>`;
    });

    // blocks: paragraphs, bullet lists, numbered lists
    let html = '', para = [], list = null;
    const flushPara = () => { if (para.length) html += '<p dir="auto">' + para.join('<br>') + '</p>'; para = []; };
    const flushList = () => { if (list) html += `<${list.t} dir="auto">${list.items.map(i => `<li>${i}</li>`).join('')}</${list.t}>`; list = null; };
    s.split('\n').forEach(line => {
      const ul = line.match(/^\s*(?:[-*•])\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const t = ul ? 'ul' : 'ol';
        if (list && list.t !== t) flushList();
        (list = list || { t, items: [] }).items.push((ul || ol)[1]);
      } else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line.trim()); }
    });
    flushPara(); flushList();
    return html;
  }

  // ---- DOM helpers ---------------------------------------------------------
  const spark = '<span class="nyr-mav" aria-hidden="true"><svg class="nyr-ic"><use href="#nyr-i-spark"/></svg></span>';
  const scrollDown = () => msgs.scrollTo({ top: msgs.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });

  function addMsg(role, text, extraClass = '') {
    const row = document.createElement('div');
    row.className = 'nyr-msg nyr-' + (role === 'user' ? 'user' : 'bot') + (extraClass ? ' ' + extraClass : '');
    if (role === 'user') {
      row.innerHTML = '<div class="nyr-bubble" dir="auto"></div>';
      row.firstChild.textContent = text;           // user text is never parsed as HTML
    } else {
      row.innerHTML = spark + '<div class="nyr-bubble">' + renderMarkdown(text) + '</div>';
    }
    msgs.appendChild(row);
    scrollDown();
    return row;
  }

  function showTyping() {
    const row = document.createElement('div');
    row.className = 'nyr-msg nyr-bot nyr-typing';
    row.setAttribute('role', 'status');
    row.setAttribute('aria-label', 'NYR Assistant is typing');
    row.innerHTML = spark + '<div class="nyr-bubble"><i></i><i></i><i></i></div>';
    msgs.appendChild(row);
    scrollDown();
    return row;
  }

  function showSuggestions() {
    const box = document.createElement('div');
    box.className = 'nyr-suggest';
    box.id = 'nyrSuggest';
    SUGGESTIONS.forEach(q => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = q;
      b.addEventListener('click', () => send(q));
      box.appendChild(b);
    });
    msgs.appendChild(box);
  }
  const removeSuggestions = () => { const s = $('nyrSuggest'); if (s) s.remove(); };
  const removeError = () => msgs.querySelectorAll('.nyr-err').forEach(e => e.remove());

  function renderAll() {
    msgs.innerHTML = '';
    addMsg('bot', WELCOME);
    addMsg('bot', WELCOME_2);
    if (!history.length) showSuggestions();
    history.forEach(m => addMsg(m.role === 'user' ? 'user' : 'bot', m.content));
    msgs.scrollTop = history.length ? msgs.scrollHeight : 0;   // fresh chat starts at the welcome message
  }

  // ---- Session history ---------------------------------------------------
  const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(history.slice(-MAX_STORED))); } catch (e) { /* storage blocked */ } };
  const load = () => {
    try {
      const v = JSON.parse(sessionStorage.getItem(STORE) || '[]');
      history = Array.isArray(v) ? v.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
    } catch (e) { history = []; }
  };

  // ---- Window state ------------------------------------------------------
  function fit() {   // keep the window above the on-screen keyboard on phones
    const vv = window.visualViewport;
    if (phone.matches && state === 'open' && vv) {
      root.style.top = vv.offsetTop + 8 + 'px';
      root.style.height = vv.height - 16 + 'px';
      root.style.bottom = 'auto';
    } else { root.style.top = root.style.height = root.style.bottom = ''; }
  }

  // Elements fade in/out with a visibility transition, so a focus() call made
  // straight away can be ignored. Retry briefly until it sticks.
  function focusSoon(el, wanted) {
    [0, 80, 250, 500].forEach(ms => setTimeout(() => {
      if (state === wanted && document.activeElement !== el && !el.disabled) el.focus({ preventScroll: true });
    }, ms));
  }

  function setState(next) {
    state = next;
    root.classList.toggle('is-open', next === 'open');
    root.classList.toggle('is-min', next === 'min');
    root.setAttribute('aria-hidden', next === 'closed');
    launcher.classList.toggle('is-hidden', next !== 'closed');
    launcher.setAttribute('aria-expanded', next !== 'closed');
    document.documentElement.classList.toggle('nyr-lock', next === 'open' && phone.matches);
    const restore = next === 'min';
    minBtn.setAttribute('aria-label', restore ? 'Restore chat' : 'Minimize chat');
    minBtn.title = restore ? 'Restore' : 'Minimize';
    minBtn.firstElementChild.firstElementChild.setAttribute('href', restore ? '#nyr-i-up' : '#nyr-i-min');
    fit();
    if (next === 'open') { focusSoon(input, 'open'); setTimeout(() => { msgs.scrollTop = history.length ? msgs.scrollHeight : 0; }, 60); ping(); }
    if (next === 'closed') focusSoon(launcher, 'closed');
  }

  launcher.addEventListener('click', () => setState('open'));
  closeBtn.addEventListener('click', () => setState('closed'));
  minBtn.addEventListener('click', () => setState(state === 'min' ? 'open' : 'min'));
  head.addEventListener('click', e => { if (state === 'min' && !e.target.closest('button')) setState('open'); });
  root.addEventListener('keydown', e => { if (e.key === 'Escape') setState('closed'); });
  if (window.visualViewport) { visualViewport.addEventListener('resize', fit); visualViewport.addEventListener('scroll', fit); }
  phone.addEventListener?.('change', () => setState(state));

  // ---- Online / offline badge -------------------------------------------
  async function ping() {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 4000);
    let ok = false;
    try { const r = await fetch(API + '/api/health', { signal: c.signal }); ok = r.ok && (await r.json()).ready === true; } catch (e) { ok = false; }
    clearTimeout(t);
    $('nyrDot').classList.toggle('off', !ok);
    root.querySelector('.nyr-status').classList.toggle('off', !ok);
    $('nyrStatus').textContent = ok ? 'Online' : 'Offline';
  }

  // ---- Sending messages --------------------------------------------------
  function setBusy(v) {
    busy = v;
    input.disabled = v;
    sendBtn.disabled = v;
    sendBtn.classList.toggle('loading', v);
    sendBtn.setAttribute('aria-busy', v);
    if (!v && state === 'open') input.focus({ preventScroll: true });
  }

  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; };

  function showError(message) {
    const row = addMsg('bot', message + `\n\nYou can also reach Nayyar directly: [WhatsApp](${WA}) or [email](${MAIL}).`, 'nyr-err');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'nyr-retry'; b.textContent = 'Try again';
    b.addEventListener('click', () => { removeError(); ask(); });
    row.querySelector('.nyr-bubble').appendChild(b);
  }

  async function ask() {
    setBusy(true); cleared = false;
    const typing = showTyping();
    ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      let res;
      try {
        res = await fetch(API + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history.slice(-MAX_SENT) }),
          signal: ctrl.signal
        });
      } catch (e) {
        if (cleared) return;
        typing.remove();
        showError(e.name === 'AbortError' ? 'That took too long to answer.' : "I can't reach the chat server right now.");
        return;
      }
      let data = {};
      try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
      typing.remove();
      if (!res.ok || typeof data.reply !== 'string') { showError(data.error || 'Sorry, something went wrong.'); return; }
      history.push({ role: 'assistant', content: data.reply });
      save();
      addMsg('bot', data.reply);
    } finally {
      clearTimeout(timer);
      if (!cleared) setBusy(false);
    }
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    removeSuggestions(); removeError();
    addMsg('user', text);
    history.push({ role: 'user', content: text });
    save();
    input.value = ''; autosize();
    await ask();
  }

  form.addEventListener('submit', e => { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  input.addEventListener('input', autosize);

  clearBtn.addEventListener('click', () => {
    cleared = true;
    if (ctrl) ctrl.abort();
    history = []; save();
    setBusy(false);
    renderAll();
    input.value = ''; autosize();
    input.focus({ preventScroll: true });
  });

  // ---- Start ---------------------------------------------------------------
  load();
  renderAll();
  window.NYRChat = { open: () => setState('open'), close: () => setState('closed') }; // e.g. onclick="NYRChat.open()"
})();
