#!/usr/bin/env python3
"""
Prox Text Analyzer — analyse un texte et stocke les statistiques dans SQLite.

Pour chaque canon du texte :
  count     : nombre d'occurrences
  avg_dist  : distance moyenne entre occurrences consécutives (en caractères)
  std_dist  : écart type de ces distances
  min_dist  : distance minimale
  max_dist  : distance maximale
  nb_forms  : nombre de formes de surface distinctes (fait/ferait/faisant…)

Table page_density : pour chaque page de 250 mots, score = nombre de paires
consécutives du même canon dont au moins une occurrence est sur cette page.
(Si les deux sont sur la même page, +2.)

Usage:
  python text_analyzer.py roman.txt -a "Victor Hugo" -t "Notre-Dame de Paris" -y 1831 -l fr
  python text_analyzer.py roman.txt -a "Dostoïevski" -t "Crime et Châtiment" -y 1866 -l ru --db corpus.db
"""

import sys
import math
import re
import json
import unicodedata
import argparse
import sqlite3
from pathlib import Path
from collections import defaultdict
from datetime import datetime


# ── Commentaires ─────────────────────────────────────────────────────────────

def strip_comments(text):
    """Supprime les blocs /*** ... ***/ du texte avant analyse."""
    return re.sub(r'/\*\*\*.*?\*\*\*/', '', text, flags=re.DOTALL)


# ── Nommage ──────────────────────────────────────────────────────────────────

def slugify(text):
    """Convertit en ASCII minuscules, remplace tout non-alphanumérique par _."""
    text = unicodedata.normalize('NFD', text)
    text = text.encode('ascii', 'ignore').decode('ascii')
    text = text.lower()
    text = re.sub(r'[^a-z0-9]+', '_', text)
    return text.strip('_')

def db_name(title, author, year):
    return f"{slugify(title)}_{slugify(author)}_{year}.db"


# ── spaCy ────────────────────────────────────────────────────────────────────

def load_spacy():
    try:
        import spacy
    except ImportError:
        print("ERREUR : spaCy non installé. pip install spacy")
        sys.exit(1)
    for model in ('fr_core_news_lg', 'fr_core_news_md', 'fr_core_news_sm'):
        try:
            nlp = spacy.load(model, disable=['parser', 'ner'])
            print(f"Modèle : {model}")
            return nlp
        except OSError:
            continue
    print("ERREUR : aucun modèle spaCy français.")
    print("  python -m spacy download fr_core_news_md")
    sys.exit(1)


# ── Tokenisation ──────────────────────────────────────────────────────────────

PAGE_SIZE = 250  # mots par page

def _chunks(text, size=100_000):
    """Découpe le texte en blocs sans couper un mot, retourne (offset_début, bloc)."""
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            boundary = end
            while boundary > start and text[boundary] not in ' \n\t':
                boundary -= 1
            if boundary > start:   # espace trouvé : on coupe proprement
                end = boundary
            # sinon : pas d'espace sur toute la longueur, on coupe quand même
        yield start, text[start:end]
        start = end

def tokenize(text, nlp):
    """
    Retourne (tokens, total_words).
    tokens : liste de (canon, forme, offset_char_absolu, index_mot)
    """
    tokens    = []
    word_idx  = 0

    for chunk_start, chunk_text in _chunks(text):
        doc = nlp(chunk_text)
        for tok in doc:
            if tok.is_alpha and len(tok.text) > 1:
                tokens.append((
                    tok.lemma_.lower(),          # canon
                    tok.text.lower(),            # forme de surface
                    chunk_start + tok.idx,       # offset absolu dans le texte
                    word_idx,                    # rang parmi les mots alpha
                ))
                word_idx += 1

    return tokens, word_idx


# ── Statistiques par canon ────────────────────────────────────────────────────

def compute_canon_stats(tokens):
    """
    Retourne dict[canon → dict] avec count, avg_dist, std_dist, min_dist, max_dist, nb_forms.
    Les distances sont calculées entre offsets de caractères d'occurrences consécutives.
    """
    by_canon = defaultdict(lambda: {'offsets': [], 'forms': set()})
    for canon, form, offset, _ in tokens:
        by_canon[canon]['offsets'].append(offset)
        by_canon[canon]['forms'].add(form)

    stats = {}
    for canon, data in by_canon.items():
        offsets = data['offsets']
        count   = len(offsets)
        nb_forms = len(data['forms'])

        if count < 2:
            stats[canon] = {
                'count': count, 'avg_dist': None, 'std_dist': None,
                'min_dist': None, 'max_dist': None, 'nb_forms': nb_forms,
            }
            continue

        dists = [offsets[i + 1] - offsets[i] for i in range(count - 1)]
        n     = len(dists)
        avg   = sum(dists) / n
        std   = math.sqrt(sum((d - avg) ** 2 for d in dists) / n)

        stats[canon] = {
            'count':    count,
            'avg_dist': round(avg, 2),
            'std_dist': round(std, 2),
            'min_dist': min(dists),
            'max_dist': max(dists),
            'nb_forms': nb_forms,
        }

    return stats


# ── Densité de répétitions par page ──────────────────────────────────────────

def compute_page_density(tokens):
    """
    Retourne dict[page_num → score].

    Pour chaque paire consécutive d'occurrences du même canon :
      - page de l'occurrence A reçoit +1
      - page de l'occurrence B reçoit +1
    Si A et B sont sur la même page, cette page reçoit +2 (comportement naturel).

    Toutes les paires sont comptées, sans seuil de distance.
    """
    by_canon = defaultdict(list)
    for canon, _, _, word_idx in tokens:
        by_canon[canon].append(word_idx)

    density = defaultdict(int)
    for word_indices in by_canon.values():
        for i in range(len(word_indices) - 1):
            density[word_indices[i]     // PAGE_SIZE + 1] += 1
            density[word_indices[i + 1] // PAGE_SIZE + 1] += 1

    return density


# ── SQLite ────────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS texts (
    id           INTEGER PRIMARY KEY,
    author       TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    year         TEXT    NOT NULL,
    lang         TEXT    NOT NULL,
    source       TEXT,
    analyzed_at  TEXT,
    total_chars  INTEGER,
    total_words  INTEGER,
    total_pages  INTEGER
);

CREATE TABLE IF NOT EXISTS canons (
    text_id   INTEGER NOT NULL REFERENCES texts(id),
    canon     TEXT    NOT NULL,
    count     INTEGER,
    avg_dist  REAL,
    std_dist  REAL,
    min_dist  INTEGER,
    max_dist  INTEGER,
    nb_forms  INTEGER,
    PRIMARY KEY (text_id, canon)
);

CREATE TABLE IF NOT EXISTS page_density (
    text_id   INTEGER NOT NULL REFERENCES texts(id),
    page_num  INTEGER NOT NULL,
    score     INTEGER,
    PRIMARY KEY (text_id, page_num)
);
"""

def init_db(db_path):
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn

def save(conn, author, title, year, lang, source, analyzed_at,
         total_chars, total_words, total_pages,
         canon_stats, page_density):

    cur = conn.cursor()

    cur.execute(
        "INSERT INTO texts (author, title, year, lang, source, analyzed_at, total_chars, total_words, total_pages) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (author, title, year, lang, source, analyzed_at, total_chars, total_words, total_pages),
    )
    text_id = cur.lastrowid

    cur.executemany(
        "INSERT INTO canons (text_id, canon, count, avg_dist, std_dist, min_dist, max_dist, nb_forms) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (text_id, canon,
             s['count'], s['avg_dist'], s['std_dist'],
             s['min_dist'], s['max_dist'], s['nb_forms'])
            for canon, s in canon_stats.items()
        ],
    )

    cur.executemany(
        "INSERT INTO page_density (text_id, page_num, score) VALUES (?, ?, ?)",
        [(text_id, page, score) for page, score in page_density.items()],
    )

    conn.commit()
    return text_id


# ── Main ──────────────────────────────────────────────────────────────────────

def analyze(source_path, author, title, year, lang, db_path=None, json_path=None, nlp=None):
    """
    Pipeline complet : lit source_path, analyse, écrit SQLite + JSON.
    Retourne un dict avec tous les résultats.
    """
    source_path = Path(source_path)
    db_path     = Path(db_path   or db_name(title, author, year))
    json_path   = Path(json_path or db_path.with_suffix('.json'))

    if nlp is None:
        nlp = load_spacy()

    text = strip_comments(source_path.read_text(encoding='utf-8', errors='ignore'))

    tokens, total_words = tokenize(text, nlp)
    canon_stats  = compute_canon_stats(tokens)
    page_density = compute_page_density(tokens)
    total_pages  = (total_words // PAGE_SIZE) + 1
    analyzed_at  = datetime.now().isoformat(timespec='seconds')

    conn    = init_db(db_path)
    text_id = save(
        conn,
        author=author, title=title, year=year, lang=lang,
        source=source_path.name, analyzed_at=analyzed_at,
        total_chars=len(text), total_words=total_words, total_pages=total_pages,
        canon_stats=canon_stats, page_density=page_density,
    )
    conn.close()

    json_data = {
        'author': author, 'title': title, 'year': year, 'lang': lang,
        'source': source_path.name, 'analyzed_at': analyzed_at,
        'total_chars': len(text), 'total_words': total_words, 'total_pages': total_pages,
        'canons':       canon_stats,
        'page_density': {str(p): s for p, s in page_density.items()},
    }
    json_path.write_text(json.dumps(json_data, ensure_ascii=False, indent=2), encoding='utf-8')

    return {
        'text_id': text_id, 'text': text, 'tokens': tokens,
        'total_words': total_words, 'total_pages': total_pages,
        'canon_stats': canon_stats, 'page_density': page_density,
        'db_path': db_path, 'json_path': json_path, 'json_data': json_data,
    }


def main():
    ap = argparse.ArgumentParser(description='Prox Text Analyzer')
    ap.add_argument('source',            help='Fichier .txt à analyser')
    ap.add_argument('--author', '-a',    required=True, help='Nom de l\'auteur')
    ap.add_argument('--title',  '-t',    required=True, help='Titre exact de l\'œuvre')
    ap.add_argument('--year',   '-y',    required=True, help='Année de publication')
    ap.add_argument('--lang',   '-l',    required=True, help='Langue originale (fr, en, ru…)')
    ap.add_argument('--db',     '-d',    default=None,
                    help='Base SQLite cible (défaut : déduit de titre_auteur_année.db)')
    ap.add_argument('--json',   '-j',    default=None,
                    help='Fichier JSON de sortie (défaut : même nom que --db avec .json)')
    args = ap.parse_args()

    source = Path(args.source)
    if not source.exists():
        print(f"Fichier introuvable : {source}")
        sys.exit(1)

    print("Chargement spaCy…")
    nlp = load_spacy()

    print(f"Analyse de {source.name}…")
    result = analyze(source, args.author, args.title, args.year, args.lang,
                     db_path=args.db, json_path=args.json, nlp=nlp)

    print(f"\n✓  text_id={result['text_id']}  |  {len(result['canon_stats']):,} canons  |  {result['total_pages']} pages")
    print(f"   SQLite → {result['db_path']}")
    print(f"   JSON   → {result['json_path']}")

if __name__ == '__main__':
    main()
