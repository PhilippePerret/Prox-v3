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


// Essai grandeur nature : ~2400 mots (équivalent 3 pages de ~800 mots), badges aléatoires,
// au moins 1000 badges par tranche de 800 mots (avant/après tirés à 75% chacun, indépendamment).
// Découpé en paragraphes (un saut de ligne tous les ~50 mots) pour que le navigateur n'ait à
// recalculer la mise en page que du paragraphe touché par une frappe, pas du document entier.
function generateStressText(totalWords, wordsPerPara) {
  const pool = ["maison","texte","proximite","badge","mot","phrase","ligne","page","curseur","exemple",
    "analyse","distance","canon","forme","repetition","lecture","ecriture","fenetre","fonction",
    "variable","boucle","tableau","objet","valeur","position","largeur","hauteur","couleur","rapide","lent"];
  const paras = [];
  let remaining = totalWords;
  while (remaining > 0) {
    const n = Math.min(wordsPerPara, remaining);
    const words = [];
    for (let i = 0; i < n; i++) words.push(pool[Math.floor(Math.random() * pool.length)]);
    paras.push(words.join(' ') + '.');
    remaining -= n;
  }
  paras[0] = 'Ceci ' + paras[0];
  return paras.join('\n');
}

let fullText = generateStressText(2400, 50);

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

// paraStates : suivi persistant, paragraphe par paragraphe puis mot par mot, du dernier rendu —
// permet à rebuildDOM de ne retoucher que le paragraphe réellement affecté par une frappe (ni les
// autres paragraphes, ni leurs badges), au lieu de tout redétruire à chaque frappe.
let paraStates = []; // [{ paraEl, wordState: [{span, spaceEl, beforeEl, afterEl, text, naturalX, _badgeXAfter}] }]

function placeWordAt(paraEl, span, w, start, badgeXIn, prevTopIn, token) {
  // Place un mot (span déjà dans le DOM) : badge avant, décalage, badge après, retour à la ligne
  // forcé si besoin. Retourne { badgeX, prevTop } à transmettre au mot suivant.
  const pageRect = pageEl.getBoundingClientRect();
  const rightLimit = pageEl.clientWidth - parseFloat(getComputedStyle(pageEl).paddingRight);
  let badgeX = badgeXIn, prevTop = prevTopIn;
  let r, wordX, naturalWidth, beforeBadgeEl = null, afterBadgeEl = null, actualX = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    r = span.getBoundingClientRect();
    if (prevTop !== null && Math.round(r.top) !== Math.round(prevTop)) badgeX = 0;
    prevTop = r.top;
    const naturalX = r.left - pageRect.left;
    naturalWidth = r.width;
    actualX = Math.max(naturalX, badgeX);

    wordX = actualX;
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
    }

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

  const centerX = r.left + r.width / 2 - pageRect.left;
  const top = r.bottom - pageRect.top + 2;

  if (token.after !== null) {
    afterBadgeEl = document.createElement('div');
    afterBadgeEl.className = 'badge';
    afterBadgeEl.textContent = token.after;
    afterBadgeEl.style.left = (centerX + GAP / 4) + 'px';
    afterBadgeEl.style.top  = top + 'px';
    badgeLayer.appendChild(afterBadgeEl);
    const br = afterBadgeEl.getBoundingClientRect();
    const bd = Math.round(br.right - pageRect.left);
    badgeX = bd + GAP;
  }

  return { badgeX, prevTop, naturalX: actualX, end: start + w.length, beforeBadgeEl, afterBadgeEl };
}

// Construit/retouche les mots d'UN SEUL paragraphe. oldWordState === null (ou nombre de mots
// différent) => reconstruction complète de ce paragraphe (mais des autres). Sinon, ne retouche
// qu'à partir du premier mot changé, jusqu'à ce qu'un mot retrouve exactement sa position d'avant.
function syncParagraph(paraEl, oldWordState, words, tokenIdxStart) {
  const isFull = !oldWordState || oldWordState.length !== words.length;
  let wordState;
  let startIdx = 0;

  if (isFull) {
    if (oldWordState) oldWordState.forEach(st => {
      if (st.beforeEl) badgeLayer.removeChild(st.beforeEl);
      if (st.afterEl)  badgeLayer.removeChild(st.afterEl);
    });
    paraEl.innerHTML = '';
    wordState = [];
  } else {
    wordState = oldWordState;
    while (startIdx < words.length && wordState[startIdx].text === words[startIdx]) startIdx++;
    if (startIdx === words.length) return wordState; // ce paragraphe n'a pas changé
  }

  let tokenIdx = tokenIdxStart + startIdx;
  var badgeX = startIdx > 0 ? (wordState[startIdx - 1]._badgeXAfter || 0) : 0;
  var prevTop = startIdx > 0 ? wordState[startIdx - 1].span.getBoundingClientRect().top : null;

  for (let i = startIdx; i < words.length; i++) {
    const w = words[i];
    let st = wordState[i];
    let textChanged = true;
    let span;
    if (isFull || !st) {
      span = document.createElement('span');
      span.className = 'word';
      span.textContent = w;
      paraEl.appendChild(span);
      st = { span, spaceEl: null, beforeEl: null, afterEl: null, text: w, naturalX: 0, _badgeXAfter: 0 };
      wordState[i] = st;
    } else {
      textChanged = st.text !== w;
      if (textChanged) { st.span.textContent = w; st.text = w; }
      span = st.span;
    }
    if (st.beforeEl) { badgeLayer.removeChild(st.beforeEl); st.beforeEl = null; }
    if (st.afterEl)  { badgeLayer.removeChild(st.afterEl);  st.afterEl  = null; }

    const token = TOKENS[tokenIdx++];
    const placed = placeWordAt(paraEl, span, w, 0, badgeX, prevTop, token);
    const stabilized = !isFull && !textChanged && Math.round(placed.naturalX) === Math.round(st.naturalX);
    badgeX = placed.badgeX;
    prevTop = placed.prevTop;
    st.naturalX = placed.naturalX;
    st.beforeEl = placed.beforeBadgeEl;
    st.afterEl  = placed.afterBadgeEl;
    st._badgeXAfter = badgeX;

    if (i < words.length - 1 && !st.spaceEl) {
      const spaceNode = document.createTextNode(' ');
      paraEl.insertBefore(spaceNode, span.nextSibling);
      st.spaceEl = spaceNode;
    }

    if (stabilized) break;
  }

  return wordState;
}

function rebuildDOM() {
  const paragraphs = fullText.split('\n');

  if (paraStates.length !== paragraphs.length) {
    // nombre de paragraphes différent (premier chargement, ou Entrée) : reconstruction complète,
    // mais paragraphe par paragraphe (chacun son propre bloc, indépendant des autres).
    textEl.innerHTML = '';
    badgeLayer.innerHTML = '';
    paraStates = [];
    let tokenIdx = 0;
    paragraphs.forEach(paraText => {
      const paraEl = document.createElement('div');
      paraEl.className = 'para';
      textEl.appendChild(paraEl);
      const words = paraText.split(' ');
      const wordState = syncParagraph(paraEl, null, words, tokenIdx);
      paraStates.push({ paraEl, wordState });
      tokenIdx += words.length;
    });
  } else {
    // même nombre de paragraphes : ne retoucher que celui qui a changé — les autres, et leurs
    // badges, restent intacts (aucune mesure, aucune reconstruction, aucun recalcul de mise en
    // page pour eux).
    let tokenIdx = 0;
    for (let pi = 0; pi < paragraphs.length; pi++) {
      const words = paragraphs[pi].split(' ');
      const ps = paraStates[pi];
      const currentText = ps.wordState.map(st => st.text).join(' ');
      if (currentText !== paragraphs[pi]) {
        ps.wordState = syncParagraph(ps.paraEl, ps.wordState, words, tokenIdx);
      }
      tokenIdx += words.length;
    }
  }

  recomputeSegments();
}

// Offsets caractère de chaque segment (mot/espace/saut) — bon marché, aucune mesure DOM. Lit la
// longueur sur `span.textContent` (toujours exact) et non sur `st.text` : `st.text` sert de
// marqueur "dernière position calculée" pour quickSync/syncParagraph (voir plus bas) et peut donc
// être volontairement en retard d'une frappe pendant la fenêtre de débounce.
function recomputeSegments() {
  segments = [];
  let pos = 0;
  paraStates.forEach((ps, pi) => {
    ps.wordState.forEach((st, i) => {
      const len = st.span.textContent.length;
      segments.push({ node: st.span, start: pos, end: pos + len, isWord: true });
      pos += len;
      if (i < ps.wordState.length - 1) {
        segments.push({ node: st.spaceEl, start: pos, end: pos + 1, isWord: false });
        pos += 1;
      }
    });
    if (pi < paraStates.length - 1) {
      segments.push({ node: ps.paraEl, start: pos, end: pos + 1, isWord: false, isBreak: true });
      pos += 1;
    }
  });
}

// ── Mise à jour immédiate, légère (frappe) ────────────────────────────────────────────────────
// Affiche le texte tapé tout de suite : texte des spans + segments, SANS toucher aux badges ni
// aux marges de placement (placeWordAt) — aucun getBoundingClientRect ici, donc aucune des
// cascades qui faisaient "tout bouger" à chaque touche. Le placement propre (badges, décalages)
// arrive séparément, 1s après la dernière frappe (scheduleRebuild, voir plus bas).
// Marque volontairement `st.text` en retard sur le mot réellement affiché, pour que syncParagraph
// (appelé plus tard par rebuildDOM) détecte le mot à replacer — voir son usage de `st.text` pour
// trouver `startIdx`.
function quickSyncParagraph(ps, words) {
  const wordState = ps.wordState;
  const paraEl = ps.paraEl;

  if (words.length === wordState.length) {
    for (let i = 0; i < words.length; i++) {
      if (wordState[i].span.textContent !== words[i]) {
        wordState[i].span.textContent = words[i];
        // st.text n'est PAS mis à jour ici : reste le marqueur de "dernière position calculée".
      }
    }
    return;
  }

  // Nombre de mots différent (espace tapé/supprimé) : reconstruction structurelle de ce seul
  // paragraphe, spans + espaces texte nus, sans badge ni marge — le placement arrive plus tard.
  wordState.forEach(st => {
    if (st.beforeEl) badgeLayer.removeChild(st.beforeEl);
    if (st.afterEl)  badgeLayer.removeChild(st.afterEl);
  });
  paraEl.innerHTML = '';
  const newState = [];
  words.forEach((w, i) => {
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = w;
    paraEl.appendChild(span);
    let spaceEl = null;
    if (i < words.length - 1) {
      spaceEl = document.createTextNode(' ');
      paraEl.appendChild(spaceEl);
    }
    // text: '' volontaire (jamais égal à w) : force syncParagraph à replacer TOUT ce paragraphe
    // à la prochaine passe différée, badges compris.
    newState.push({ span, spaceEl, beforeEl: null, afterEl: null, text: '', naturalX: 0, _badgeXAfter: 0 });
  });
  ps.wordState = newState;
}

// Index (0-based) du paragraphe contenant idx, sans mesure DOM.
function paragraphIndexAt(idx) {
  return fullText.slice(0, idx).split('\n').length - 1;
}

// Changement du nombre de paragraphes (Entrée, ou Backspace/Delete qui fusionne deux
// paragraphes) : ne retouche QUE le(s) paragraphe(s) concerné(s) — repéré via cursorIdx — jamais
// tout le document. Une frappe simple ne peut scinder/fusionner qu'un seul paragraphe à la fois.
// Retourne true si un rebuild complet (lourd, mesure DOM) a eu lieu à la place — cas rare, une
// sélection à cheval sur plusieurs paragraphes supprimée d'un coup, pas de raccourci sûr pour ça.
function quickSyncParagraphCount() {
  const paragraphs = fullText.split('\n');
  const newCount = paragraphs.length;
  const oldCount = paraStates.length;

  if (newCount === oldCount + 1) {
    // scission : cursorIdx est juste après le \n inséré, donc au tout début du second morceau.
    const pi = paragraphIndexAt(cursorIdx) - 1;
    quickSyncParagraph(paraStates[pi], paragraphs[pi].split(' '));
    const newParaEl = document.createElement('div');
    newParaEl.className = 'para';
    textEl.insertBefore(newParaEl, paraStates[pi].paraEl.nextSibling);
    const newPs = { paraEl: newParaEl, wordState: [] };
    quickSyncParagraph(newPs, paragraphs[pi + 1].split(' '));
    paraStates.splice(pi + 1, 0, newPs);
    return false;
  }

  if (newCount === oldCount - 1) {
    // fusion : cursorIdx est dans le paragraphe résultant ; celui d'après disparaît.
    const pi = paragraphIndexAt(cursorIdx);
    textEl.removeChild(paraStates[pi + 1].paraEl);
    paraStates[pi + 1].wordState.forEach(st => {
      if (st.beforeEl) badgeLayer.removeChild(st.beforeEl);
      if (st.afterEl)  badgeLayer.removeChild(st.afterEl);
    });
    paraStates.splice(pi + 1, 1);
    quickSyncParagraph(paraStates[pi], paragraphs[pi].split(' '));
    return false;
  }

  rebuildDOM();
  return true;
}

function quickSync() {
  const paragraphs = fullText.split('\n');
  if (paraStates.length !== paragraphs.length) {
    const didFullRebuild = quickSyncParagraphCount();
    if (!didFullRebuild) recomputeSegments();
    return didFullRebuild;
  }
  // Une frappe normale (lettre, espace, backspace dans un mot) ne touche jamais qu'UN seul
  // paragraphe, celui du curseur — pas la peine de reparcourir tout le document à chaque touche.
  const pi = paragraphIndexAt(cursorIdx);
  quickSyncParagraph(paraStates[pi], paragraphs[pi].split(' '));
  recomputeSegments();
  return false;
}

// Test badges : générée automatiquement à partir de fullText, avant/après forcés par index
// ensuite — sera remplacée par l'analyse Python réelle.
function buildTokens(text) {
  const tokens = [];
  let i = 0;
  let offset = 0;
  text.split('\n').forEach((paraText, pi) => {
    paraText.split(' ').forEach(forme => {
      tokens.push({ i, forme, canon: forme.toLowerCase(), offset, before: null, after: null });
      offset += forme.length + 1;
      i++;
    });
    offset += 1; // le caractère de saut de ligne lui-même
  });
  return tokens;
}

const TOKENS = buildTokens(fullText);

// Distances réelles (proximités lexicales), reçues de Python via window.pywebview.api.analyze —
// remplace l'ancien tirage au hasard. TOKENS garde before/after à null tant que la réponse n'est
// pas arrivée (placeWordAt gère déjà before/after === null : pas de badge affiché).
function requestAnalysis(text) {
  if (!(window.pywebview && window.pywebview.api)) return;
  window.pywebview.api.analyze(text).then(reps => applyRepetitions(reps));
}

function applyRepetitions(reps) {
  const byOffset = new Map(); // offset du mot -> { before, after }
  reps.forEach(({ offset_a, offset_b, distance }) => {
    const a = byOffset.get(offset_a) || {};
    a.after = distance;
    byOffset.set(offset_a, a);
    const b = byOffset.get(offset_b) || {};
    b.before = distance;
    byOffset.set(offset_b, b);
  });
  TOKENS.forEach(t => {
    const entry = byOffset.get(t.offset);
    t.before = entry ? (entry.before ?? null) : null;
    t.after  = entry ? (entry.after  ?? null) : null;
  });
  rebuildDOM();
  setCursor(cursorIdx, false);
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
  // Relance le clignotement à chaque déplacement, pour que le curseur soit toujours visible juste
  // après un mouvement au lieu de retomber, par hasard, dans sa phase invisible. `offsetHeight`
  // forcerait un reflow synchrone de TOUTE la page à chaque frappe (coûteux sur un gros document,
  // même quand rien d'autre ne bouge) — on relance via une frame d'animation à la place, sans
  // lire aucune propriété de layout.
  cursorEl.style.animation = 'none';
  requestAnimationFrame(() => { cursorEl.style.animation = ''; });
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
  if (info) infoEl.textContent = info;
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

// Débounce du PLACEMENT (badges, décalages de marge) : quickSync() a déjà affiché le texte tapé
// tout de suite (voir plus haut) ; ici on ne fait que différer la passe coûteuse (placeWordAt,
// mesures DOM) de 1s après la dernière frappe, pour éviter la cascade visuelle à chaque touche.
let rebuildDebounceTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildDebounceTimer);
  rebuildDebounceTimer = setTimeout(() => {
    rebuildDebounceTimer = null;
    rebuildDOM();
    setCursor(cursorIdx, false);
  }, 1000);
}

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
  const didFullRebuild = quickSync();
  setCursor(cursorIdx, false);
  if (!didFullRebuild) scheduleRebuild();
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
  if (!deleteSelectionIfAny()) {
    if (cursorIdx === 0) return;
    fullText = fullText.slice(0, cursorIdx - 1) + fullText.slice(cursorIdx);
    cursorIdx -= 1;
  }
  const didFullRebuild = quickSync();
  setCursor(cursorIdx, false);
  if (!didFullRebuild) scheduleRebuild();
}

function deleteForward() {
  if (!deleteSelectionIfAny()) {
    if (cursorIdx >= fullText.length) return;
    fullText = fullText.slice(0, cursorIdx) + fullText.slice(cursorIdx + 1);
  }
  const didFullRebuild = quickSync();
  setCursor(cursorIdx, false);
  if (!didFullRebuild) scheduleRebuild();
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

if (window.pywebview && window.pywebview.api) {
  requestAnalysis(fullText);
} else {
  window.addEventListener('pywebviewready', () => requestAnalysis(fullText));
}
