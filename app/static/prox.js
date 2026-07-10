/**
 * Proximity — prox.js
 * ProseMirror double-page + badges de proximité lexicale.
 */

'use strict';

const { Schema }                                              = prosemirrorModel;
const { EditorState, TextSelection, Plugin, PluginKey }       = prosemirrorState;
const { EditorView, Decoration, DecorationSet }               = prosemirrorView;
const { baseKeymap }                                          = prosemirrorCommands;
const { keymap }                                              = prosemirrorKeymap;
const { history, undo, redo }                                 = prosemirrorHistory;

// ── Schéma minimal ────────────────────────────────────────────────────────
const schema = new Schema({
  nodes: {
    doc:       { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block',
                 parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    text:      { group: 'inline' },
  },
  marks: {},
});

// ── État global ───────────────────────────────────────────────────────────
let _fullText    = '';
let _fullWords   = [];   // mots du vivant (avec trailing space)
let _bufStart    = 0;    // index premier mot hors PG+PD
let _vivantStart = 0;    // offset dans _fullText
let _seuil       = 1500;
let _totalWords  = 0;
let _totalChars  = 0;
let _totalPages  = 1;
let _currentPage = 1;
const CHARS_PER_PAGE = 1500;
const VIVANT_SIZE    = 6000;

let viewPG = null;
let viewPD = null;

let _navHistory = [0];
let _navIdx     = 0;

// ── Couleur badge/mot : gradient 3 points vert→orange→rouge ──────────────
function repColor(distance, seuil) {
  const ratio = Math.max(0, Math.min(1, 1 - distance / seuil));
  let hue, val;
  if (ratio <= 0.5) {
    const t = ratio * 2;
    hue = Math.round(120 - t * 90);   // vert → orange
    val = Math.round(180 + t * 60);
  } else {
    const t = (ratio - 0.5) * 2;
    hue = Math.round(30 - t * 30);    // orange → rouge
    val = Math.round(240 - t * 20);
  }
  const s = 1.0, v = val / 255, h6 = hue / 60;
  const i = Math.floor(h6), f = h6 - i;
  const p = v * (1 - s), q = v * (1 - s * f), t2 = v * (1 - s * (1 - f));
  let r, g, b;
  switch (i % 6) {
    case 0: r=v;g=t2;b=p; break; case 1: r=q;g=v;b=p; break;
    case 2: r=p;g=v;b=t2; break; case 3: r=p;g=q;b=v; break;
    case 4: r=t2;g=p;b=v; break; default: r=v;g=p;b=q;
  }
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

// ── Plugins décorations inline (un par page) ──────────────────────────────
const decoKeyPG = new PluginKey('decoPG');
const decoKeyPD = new PluginKey('decoPD');

function makeDecoPlugin(key) {
  return new Plugin({
    key,
    state: {
      init()         { return DecorationSet.empty; },
      apply(tr, old) {
        const meta = tr.getMeta(key);
        if (meta !== undefined) return meta;
        return old.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) { return this.getState(state); },
    },
  });
}

// ── Exergue : activer/désactiver un groupe (badge + mot pairs) ────────────
let _activeRepIdx = null;

function activateGroup(idx) {
  document.querySelectorAll(`[data-rep-idx="${idx}"]`)
          .forEach(el => el.classList.add('active'));
}
function deactivateAll() {
  document.querySelectorAll('.prox-badge.active, .prox-word.active')
          .forEach(el => el.classList.remove('active'));
  _activeRepIdx = null;
}

// Appelé quand le curseur bouge — cherche si on est dans un mot annoté
function updateCursorHighlight(view, decoKey) {
  const { from }  = view.state.selection;
  const decoSet   = decoKey.getState(view.state);
  if (!decoSet) { deactivateAll(); return; }
  const found = decoSet.find(from - 1, from + 1);
  const idx   = found.length ? found[0].spec.repIdx : null;
  if (idx !== _activeRepIdx) {
    deactivateAll();
    _activeRepIdx = idx;
    if (idx !== null) activateGroup(idx);
  }
}

// ── Flag reflow : empêche onEdit() pendant setText() internes ────────────
let _inReflow = false;

// ── Création d'un EditorView ──────────────────────────────────────────────
function createView(domNode, decoKey, onEdit) {
  const state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph', null, [])]),
    plugins: [
      history(),
      keymap({ 'Mod-z': undo, 'Mod-y': redo }),
      keymap(baseKeymap),
      makeDecoPlugin(decoKey),
    ],
  });
  const view = new EditorView(domNode, {
    state,
    dispatchTransaction(tr) {
      const selBefore = view.state.selection;
      const newState  = view.state.apply(tr);
      view.updateState(newState);
      if (tr.docChanged && !_inReflow) onEdit();
      if (!selBefore.eq(newState.selection) && !_inReflow) {
        updateCursorHighlight(view, decoKey);
        updateFakeCursor();
      }
    },
  });
  return view;
}

function getText(view) { return view.state.doc.textContent; }

function setText(view, text) {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, text ? [schema.text(text)] : []),
  ]);
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
  view.dispatch(tr);
}

function restoreCursor(view, anchor) {
  if (anchor === null || anchor === undefined) return;
  const max = view.state.doc.content.size;
  const pos = Math.max(1, Math.min(anchor, max));
  try {
    const sel = TextSelection.create(view.state.doc, pos);
    view.dispatch(view.state.tr.setSelection(sel));
  } catch (e) {}
}

// ── Overflow ──────────────────────────────────────────────────────────────
function isOverflowing(pmDom) {
  return pmDom.scrollHeight > pmDom.clientHeight + 2;
}

// ── Remplissage par binary search ─────────────────────────────────────────
function fillPage(view, words, startIdx) {
  const available = words.slice(startIdx);
  if (!available.length) { setText(view, ''); return 0; }
  const dom = view.dom;
  let lo = 0, hi = available.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    setText(view, available.slice(0, mid).join('').trimEnd());
    if (isOverflowing(dom)) hi = mid - 1;
    else lo = mid;
  }
  setText(view, available.slice(0, lo).join('').trimEnd());
  return lo;
}

function fillEditors() {
  _inReflow = true;
  const pgCount = fillPage(viewPG, _fullWords, 0);
  const pdCount = fillPage(viewPD, _fullWords, pgCount);
  _bufStart = pgCount + pdCount;
  _inReflow = false;
  updateFooter();
}

// ── Reflow après édition (debounce 300ms) ─────────────────────────────────
let _reflowTimer = null;
function scheduleReflow() {
  clearTimeout(_reflowTimer);
  _reflowTimer = setTimeout(doReflow, 300);
}

function doReflow() {
  _inReflow = true;
  const pgDom = viewPG.dom;
  const pdDom = viewPD.dom;

  const activePG = document.activeElement === viewPG.dom;
  const activePD = document.activeElement === viewPD.dom;
  const pgAnchor = activePG ? viewPG.state.selection.anchor : null;
  const pdAnchor = activePD ? viewPD.state.selection.anchor : null;

  // PG déborde → dernier mot vers PD
  while (isOverflowing(pgDom)) {
    const text = getText(viewPG);
    const m = text.match(/\S+\s*$/);
    if (!m) break;
    setText(viewPG, text.slice(0, m.index).trimEnd());
    const cur = getText(viewPD);
    setText(viewPD, m[0].trimEnd() + (cur ? ' ' + cur : ''));
  }

  // PD déborde → dernier mot vers buffer
  while (isOverflowing(pdDom)) {
    const text = getText(viewPD);
    const m = text.match(/\S+\s*$/);
    if (!m) break;
    if (_bufStart > 0) _bufStart--;
    setText(viewPD, text.slice(0, m.index).trimEnd());
  }

  // PG underflow ← PD
  while (!isOverflowing(pgDom) && getText(viewPD).trim()) {
    const pdText = getText(viewPD);
    const m = pdText.match(/^\S+\s*/);
    if (!m) break;
    const pgText = getText(viewPG);
    setText(viewPG, pgText + (pgText ? ' ' : '') + m[0].trimEnd());
    if (isOverflowing(pgDom)) { setText(viewPG, pgText); break; }
    setText(viewPD, pdText.slice(m[0].length));
  }

  // PD underflow ← buffer
  while (!isOverflowing(pdDom) && _bufStart < _fullWords.length) {
    const word = _fullWords[_bufStart];
    const cur  = getText(viewPD);
    setText(viewPD, cur + (cur ? ' ' : '') + word.trimEnd());
    if (isOverflowing(pdDom)) { setText(viewPD, cur); break; }
    _bufStart++;
  }

  _inReflow = false;
  if (activePG && pgAnchor !== null && pgAnchor > viewPG.state.doc.content.size - 1) {
    // Mot typé en fin de PG a débordé vers PD → curseur suit, après le mot
    const pdText   = getText(viewPD);
    const firstWord = pdText.match(/^\S+/);
    const cursorPos = firstWord ? 1 + firstWord[0].length : 1;
    viewPD.focus();
    restoreCursor(viewPD, cursorPos);
  } else {
    restoreCursor(viewPG, pgAnchor);
    restoreCursor(viewPD, pdAnchor);
  }
}

// ── Badges DOM ────────────────────────────────────────────────────────────
function clearBadges() {
  document.querySelectorAll('.page-wrap .prox-badge').forEach(b => b.remove());
}

function clearWordDecos() {
  if (viewPG) viewPG.dispatch(viewPG.state.tr.setMeta(decoKeyPG, DecorationSet.empty));
  if (viewPD) viewPD.dispatch(viewPD.state.tr.setMeta(decoKeyPD, DecorationSet.empty));
}

// Badges — plus aucune décoration posée sur le mot lui-même (bloquait le clic).
// Position calculée via coordsAtPos() (API ProseMirror), sans passer par un span dans le texte.
function applyWordDecosAndBadges(view, decoKey, repList) {
  const wrap = view.dom.closest('.page-wrap');
  wrap.querySelectorAll('.prox-badge').forEach(b => b.remove());

  requestAnimationFrame(() => {
    const created = [];
    repList.forEach(({ offset, forme, dir, distance, repIdx }) => {
      const from = offset + 1;
      const to   = from + forme.length;
      if (to > view.state.doc.content.size) return;
      let c1, c2;
      try { c1 = view.coordsAtPos(from); c2 = view.coordsAtPos(to); } catch (e) { return; }
      const wr = {
        left:   Math.min(c1.left, c2.left),
        right:  Math.max(c1.right, c2.right),
        top:    Math.min(c1.top, c2.top),
        bottom: Math.max(c1.bottom, c2.bottom),
      };
      wr.width  = wr.right - wr.left;
      wr.height = wr.bottom - wr.top;

      const label = dir === 'avant' ? `←${distance}` : `${distance}→`;
      const [r, g, b] = repColor(distance, _seuil);
      const badge = document.createElement('span');
      badge.className      = 'prox-badge';
      badge.dataset.repIdx = String(repIdx);
      badge.dataset.dir    = dir;
      badge.style.setProperty('--badge-rgb', `${r},${g},${b}`);
      badge.textContent    = label;
      badge.style.left     = '0';
      badge.style.top      = '0';
      badge.style.visibility = 'hidden';
      wrap.appendChild(badge);
      created.push({ badge, wr, dir });
    });

    // rAF2 : badges en DOM → largeurs disponibles — on calcule les positions finales
    requestAnimationFrame(() => {
      const fr     = wrap.getBoundingClientRect();
      const GUTTER = 10;   // gouttière min entre deux badges du même mot
      const LINE_H = 2.2 * 24;

      const posGroups = [];
      created.forEach(({ badge, wr, dir }) => {
        const center = wr.left + wr.width / 2;
        let group = posGroups.find(g => Math.abs(g.center - center) < 4);
        if (!group) { group = { center, wr, left: [], right: [] }; posGroups.push(group); }
        (dir === 'avant' ? group.left : group.right).push(badge);
      });

      posGroups.forEach(({ center, wr, left, right }) => {
        const place = (badge, leftPx) => {
          const { height: bh } = badge.getBoundingClientRect();
          const topY = wr.bottom + (LINE_H - wr.height) / 2 - bh / 2;
          let t = topY;
          if (t + bh > fr.bottom - 2) { t = wr.top - (LINE_H - wr.height) / 2 - bh - 4; badge.classList.add('flip'); }
          badge.style.left = (leftPx - fr.left) + 'px';
          badge.style.top  = (t - fr.top) + 'px';
          badge.style.visibility = '';
        };

        if (left[0]) place(left[0], center - GUTTER / 2 - left[0].getBoundingClientRect().width);
        if (right[0]) place(right[0], center + GUTTER / 2);
      });
    });
  });
}

// ── Faux curseur (hauteur = police) ──────────────────────────────────────
function updateFakeCursor() {
  const cursor = document.getElementById('fake-cursor');
  if (!cursor) return;

  const activeView = (document.activeElement === viewPG?.dom) ? viewPG
                   : (document.activeElement === viewPD?.dom) ? viewPD
                   : null;

  if (!activeView) { cursor.style.display = 'none'; return; }

  const { from } = activeView.state.selection;
  let coords;
  try { coords = activeView.coordsAtPos(from); } catch (e) { coords = null; }
  if (!coords) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const rect  = range.getClientRects()[0] || range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        coords = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }
    }
  }
  if (!coords) { cursor.style.display = 'none'; return; }

  const wrap = activeView.dom.closest('.page-wrap');
  const fr   = wrap.getBoundingClientRect();
  if (cursor.parentElement !== wrap) wrap.appendChild(cursor);

  // Reset animation (repart de visible à chaque frappe)
  cursor.style.animation = 'none';
  cursor.offsetHeight;
  cursor.style.animation = '';

  cursor.style.display = 'block';
  cursor.style.left    = (coords.left   - fr.left) + 'px';
  cursor.style.top     = (coords.top    - fr.top)  + 'px';
  cursor.style.height  = (coords.bottom - coords.top) + 'px';
}

// ── PageLine ──────────────────────────────────────────────────────────────
function updatePageLine() {
  const cursor = document.getElementById('pageline-cursor');
  if (!cursor || !_fullText.length) return;
  const pct  = _vivantStart / _fullText.length;
  const size = Math.min((CHARS_PER_PAGE * 2) / _fullText.length, 1 - pct);
  cursor.style.left  = (pct  * 100) + '%';
  cursor.style.width = Math.max(size * 100, 1) + '%';
}

// ── Footer ────────────────────────────────────────────────────────────────
function updateFooter() {
  document.getElementById('footer-stats').textContent =
    `Page ${_currentPage} / ${_totalPages}   ·   ${_totalWords} mots   ·   ${_totalChars} caractères`;
  document.getElementById('btn-prev').disabled = (_navIdx === 0);
  document.getElementById('btn-next').disabled =
    (_vivantStart + VIVANT_SIZE >= _fullText.length);
  updatePageLine();
}

// ── Navigation ────────────────────────────────────────────────────────────
function snapToWord(pos) {
  const n = _fullText.length;
  let p = Math.max(0, Math.min(pos, n));
  if (p > 0 && p < n && !/\s/.test(_fullText[p-1]) && !/\s/.test(_fullText[p]))
    while (p < n && !/\s/.test(_fullText[p])) p++;
  while (p < n && /\s/.test(_fullText[p])) p++;
  return p;
}

function goToPage(newStart) {
  _vivantStart = newStart;
  _currentPage = Math.floor(_vivantStart / CHARS_PER_PAGE) + 1;
  const vivant = _fullText.slice(_vivantStart, _vivantStart + VIVANT_SIZE)
                           .replace(/\s+/g, ' ').trim();
  _fullWords = vivant.match(/\S+\s*/g) || [];
  clearBadges();
  clearWordDecos();
  fillEditors();
  scheduleAnalysis();
}

document.getElementById('btn-prev').addEventListener('click', () => {
  if (_navIdx > 0) {
    _navIdx--;
    goToPage(_navHistory[_navIdx]);
    updateFooter();
  }
});

document.getElementById('btn-next').addEventListener('click', () => {
  const ns = snapToWord(_vivantStart + CHARS_PER_PAGE);
  if (ns < _fullText.length && ns !== _vivantStart) {
    _navHistory = _navHistory.slice(0, _navIdx + 1);
    _navHistory.push(ns);
    _navIdx++;
    goToPage(ns);
    updateFooter();
  }
});

// ── Analyse ───────────────────────────────────────────────────────────────
let _analysisTimer = null;
function scheduleAnalysis() {
  clearTimeout(_analysisTimer);
  _analysisTimer = setTimeout(runAnalysis, 800);
}

function runAnalysis() {
  if (!window.pywebview || !window.pywebview.api) {
    console.warn('pywebview.api not ready');
    return;
  }
  const pgText = getText(viewPG);
  const pdText = getText(viewPD);
  const text   = pgText + ' ' + pdText;
  if (!text.trim()) return;

  console.log('analyze:', text.length, 'chars');
  window.pywebview.api.analyze(text).then(reps => {
    console.log('retour:', reps ? reps.length : 'null', 'rép.');
    if (reps && reps.length) updateBadges(reps, pgText, pdText);
    else document.getElementById('footer-info').textContent = 'Aucune répétition';
  }).catch(e => console.error('analyze error:', e));
}

// ── Mise à jour badges + décorations mots ────────────────────────────────
function updateBadges(reps, pgTextArg, pdTextArg) {
  clearBadges();
  clearWordDecos();
  if (!reps || !reps.length) {
    document.getElementById('footer-info').textContent = 'Aucune répétition';
    return;
  }
  const pgText   = pgTextArg !== undefined ? pgTextArg : getText(viewPG);
  const pdText   = pdTextArg !== undefined ? pdTextArg : getText(viewPD);
  const pdOffset = pgText.length + 1;   // +1 : espace séparateur

  const pgReps = [], pdReps = [];
  reps.forEach((rep, i) => {
    [
      { off: rep.offset_a, forme: rep.forme_a, dir: 'après' },
      { off: rep.offset_b, forme: rep.forme_b, dir: 'avant' },
    ].forEach(({ off, forme, dir }) => {
      if (off < pgText.length) {
        pgReps.push({ offset: off, forme, dir, distance: rep.distance, repIdx: i });
      } else if (off >= pdOffset && off < pdOffset + pdText.length) {
        pdReps.push({ offset: off - pdOffset, forme, dir, distance: rep.distance, repIdx: i });
      }
    });
  });

  // Règle absolue : max 1 badge ← et 1 badge → par mot (garder la distance minimale)
  const nearestOnly = list => {
    const best = new Map();
    list.forEach(rep => {
      const key = `${rep.offset}:${rep.dir}`;
      if (!best.has(key) || rep.distance < best.get(key).distance) best.set(key, rep);
    });
    return [...best.values()];
  };

  console.log('badges: PG', pgReps.length, '/ PD', pdReps.length);
  applyWordDecosAndBadges(viewPG, decoKeyPG, nearestOnly(pgReps));
  applyWordDecosAndBadges(viewPD, decoKeyPD, nearestOnly(pdReps));

  const n = reps.length;
  document.getElementById('footer-info').textContent =
    `${n} répétition${n > 1 ? 's' : ''}`;
}

// ── Initialisation (appelée par Python via evaluate_js) ──────────────────
function init(data) {
  _fullText    = data.text;
  _totalWords  = data.total_words;
  _totalChars  = data.total_chars;
  _totalPages  = Math.ceil(_totalChars / CHARS_PER_PAGE);
  _seuil       = data.seuil || 1500;
  _vivantStart = 0;
  _currentPage = 1;
  _navHistory  = [0];
  _navIdx      = 0;

  const vivant = _fullText.slice(0, VIVANT_SIZE).replace(/\s+/g, ' ').trim();
  _fullWords = vivant.match(/\S+\s*/g) || [];

  document.getElementById('splash').classList.add('hidden');
  document.getElementById('app').style.display = 'flex';

  fillEditors();
  scheduleAnalysis();
}

// ── Hover sur mot annoté (badges pointer-events:none, ne reçoivent pas d'events) ──
document.addEventListener('mouseover', e => {
  const target = e.target.closest('.prox-word');
  if (!target) return;
  const idx = target.dataset.repIdx;
  deactivateAll();
  _activeRepIdx = idx;
  activateGroup(idx);
});
document.addEventListener('mouseout', e => {
  const target = e.target.closest('.prox-word');
  if (!target) return;
  const related = e.relatedTarget && e.relatedTarget.closest('.prox-word');
  if (related && related.dataset.repIdx === target.dataset.repIdx) return;
  deactivateAll();
});

window.proxJS = { init, updateBadges };

// ── DEBUG curseur ─────────────────────────────────────────────────────────
function dbg(msg) {
  const el = document.getElementById('footer-info');
  if (el) el.textContent = msg;
}

// ── Démarrage ─────────────────────────────────────────────────────────────
document.addEventListener('mousedown', e => {
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const utag  = under ? under.tagName : '—';
  const ucls  = under ? (under.className || '—') : '—';
  const msg   = `CAPTURE x=${e.clientX} y=${e.clientY} cible=${utag}.${ucls}`;
  if (window.pywebview && window.pywebview.api) window.pywebview.api.debug_log(msg);
}, true);

window.addEventListener('DOMContentLoaded', () => {
  const onEdit = () => {
    scheduleReflow();
    clearBadges();
    clearWordDecos();
    scheduleAnalysis();
  };
  viewPG = createView(document.getElementById('editor-pg'), decoKeyPG, onEdit);
  viewPD = createView(document.getElementById('editor-pd'), decoKeyPD, onEdit);

  // DEBUG : log clic dans footer-info
  [viewPG, viewPD].forEach((v, i) => {
    const side = i === 0 ? 'PG' : 'PD';
    v.dom.addEventListener('mousedown', e => {
      const tag = e.target.tagName;
      const cls = e.target.className || '—';
      const ri  = e.target.dataset ? (e.target.dataset.repIdx || '—') : '—';
      const pos = v.posAtCoords({ left: e.clientX, top: e.clientY });
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const utag  = under ? under.tagName : '—';
      const ucls  = under ? (under.className || '—') : '—';
      const msg = `BUBBLE ${side} tag=${tag} class=${cls} repIdx=${ri} posAtCoords=${JSON.stringify(pos)} sous-la-souris=${utag}.${ucls}`;
      dbg(msg);
      if (window.pywebview && window.pywebview.api) window.pywebview.api.debug_log(msg);
    });
  });

  // Faux curseur : show/hide au focus/blur
  [viewPG, viewPD].forEach(v => {
    v.dom.addEventListener('focus', () => updateFakeCursor());
    v.dom.addEventListener('blur',  () => {
      const c = document.getElementById('fake-cursor');
      if (c) c.style.display = 'none';
    });
  });

  // Curseur début de PD → fin de PG via ←
  viewPD.dom.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') {
      const { $from } = viewPD.state.selection;
      if ($from.parentOffset === 0) {
        viewPG.focus();
        restoreCursor(viewPG, viewPG.state.doc.content.size - 1);
        e.preventDefault();
      }
    }
  });

  // Curseur bas de PG → début de PD via →
  viewPG.dom.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') {
      const { $from } = viewPG.state.selection;
      if ($from.parentOffset === $from.parent.content.size) {
        viewPD.focus();
        restoreCursor(viewPD, 1);
        e.preventDefault();
      }
    }
  });

  // Bloquer tout scroll
  document.addEventListener('wheel',     e => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

  // Ctrl+Shift+→/← : page suivante/précédente
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'ArrowRight') {
      document.getElementById('btn-next').click();
      e.preventDefault();
    } else if (e.ctrlKey && e.shiftKey && e.key === 'ArrowLeft') {
      document.getElementById('btn-prev').click();
      e.preventDefault();
    }
  });

  // PageLine cliquable
  document.getElementById('pageline').addEventListener('click', e => {
    const bar  = e.currentTarget;
    const rect = bar.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const pos   = snapToWord(Math.floor(ratio * _fullText.length));
    if (pos === _vivantStart || !_fullText.length) return;
    _navHistory = _navHistory.slice(0, _navIdx + 1);
    _navHistory.push(pos);
    _navIdx++;
    goToPage(pos);
    updateFooter();
  });
});
