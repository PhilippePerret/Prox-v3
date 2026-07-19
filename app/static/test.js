'use strict';

// Distance FIXE entre deux mots
const GAP = 12;
// Distance entre le bord droit d'un badge "après" et le mot suivant qui en hérite comme plancher
// de position (badgeX) — distincte de GAP (centre du mot/bord du badge, cf. plus bas), qui reste
// inchangé. Décision utilisateur 2026-07-18.
const BADGE_GAP = 8;

// Seuil de proximité (dupliqué de app/config.py::SEUIL_DEFAUT — pas d'import Python->JS
// possible ; à garder synchronisé si la valeur change côté serveur).
const SEUIL_DEFAUT = 1500;

// Seuil par canon (nourri plus tard depuis un outil d'analyse de corpus d'auteurs — vide pour
// l'instant, cf. merde_claude_buildTokenIndex : tout canon retombe sur SEUIL par défaut tant qu'il n'a pas
// d'entrée ici. Décision utilisateur 2026-07-17 : PAS une feature future, le seuil est par canon
// depuis le principe, seul l'outil qui le calcule n'est pas encore branché).
// Conjonctions de coordination, seuil 300 (décision utilisateur 2026-07-18, pour test visuel).
// Clé = le canon (lemme, texte) — token.c est le texte du lemme (jointure côté
// db.py::tokens_from), jamais l'id numérique canon_id, fragile car dépendant de l'ordre
// d'insertion dans la base.
// Réglages utilisateur (~/Library/Application Support/Proximity/settings.json côté Python,
// cf. app/settings.py) — chargés une fois avant textRender(), jamais avant (get_settings() est
// asynchrone, pas de valeur par défaut locale à maintenir en double ici).
let APP_SETTINGS = {};

const SEUIL_PER_CANON = {
  mais: 300, ou: 300, et: 300, donc: 300, or: 300, ni: 300, car: 300,
};

// Couleur badge/mot selon l'éloignement — 3 couleurs FIXES, pas de dégradé continu (décision
// utilisateur 2026-07-16 : un dégradé produisait trop de cas illisibles). Valeurs de départ,
// à retoucher directement dans l'inspecteur WebKit (cf. discussion) pour trouver l'équilibre.
const COULEUR_PROCHE   = [211, 47, 47];  // rouge   — ratio proche de 0 (distance proche de 0)
const COULEUR_MOYEN    = [255, 179, 0];  // ambre   — ratio autour de 1/2 (2026-07-19 : plus loin du rouge)
const COULEUR_LOINTAIN = [56, 142, 60];  // vert    — ratio proche de 1 (distance proche du seuil)
function repColor(distance, seuil) {
  const ratio = Math.max(0, Math.min(1, distance / seuil));
  if (ratio < 1 / 3) return COULEUR_PROCHE;
  if (ratio < 2 / 3) return COULEUR_MOYEN;
  return COULEUR_LOINTAIN;
}


window.addEventListener('error', e => {
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.debug_log(`ERROR: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  }
});

const hiddenInput = document.getElementById('hidden-input');

// Champ texte caché (hors écran, voir test.css) : seule source de vérité pour la frappe et la
// composition (accents, touches mortes) — le focus y reste en permanence.
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


const infoEl = document.getElementById('footer-info');

// PAGES : les deux conteneurs visuels gauche/droite. Le curseur/la
// sélection se dessinent dans les calques (badge-layer, sel-layer, fake-cursor) de la page qui
// contient l'index concerné.
const PAGES = ['left', 'right'].map(side => {
  const pageEl = document.querySelector(`.page[data-side="${side}"]`);
  return {
      side
    , pageEl
    , textEl:     pageEl.querySelector('.text')
    , badgeLayer: pageEl.querySelector('.badge-layer')
    , selLayer:   pageEl.querySelector('.sel-layer')
    , cursorEl:   pageEl.querySelector('.fake-cursor')
    , boundingRect: null
  };
});
const [PAGE_LEFT, PAGE_RIGHT] = PAGES;

// ── segments : table indexée par position caractère (segments[12] = le segment qui couvre le
// caractère 12) — accès direct O(1), pas de recherche. Chaque segment (mot, espace, ou retour à
// la ligne) a aussi nextSeg/prevSeg (voisin dans l'ordre de lecture, pour parcourir sans revenir à
// cette table). Construite dans buildDOM (test.js), une entrée par caractère, jamais recalculée
// séparément.
let segments = [];
// wordSegmentsList : les mots uniquement (pas les espaces/sauts), un élément par mot, dans l'ordre
// de lecture — construite EN MÊME TEMPS que segments (addSegment, dans buildDOM), pas par un
// passage de filtre séparé après coup.
let wordSegmentsList = [];

// TOKENS/indexFirstToken : seule source de vérité du texte affiché, niveau module pour que les
// fonctions d'édition (plus bas) puissent les relire/muter — pas de fullText séparé à côté
// (l'ancien système avait fullText ET paraStates comme deux vérités parallèles, jamais fiables
// l'une envers l'autre ; détruit le 2026-07-19, cf. historique).
let TOKENS = [];
// pairId -> { before: token, after: token } — reconstruite en entier à chaque computeProximities
// (debounce), consultée/tenue à jour incrémentalement par updateProximitiesAfterEdit (frappe).
let PAIR_TOKENS = new Map();
let indexFirstToken = 0;

// Horodatage réel (ms depuis le chargement de la page) sur chaque ligne de log — sert à repérer
// OÙ se situe un délai (attente IPC pywebview, promesse analyze(), boucle DOM synchrone...) sans
// avoir à deviner à partir du seul ordre des lignes.
function dlog(msg) {
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.debug_log(`[${performance.now().toFixed(0)}ms] ${msg}`);
  }
}

function logError(context, err) {
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.debug_log(`ERROR in ${context}: ${(err && err.stack) || err}`);
  }
}

// Bascule splash -> page une seule fois, appelée depuis textRender() après buildDOM().
let revealed = false;
function reveal() {
  if (revealed) return;
  revealed = true;
  document.getElementById('splash').classList.add('hidden');
  document.getElementById('pages').classList.remove('hidden');
  hiddenInput.focus();
}

function segmentAt(idx) {
  return segments[idx] ?? segments[segments.length - 1];
}

// Nœud à mesurer pour un segment-mot : son texte, ou le span lui-même s'il est vide (mot ""
// produit par split(' ') sur un double espace — span sans firstChild, sinon getCaretRect plante
// sur node.nodeType).
function wordNode(seg) { return seg.node.firstChild || seg.node; }

function charIndexToDom(idx) {
  const seg = segmentAt(idx);
  const node = seg.isWord ? wordNode(seg) : seg.node;
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

function nearestWord(fromSeg, dir) {
  let seg = fromSeg;
  while (seg) {
    if (seg.isWord) return seg;
    seg = dir > 0 ? seg.nextSeg : seg.prevSeg;
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
  const breakSeg = segments[idx];
  if (breakSeg && breakSeg.isBreak && breakSeg.start === idx) {
    const w = nearestWord(breakSeg.prevSeg, -1);
    if (w) return getCaretRect(wordNode(w), w.end - w.start);
  }
  const seg = segmentAt(idx);
  if (!seg.isWord) {
    if (idx === seg.end) {
      const w = nearestWord(seg.nextSeg, 1);
      if (w) return getCaretRect(wordNode(w), 0);
    }
    if (idx === seg.start) {
      const w = nearestWord(seg.prevSeg, -1);
      if (w) return getCaretRect(wordNode(w), w.end - w.start);
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
  const prevSeg = seg.prevSeg;
  const nextSeg = seg.nextSeg;
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

function clampIdx(idx) { return Math.max(0, Math.min(idx, segments.length)); }

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

// Page qui porte l'index donné (celle du paraState du paragraphe contenant idx).
function pageForIdx(idx) {
  const node = segmentAt(idx).node;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const pageEl = el.closest('.page');
  return PAGES.find(p => p.pageEl === pageEl) || PAGE_LEFT;
}

function renderCursor() {
  const rect     = rectForIndex(cursorIdx);
  const page     = pageForIdx(cursorIdx);
  const pageRect = page.pageEl.getBoundingClientRect();
  PAGES.forEach(p => { if (p !== page) p.cursorEl.style.display = 'none'; });
  const cursorEl = page.cursorEl;
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
  PAGES.forEach(p => { p.selLayer.innerHTML = ''; });
  if (anchorIdx === null || anchorIdx === cursorIdx) return;
  const from = Math.min(anchorIdx, cursorIdx);
  const to   = Math.max(anchorIdx, cursorIdx);
  const a = charIndexToDom(from), b = charIndexToDom(to);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  // La sélection peut chevaucher les deux pages (ancre à gauche, curseur à droite) : chaque
  // rectangle de la Range est routé vers la page qu'il recouvre horizontalement, pas vers une
  // page unique fixe.
  Array.from(range.getClientRects()).forEach(r => {
    const page = PAGES.find(p => {
      const pr = p.pageEl.getBoundingClientRect();
      return r.left >= pr.left - 1 && r.left < pr.right + 1;
    }) || PAGE_LEFT;
    const pageRect = page.pageEl.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'sel-box';
    box.style.left   = (r.left   - pageRect.left) + 'px';
    box.style.top    = (r.top    - pageRect.top)  + 'px';
    box.style.width  = r.width  + 'px';
    box.style.height = r.height + 'px';
    page.selLayer.appendChild(box);
  });
}

function render(info) {
  renderCursor();
  renderSelection();
  if (info) infoEl.textContent = info;
}

// silentPairs=true : ne touche pas à l'exergue (cursorPairIds) — sert au réaffichage du curseur
// après un rebuild où la position n'a pas réellement bougé sous l'action de l'utilisateur, pour
// ne pas allumer une proximité que personne n'a cliquée.
function setCursor(idx, keepAnchor, silentPairs) {
  cursorIdx = clampIdx(idx);
  if (!keepAnchor) anchorIdx = null;
  render(`position ${cursorIdx} — ${describePosition(cursorIdx)}` + (anchorIdx !== null ? ` — sélection [${Math.min(anchorIdx, cursorIdx)}, ${Math.max(anchorIdx, cursorIdx)})` : ''));
  if (!silentPairs && APP_SETTINGS.exergue_prox_when_cursor_in_mot) updateCursorPairs();
  logCursor();
}

const DEBUG_LOG_ENABLED = false; // coupé temporairement pour tester si debug_log cause le lag flèches

function logCursor() {
  if (!DEBUG_LOG_ENABLED) return;
  if (!(window.pywebview && window.pywebview.api)) return;
  const rect    = rectForIndex(cursorIdx);
  const pageRect = pageForIdx(cursorIdx).pageEl.getBoundingClientRect();
  window.pywebview.api.debug_log(
    `idx=${cursorIdx} rect(left=${Math.round(rect.left - pageRect.left)},top=${Math.round(rect.top - pageRect.top)},bottom=${Math.round(rect.bottom - pageRect.top)}) anchor=${anchorIdx}`
  );
}

// ── Mots : bornes pour Alt+flèche (mot par mot) ───────────────────────────────────────────────
function wordSegments() { return wordSegmentsList; }

// ── Ligne visuelle (pour Home/End) : mots qui partagent le même haut de rectangle que idx ────
function lineBoundsAt(idx) {
  const top = rectForIndex(idx).top;
  let from = null, to = null;
  wordSegments().forEach(s => {
    const r = getCaretRect(wordNode(s), 0);
    if (Math.abs(r.top - top) < 3) {
      if (from === null) from = s.start;
      to = s.end;
    }
  });
  if (from === null) return { from: 0, to: segments.length };
  return { from, to };
}

function lineBoundsAtTop(top) {
  let from = null, to = null;
  wordSegments().forEach(s => {
    const r = getCaretRect(wordNode(s), 0);
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
    const r = getCaretRect(wordNode(s), 0);
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
  let s = segmentAt(idx);
  while (s.prevSeg && !s.prevSeg.isBreak) s = s.prevSeg;
  let e = segmentAt(idx);
  while (e.nextSeg && !e.nextSeg.isBreak) e = e.nextSeg;
  return { from: s.start, to: e.end };
}

function nextWordBoundary(idx, dir) {
  const ws = wordSegments();
  if (dir > 0) {
    for (const s of ws) if (s.start > idx) return s.start;
    return segments.length;
  } else {
    let prev = 0;
    for (const s of ws) { if (s.start >= idx) break; prev = s.start; }
    return prev;
  }
}

// ── Édition ────────────────────────────────────────────────────────────────────────────────
// Pas de fullText persistant (cf. commentaire sur TOKENS/indexFirstToken plus haut) : chaque
// frappe dérive une string TEMPORAIRE depuis TOKENS, la modifie, la retokenise entièrement
// (localTokenize), puis rebuild tout via prepareTokens+buildDOM — TOKENS reste l'unique vérité,
// la string ne survit jamais entre deux frappes. Canon = minuscule du mot (pas de vraie
// lemmatisation spaCy ici, cf. décision utilisateur 2026-07-19 : pas la priorité du jour).
let _localTokenId = -1;
function localTokenize(text) {
  const tokens = [];
  const paras = text.split('\n');
  paras.forEach((paraText, pi) => {
    const words = paraText.split(' ');
    words.forEach((forme, wi) => {
      tokens.push({
        i: _localTokenId--, m: forme, w: forme.length,
        s: wi < words.length - 1 ? ' ' : '', t: true, c: forme.toLowerCase(), x: false
      });
    });
    if (pi < paras.length - 1) {
      tokens.push({ i: _localTokenId--, m: '\n', w: 1, s: '', t: false, c: null, x: false });
    }
  });
  return tokens;
}

// ── Patch local instantané (lightInsertChar/lightDeleteChar) : lettre ou espace ajouté/retiré
// À L'INTÉRIEUR d'un token existant — un seul span.textContent modifié, tout le reste juste
// décalé, AUCUN buildDOM, aucun retokenize. Rien d'autre pour l'instant (2026-07-19, décision
// utilisateur) : le débounce plein-document a été retiré (il détruisait le texte à chaque
// recalcul, cf. captures "avant/après") — les cas structurels (retour ligne, sélection, fusion
// de mots en bord de token) ne sont pas encore branchés, à reprendre plus tard, pas à pas.

function shiftAfter(seg, delta) {
  for (let s = seg.nextSeg; s; s = s.nextSeg) { s.start += delta; s.end += delta; }
}
function shiftTokensAfter(token, delta) {
  for (let k = token.idx + 1; k < TOKENS.length; k++) {
    TOKENS[k].o += delta;
    if (TOKENS[k].t) TOKENS[k].om += delta;
  }
}

function removePairBadges(pairId) {
  if (!pairId) return;
  document.querySelectorAll(`.badge[data-pair="${pairId}"]`).forEach(el => el.remove());
  PAIR_TOKENS.delete(pairId);
}
function updateBadgeValue(pairId, newDist, seuil) {
  document.querySelectorAll(`.badge[data-pair="${pairId}"]`).forEach(el => {
    el.textContent = newDist;
    el.style.setProperty('--badge-rgb', repColor(newDist, seuil).join(','));
  });
}

// Paires à cheval sur le point d'édition xo (un membre avant, l'autre après) : seule leur
// distance change, de delta — rien d'autre ne bouge. Bornage : SEUIL_DEFAUT, le plus grand
// seuil existant, aucune paire valide ne peut être plus loin en arrière. Aucun rebuild, aucune
// mesure DOM — juste ajout/retrait/valeur des badges concernés. fromIdx : dernier index TOKENS
// à considérer (inclus) pour la recherche vers l'arrière.
function shiftStraddlingPairs(xo, delta, fromIdx) {
  for (let k = fromIdx; k >= 0; k--) {
    const t = TOKENS[k];
    if (t.o < xo - SEUIL_DEFAUT) break;
    if (!t.aftPair) continue;
    const pair = PAIR_TOKENS.get(t.aftPair);
    if (!pair || pair.after.o <= xo) continue; // partenaire pas après le point d'édition : intact
    const newDist = t.aft + delta;
    if (newDist >= t.aftSeuil) {
      removePairBadges(t.aftPair);
      t.aft = t.aftPair = undefined;
      pair.after.bef = pair.after.befPair = undefined;
    } else {
      t.aft = newDist;
      pair.after.bef = newDist;
      updateBadgeValue(t.aftPair, newDist, t.aftSeuil);
    }
  }
}

// À chaque frappe (pas au débounce) : le mot édité a changé de canon, sa/ses proximité(s)
// tombent (une proximité est une PAIRE — les deux badges disparaissent, pas juste le sien).
function updateProximitiesAfterEdit(editedToken, delta) {
  removePairBadges(editedToken.befPair);
  removePairBadges(editedToken.aftPair);
  editedToken.bef = editedToken.aft = editedToken.befPair = editedToken.aftPair = undefined;
  shiftStraddlingPairs(editedToken.o, delta, editedToken.idx - 1);
}

// str : un seul caractère (lettre ou espace, jamais '\n' — pas de rendu visuel de retour ligne
// dans un span). Insertion DANS un token (segmentAt(cursorIdx) le couvre) ou juste APRÈS
// (cursorIdx == seg.end : cas le plus courant, taper la suite d'un mot déjà commencé).
function lightInsertChar(str) {
  let seg = segmentAt(cursorIdx);
  if (!seg || !seg.isWord) {
    seg = cursorIdx > 0 ? segments[cursorIdx - 1] : null;
    if (!seg || !seg.isWord || seg.end !== cursorIdx) return false;
  }
  const localPos = cursorIdx - seg.start;
  const oldText  = seg.node.textContent;
  const newText  = oldText.slice(0, localPos) + str + oldText.slice(localPos);
  seg.node.textContent = newText;
  seg.token.m = newText;
  seg.token.w += str.length;
  seg.end += str.length;
  shiftAfter(seg, str.length);
  shiftTokensAfter(seg.token, str.length);
  updateProximitiesAfterEdit(seg.token, str.length);
  segments.splice(cursorIdx, 0, ...Array(str.length).fill(seg));
  return true;
}

// Le token disparaît entièrement (son dernier caractère vient d'être retiré) : retire aussi son
// espace suivant (token.s), sinon double espace visible — "un mot ici" - "mot" doit donner
// "un ici", pas "un  ici". Décale/réindexe tout ce qui suit (TOKENS a perdu une entrée : idx de
// chaque token après doit reculer d'un cran, pas seulement o/om).
function removeEmptyToken(seg) {
  const token = seg.token;
  const hasSpaceSeg = token.s.length > 0;
  const removedChars = 1 + token.s.length;

  updateProximitiesAfterEdit(token, -removedChars); // retire ses paires, ajuste celles à cheval

  shiftAfter(seg, -removedChars);
  for (let k = token.idx + 1; k < TOKENS.length; k++) {
    TOKENS[k].o -= removedChars;
    if (TOKENS[k].t) TOKENS[k].om -= removedChars;
    TOKENS[k].idx -= 1;
  }

  const spaceSeg = hasSpaceSeg ? seg.nextSeg : null;
  const after    = hasSpaceSeg ? spaceSeg.nextSeg : seg.nextSeg;
  seg.node.remove();
  if (spaceSeg) spaceSeg.node.remove();
  if (seg.prevSeg) seg.prevSeg.nextSeg = after;
  if (after) after.prevSeg = seg.prevSeg;

  segments.splice(seg.start, removedChars);
  const wi = wordSegmentsList.indexOf(seg);
  if (wi !== -1) wordSegmentsList.splice(wi, 1);
  TOKENS.splice(token.idx, 1);
}

// Retire un caractère d'un segment ESPACE (celui qui suit un mot, token.s) — aucun canon ne
// change (aucun mot touché), donc aucune paire propre à supprimer : seules les paires à cheval
// sur ce point peuvent voir leur distance changer (cf. shiftStraddlingPairs).
function lightDeleteSpaceChar(seg, atIdx) {
  if (seg.isBreak) return false; // saut de paragraphe, pas un espace — structurel, pas géré ici
  const ownerSeg = seg.prevSeg;
  if (!ownerSeg || !ownerSeg.isWord) return false; // sécurité : un espace suit toujours un token
  const token = ownerSeg.token;
  const localPos = atIdx - seg.start;
  token.s = token.s.slice(0, localPos) + token.s.slice(localPos + 1);
  seg.end -= 1;

  shiftStraddlingPairs(atIdx, -1, token.idx);
  shiftAfter(seg, -1);
  shiftTokensAfter(token, -1);

  if (seg.end - seg.start <= 0) {
    // plus aucun caractère : le segment espace disparaît entièrement (cas normal, un seul
    // espace entre deux mots).
    seg.node.remove();
    const after = seg.nextSeg;
    ownerSeg.nextSeg = after;
    if (after) after.prevSeg = ownerSeg;
  } else {
    // espaces multiples tapés : il en reste, juste raccourci d'un caractère.
    seg.node.textContent = token.s;
  }
  segments.splice(atIdx, 1);
  return true;
}

// atIdx : position du caractère à retirer.
function lightDeleteChar(atIdx) {
  const seg = segments[atIdx];
  if (!seg) return false;
  if (!seg.isWord) return lightDeleteSpaceChar(seg, atIdx);
  if (seg.end - seg.start <= 1) {
    removeEmptyToken(seg);
    return true;
  }
  const localPos = atIdx - seg.start;
  const newText = seg.node.textContent.slice(0, localPos) + seg.node.textContent.slice(localPos + 1);
  seg.node.textContent = newText;
  seg.token.m = newText;
  seg.token.w -= 1;
  seg.end -= 1;
  shiftAfter(seg, -1);
  shiftTokensAfter(seg.token, -1);
  updateProximitiesAfterEdit(seg.token, -1);
  segments.splice(atIdx, 1);
  return true;
}

function noSelection() { return anchorIdx === null || anchorIdx === cursorIdx; }

// Masque tous les badges dès la première frappe, les réaffiche après un temps sans frappe
// (laps_before_recal_prox) — juste un toggle visuel (classe #pages.editing, cf. test.css),
// indépendant de tout recalcul : les valeurs/positions sous-jacentes restent celles déjà à jour
// via updateProximitiesAfterEdit, seul l'AFFICHAGE est temporairement coupé.
let badgeHideTimer = null;
function scheduleBadgeHide() {
  document.getElementById('pages').classList.add('editing');
  clearTimeout(badgeHideTimer);
  badgeHideTimer = setTimeout(() => {
    badgeHideTimer = null;
    document.getElementById('pages').classList.remove('editing');
  }, (APP_SETTINGS.laps_before_recal_prox ?? 3) * 1000);
}

// Cas structurels (retour ligne, sélection, fusion de mots en bord de token) : pas encore
// branchés (cf. commentaire plus haut) — ne font rien pour l'instant, à reprendre pas à pas.

function insertText(str) {
  if (noSelection() && str !== '\n' && lightInsertChar(str)) {
    setCursor(cursorIdx + str.length, false);
    scheduleBadgeHide();
  }
}

function insertParagraphBreak() {
}

function backspace() {
  if (noSelection() && cursorIdx > 0 && lightDeleteChar(cursorIdx - 1)) {
    setCursor(cursorIdx - 1, false);
    scheduleBadgeHide();
  }
}

function deleteForward() {
  if (noSelection() && lightDeleteChar(cursorIdx)) {
    setCursor(cursorIdx, false);
    scheduleBadgeHide();
  }
}

// ── Exergue proximité : curseur dans un mot en proximité => opacité 1 (CSS .badge.active) sur
// son badge ET son partenaire (même data-pair). Rien au survol de la souris (décision utilisateur
// 2026-07-16 : le survol faisait tout apparaître dès qu'on bouge la souris, non voulu — seul le
// déplacement du curseur texte, donc un clic ou les flèches, déclenche l'exergue). Par défaut,
// opacité faible pour tous les badges (cf. test.css .badge). Un mot peut avoir un pair AVANT et
// un pair APRÈS en même temps (occurrences successives du même canon) : les deux s'allument.
let cursorPairIds = new Set();

function refreshActivePairs() {
  const ids = cursorPairIds;
  document.querySelectorAll('.badge.active').forEach(el => {
    if (!ids.has(el.dataset.pair)) el.classList.remove('active');
  });
  ids.forEach(id => {
    document.querySelectorAll(`.badge[data-pair="${id}"]`).forEach(el => el.classList.add('active'));
  });
  document.getElementById('pages').classList.toggle('has-exergue', ids.size > 0);
}

function updateCursorPairs() {
  const seg = segmentAt(cursorIdx);
  cursorPairIds = new Set();
  if (seg.isWord && seg.token) {
    if (seg.token.befPair) cursorPairIds.add(seg.token.befPair);
    if (seg.token.aftPair) cursorPairIds.add(seg.token.aftPair);
  }
  refreshActivePairs();
}

// ── Souris : clic simple, glissé, Maj+clic, double-clic, triple-clic ─────────────────────────
let lastClick = { time: 0, idx: -1, count: 0 };

PAGES.forEach(page => {
  // Clic sur un badge : allume ce badge ET son partenaire (même data-pair), sans déplacer le
  // curseur texte (un badge n'est pas une position dans le texte). `.badge-layer` a
  // pointer-events:none mais `.badge` le réactive individuellement (cf. test.css) — l'évènement
  // remonte normalement jusqu'ici par bubbling, indépendamment de la valeur sur les ancêtres.
  page.badgeLayer.addEventListener('mousedown', e => {
    if (!e.target.classList.contains('badge') || !e.target.dataset.pair) return;
    const pair = e.target.dataset.pair;
    // Toggle : recliquer le badge déjà en exergue l'éteint, au lieu de le rallumer à l'identique.
    cursorPairIds = cursorPairIds.has(pair) ? new Set() : new Set([pair]);
    refreshActivePairs();
  });

  page.textEl.addEventListener('mousedown', e => {
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

  page.textEl.addEventListener('mousemove', e => {
    if (!dragging) return;
    const idx = indexAtPoint(e.clientX, e.clientY);
    if (idx === null) return;
    setCursor(idx, true);
  });
});

document.addEventListener('mouseup', () => { dragging = false; });

function validateCorrection() {
  // Pas encore implémenté — juste le branchement de la touche pour l'instant.
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.debug_log('Tab : validation (pas encore implémentée)');
  }
}

// Déplace le curseur à idx, étend la sélection depuis anchorIdx si extend=true.
function moveTo(idx, extend) {
  if (extend) { if (anchorIdx === null) anchorIdx = cursorIdx; setCursor(idx, true); }
  else setCursor(idx, false);
}

// Touches gérées par le listener keydown ci-dessous, une méthode par touche — meta+flèche saute
// en bord de ligne/paragraphe, sinon déplacement normal (mot entier si alt). meta+toute autre
// touche de cette table n'est PAS interceptée (cf. garde meta dans le listener) : laisse passer
// les raccourcis natifs (Cmd+Backspace, Cmd+Entrée...).
const METHOD_ON_KEY = {
  ArrowLeft:  (shift, alt, meta) => moveTo(meta ? lineBoundsAt(cursorIdx).from : (alt ? nextWordBoundary(cursorIdx, -1) : visualStep(cursorIdx, -1)), shift),
  ArrowRight: (shift, alt, meta) => moveTo(meta ? lineBoundsAt(cursorIdx).to   : (alt ? nextWordBoundary(cursorIdx, 1)  : visualStep(cursorIdx, 1)),  shift),
  ArrowUp:    (shift, alt, meta) => moveTo(meta ? paragraphBoundsAt(cursorIdx).from : moveVertical(cursorIdx, -1), shift),
  ArrowDown:  (shift, alt, meta) => moveTo(meta ? paragraphBoundsAt(cursorIdx).to   : moveVertical(cursorIdx, 1),  shift),
  Home:       (shift) => { if (shift && anchorIdx === null) anchorIdx = cursorIdx; setCursor(lineBoundsAt(cursorIdx).from, shift); },
  End:        (shift) => { if (shift && anchorIdx === null) anchorIdx = cursorIdx; setCursor(lineBoundsAt(cursorIdx).to, shift); },
  Backspace:  () => backspace(),
  Delete:     () => deleteForward(),
  Enter:      () => insertParagraphBreak(),
  Tab:        () => validateCorrection(),
};
const META_ALLOWED_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

// ── Clavier : navigation + édition ────────────────────────────────────────────────────────────
// Le champ caché (hiddenInput) est la seule source de vérité pour la frappe/composition — il
// garde le focus en permanence ; ce listener ne gère que les touches de contrôle (navigation,
// suppression, validation). Les touches "normales" ne sont pas interceptées ici : on les laisse
// atteindre hiddenInput normalement (composition comprise), récupérées ensuite via ses écouteurs
// 'input'/'compositionend'.
document.addEventListener('keydown', e => {
  if (document.activeElement !== hiddenInput) hiddenInput.focus();

  const method = METHOD_ON_KEY[e.key];
  if (!method) return;
  if (e.metaKey && !META_ALLOWED_KEYS.has(e.key)) return;

  method(e.shiftKey, e.altKey, e.metaKey);
  e.preventDefault();
});

// ── Départ ─────────────────────────────────────────────────────────────────────────────────
// Texte réel (assets/texte-modele.txt via load_window()) — point d'entrée exclusif via
// `python -m app.test_pywebview` (cf. son docstring), toujours lancé avec pywebview.

/*- Point d'entrée -*/
function textRender() {
  logJS('textRender: appel load_window')
  window.pywebview.api.load_window().then(({ TOKENS: loaded, total_chars, firstTokenId }) => {
    logJS(`textRender: load_window resolu, ${loaded.length} tokens, firstTokenId=${firstTokenId}`)
    ;[TOKENS, indexFirstToken] = prepareTokens(loaded, firstTokenId)
    logJS(`textRender: prepareTokens fait, indexFirstToken=${indexFirstToken}`)
    buildDOM(TOKENS, indexFirstToken)
    logJS('textRender: buildDOM fait')
    reveal()
    logJS('textRender: reveal fait')
  }).catch(err => logJSError('JS textRender:', err))
}

// Offsets (token.o/om) uniquement — pas touche aux proximités/badges.
function computeOffsets(TOKENS, firstTokenId) {
  let pos = 0, posMot = 0;
  let indexFirstToken;
  TOKENS.forEach((token, idx) => {
    if (token.i == firstTokenId) indexFirstToken = idx
    token.idx = idx
    token.o = pos
    const twidth = token.w + token.s.length
    pos += twidth
    if (!token.t) return // ponctuation
    token.om = posMot
    posMot += twidth
  })
  // Après une frappe, les tokens retokenisés localement (cf. localTokenize) ont des id
  // synthétiques qui ne matchent jamais firstTokenId — indexFirstToken resterait undefined,
  // buildDOM ne rendrait alors plus rien. Repli sur 0 : pas de navigation de fenêtre pendant
  // l'édition de toute façon (cf. commentaire plus bas, "Pas de navigation pour l'instant").
  if (indexFirstToken === undefined) indexFirstToken = 0
  return indexFirstToken
}

// Proximités/badges (bef/aft/pair) — calcul complet, coûteux à faire à chaque frappe. Appelé
// seulement au chargement initial (prepareTokens) ; en édition, cf. updateProximitiesAfterEdit
// (mise à jour incrémentale, pas de recalcul complet).
function computeProximities(TOKENS) {
  let pairCounter = 0;
  PAIR_TOKENS = new Map();
  const parCanon = new Map(); // canon -> { seuil, last }
  TOKENS.forEach(token => {
    if (!token.t || token.x) return // ponctuation ou ignoré

    const entry = parCanon.get(token.c)
    if (entry) {
      // canon déjà rencontré : vérifie la proximité avec son dernier token
      let dist
      if ((dist = token.om - entry.last.om) < entry.seuil) {
        const pairId = ++pairCounter
        entry.last.aft = dist
        entry.last.aftSeuil = entry.rawSeuil
        entry.last.aftPair = pairId
        token.bef = dist
        token.befSeuil = entry.rawSeuil
        token.befPair = pairId
        PAIR_TOKENS.set(pairId, { before: entry.last, after: token })
      }
      entry.last = token // dernier de son canon
    } else {
      // premier token du canon : crée le canon, enregistre son seuil (seuil : +1 pour que la
      // comparaison < ci-dessus se comporte comme <=. rawSeuil : valeur réelle, pour la couleur).
      const rawSeuil = SEUIL_PER_CANON[token.c] ?? SEUIL_DEFAUT
      parCanon.set(token.c, { seuil: rawSeuil + 1, rawSeuil, last: token });
    }
  })
}

function prepareTokens(TOKENS, firstTokenId){
  const indexFirstToken = computeOffsets(TOKENS, firstTokenId)
  computeProximities(TOKENS)
  return [TOKENS, indexFirstToken]
}

/**
 * 
 * ==================================================================
 * 
 *          GRANDE FONCTION DE CONSTRUCTION DU DOM 
 * 
 * ==================================================================
 */
function buildDOM(TOKENS /* préparés */, tokenIdx /* first token index */){

  // DOMRect (getBoundingClientRect) a ses champs en accesseurs sur le prototype, pas en
  // propriétés propres — {...r} donne {} et toute mutation directe (r.left += x) jette en
  // strict mode. D'où cette copie manuelle en objet plain mutable.
  function spreadRect(r) {
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }

  function buildNewParagraph() {
    return Div('para', CURRENT_PAGE.textEl)
  }
  function buildNewTokenSpan(params){
    return Span('word', params.in, params.content)
  }
  function currentBottom(page){
    return 0 + page.pageEl.getBoundingClientRect().bottom
  }
  // Relie seg au précédent (nextSeg/prevSeg) et remplit la table segments[start..end[ (borne end
  // exclue : la frontière appartient au segment SUIVANT, jamais aux deux à la fois).
  let prevSegment = null
  function addSegment(seg) {
    if (prevSegment) { prevSegment.nextSeg = seg; seg.prevSeg = prevSegment }
    for (let i = seg.start; i < seg.end; i++) segments[i] = seg
    if (seg.isWord) wordSegmentsList.push(seg)
    prevSegment = seg
  }
  function buildNewBadge(params){
    const b = Div('badge', params.page.badgeLayer)
    b.textContent = params.value
    b.style.left = px(params.left)
    b.style.top  = px(params.top)
    b.style.setProperty('--badge-rgb', repColor(params.value, params.seuil).join(','))
    b.dataset.pair = params.pair
    return b
  }

  function initCurrentPage(page){
    // .page a une hauteur CSS auto (grandit avec son contenu, cf. commentaire sur #pages) — sans
    // hauteur fixée ici, getBoundingClientRect().bottom mesuré une fois avant tout contenu (juste
    // en dessous) donnait un plancher minuscule, dépassé dès la 2e ligne. #pages, lui, est borné
    // par le flex layout du body (flex:1 1 auto + min-height:0) donc sa hauteur est déjà la bonne
    // cible, indépendante du contenu de .page.
    page.pageEl.style.height = px(document.getElementById('pages').clientHeight)
    page.boundingRect = page.pageEl.getBoundingClientRect()
    page.left = page.boundingRect.left
    page.isRight = (page.side == 'right')
    page.rightLimit = page.pageEl.clientWidth - parseFloat(getComputedStyle(page.pageEl).paddingRight)
    // Seuil dernier 1/5 de page, calculé une fois par page (pas par mot) : au-delà, on réserve
    // systématiquement la place d'un badge (28px, cf. CSS .badge) même si CE mot n'en a pas —
    // un badge peut apparaître sur n'importe quel mot de la ligne, l'utilisateur ne peut pas
    // savoir si une ligne coupée court manque un badge invisible.
    page.bottom = currentBottom(page)
    page.nearBottom = page.boundingRect.top + (page.bottom - page.boundingRect.top) * 4 / 5
    return page
  }

  // Nettoyage — badgeLayer aussi : sinon chaque rebuild (debounce de badges compris) EMPILE un
  // nouveau jeu de badges sur les précédents, jamais retirés (constaté 2026-07-19, badges
  // accumulés à des positions figées d'avant édition, "n'importe où" à l'écran).
  PAGE_LEFT.textEl.innerHTML = ''
  PAGE_RIGHT.textEl.innerHTML = ''
  PAGE_LEFT.badgeLayer.innerHTML = ''
  PAGE_RIGHT.badgeLayer.innerHTML = ''
  segments = []
  wordSegmentsList = []

  // On commence sur la page gauche
  let CURRENT_PAGE = initCurrentPage(PAGE_LEFT)
  let currentParagraph = buildNewParagraph()
  let badgeX = 0, prevTop = null // décalage porté d'un mot à l'autre sur la même ligne (anti-chevauchement badge)
  let hauteur_de_badge = null // diff entre bottom de span mot et bottom du badge

  /* -----------------------------------------------------*/
  /*                                                      */
  /* ---          BOUCLE SUR TOUS LES TOKENS          --- */
  /*                                                      */
  /* -----------------------------------------------------*/

  for (let len = TOKENS.length; tokenIdx < len; ++tokenIdx) {
    const token = TOKENS[tokenIdx]

    if (token.m === '\n') {
      addSegment({node: currentParagraph, start: token.o, end: token.o + 1, isWord: false, isBreak: true})
      currentParagraph = buildNewParagraph()
      badgeX = 0; prevTop = null
      continue
    }

    // Construction du SPAN pour le token — placement calqué sur placeWordAt (test.js.bak:85-144,
    // algo de référence pixel-perfect) : jusqu'à 2 tentatives (ligne courante, puis ligne
    // suivante si dépassement), un seul marginLeft posé à la fin, remesure DOM après (jamais de
    // patch manuel de rect).
    const span = buildNewTokenSpan({content: token.m, in: currentParagraph})
    addSegment({node: span, start: token.o, end: token.o + token.w, isWord: true, token})
    let rect, naturalX, wordX, beforeBadge = null, afterBadge = null
    for (let attempt = 0; attempt < 2; attempt++) {
      rect = spreadRect(span.getBoundingClientRect())
      // Reset sur wrap (naturel CSS ou forcé) : badgeX ne vaut que "sur la même ligne".
      if (prevTop !== null && Math.round(rect.top) !== Math.round(prevTop)) {
        badgeX = 0
      }
      prevTop = rect.top
      naturalX = rect.left - CURRENT_PAGE.left
      // badgeX (réservation laissée par le badge après du mot précédent) ne s'applique QUE si
      // CE token a lui-même un badge avant à placer — sinon rien n'est ajouté, le mot est à sa
      // place naturelle (décision utilisateur 2026-07-19 : pas d'héritage de réservation entre
      // mots sans rapport). Ponctuation : jamais concernée non plus (décision 2026-07-18).
      const actualX = (token.t && token.bef) ? Math.max(naturalX, badgeX) : naturalX
      wordX = actualX
      if ( token.bef ) {
        // <= Le token a une proximité avant : badge posé à actualX, mot recentré derrière lui
        beforeBadge = buildNewBadge({
          value: token.bef, page: CURRENT_PAGE, seuil: token.befSeuil, pair: token.befPair,
          left: actualX, top: rect.bottom - CURRENT_PAGE.boundingRect.top + 2
        })
        const bw = beforeBadge.getBoundingClientRect().width
        const mid = actualX + bw + GAP / 4
        wordX = Math.max(naturalX, mid - rect.width / 2)
      }
      if ( wordX + rect.width > CURRENT_PAGE.rightLimit && attempt === 0 ) {
        // Badge ou mot dépasse => passage à la ligne forcé, on retente sur la ligne suivante
        if (beforeBadge) { CURRENT_PAGE.badgeLayer.removeChild(beforeBadge); beforeBadge = null }
        span.style.marginLeft = '0px'
        currentParagraph.insertBefore(Br(), span)
        badgeX = 0; prevTop = null
        continue
      }
      break
    }
    span.style.marginLeft = px(wordX - naturalX)
    rect = spreadRect(span.getBoundingClientRect())

    if ( token.aft ) {
      // <= Le token a une proximité après : badge posé au centre du mot (position finale, post-marginLeft)
      const centerX = (rect.left - CURRENT_PAGE.left) + rect.width / 2
      afterBadge = buildNewBadge({
        value: token.aft, page: CURRENT_PAGE, seuil: token.aftSeuil, pair: token.aftPair,
        left: centerX + GAP / 4, top: rect.bottom - CURRENT_PAGE.boundingRect.top + 2
      })
      const br = afterBadge.getBoundingClientRect()
      badgeX = Math.round(br.right - CURRENT_PAGE.left) + BADGE_GAP
    }
    var spanBottom = rect.bottom

    // Extra-space après le mot
    if (token.s) {
      const spaceNode = document.createTextNode(token.s)
      currentParagraph.appendChild(spaceNode)
      addSegment({node: spaceNode, start: token.o + token.w, end: token.o + token.w + token.s.length, isWord: false})
    }
    

    // On arrive en bas de page, on peut checker la proximité
    // de la marge (avant, calcul inutile)
    if ( spanBottom > CURRENT_PAGE.nearBottom ) {
      if ( null === hauteur_de_badge /* ~ 28 */) {
        // Il faut calculer la hauteur de badge en prenant le premier
        // en exemple (attention : valeur par défaut, car il peut n'y 
        // avoir aucun badge)
        // Autre manière (mais j'aime moins bien car il faut faire le
        // test sur chaque badge : prendre le premier badge à la cons-
        // truction ci-dessus)
        const unBadge = beforeBadge || afterBadge
        hauteur_de_badge = unBadge
          ? Math.round(unBadge.getBoundingClientRect().bottom - rect.bottom)
          : 28
      }
      if (spanBottom > CURRENT_PAGE.bottom - hauteur_de_badge) {
        if ( CURRENT_PAGE.isRight) {
          return true // FIN TEXTE LONG
        } else {
          // Passer à la  page droite
          CURRENT_PAGE = initCurrentPage(PAGE_RIGHT)
          currentParagraph = buildNewParagraph()
          badgeX = 0; prevTop = null
        }
      }
    }

  }
  const words = document.querySelectorAll('.word')
  const paras = document.querySelectorAll('.para')
  const tops = Array.from(words).map(w => w.getBoundingClientRect().top)
  logJS(`buildDOM: ${words.length} mots, ${paras.length} paragraphes, top premier=${tops[0]}, top dernier=${tops[tops.length - 1]}, tops distincts=${new Set(tops).size}`)
  return true // FIN TEXTE COURT
} // /buildDOM



function Div(css, container, content){
  const p = document.createElement('DIV')
  p.className = css
  container.appendChild(p)
  return p
}
function Span(css, container, content){
  const s = document.createElement('SPAN')
  s.className = css
  s.textContent = content
  container.appendChild(s)
  return s
}
function Br(params){
  const br = document.createElement('BR')
  params?.in?.appendChild(br)
  return br
}
function px(nombre) { return String(nombre) + 'px' }













function logJS(msg) {
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.debug_log(`JS: ${msg}`)
  } else {
    console.log(msg)
  }
}
function logJSError(prefix, err) {
  const msg = `${prefix} ${err && err.stack ? err.stack : err}`
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.debug_log(msg)
  } else {
    console.error(msg)
  }
}
window.addEventListener('error', (e) => logJSError('JS window.onerror:', e.error || e.message))
window.addEventListener('unhandledrejection', (e) => logJSError('JS unhandledrejection:', e.reason))

function loadSettingsThenRender() {
  window.pywebview.api.get_settings().then(s => {
    APP_SETTINGS = s;
    textRender();
  }).catch(err => logJSError('JS get_settings:', err))
}

if (window.pywebview && window.pywebview.api) {
  loadSettingsThenRender();
} else {
  window.addEventListener('pywebviewready', loadSettingsThenRender);
}
