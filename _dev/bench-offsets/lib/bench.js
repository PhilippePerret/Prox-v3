'use strict';
// Bancs d'essai JS — 6 des 12 tests définis dans README.md :
//   READ-FULL-TEXT/SPLIT-SPACE/JS   READ-STREAMING/SPLIT-SPACE/JS
//   READ-FULL-TEXT/SPACE-CSS/JS     READ-STREAMING/SPACE-CSS/JS
//   READ-FULL-TEXT/SPACE-CALC/JS    READ-STREAMING/SPACE-CALC/JS
// Les 6 bancs PY (mêmes noms, suffixe /PY) sont dans bench.py.
//
// Nécessite spacy_cache.json (build_spacy_cache.py côté Python — à lancer une fois avant).
// spaCy ne tourne jamais ici, seulement le JSON déjà calculé est chargé. 4 étapes
// chronométrées séparément (noms imposés par README.md) :
//   - Spacy analyse loading : chargement du cache spaCy (+ texte.txt en plus, pour SPLIT-SPACE
//     seulement, qui ignore les offsets spaCy mais a besoin du texte brut pour son split() naïf)
//   - Tokens Fullfillment   : TOKENS = tokens spaCy + gap propre à la technique + proximité
//   - HTML building         : construction du DOM (createElement/appendChild, via jsdom
//     puisque Node n'a pas de DOM natif), spans data-canon
//   - Html doc loading      : 0 — construire le DOM, c'est déjà avoir le document chargé,
//     pas d'étape d'ouverture séparée côté JS (cf. README)
//
// Nécessite `npm install` dans ce dossier (jsdom) + un tas V8 augmenté (les éléments DOM
// jsdom sont lourds, 6 tests x ~200-350k noeuds épuisent le tas par défaut) :
//   node --max-old-space-size=4096 _dev/bench-offsets/lib/bench.js

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { JSDOM } = require('jsdom');

const SOURCE_TXT = path.join(__dirname, 'texte.txt');
const CACHE_JSON = path.join(__dirname, 'spacy_cache.json');

function readFull(file) {
  return fs.readFileSync(file, 'utf-8');
}

function readStreaming(file) {
  return new Promise((resolve, reject) => {
    const parts = [];
    const stream = fs.createReadStream(file, { encoding: 'utf-8' });
    stream.on('data', (chunk) => parts.push(chunk));
    stream.on('end', () => resolve(parts.join('')));
    stream.on('error', reject);
  });
}

async function loadCacheFull(file) {
  return JSON.parse(readFull(file));
}

async function loadCacheStreaming(file) {
  return JSON.parse(await readStreaming(file));
}

const LOAD_MODES = [
  ['READ-FULL-TEXT', async (f) => readFull(f), loadCacheFull],
  ['READ-STREAMING', async (f) => readStreaming(f), loadCacheStreaming],
];

// SPLIT-SPACE — split('\n') puis split(' '), n'utilise pas les offsets spaCy pour le gap, mais
// réutilise le canon déjà calculé dans le cache (fait linguistique, pas un offset). Si le
// découpage naïf ne retombe pas exactement sur un offset spaCy (ponctuation collée différemment),
// fallback sur la forme elle-même en minuscules : un canon n'est jamais vide.
function splitSpaceTokens(text, spacyTokens) {
  const canonParFormeOffset = new Map(spacyTokens.map(([f, o, ws, c]) => [`${f}@${o}`, c]));
  const out = [];
  let offset = 0;
  const paragraphs = text.split('\n');
  paragraphs.forEach((para, pi) => {
    const words = para === '' ? [] : para.split(' ');
    words.forEach((forme, wi) => {
      const gap = wi === words.length - 1 ? 0 : 1;
      const canon = canonParFormeOffset.get(`${forme}@${offset}`) ?? forme.toLowerCase();
      out.push([forme, offset, gap, canon]);
      offset += forme.length + gap;
    });
    if (pi < paragraphs.length - 1) offset += 1;
  });
  return out;
}

// SPACE-CSS — classe s0/s1 par mot, depuis offset/longueur spaCy déjà en cache.
function spaceCssTokens(text, spacyTokens) {
  return spacyTokens.map(([forme, offset, ws, canon]) => [forme, offset, ws ? 's1' : 's0', canon]);
}

// SPACE-CALC — même formule, mais l'espace (chaîne réelle) est le gap porté par le token.
function spaceCalcTokens(text, spacyTokens) {
  return spacyTokens.map(([forme, offset, ws, canon]) => [forme, offset, ws, canon]);
}

// ─── DOM building (JS — équivalent de la construction HTML de bench.py) ───────────────────

function domSplitSpace(document, tokensOut) {
  const p = document.createElement('p');
  tokensOut.forEach(([forme, offset, gap, canon]) => {
    const span = document.createElement('span');
    span.setAttribute('data-canon', canon || '');
    span.textContent = forme;
    p.appendChild(span);
    if (gap) p.appendChild(document.createTextNode(' '));
  });
  return p;
}

function domSpaceCss(document, tokensOut) {
  const container = document.createElement('div');
  tokensOut.forEach(([forme, offset, cls, canon]) => {
    const span = document.createElement('span');
    span.className = cls;
    span.setAttribute('data-canon', canon || '');
    span.textContent = forme;
    container.appendChild(span);
  });
  return container;
}

function domSpaceCalc(document, tokensOut) {
  const container = document.createElement('div');
  tokensOut.forEach(([forme, offset, ws, canon]) => {
    const span = document.createElement('span');
    span.setAttribute('data-canon', canon || '');
    span.textContent = forme;
    container.appendChild(span);
    if (ws) container.appendChild(document.createTextNode(ws));
  });
  return container;
}

const TECHNIQUES = [
  ['SPLIT-SPACE', splitSpaceTokens, domSplitSpace, true],   // true = a besoin du texte brut
  ['SPACE-CSS', spaceCssTokens, domSpaceCss, false],
  ['SPACE-CALC', spaceCalcTokens, domSpaceCalc, false],
];

async function main() {
  if (!fs.existsSync(CACHE_JSON)) {
    console.error(`Cache manquant : ${CACHE_JSON}. Lancer d'abord build_spacy_cache.py.`);
    process.exit(1);
  }

  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const document = dom.window.document;

  console.log("BANCS D'ESSAIS — JS (6/12)");
  const results = [];
  let firstRootHtml = null;
  for (const [modeName, readTextFn, readCacheFn] of LOAD_MODES) {
    for (const [techName, tokensFn, domFn, besoinTexte] of TECHNIQUES) {
      let t0 = performance.now();
      const text = besoinTexte ? await readTextFn(SOURCE_TXT) : null;
      const cache = await readCacheFn(CACHE_JSON);
      const spacyAnalyseMs = performance.now() - t0;
      const spacyTokens = cache.tokens;

      t0 = performance.now();
      const tokensOut = tokensFn(text, spacyTokens);
      const tokensMs = performance.now() - t0;

      t0 = performance.now();
      const root = domFn(document, tokensOut);
      const htmlBuildingMs = performance.now() - t0;

      // Html doc loading — équivalent JS du chargement réel du document dans un navigateur
      // (cf. bench.py/charger_dans_navigateur) : attacher l'arbre construit au document live.
      t0 = performance.now();
      document.body.innerHTML = '';
      document.body.appendChild(root);
      const htmlDocLoadingMs = performance.now() - t0;

      const totalMs = spacyAnalyseMs + tokensMs + htmlBuildingMs + htmlDocLoadingMs;

      const nom = `${modeName}/${techName}/JS`;
      console.log(`${nom.padEnd(32)} `
        + `Spacy analyse loading ${spacyAnalyseMs.toFixed(1)} ms | `
        + `Tokens Fullfillment ${tokensMs.toFixed(1)} ms | `
        + `HTML building ${htmlBuildingMs.toFixed(1)} ms | `
        + `Html doc loading ${htmlDocLoadingMs.toFixed(1)} ms | `
        + `total ${totalMs.toFixed(1)} ms`);

      results.push({
        nom,
        spacy_analyse_loading_ms: Math.round(spacyAnalyseMs * 10) / 10,
        tokens_fullfillment_ms: Math.round(tokensMs * 10) / 10,
        html_building_ms: Math.round(htmlBuildingMs * 10) / 10,
        html_doc_loading_ms: htmlDocLoadingMs,
        total_ms: Math.round(totalMs * 10) / 10,
        tokens: tokensOut.length,
      });

      if (firstRootHtml === null) firstRootHtml = root.outerHTML;
    }
  }

  fs.writeFileSync(path.join(__dirname, 'results_js.json'), JSON.stringify(results, null, 2), 'utf-8');

  const texteJs = path.join(__dirname, '..', 'texte_js.html');
  fs.writeFileSync(texteJs, `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${firstRootHtml}</body></html>`, 'utf-8');
  console.log(`-> ${texteJs}`);
}

main();
