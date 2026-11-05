/* Flipbook: renders PDF pages with PDF.js and turns them with StPageFlip. */
(function () {
  'use strict';

  var cfg = window.FLIPBOOK_CONFIG || {};
  var doc = document;
  var byId = function (id) { return doc.getElementById(id); };

  var el = {
    dropzone: byId('dropzone'),
    loader: byId('loader'),
    loaderText: byId('loader-text'),
    loaderBar: byId('loader-bar'),
    error: byId('error'),
    errorText: byId('error-text'),
    errorPick: byId('error-pick'),
    retry: byId('retry-book'),
    feedbackOpen: byId('feedback-open'),
    feedbackDialog: byId('feedback-dialog'),
    feedbackForm: byId('feedback-form'),
    feedbackText: byId('feedback-text'),
    feedbackSend: byId('feedback-send'),
    feedbackClose: byId('feedback-close'),
    feedbackCancel: byId('feedback-cancel'),
    passwordPanel: byId('password-panel'),
    passwordForm: byId('password-form'),
    passwordInput: byId('book-password'),
    passwordError: byId('password-error'),
    passwordCancel: byId('password-cancel'),
    wrap: byId('book-wrap'),
    book: byId('book'),
    overlay: byId('drop-overlay'),
    controls: byId('controls'),
    title: byId('book-title'),
    openBtn: byId('open-btn'),
    fileInput: byId('file-input'),
    homeLink: byId('home-link'),
    homeLabel: byId('home-label'),
    first: byId('btn-first'),
    prev: byId('btn-prev'),
    next: byId('btn-next'),
    last: byId('btn-last'),
    pager: byId('pager'),
    pageInput: byId('page-input'),
    pageTotal: byId('page-total'),
    sound: byId('btn-sound'),
    fullscreen: byId('btn-fullscreen'),
    announcer: byId('announcer')
  };

  var MIN_PAGE_WIDTH = 240;
  var MAX_FILE_MB = 200;
  var PDF_RANGE_CHUNK_SIZE = 64 * 1024;
  var RENDER_BEHIND = 1;
  var RENDER_AHEAD = 4;
  /* Only PDFs inside /books may be opened through the ?pdf= link parameter. */
  var SAFE_PDF_PARAM = /^books\/[\w\-. ()]+\.pdf$/i;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var allowPicker = cfg.allowPicker !== false;

  var state = {
    token: 0,
    loadingTask: null,
    pdf: null,
    flip: null,
    total: 0,
    ratio: Math.SQRT2,
    current: 0,
    pages: [],
    rendered: [],
    urls: [],
    busy: false,
    renderWidth: 1200
  };
  var submitPassword = null;
  var retryBook = null;

  function closeFeedback() {
    if (el.feedbackDialog.open) el.feedbackDialog.close();
    el.feedbackOpen.focus();
  }

  el.feedbackOpen.addEventListener('click', function () {
    if (typeof el.feedbackDialog.showModal === 'function') {
      el.feedbackDialog.showModal();
      el.feedbackText.focus();
    }
  });
  el.feedbackClose.addEventListener('click', closeFeedback);
  el.feedbackCancel.addEventListener('click', closeFeedback);
  el.feedbackDialog.addEventListener('click', function (event) {
    if (event.target === el.feedbackDialog) closeFeedback();
  });
  el.feedbackForm.addEventListener('submit', function (event) { event.preventDefault(); });
  el.feedbackText.addEventListener('input', function () {
    var feedback = el.feedbackText.value.trim();
    var hasText = !!feedback;
    el.feedbackSend.setAttribute('aria-disabled', String(!hasText));
    el.feedbackSend.tabIndex = hasText ? 0 : -1;
    if (!hasText) {
      el.feedbackSend.href = '#';
      return;
    }
    var title = el.title.textContent.trim();
    var page = state.flip ? state.flip.getCurrentPageIndex() + 1 : 1;
    var body = 'Honest feedback about "' + title + '" (page ' + page + ' of ' + state.total + '):\n\n' + feedback;
    el.feedbackSend.href = 'https://wa.me/' + encodeURIComponent(cfg.feedbackNumber || '919848085505') + '?text=' + encodeURIComponent(body);
  });
  el.feedbackSend.addEventListener('click', function (event) {
    if (el.feedbackSend.getAttribute('aria-disabled') === 'true') {
      event.preventDefault();
      el.feedbackText.focus();
      return;
    }
    closeFeedback();
  });

  el.passwordForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!submitPassword || !el.passwordInput.value) return;
    var updatePassword = submitPassword;
    var password = el.passwordInput.value;
    view('loading');
    progress(0.4, 'Unlocking your book...');
    updatePassword(password);
  });
  el.passwordCancel.addEventListener('click', function () {
    ++state.token;
    teardown();
    showError('Book opening cancelled. Select Try again to enter the password.');
    el.retry.focus();
  });
  el.retry.addEventListener('click', function () {
    if (retryBook) retryBook();
  });

  /* ---------- Views ---------- */
  function view(name) {
    el.feedbackOpen.hidden = name !== 'book';
    el.passwordPanel.hidden = name !== 'password';
    if (name !== 'password') {
      submitPassword = null;
      el.passwordInput.value = '';
    }
    el.dropzone.hidden = name !== 'drop';
    el.loader.hidden = name !== 'loading';
    el.error.hidden = name !== 'error';
    el.controls.hidden = name !== 'book';
    if (name !== 'book' && name !== 'loading') el.wrap.hidden = true;
  }

  function progress(fraction, text) {
    el.loaderBar.style.transform = 'scaleX(' + Math.max(0.02, Math.min(1, fraction)) + ')';
    if (text) el.loaderText.textContent = text;
  }

  function showError(message) {
    el.errorText.textContent = message;
    el.errorPick.hidden = !allowPicker;
    el.retry.hidden = !retryBook;
    view('error');
  }

  function setTitle(text) {
    el.title.textContent = text;
    if (/[\u0C00-\u0C7F]/.test(text)) el.title.setAttribute('lang', 'te'); else el.title.removeAttribute('lang');
    doc.title = text + ' — Flipbook';
  }

  function fileTitle(name) {
    return String(name || '').split('/').pop().replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
  }

  function messageFor(err) {
    var name = err && err.name;
    if (name === 'PasswordException') return 'This book needs a valid PDF password. Select Try again to unlock it.';
    if (name === 'InvalidPDFException') return 'This file does not look like a valid PDF.';
    if (name === 'MissingPDFException' || name === 'UnexpectedResponseException') return 'The PDF could not be found. Please check the file name and location.';
    return 'Sorry, this PDF could not be opened.';
  }

  /* ---------- Layout ---------- */
  /* Size the book so a full spread (or a single page on narrow screens) fits the stage. */
  function fit() {
    if (el.wrap.hidden || !el.book) return;
    var W = el.wrap.clientWidth;
    var H = el.wrap.clientHeight;
    if (!W || !H) return;
    var r = state.ratio;
    var w = Math.min(W, (2 * H) / r);
    if (w < 2 * MIN_PAGE_WIDTH) w = Math.min(W, H / r);
    el.book.style.width = Math.max(MIN_PAGE_WIDTH, Math.floor(w)) + 'px';
  }

  function refreshLayout() {
    fit();
    window.dispatchEvent(new Event('resize'));
  }

  /* ---------- Book lifecycle ---------- */
  function teardown() {
    submitPassword = null;
    el.passwordInput.value = '';
    if (state.loadingTask) {
      state.loadingTask.destroy().catch(function () {});
      state.loadingTask = null;
    }
    if (state.flip) {
      try { state.flip.destroy(); } catch (e) { /* already detached */ }
    }
    state.urls.forEach(function (u) { URL.revokeObjectURL(u); });
    state.flip = null;
    state.pdf = null;
    state.pages = [];
    state.rendered = [];
    state.urls = [];
    state.current = 0;
    state.busy = false;
  }

  function buildBook() {
    var n = state.total;
    el.wrap.innerHTML = '<div class="book" id="book"></div>';
    el.book = el.wrap.firstChild;
    el.wrap.hidden = false;
    el.wrap.classList.add('is-preparing');

    state.pages = [];
    state.rendered = [];
    for (var i = 0; i < n; i++) {
      var page = doc.createElement('div');
      var isCover = n > 2 && (i === 0 || i === n - 1);
      page.className = 'page' + (isCover ? ' page--cover' : '');
      if (isCover) page.setAttribute('data-density', 'hard');
      page.innerHTML = '<div class="page__content"><span class="page__spinner" aria-hidden="true"></span></div>';
      el.book.appendChild(page);
      state.pages.push(page);
      state.rendered.push(false);
    }

    fit();
    var baseWidth = 500;
    state.flip = new St.PageFlip(el.book, {
      width: baseWidth,
      height: Math.round(baseWidth * state.ratio),
      size: 'stretch',
      minWidth: MIN_PAGE_WIDTH,
      maxWidth: 1400,
      minHeight: Math.round(MIN_PAGE_WIDTH * state.ratio),
      maxHeight: Math.round(1400 * state.ratio),
      showCover: true,
      usePortrait: true,
      mobileScrollSupport: false,
      maxShadowOpacity: 0.45,
      flippingTime: reduceMotion ? 350 : 850,
      drawShadow: true,
      showPageCorners: !reduceMotion,
      swipeDistance: 30,
      startPage: 0
    });
    state.flip.loadFromHTML(state.pages);

    state.flip.on('flip', function (e) {
      state.current = e.data;
      updateControls(true);
      pump(state.token);
    });
    state.flip.on('changeState', function (e) {
      if (e.data === 'flipping') PageSound.play();
    });
    state.flip.on('changeOrientation', function () { updateControls(false); });

    /* Render pages sharp enough for the current page size on this screen. */
    var bookWidth = el.book.getBoundingClientRect().width || 800;
    var landscape = state.flip.getOrientation() === 'landscape';
    var cssPageWidth = landscape ? bookWidth / 2 : bookWidth;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.renderWidth = Math.round(Math.min(2400, Math.max(900, cssPageWidth * dpr * 1.25)));

    el.pageTotal.textContent = n;
    el.pageInput.max = n;
  }

  async function renderPage(i, token) {
    if (state.rendered[i]) return;
    state.rendered[i] = 'pending';
    var content = state.pages[i].querySelector('.page__content');
    try {
      var page = await state.pdf.getPage(i + 1);
      if (token !== state.token) return;
      var base = page.getViewport({ scale: 1 });
      var viewport = page.getViewport({ scale: Math.min(4, Math.max(0.5, state.renderWidth / base.width)) });

      var canvas = doc.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      page.cleanup();
      if (token !== state.token) return;

      var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.9); });
      canvas.width = canvas.height = 0;
      if (token !== state.token || !blob) return;

      var url = URL.createObjectURL(blob);
      state.urls.push(url);
      var img = new Image();
      img.alt = 'Page ' + (i + 1);
      img.draggable = false;
      img.src = url;
      try { await img.decode(); } catch (e) { /* the image still loads */ }
      if (token !== state.token) return;
      content.innerHTML = '';
      content.appendChild(img);
    } catch (err) {
      if (token !== state.token) return;
      content.innerHTML = '<p class="page__error">This page could not be displayed.</p>';
    }
    state.rendered[i] = true;
  }

  /* Keep nearby pages ready without rendering the entire book in the background. */
  function nextToRender() {
    var best = -1;
    var bestScore = Infinity;
    var first = Math.max(0, state.current - RENDER_BEHIND);
    var last = Math.min(state.total - 1, state.current + RENDER_AHEAD);
    for (var i = first; i <= last; i++) {
      if (state.rendered[i]) continue;
      var d = i - state.current;
      var score = d >= -1 ? Math.abs(d) : Math.abs(d) + 0.5;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  async function pump(token) {
    if (state.busy) return;
    state.busy = true;
    while (token === state.token) {
      var i = nextToRender();
      if (i < 0) break;
      await renderPage(i, token);
    }
    if (token === state.token) state.busy = false;
  }

  async function openPdf(source, opts) {
    opts = opts || {};
    retryBook = function () { openPdf(source, opts); };
    var token = ++state.token;
    teardown();
    view('loading');
    progress(0.02, 'Opening your book…');

    try {
      var loadingOptions = {
        rangeChunkSize: PDF_RANGE_CHUNK_SIZE
      };
      if (source.data) loadingOptions.data = source.data;
      else loadingOptions.url = source.url;
      var task = pdfjsLib.getDocument(loadingOptions);
      state.loadingTask = task;
      task.onPassword = function (updatePassword, reason) {
        if (token !== state.token) return;
        var incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
        el.passwordInput.value = '';
        el.passwordInput.setAttribute('aria-invalid', String(incorrect));
        el.passwordError.textContent = incorrect ? 'Incorrect password. Please try again.' : '';
        submitPassword = updatePassword;
        view('password');
        el.passwordInput.focus();
      };
      task.onProgress = function (p) {
        if (token === state.token && p.total) {
          var f = p.loaded / p.total;
          progress(f * 0.4, 'Loading PDF… ' + Math.round(f * 100) + '%');
        }
      };
      var pdf = await task.promise;
      if (token !== state.token) { pdf.destroy(); return; }
      state.pdf = pdf;
      state.total = pdf.numPages;

      var first = await pdf.getPage(1);
      var vp = first.getViewport({ scale: 1 });
      state.ratio = vp.height / vp.width;

      var title = opts.title;
      if (!title) {
        try {
          var meta = await pdf.getMetadata();
          title = meta && meta.info && meta.info.Title;
        } catch (e) { /* no metadata */ }
      }
      setTitle(title || opts.fallbackTitle || 'Flipbook');

      buildBook();

      /* Show the book once the cover and first spread are ready; the rest render in the background. */
      var firstBatch = Math.min(state.total, 3);
      for (var i = 0; i < firstBatch; i++) {
        await renderPage(i, token);
        if (token !== state.token) return;
        progress(0.4 + 0.6 * (i + 1) / firstBatch, 'Preparing pages…');
      }

      view('book');
      el.wrap.classList.remove('is-preparing');
      refreshLayout();
      updateControls(false);
      el.announcer.textContent = (title || opts.fallbackTitle || 'Book') + ' is open. ' + state.total + ' pages. Use the arrow keys to turn pages.';
      pump(token);
    } catch (err) {
      if (token !== state.token) return;
      teardown();
      showError(messageFor(err));
    }
  }

  /* ---------- Controls ---------- */
  function updateControls(announce) {
    if (!state.flip) return;
    var n = state.total;
    var i = state.flip.getCurrentPageIndex();
    var landscape = state.flip.getOrientation() === 'landscape';
    var spread = landscape && i > 0 && i + 1 < n;
    state.current = i;

    el.pageInput.value = i + 1;
    el.first.disabled = el.prev.disabled = i <= 0;
    el.next.disabled = el.last.disabled = i + (spread ? 2 : 1) >= n;

    if (announce) {
      el.announcer.textContent = spread ? 'Pages ' + (i + 1) + ' and ' + (i + 2) + ' of ' + n : 'Page ' + (i + 1) + ' of ' + n;
    }
  }

  function goTo(index) {
    if (!state.flip) return;
    var target = Math.max(0, Math.min(state.total - 1, index));
    if (target === state.flip.getCurrentPageIndex()) return;
    state.flip.flip(target);
  }

  el.first.addEventListener('click', function () { goTo(0); });
  el.prev.addEventListener('click', function () { if (state.flip) state.flip.flipPrev(); });
  el.next.addEventListener('click', function () { if (state.flip) state.flip.flipNext(); });
  el.last.addEventListener('click', function () { goTo(state.total - 1); });

  el.pager.addEventListener('submit', function (e) {
    e.preventDefault();
    var n = parseInt(el.pageInput.value, 10);
    if (isNaN(n)) { updateControls(false); return; }
    goTo(n - 1);
    el.pageInput.blur();
  });

  doc.addEventListener('keydown', function (e) {
    if (!state.flip || el.controls.hidden) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault(); state.flip.flipNext(); break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault(); state.flip.flipPrev(); break;
      case 'Home':
        e.preventDefault(); goTo(0); break;
      case 'End':
        e.preventDefault(); goTo(state.total - 1); break;
      case 'f':
      case 'F':
        if (el.fullscreen && !el.fullscreen.hidden) toggleFullscreen(); break;
      case 'm':
      case 'M':
        setSound(!PageSound.isEnabled(), true); break;
    }
  });

  /* ---------- Sound ---------- */
  function readSoundPref() {
    try { return localStorage.getItem('flipbook-sound'); } catch (e) { return null; }
  }

  function setSound(on, remember) {
    PageSound.setEnabled(on);
    el.sound.setAttribute('aria-pressed', String(on));
    el.sound.setAttribute('aria-label', on ? 'Page-turn sound on' : 'Page-turn sound off');
    if (remember) {
      try { localStorage.setItem('flipbook-sound', on ? '1' : '0'); } catch (e) { /* private mode */ }
      if (on) PageSound.unlock();
    }
  }

  el.sound.addEventListener('click', function () { setSound(!PageSound.isEnabled(), true); });

  /* Browsers only allow audio after a user gesture. */
  function unlockAudio() {
    if (PageSound.isEnabled()) PageSound.unlock();
    doc.removeEventListener('pointerdown', unlockAudio);
    doc.removeEventListener('keydown', unlockAudio);
  }
  doc.addEventListener('pointerdown', unlockAudio);
  doc.addEventListener('keydown', unlockAudio);

  /* ---------- Full screen ---------- */
  function toggleFullscreen() {
    if (doc.fullscreenElement) doc.exitFullscreen();
    else doc.documentElement.requestFullscreen().catch(function () {});
  }

  if (!doc.fullscreenEnabled) {
    el.fullscreen.hidden = true;
  } else {
    el.fullscreen.addEventListener('click', toggleFullscreen);
    doc.addEventListener('fullscreenchange', function () {
      var on = !!doc.fullscreenElement;
      el.fullscreen.setAttribute('aria-pressed', String(on));
      el.fullscreen.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
      requestAnimationFrame(refreshLayout);
    });
  }

  /* Registered before the page-flip library's own resize handler, so the book is re-fitted first. */
  window.addEventListener('resize', fit);

  /* ---------- Opening files ---------- */
  function openFile(file) {
    if (!file) return;
    var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) { showError('Please choose a PDF file.'); return; }
    if (file.size > MAX_FILE_MB * 1024 * 1024) { showError('This PDF is larger than ' + MAX_FILE_MB + ' MB. Please choose a smaller file.'); return; }
    file.arrayBuffer().then(function (buffer) {
      openPdf({ data: new Uint8Array(buffer) }, { fallbackTitle: fileTitle(file.name) });
    }, function () {
      showError('Sorry, this file could not be read.');
    });
  }

  if (allowPicker) {
    el.openBtn.hidden = false;
    el.fileInput.addEventListener('change', function () {
      openFile(el.fileInput.files[0]);
      el.fileInput.value = '';
    });

    var dragDepth = 0;
    var hasFiles = function (e) {
      return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
    };
    doc.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      el.overlay.hidden = false;
    });
    doc.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    doc.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) el.overlay.hidden = true;
    });
    doc.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      el.overlay.hidden = true;
      openFile(e.dataTransfer.files[0]);
    });
  } else {
    el.fileInput.disabled = true;
  }

  if (cfg.homeUrl) {
    el.homeLink.href = cfg.homeUrl;
    el.homeLabel.textContent = cfg.homeLabel || 'Home';
    el.homeLink.hidden = false;
  }

  /* ---------- Start ---------- */
  PageSound.useFile(cfg.soundFile);
  var pref = readSoundPref();
  setSound(pref === null ? cfg.sound !== false : pref === '1', false);

  if (!window.pdfjsLib || !window.St || !window.St.PageFlip) {
    showError('The book viewer could not be loaded. Please refresh the page.');
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  var param = new URLSearchParams(window.location.search).get('pdf');
  var source = param && SAFE_PDF_PARAM.test(param) && param.indexOf('..') === -1 ? param : cfg.pdf;

  if (source) {
    openPdf({ url: source }, { title: param ? '' : cfg.title, fallbackTitle: fileTitle(source) });
  } else if (allowPicker) {
    if (cfg.title) setTitle(cfg.title);
    view('drop');
  } else {
    showError('No book has been set up yet.');
  }
})();
