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


// fullText : la fenêtre ENTIÈRE reçue de load_window() (7200 tokens, cf. test_pywebview.py) — plus
// de split visible/caché (VISIBLE_LEN/hiddenTail supprimés 2026-07-17). Construction DOM en 2
// passes (cf. merde_claude_buildTokenIndex/merde_claude_rebuildDOM) : la passe 1 calcule offsets+proximités sur toute la
// fenêtre AVANT tout rendu (un before/after peut référencer un mot hors de ce qui tiendra à
// l'écran) ; la passe 2 construit le DOM depuis le premier mot et remplit jusqu'à ce qu'il n'y ait
// plus de place (merde_claude_clipOverflowParagraphs, déjà existant, décide seul ce qui reste visible).
let fullText = '';

const infoEl = document.getElementById('footer-info');

// Position dans le livre entier (pageline du footer) — connue une seule fois au chargement
// (load_window() renvoie total_chars/start_offset), pas de navigation pour l'instant donc pas de
// raison qu'elle change en cours de session (cf. app/static/prox.js d'origine, jamais branché
// dans test.html jusqu'ici).
let windowTotalChars  = 0;
let windowStartOffset = 0;

// PAGES : les deux conteneurs visuels gauche/droite. Un paragraphe entier de fullText est toujours
// rendu dans l'un OU l'autre, jamais coupé en deux — cf. merde_claude_computeSplitParaIndex. Le curseur/la
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

// paraStates : suivi persistant, paragraphe par paragraphe puis mot par mot, du dernier rendu —
// permet à merde_claude_rebuildDOM de ne retoucher que le paragraphe réellement affecté par une frappe (ni les
// autres paragraphes, ni leurs badges), au lieu de tout redétruire à chaque frappe.
let paraStates = []; // [{ paraEl, wordState: [{span, spaceEl, beforeEl, afterEl, text, naturalX, _badgeXAfter}] }]

function merde_claude_placeWordAt(page, paraEl, span, w, start, badgeXIn, prevTopIn, token, pageRect, rightLimit) {
  // Place un mot (span déjà dans le DOM) : badge avant, décalage, badge après, retour à la ligne
  // forcé si besoin. Retourne { badgeX, prevTop } à transmettre au mot suivant.
  // rightLimit est la largeur de LA PAGE qui porte ce paragraphe (page.pageEl), pas une largeur
  // globale — chaque page gauche/droite a sa propre limite de ligne.
  // pageRect/rightLimit calculés UNE FOIS par appelant (merde_claude_syncParagraph), pas ici : le conteneur
  // .page ne bouge pas pendant qu'on place les mots un par un — recalculer sa geometrie à chaque
  // mot (getBoundingClientRect + getComputedStyle, 2 layouts forcés) est un recalcul identique
  // répété inutilement à chaque mot (531 fois sur le texte de test).
  const badgeLayer = page.badgeLayer;
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
      beforeBadgeEl.style.setProperty('--badge-rgb', repColor(token.before, SEUIL_DEFAUT).join(','));
      if (token.beforePair) beforeBadgeEl.dataset.pair = token.beforePair;
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
    afterBadgeEl.style.setProperty('--badge-rgb', repColor(token.after, SEUIL_DEFAUT).join(','));
    if (token.afterPair) afterBadgeEl.dataset.pair = token.afterPair;
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
function merde_claude_syncParagraph(page, paraEl, oldWordState, words, tokenIdxStart, force) {
  const badgeLayer = page.badgeLayer;
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
    if (!force) {
      while (startIdx < words.length && wordState[startIdx].text === words[startIdx]) startIdx++;
      if (startIdx === words.length) return wordState; // ce paragraphe n'a pas changé
    }
  }

  // Geometrie de LA page (fixe pendant toute cette passe) : calculée une seule fois ici, transmise
  // à chaque merde_claude_placeWordAt au lieu d'être relue à chaque mot.
  const pageRect = page.pageEl.getBoundingClientRect();
  const rightLimit = page.pageEl.clientWidth - parseFloat(getComputedStyle(page.pageEl).paddingRight);

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
    const placed = merde_claude_placeWordAt(page, paraEl, span, w, 0, badgeX, prevTop, token, pageRect, rightLimit);
    const stabilized = !isFull && !force && !textChanged && Math.round(placed.naturalX) === Math.round(st.naturalX);
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

// Paragraphe (index 0-based, dans fullText.split('\n')) après lequel on bascule de la page gauche
// à la page droite. Choisi comme la frontière de paragraphe la plus proche du milieu de fullText —
// jamais un paragraphe coupé en deux entre les pages (cf. décision utilisateur 2026-07-14 : jamais
// de mot coupé, ici étendu au paragraphe pour ne pas fragmenter un seul paraEl entre deux DOM
// distincts). Un seul paragraphe total => tout à gauche, page droite vide.
function merde_claude_computeSplitParaIndex(paragraphs) {
  if (paragraphs.length <= 1) return paragraphs.length;
  const target = Math.floor(fullText.length / 2);
  let pos = 0, bestIdx = paragraphs.length, bestDist = Infinity;
  for (let i = 0; i < paragraphs.length; i++) {
    pos += paragraphs[i].length;
    const dist = Math.abs(pos - target);
    if (dist < bestDist) { bestDist = dist; bestIdx = i + 1; }
    pos += 1; // le \n
  }
  return bestIdx;
}

function merde_claude_pageForParaIndex(pi, splitIdx) { return pi < splitIdx ? PAGE_LEFT : PAGE_RIGHT; }

// force=true : retouche TOUS les paragraphes même si leur texte n'a pas changé — nécessaire après
// merde_claude_applyProximites, qui modifie les données de badge (TOKENS[i].before/after) sans jamais toucher
// fullText ; sans ce forçage, le test "texte inchangé => rien à refaire" saute silencieusement le
// placement des badges tant qu'aucune frappe n'a eu lieu sur le paragraphe concerné.
function merde_claude_rebuildDOM(force) {
  const paragraphs = fullText.split('\n');
  const splitIdx = merde_claude_computeSplitParaIndex(paragraphs);
  const sideChanged = paraStates.length === paragraphs.length &&
    paraStates.some((ps, pi) => ps.page !== merde_claude_pageForParaIndex(pi, splitIdx));

  // Nombre de caractères de fullText assignés à chaque page — sert à juger si un zoom (taille de
  // police) permettrait d'en afficher plus (cf. discussion 2026-07-16, interligne réduit pour
  // récupérer des paires actuellement hors fenêtre visible).
  const leftChars  = paragraphs.slice(0, splitIdx).join('\n').length;
  const rightChars = paragraphs.slice(splitIdx).join('\n').length;
  const nbMots = TOKENS.length;
  document.getElementById('footer-stats').textContent =
    `${nbMots} mots · ${leftChars} + ${rightChars} caractères (g/d)`;

  if (paraStates.length !== paragraphs.length || sideChanged) {
    // nombre de paragraphes différent (premier chargement, Entrée) OU la frontière gauche/droite
    // a bougé (édition qui déplace le milieu de fullText) : reconstruction complète des DEUX pages.
    PAGE_LEFT.textEl.innerHTML = '';   PAGE_LEFT.badgeLayer.innerHTML = '';
    PAGE_RIGHT.textEl.innerHTML = '';  PAGE_RIGHT.badgeLayer.innerHTML = '';
    paraStates = [];
    let tokenIdx = 0;
    paragraphs.forEach((paraText, pi) => {
      const page = merde_claude_pageForParaIndex(pi, splitIdx);
      const paraEl = document.createElement('div');
      paraEl.className = 'para';
      page.textEl.appendChild(paraEl);
      const words = paraText.split(' ');
      const wordState = merde_claude_syncParagraph(page, paraEl, null, words, tokenIdx);
      paraStates.push({ paraEl, wordState, page });
      tokenIdx += words.length;
    });
  } else {
    // même nombre de paragraphes, même répartition gauche/droite : ne retoucher que celui qui a
    // changé — les autres, et leurs badges, restent intacts (aucune mesure, aucune reconstruction).
    let tokenIdx = 0;
    for (let pi = 0; pi < paragraphs.length; pi++) {
      const words = paragraphs[pi].split(' ');
      const ps = paraStates[pi];
      const currentText = ps.wordState.map(st => st.text).join(' ');
      if (force || currentText !== paragraphs[pi]) {
        ps.wordState = merde_claude_syncParagraph(ps.page, ps.paraEl, ps.wordState, words, tokenIdx, force);
      }
      tokenIdx += words.length;
    }
  }

  merde_claude_recomputeSegments();
}

// Offsets caractère de chaque segment (mot/espace/saut) — bon marché, aucune mesure DOM. Lit la
// longueur sur `span.textContent` (toujours exact) et non sur `st.text` : `st.text` sert de
// marqueur "dernière position calculée" pour quickSync/merde_claude_syncParagraph (voir plus bas) et peut donc
// être volontairement en retard d'une frappe pendant la fenêtre de débounce.
function merde_claude_recomputeSegments() {
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
// aux marges de placement (merde_claude_placeWordAt) — aucun getBoundingClientRect ici, donc aucune des
// cascades qui faisaient "tout bouger" à chaque touche. Le placement propre (badges, décalages)
// arrive séparément, 1s après la dernière frappe (scheduleRebuild, voir plus bas).
// Marque volontairement `st.text` en retard sur le mot réellement affiché, pour que merde_claude_syncParagraph
// (appelé plus tard par merde_claude_rebuildDOM) détecte le mot à replacer — voir son usage de `st.text` pour
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
  const badgeLayer = ps.page.badgeLayer;
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
    // text: '' volontaire (jamais égal à w) : force merde_claude_syncParagraph à replacer TOUT ce paragraphe
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
    // Le nouveau paragraphe hérite provisoirement de la page de son voisin — corrigé, si besoin,
    // par le prochain merde_claude_rebuildDOM (seul endroit qui recalcule la frontière gauche/droite).
    const pi = paragraphIndexAt(cursorIdx) - 1;
    const page = paraStates[pi].page;
    quickSyncParagraph(paraStates[pi], paragraphs[pi].split(' '));
    const newParaEl = document.createElement('div');
    newParaEl.className = 'para';
    page.textEl.insertBefore(newParaEl, paraStates[pi].paraEl.nextSibling);
    const newPs = { paraEl: newParaEl, wordState: [], page };
    quickSyncParagraph(newPs, paragraphs[pi + 1].split(' '));
    paraStates.splice(pi + 1, 0, newPs);
    return false;
  }

  if (newCount === oldCount - 1) {
    // fusion : cursorIdx est dans le paragraphe résultant ; celui d'après disparaît.
    const pi = paragraphIndexAt(cursorIdx);
    const removed = paraStates[pi + 1];
    removed.page.textEl.removeChild(removed.paraEl);
    removed.wordState.forEach(st => {
      if (st.beforeEl) removed.page.badgeLayer.removeChild(st.beforeEl);
      if (st.afterEl)  removed.page.badgeLayer.removeChild(st.afterEl);
    });
    paraStates.splice(pi + 1, 1);
    quickSyncParagraph(paraStates[pi], paragraphs[pi].split(' '));
    return false;
  }

  merde_claude_rebuildDOM();
  return true;
}

function quickSync() {
  const paragraphs = fullText.split('\n');
  if (paraStates.length !== paragraphs.length) {
    const didFullRebuild = quickSyncParagraphCount();
    if (!didFullRebuild) merde_claude_recomputeSegments();
    return didFullRebuild;
  }
  // Une frappe normale (lettre, espace, backspace dans un mot) ne touche jamais qu'UN seul
  // paragraphe, celui du curseur — pas la peine de reparcourir tout le document à chaque touche.
  const pi = paragraphIndexAt(cursorIdx);
  quickSyncParagraph(paraStates[pi], paragraphs[pi].split(' '));
  merde_claude_recomputeSegments();
  return false;
}

// Squelette des tokens DOM (offsets, découpage mots), reconstruit depuis fullText (toute la
// fenêtre chargée, cf. plus haut) — before/after (distances) remplis ensuite par merde_claude_applyProximites()
// une fois les proximités connues.
function merde_claude_buildTokens(text) {
  const tokens = [];
  let i = 0;
  let offset = 0;
  text.split('\n').forEach((paraText, pi) => {
    const words = paraText.split(' ');
    words.forEach((forme, wi) => {
      tokens.push({ i, forme, canon: forme.toLowerCase(), offset, before: null, after: null });
      offset += forme.length;
      if (wi < words.length - 1) offset += 1; // espace entre mots du paragraphe
      i++;
    });
    offset += 1; // le caractère de saut de ligne lui-même (jamais un espace après le dernier mot)
  });
  return tokens;
}

let TOKENS = merde_claude_buildTokens(fullText);

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

// Bascule splash -> page une seule fois, la première fois que texte ET badges sont prêts
// ensemble (paraStates vide => tout premier passage de merde_claude_rebuildDOM(true) ci-dessus, qui a
// construit la page en entier vu qu'aucun paraState n'existait encore).
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
// après un rebuild (merde_claude_rebuildDOM, merde_claude_applyProximites) où la position n'a pas réellement bougé sous
// l'action de l'utilisateur, pour ne pas allumer une proximité que personne n'a cliquée.
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
  const around  = JSON.stringify(fullText.slice(Math.max(0, cursorIdx - 8), cursorIdx) + '|' + fullText.slice(cursorIdx, cursorIdx + 8));
  const pageRect = pageForIdx(cursorIdx).pageEl.getBoundingClientRect();
  window.pywebview.api.debug_log(
    `idx=${cursorIdx} autour=${around} rect(left=${Math.round(rect.left - pageRect.left)},top=${Math.round(rect.top - pageRect.top)},bottom=${Math.round(rect.bottom - pageRect.top)}) anchor=${anchorIdx}`
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

// ── Édition : tout passe par une modification de fullText, puis reconstruction ───────────────
// Un retour à la ligne (Entrée) est juste le caractère "\n" — inséré, supprimé, fusionné comme
// n'importe quel autre caractère, sans cas particulier.

// Débounce du PLACEMENT (badges, décalages de marge) : quickSync() a déjà affiché le texte tapé
// tout de suite (voir plus haut) ; ici on ne fait que différer la passe coûteuse (merde_claude_placeWordAt,
// mesures DOM) de 1s après la dernière frappe, pour éviter la cascade visuelle à chaque touche.
let rebuildDebounceTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildDebounceTimer);
  rebuildDebounceTimer = setTimeout(() => {
    rebuildDebounceTimer = null;
    merde_claude_rebuildDOM();
    merde_claude_clipOverflowParagraphs();
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

// Coupure nette en bas de page : dès qu'un mot commence après la limite (hauteur de .page moins
// son padding bas), lui et TOUT ce qui suit (même mot, badges compris, paragraphes suivants sur
// la même page) passent en visibility:hidden — jamais de ligne affichée à moitié, cachée par le
// footer noir. visibility (pas display:none) : garde la boîte de layout, comme #pages.hidden,
// pour ne pas fausser les mesures DOM des passes suivantes.
function merde_claude_clipOverflowParagraphs() {
  // Limite = bas du conteneur #pages (borné par flex, cf. CSS), PAS bas de .page lui-même —
  // .page n'est jamais étiré (align-items:flex-start) : sa hauteur est celle de SON contenu,
  // donc toujours >= à lui-même, "bottom > limit" ne se déclenchait quasiment jamais.
  const pagesRect = document.getElementById('pages').getBoundingClientRect();
  PAGES.forEach(page => {
    const pageRect = page.pageEl.getBoundingClientRect();
    const padBottom = parseFloat(getComputedStyle(page.pageEl).paddingBottom);
    const limit = pagesRect.bottom - pageRect.top - padBottom;
    let cut = false;
    paraStates.forEach(ps => {
      if (ps.page !== page) return;
      ps.wordState.forEach(st => {
        if (!cut) {
          // Référence = le bas le plus bas parmi le mot ET ses badges (le badge "after" déborde
          // plus bas que le mot lui-même) — sinon un mot tient dans la page mais son badge, sous
          // la ligne, se fait couper par l'overflow:hidden de .page, invisible sans prévenir.
          let bottom = st.span.getBoundingClientRect().bottom;
          if (st.beforeEl) bottom = Math.max(bottom, st.beforeEl.getBoundingClientRect().bottom);
          if (st.afterEl)  bottom = Math.max(bottom, st.afterEl.getBoundingClientRect().bottom);
          if (bottom - pageRect.top > limit) cut = true;
        }
        st.span.style.visibility = cut ? 'hidden' : '';
        if (st.beforeEl) st.beforeEl.style.visibility = cut ? 'hidden' : '';
        if (st.afterEl)  st.afterEl.style.visibility  = cut ? 'hidden' : '';
      });
    });
  });
}

// Token JS (span space-split) qui contient charIdx, ou null (entre deux mots) — même recherche
// par offset que merde_claude_applyProximites, réutilisée ici pour retrouver la paire depuis le curseur.
function tokenAt(charIdx) {
  let lo = 0, hi = TOKENS.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (TOKENS[mid].offset <= charIdx) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (found === -1) return null;
  const t = TOKENS[found];
  if (charIdx >= t.offset + t.forme.length) return null;
  return t;
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
  // curseur texte (un badge n'est pas une position dans fullText). `.badge-layer` a
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
// Texte réel (assets/texte-modele.txt via load_window()) — point d'entrée exclusif via
// `python -m app.test_pywebview` (cf. son docstring), toujours lancé avec pywebview.

// Position/largeur de la pageline : proportion du livre couverte par la fenêtre actuellement
// chargée. Pas de navigation pour l'instant (boutons prev/next visibles mais désactivés — la
// vraie pagination demande que load_window() accepte un point de départ arbitraire côté Python,
// pas fait) — calculée une fois, ne bouge pas en cours de session.
function updatePageLine() {
  const cursorEl = document.getElementById('pageline-cursor');
  if (!windowTotalChars) return;
  const pct  = windowStartOffset / windowTotalChars;
  const size = fullText.length / windowTotalChars;
  cursorEl.style.left  = (pct * 100) + '%';
  cursorEl.style.width = Math.max(size * 100, 0.5) + '%';
}

/*- Point d'entrée -*/
function textRender() {
  logJS('textRender: appel load_window')
  window.pywebview.api.load_window().then(({ TOKENS, total_chars, firstTokenId }) => {
    logJS(`textRender: load_window resolu, ${TOKENS.length} tokens, firstTokenId=${firstTokenId}`)
    let indexFirstToken
    [TOKENS, indexFirstToken] = prepareTokens(TOKENS, firstTokenId)
    logJS(`textRender: prepareTokens fait, indexFirstToken=${indexFirstToken}`)
    buildDOM(TOKENS, indexFirstToken)
    logJS('textRender: buildDOM fait')
    reveal()
    logJS('textRender: reveal fait')
  }).catch(err => logJSError('JS textRender:', err))
}

function prepareTokens(TOKENS, firstTokenId){
  let pos = 0, posMot = 0, pairCounter = 0;
  let indexFirstToken;
  const parCanon = new Map(); // canon_id -> { seuil, last }
  TOKENS = TOKENS.map((token, idx) => {
    if (token.i == firstTokenId) {
      indexFirstToken = idx
    }
    token.idx = idx
    token.o = pos
    const twidth = token.w + token.s.length
    pos += twidth
    if (!token.t) return token // ponctuation
    // offset mot
    token.om = posMot
    posMot += twidth
    if (token.x) return token // ignoré

    // Canon
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
      }
      entry.last = token // dernier de son canon
    } else {
      // premier token du canon : crée le canon, enregistre son seuil (seuil : +1 pour que la
      // comparaison < ci-dessus se comporte comme <=. rawSeuil : valeur réelle, pour la couleur).
      const rawSeuil = SEUIL_PER_CANON[token.c] ?? SEUIL_DEFAUT
      parCanon.set(token.c, { seuil: rawSeuil + 1, rawSeuil, last: token });
    }
    return token;
  })
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

  // Nettoyage
  PAGE_LEFT.textEl.innerHTML = ''
  PAGE_RIGHT.textEl.innerHTML = ''
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
      // Un token qui n'est pas un mot (ponctuation) n'hérite jamais du badgeX d'un mot
      // précédent : pas de place à réserver pour un badge devant une virgule, un point, etc.
      // (décision utilisateur 2026-07-18 — évite l'espace visible avant une ponctuation qui
      // devrait rester collée au mot précédent).
      const actualX = token.t ? Math.max(naturalX, badgeX) : naturalX
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
