'use strict';

// Distance FIXE entre deux mots
const GAP = 12;


window.addEventListener('error', e => {
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.debug_log(`ERROR: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  }
});

const hiddenInput = document.getElementById('hidden-input');

// Champ texte caché (hors écran, voir test.css) : seule source de vérité pour la frappe et la
// composition (accents, touches mortes). Le focus y reste en permanence ; ni fullText ni cursorIdx
// ne dépendent de sa position interne — seul son contenu, une fois flush dans fullText, compte.
let composing = false;
hiddenInput.addEventListener('compositionstart', () => { composing = true; });
hiddenInput.addEventListener('compositionend', e => { composing = false; if (e.data) insertText(e.data); });
hiddenInput.addEventListener('input', e => {
  if (!composing && e.data) insertText(e.data);
  scheduleHiddenInputClear();
});

let hiddenInputClearTimer = null;
function scheduleHiddenInputClear() {
  clearTimeout(hiddenInputClearTimer);
  hiddenInputClearTimer = setTimeout(() => {
    if (!composing) hiddenInput.value = '';
  }, 10 * 60 * 1000);
}


let fullText = "Ceci est un texte ! Ajoutons ici quelques mots supplementaires pour bien depasser la largeur fine de cette page et forcer une ligne suivante visible. Il faut regarder aussi comment ça se passer avec son badge :after qui déborde.";

function OwnSpecialValues(){
  var tokens = buildTokens(fullText);
  tokens[1].after  = 1200; // est
  tokens[2].before = 1012; // un
  tokens[2].after  = 1299; // un
  tokens[3].before = 1111; // texte
  tokens[15].before = 999  // fine
  tokens[34].after  = 899   // son
  return tokens
}

const pageEl    = document.getElementById('page');
const textEl    = document.getElementById('text');
const cursorEl  = document.getElementById('fake-cursor');
const infoEl    = document.getElementById('info');
const selLayer  = document.getElementById('sel-layer');
const badgeLayer = document.getElementById('badge-layer');

// ── segments : la liste, dans l'ordre, de chaque unité du DOM (mot, espace, ou retour à la
// ligne) avec sa plage [start, end) dans fullText — traduit un index de caractère en (noeud,
// offset) et l'inverse. Un retour à la ligne occupe une position, comme un caractère, mais n'a
// rien de mesurable à son propre emplacement (pas de glyphe) — voir rectForIndex.
let segments = [];

let wordPositionsInfo = '';

function rebuildDOM() {
  textEl.innerHTML = '';
  badgeLayer.innerHTML = '';
  segments = [];
  wordPositionsInfo = '';
  let pos = 0;
  let tokenIdx = 0;
  const paragraphs = fullText.split('\n');
  paragraphs.forEach((paraText, pi) => {
    const paraEl = document.createElement('div');
    paraEl.className = 'para';
    textEl.appendChild(paraEl);

    const words = paraText.split(' ');
    var badgeX = 0;
    var prevTop = null;
    words.forEach((w, i) => {
      // un paragraphe qui finit ou commence par un espace produit un élément vide en bout de
      // split : ce n'est pas un mot, juste un espace déjà couvert par un autre segment — ne pas
      // créer de span/segment vide pour lui (sinon aucun noeud texte à mesurer à cette position).
      const isEmptyBoundary = w === '' && (i === 0 || i === words.length - 1) && words.length > 1;
      if (!isEmptyBoundary) {
        const start = pos;
        const span = document.createElement('span');
        span.className = 'word';
        span.textContent = w;
        paraEl.appendChild(span);

        const pageRect = pageEl.getBoundingClientRect();
        const rightLimit = pageEl.clientWidth - parseFloat(getComputedStyle(pageEl).paddingRight);
        const token = TOKENS[tokenIdx++];

        let r, wordX, bgText, naturalWidth;
        let beforeBadgeEl = null;

        for (let attempt = 0; attempt < 2; attempt++) {
          r = span.getBoundingClientRect();
          if (prevTop !== null && Math.round(r.top) !== Math.round(prevTop)) badgeX = 0;
          prevTop = r.top;
          const naturalX = r.left - pageRect.left;
          naturalWidth = r.width;
          const actualX = Math.max(naturalX, badgeX);

          wordX = actualX;
          bgText = '';
          if (token.before !== null) {
            beforeBadgeEl = document.createElement('div');
            beforeBadgeEl.className = 'badge';
            beforeBadgeEl.textContent = token.before;
            badgeLayer.appendChild(beforeBadgeEl);
            const bw = beforeBadgeEl.getBoundingClientRect().width;
            beforeBadgeEl.style.left = actualX + 'px';
            beforeBadgeEl.style.top  = (r.top - pageRect.top + r.height + 2) + 'px';
            const mid = actualX + bw + GAP / 4;
            wordX = Math.max(naturalX, mid - naturalWidth / 2);
            bgText = `BG ${Math.round(actualX)} `;
          }

          // le mot (avec son éventuel badge avant) déborde le bord droit de la page : on annule
          // tout pour ce mot et on force le passage à la ligne suivante.
          if (wordX + naturalWidth > rightLimit && attempt === 0) {
            if (beforeBadgeEl) { badgeLayer.removeChild(beforeBadgeEl); beforeBadgeEl = null; }
            span.style.marginLeft = '0px';
            paraEl.insertBefore(document.createElement('br'), span);
            badgeX = 0;
            prevTop = null;
            continue;
          }
          break;
        }

        span.style.marginLeft = (wordX - (r.left - pageRect.left)) + 'px';
        r = span.getBoundingClientRect();

        segments.push({ node: span, start, end: start + w.length, isWord: true });
        pos += w.length;

        wordPositionsInfo += `${w} ${Math.round(r.left - pageRect.left)}/${Math.round(r.width)} `;
        wordPositionsInfo += bgText;

        const centerX = r.left + r.width / 2 - pageRect.left;
        const top = r.bottom - pageRect.top + 2;

        if (token.after !== null) {
          const badge = document.createElement('div');
          badge.className = 'badge';
          badge.textContent = token.after;
          badge.style.left = (centerX + GAP / 4) + 'px';
          badge.style.top  = top + 'px';
          badgeLayer.appendChild(badge);
          const br = badge.getBoundingClientRect();
          const bd = Math.round(br.right - pageRect.left);
          wordPositionsInfo += `BD ${bd} `;
          badgeX = bd + GAP;
        }
      }
      if (i < words.length - 1) {
        const spaceNode = document.createTextNode(' ');
        paraEl.appendChild(spaceNode);
        segments.push({ node: spaceNode, start: pos, end: pos + 1, isWord: false });
        pos += 1;
      }
    });

    if (pi < paragraphs.length - 1) {
      segments.push({ node: paraEl, start: pos, end: pos + 1, isWord: false, isBreak: true });
      pos += 1;
    }
  });
}

// Test badges : générée automatiquement à partir de fullText, avant/après forcés par index
// ensuite — sera remplacée par l'analyse Python réelle.
function buildTokens(text) {
  const tokens = [];
  let offset = 0;
  text.split(' ').forEach((forme, i) => {
    tokens.push({ i, forme, canon: forme.toLowerCase(), offset, before: null, after: null });
    offset += forme.length + 1;
  });
  return tokens;
}

const TOKENS = OwnSpecialValues()

function computeBadges() {
  const byStart = new Map(); // offset du mot -> { canon, before, after }
  TEST_PAIRS.forEach(({ canon, offset_a, offset_b, distance }) => {
    const a = byStart.get(offset_a) || { canon };
    a.after = distance;
    byStart.set(offset_a, a);
    const b = byStart.get(offset_b) || { canon };
    b.before = distance;
    byStart.set(offset_b, b);
  });
  const result = [];
  wordSegments().forEach(w => {
    const entry = byStart.get(w.start);
    if (!entry) return;
    result.push({ word: w, canon: entry.canon, before: entry.before ?? null, after: entry.after ?? null });
  });
  return result;
}

// GAP (badges.adoc) : largeur d'un "e" dans la police courante, mesurée via canvas.
function measureGap() {
  const sample = document.querySelector('.word');
  if (!sample) return 6;
  const style = getComputedStyle(sample);
  const canvas = measureGap._canvas || (measureGap._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return ctx.measureText('e').width;
}

function renderBadges() {
  badgeLayer.innerHTML = '';
  const pageRect = pageEl.getBoundingClientRect();
  const gap = measureGap();
  computeBadges().forEach(({ word, before, after }) => {
    const r = word.node.getBoundingClientRect();
    const top = r.bottom - pageRect.top + 2;
    const centerX = r.left + r.width / 2 - pageRect.left;
    if (before !== null) {
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = before;
      badgeLayer.appendChild(badge);
      const w = badge.getBoundingClientRect().width;
      badge.style.left = (centerX - gap / 2 - w) + 'px';
      badge.style.top  = top + 'px';
    }
    if (after !== null) {
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = after;
      badge.style.left = (centerX + gap / 2) + 'px';
      badge.style.top  = top + 'px';
      badgeLayer.appendChild(badge);
    }
  });
}

function segmentAt(idx) {
  for (const seg of segments) {
    if (idx >= seg.start && idx <= seg.end) return seg;
  }
  return segments[segments.length - 1];
}

function charIndexToDom(idx) {
  const seg = segmentAt(idx);
  const node = seg.isWord ? seg.node.firstChild : seg.node;
  return { node, offset: idx - seg.start };
}

function domToCharIndex(node, offset) {
  const target = node.nodeType === Node.TEXT_NODE ? node : (node.firstChild || node);
  const seg = segments.find(s => (s.isWord ? s.node.firstChild : s.node) === target);
  if (!seg) return 0;
  return seg.start + offset;
}

// Rectangle fiable pour une position ponctuelle : un point (largeur nulle) n'est pas mesurable
// directement dans ce moteur — on mesure le caractère voisin (après, sinon avant) à la place.
function getCaretRect(node, offset) {
  const probe = document.createRange();
  if (node.nodeType === Node.TEXT_NODE) {
    const len = node.data.length;
    if (offset < len) {
      probe.setStart(node, offset);
      probe.setEnd(node, offset + 1);
      const r = probe.getClientRects()[0];
      if (r) return { left: r.left, top: r.top, bottom: r.bottom };
    }
    if (offset > 0) {
      probe.setStart(node, offset - 1);
      probe.setEnd(node, offset);
      const r = probe.getClientRects()[0];
      if (r) return { left: r.right, top: r.top, bottom: r.bottom };
    }
  }
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const r  = el.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom };
}

function nearestWord(fromSegIdx, dir) {
  for (let i = fromSegIdx; i >= 0 && i < segments.length; i += dir) {
    if (segments[i].isWord) return segments[i];
  }
  return null;
}

// Position à l'écran pour un index de caractère. Un espace ou un retour à la ligne collé à un
// changement de ligne visuel n'a souvent aucun rectangle mesurable à son propre emplacement (le
// navigateur ne dessine rien à cet endroit précis) — dans ce cas on mesure le mot voisin à la
// place : celui d'après si on est au tout début de l'espace/saut, sinon celui d'avant.
function rectForIndex(idx) {
  // Cas particulier : idx tombe exactement sur la position d'un retour à la ligne. Si le
  // paragraphe précédent finit par une espace, cette espace et le retour à la ligne revendiquent
  // la même frontière — segmentAt peut retenir l'espace au lieu du retour à la ligne, ce qui fait
  // sauter cette position jusqu'au mot du paragraphe suivant au lieu de l'afficher en fin de ligne
  // précédente. On force ici le rendu "fin de ligne précédente" dès que idx est le début d'un
  // segment de rupture, sans dépendre du segment que segmentAt aurait choisi.
  const breakSeg = segments.find(s => s.isBreak && s.start === idx);
  if (breakSeg) {
    const w = nearestWord(segments.indexOf(breakSeg) - 1, -1);
    if (w) return getCaretRect(w.node.firstChild, w.end - w.start);
  }
  const seg = segmentAt(idx);
  if (!seg.isWord) {
    const segIdx = segments.indexOf(seg);
    if (idx === seg.end) {
      const w = nearestWord(segIdx + 1, 1);
      if (w) return getCaretRect(w.node.firstChild, 0);
    }
    if (idx === seg.start) {
      const w = nearestWord(segIdx - 1, -1);
      if (w) return getCaretRect(w.node.firstChild, w.end - w.start);
    }
  }
  const { node, offset } = charIndexToDom(idx);
  return getCaretRect(node, offset);
}

function describePosition(idx) {
  const seg = segmentAt(idx);
  if (seg.isWord) {
    const word   = seg.node.textContent;
    const offset = idx - seg.start;
    let where;
    if (offset === 0) where = 'tout début du mot';
    else if (offset === word.length) where = 'toute fin du mot';
    else where = `entre "${word.slice(0, offset)}" et "${word.slice(offset)}"`;
    return `mot "${word}" — caractère ${offset}/${word.length} — ${where}`;
  }
  if (seg.isBreak) return `au niveau d'un retour à la ligne`;
  const prevSeg = segments[segments.indexOf(seg) - 1];
  const nextSeg = segments[segments.indexOf(seg) + 1];
  const beforeWord = prevSeg && prevSeg.isWord ? prevSeg.node.textContent : null;
  const afterWord  = nextSeg && nextSeg.isWord ? nextSeg.node.textContent : null;
  if (beforeWord && afterWord) return `espace entre "${beforeWord}" et "${afterWord}"`;
  if (!beforeWord && afterWord) return `tout début du texte, juste avant "${afterWord}"`;
  if (beforeWord && !afterWord) return `toute fin du texte, juste après "${beforeWord}"`;
  return `position indéterminée`;
}

// ── État : position du curseur + ancre de sélection (null = pas de sélection) ────────────────
let cursorIdx = 0;
let anchorIdx = null;
let dragging  = false;

function clampIdx(idx) { return Math.max(0, Math.min(idx, fullText.length)); }

// Avance/recule d'un caractère, mais si cette position rend exactement au même endroit à l'écran
// qu'avant (espace invisible en fin de ligne, largeur nulle) — saute directement d'un caractère de
// plus, pour qu'une pression de flèche corresponde toujours à un déplacement visible du curseur.
function visualStep(idx, dir) {
  const next = clampIdx(idx + dir);
  if (next === idx) return next;
  const a = rectForIndex(idx), b = rectForIndex(next);
  if (Math.round(a.left) === Math.round(b.left) && Math.round(a.top) === Math.round(b.top)) {
    const further = clampIdx(next + dir);
    if (further !== next) return further;
  }
  return next;
}

function indexAtPoint(x, y) {
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
  else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  }
  if (!range) return null;
  return domToCharIndex(range.startContainer, range.startOffset);
}

function renderCursor() {
  const rect     = rectForIndex(cursorIdx);
  const pageRect = pageEl.getBoundingClientRect();
  cursorEl.style.display = (anchorIdx !== null && anchorIdx !== cursorIdx) ? 'none' : 'block';
  cursorEl.style.left    = (rect.left - pageRect.left) + 'px';
  cursorEl.style.top     = (rect.top  - pageRect.top)  + 'px';
  cursorEl.style.height  = (rect.bottom - rect.top) + 'px';
  // relance le clignotement à chaque déplacement, pour que le curseur soit toujours visible juste
  // après un mouvement au lieu de retomber, par hasard, dans sa phase invisible
  cursorEl.style.animation = 'none';
  void cursorEl.offsetHeight;
  cursorEl.style.animation = '';
}

function renderSelection() {
  selLayer.innerHTML = '';
  if (anchorIdx === null || anchorIdx === cursorIdx) return;
  const from = Math.min(anchorIdx, cursorIdx);
  const to   = Math.max(anchorIdx, cursorIdx);
  const a = charIndexToDom(from), b = charIndexToDom(to);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  const pageRect = pageEl.getBoundingClientRect();
  Array.from(range.getClientRects()).forEach(r => {
    const box = document.createElement('div');
    box.className = 'sel-box';
    box.style.left   = (r.left   - pageRect.left) + 'px';
    box.style.top    = (r.top    - pageRect.top)  + 'px';
    box.style.width  = r.width  + 'px';
    box.style.height = r.height + 'px';
    selLayer.appendChild(box);
  });
}

function render(info) {
  renderCursor();
  renderSelection();
  if (info) infoEl.textContent = wordPositionsInfo + '\n' + info;
}

function setCursor(idx, keepAnchor) {
  cursorIdx = clampIdx(idx);
  if (!keepAnchor) anchorIdx = null;
  render(`position ${cursorIdx} — ${describePosition(cursorIdx)}` + (anchorIdx !== null ? ` — sélection [${Math.min(anchorIdx, cursorIdx)}, ${Math.max(anchorIdx, cursorIdx)})` : ''));
  logCursor();
}

const DEBUG_LOG_ENABLED = false; // coupé temporairement pour tester si debug_log cause le lag flèches

function logCursor() {
  if (!DEBUG_LOG_ENABLED) return;
  if (!(window.pywebview && window.pywebview.api)) return;
  const rect    = rectForIndex(cursorIdx);
  const around  = JSON.stringify(fullText.slice(Math.max(0, cursorIdx - 8), cursorIdx) + '|' + fullText.slice(cursorIdx, cursorIdx + 8));
  const pageRect = pageEl.getBoundingClientRect();
  window.pywebview.api.debug_log(
    `idx=${cursorIdx} autour=${around} rect(left=${Math.round(rect.left - pageRect.left)},top=${Math.round(rect.top - pageRect.top)},bottom=${Math.round(rect.bottom - pageRect.top)}) anchor=${anchorIdx}`
  );
}

// ── Mots : bornes pour Alt+flèche (mot par mot) ───────────────────────────────────────────────
function wordSegments() { return segments.filter(s => s.isWord); }

// ── Ligne visuelle (pour Home/End) : mots qui partagent le même haut de rectangle que idx ────
function lineBoundsAt(idx) {
  const top = rectForIndex(idx).top;
  let from = null, to = null;
  wordSegments().forEach(s => {
    const r = getCaretRect(s.node.firstChild, 0);
    if (Math.abs(r.top - top) < 3) {
      if (from === null) from = s.start;
      to = s.end;
    }
  });
  if (from === null) return { from: 0, to: fullText.length };
  return { from, to };
}

function lineBoundsAtTop(top) {
  let from = null, to = null;
  wordSegments().forEach(s => {
    const r = getCaretRect(s.node.firstChild, 0);
    if (Math.abs(r.top - top) < 3) {
      if (from === null) from = s.start;
      to = s.end;
    }
  });
  if (from === null) return null;
  return { from, to };
}

function allLineTops() {
  const tops = [];
  wordSegments().forEach(s => {
    const r = getCaretRect(s.node.firstChild, 0);
    if (!tops.some(t => Math.abs(t - r.top) < 3)) tops.push(r.top);
  });
  return tops.sort((a, b) => a - b);
}

function moveVertical(idx, dir) {
  const curRect = rectForIndex(idx);
  const tops = allLineTops();
  const curLineIdx = tops.findIndex(t => Math.abs(t - curRect.top) < 3);
  if (curLineIdx === -1) return idx;
  const targetLineIdx = curLineIdx + dir;
  if (targetLineIdx < 0 || targetLineIdx >= tops.length) return idx;
  const bounds = lineBoundsAtTop(tops[targetLineIdx]);
  if (!bounds) return idx;
  let best = bounds.from, bestDist = Infinity;
  for (let i = bounds.from; i <= bounds.to; i++) {
    const d = Math.abs(rectForIndex(i).left - curRect.left);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function paragraphBoundsAt(idx) {
  const from = fullText.lastIndexOf('\n', idx - 1) + 1;
  let to = fullText.indexOf('\n', idx);
  if (to === -1) to = fullText.length;
  return { from, to };
}

function nextWordBoundary(idx, dir) {
  const ws = wordSegments();
  if (dir > 0) {
    for (const s of ws) if (s.start > idx) return s.start;
    return fullText.length;
  } else {
    let prev = 0;
    for (const s of ws) { if (s.start >= idx) break; prev = s.start; }
    return prev;
  }
}

// ── Édition : tout passe par une modification de fullText, puis reconstruction ───────────────
// Un retour à la ligne (Entrée) est juste le caractère "\n" — inséré, supprimé, fusionné comme
// n'importe quel autre caractère, sans cas particulier.
function deleteSelectionIfAny() {
  if (anchorIdx === null || anchorIdx === cursorIdx) return false;
  const from = Math.min(anchorIdx, cursorIdx);
  const to   = Math.max(anchorIdx, cursorIdx);
  fullText = fullText.slice(0, from) + fullText.slice(to);
  cursorIdx = from;
  anchorIdx = null;
  return true;
}

function insertText(str) {
  deleteSelectionIfAny();
  fullText = fullText.slice(0, cursorIdx) + str + fullText.slice(cursorIdx);
  cursorIdx += str.length;
  rebuildDOM();
  setCursor(cursorIdx, false);
}

function insertParagraphBreak() {
  deleteSelectionIfAny();
  if (fullText[cursorIdx - 1] === ' ') {
    fullText = fullText.slice(0, cursorIdx - 1) + fullText.slice(cursorIdx);
    cursorIdx -= 1;
  }
  insertText('\n');
}

function backspace() {
  if (deleteSelectionIfAny()) { rebuildDOM(); setCursor(cursorIdx, false); return; }
  if (cursorIdx === 0) return;
  fullText = fullText.slice(0, cursorIdx - 1) + fullText.slice(cursorIdx);
  cursorIdx -= 1;
  rebuildDOM();
  setCursor(cursorIdx, false);
}

function deleteForward() {
  if (deleteSelectionIfAny()) { rebuildDOM(); setCursor(cursorIdx, false); return; }
  if (cursorIdx >= fullText.length) return;
  fullText = fullText.slice(0, cursorIdx) + fullText.slice(cursorIdx + 1);
  rebuildDOM();
  setCursor(cursorIdx, false);
}

// ── Souris : clic simple, glissé, Maj+clic, double-clic, triple-clic ─────────────────────────
let lastClick = { time: 0, idx: -1, count: 0 };

textEl.addEventListener('mousedown', e => {
  hiddenInput.focus();
  const idx = indexAtPoint(e.clientX, e.clientY);
  if (idx === null) return;

  const now = Date.now();
  if (now - lastClick.time < 500 && lastClick.idx === idx) lastClick.count++;
  else lastClick.count = 1;
  lastClick = { time: now, idx, count: lastClick.count };

  if (e.shiftKey) {
    if (anchorIdx === null) anchorIdx = cursorIdx;
    setCursor(idx, true);
    return;
  }

  if (lastClick.count === 2) {
    const seg = segmentAt(idx);
    if (seg.isWord) { anchorIdx = seg.start; setCursor(seg.end, true); return; }
  }
  if (lastClick.count >= 3) {
    const bounds = lineBoundsAt(idx);
    anchorIdx = bounds.from;
    setCursor(bounds.to, true);
    return;
  }

  anchorIdx = idx;
  dragging  = true;
  setCursor(idx, true);
});

textEl.addEventListener('mousemove', e => {
  if (!dragging) return;
  const idx = indexAtPoint(e.clientX, e.clientY);
  if (idx === null) return;
  setCursor(idx, true);
});

document.addEventListener('mouseup', () => { dragging = false; });

function validateCorrection() {
  // Pas encore implémenté — juste le branchement de la touche pour l'instant.
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.debug_log('Tab : validation (pas encore implémentée)');
  }
}

// ── Clavier : navigation + édition ────────────────────────────────────────────────────────────
// Le champ caché (hiddenInput) est la seule source de vérité pour la frappe/composition — il
// garde le focus en permanence ; ce listener ne gère que les touches de contrôle (navigation,
// suppression, validation). Les touches "normales" ne sont pas interceptées ici : on les laisse
// atteindre hiddenInput normalement (composition comprise), récupérées ensuite via ses écouteurs
// 'input'/'compositionend'.
document.addEventListener('keydown', e => {
  if (document.activeElement !== hiddenInput) hiddenInput.focus();

  const shift = e.shiftKey, alt = e.altKey, meta = e.metaKey;
  let handled = true;

  if (meta && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const bounds = lineBoundsAt(cursorIdx);
    const target = e.key === 'ArrowLeft' ? bounds.from : bounds.to;
    if (shift) { if (anchorIdx === null) anchorIdx = cursorIdx; setCursor(target, true); }
    else setCursor(target, false);
  } else if (meta && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const bounds = paragraphBoundsAt(cursorIdx);
    const target = e.key === 'ArrowUp' ? bounds.from : bounds.to;
    if (shift) { if (anchorIdx === null) anchorIdx = cursorIdx; setCursor(target, true); }
    else setCursor(target, false);
  } else if (meta) { handled = false; }
  else if (e.key === 'ArrowRight') {
    const next = alt ? nextWordBoundary(cursorIdx, 1) : visualStep(cursorIdx, 1);
    if (shift) { if (anchorIdx === null) anchorIdx = cursorIdx; setCursor(next, true); }
    else setCursor(next, false);
  } else if (e.key === 'ArrowLeft') {
    const prev = alt ? nextWordBoundary(cursorIdx, -1) : visualStep(cursorIdx, -1);
    if (shift) { if (anchorIdx === null) anchorIdx = cursorIdx; setCursor(prev, true); }
    else setCursor(prev, false);
  } else if (e.key === 'ArrowDown') {
    const next = moveVertical(cursorIdx, 1);
    if (shift) { if (anchorIdx === null) anchorIdx = cursorIdx; setCursor(next, true); }
    else setCursor(next, false);
  } else if (e.key === 'ArrowUp') {
    const prev = moveVertical(cursorIdx, -1);
    if (shift) { if (anchorIdx === null) anchorIdx = cursorIdx; setCursor(prev, true); }
    else setCursor(prev, false);
  } else if (e.key === 'Home') {
    if (shift && anchorIdx === null) anchorIdx = cursorIdx;
    setCursor(lineBoundsAt(cursorIdx).from, shift);
  } else if (e.key === 'End') {
    if (shift && anchorIdx === null) anchorIdx = cursorIdx;
    setCursor(lineBoundsAt(cursorIdx).to, shift);
  } else if (e.key === 'Backspace') {
    backspace();
  } else if (e.key === 'Delete') {
    deleteForward();
  } else if (e.key === 'Enter') {
    insertParagraphBreak();
  } else if (e.key === 'Tab') {
    validateCorrection();
  } else {
    handled = false;
  }
  if (handled) e.preventDefault();
});

// ── Départ ─────────────────────────────────────────────────────────────────────────────────
rebuildDOM();
setCursor(0, false);
hiddenInput.focus();
