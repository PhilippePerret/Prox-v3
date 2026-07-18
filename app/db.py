"""
Base SQLite — une base par document (décidé 2026-07-15).

Schéma acté (révisé 2026-07-17 — ajout is_alphanum, plus de migration de schéma pendant la phase
d'expérimentation : un changement de colonne se traite en réécrivant CREATE TABLE, jamais en ALTER
TABLE — base existante à effacer par l'utilisateur si besoin, cf. décision explicite 2026-07-17) :
- canons(id, canon, ignored) : forme canonique/lemme, globale au document.
- tokens(id, mot, longueur, wspace, canon_id, ignored, is_alphanum) : TOUS les tokens du texte,
  dans l'ordre — mots ET ponctuation, y compris ceux que le filtre de significativité écarte
  (marqués `ignored=1`, jamais absents de la séquence). `mot` = texte brut du token (spaCy
  `tok.text`). `wspace` = séparateur réel après ce token (spaCy `tok.whitespace_` : '' ou ' ',
  jamais supposé). `is_alphanum` (spaCy `tok.is_alpha or tok.is_digit`) : distingue un vrai mot
  (lettres OU chiffres, "à"/"12" comptent) de la ponctuation — distinct de `ignored`, qui mélange
  "n'est pas un mot" ET "mot pas assez significatif" (cf. `significatif` ci-dessous) ; nécessaire
  côté JS pour calculer l'offset ENTRE MOTS (`om`, cf. test.js) sans compter la ponctuation.
  Pas d'offset absolu persisté — un offset relatif se recalcule à la volée pour une fenêtre
  donnée en sommant `longueur + len(wspace)` des tokens qui précèdent dans cette fenêtre (section
  toujours indexée depuis 0, `id` sert d'ordre).
- historique_lecture(id, first_token_id, date, start_prox_count, end_prox_count,
  start_prox_taux, end_prox_taux) : log, une ligne par point de suivi (peut y en avoir plusieurs
  en cours de session, pas seulement ouverture/fermeture). `start_prox_taux`/`end_prox_taux` sur
  une échelle 0.00-1.00 (2 décimales) : distance 1500 -> valeur mini, distance 0 -> valeur maxi.

Envoi au frontend (IPC pywebview, JSON, plusieurs milliers de tokens par fenêtre) : clés
raccourcies dès la lecture — alias posés dans le SELECT (`tokens_from`), jamais de passe de
renommage séparée après coup.
  id -> i   mot -> m   longueur -> w   wspace -> s   canon (texte, via jointure) -> c   ignored -> x
  is_alphanum -> t  (pour "texte" ; alias 'a' déjà pris côté JS par la distance "after" posée sur
  ces mêmes objets token, cf. test.js::buildTokenIndex)

Offset relatif et proximités (avant/après, avec seuil) : calculés côté JS, jamais en Python —
mesuré (2026-07-16, 7000 tokens synthétiques, même algo des deux côtés) : Python médiane 1.334ms,
JS (V8) médiane 0.237ms. Nécessaire aussi côté JS pour la frappe en direct (recalcul à chaque
saisie), donc un seul endroit qui porte cette logique plutôt que deux implémentations à tenir
synchronisées.
"""

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS canons (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    canon   TEXT NOT NULL UNIQUE,
    ignored BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tokens (
    id          INTEGER PRIMARY KEY,
    mot         TEXT NOT NULL,
    longueur    INTEGER NOT NULL,
    wspace      TEXT NOT NULL DEFAULT '',
    canon_id    INTEGER NOT NULL REFERENCES canons(id),
    ignored     BOOLEAN NOT NULL DEFAULT 0,
    is_alphanum BOOLEAN NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tokens_canon_id ON tokens(canon_id);

CREATE TABLE IF NOT EXISTS historique_lecture (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    first_token_id    INTEGER NOT NULL REFERENCES tokens(id),
    date              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    start_prox_count  INTEGER NOT NULL,
    end_prox_count    INTEGER,
    start_prox_taux   REAL NOT NULL,
    end_prox_taux     REAL
);
"""


def open_document_db(db_path: Path) -> sqlite3.Connection:
    """Ouvre (et crée si besoin) la base SQLite d'un document, avec le schéma canons/tokens.
    check_same_thread=False : pywebview appelle les méthodes de l'API (donc analyze()) depuis un
    thread différent de celui où la connexion est créée — sqlite3 le refuse par défaut."""
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate_first_token_id(conn)
    conn.commit()
    return conn


def _migrate_first_token_id(conn: sqlite3.Connection) -> None:
    """`historique_lecture` existait déjà (ancien schéma, colonne `first_mot_id`) sur les bases
    créées avant le renommage 2026-07-16 : `CREATE TABLE IF NOT EXISTS` ne retouche pas une table
    déjà présente. Renomme la colonne si besoin — lignes existantes conservées, rien d'autre
    touché."""
    cols = [row[1] for row in conn.execute("PRAGMA table_info(historique_lecture)")]
    if 'first_mot_id' in cols and 'first_token_id' not in cols:
        conn.execute("ALTER TABLE historique_lecture RENAME COLUMN first_mot_id TO first_token_id")


def _canon_id(conn: sqlite3.Connection, canon: str) -> int:
    row = conn.execute("SELECT id FROM canons WHERE canon = ?", (canon,)).fetchone()
    if row:
        return row[0]
    return conn.execute("INSERT INTO canons(canon) VALUES (?)", (canon,)).lastrowid


def replace_tokens(conn: sqlite3.Connection, doc) -> None:
    """Remplace le contenu de `tokens` par TOUS les tokens du doc spaCy — mots ET ponctuation,
    dans l'ordre du texte. `ignored` : filtre de significativité (is_alpha and (len>3 or verbe)),
    marqué, jamais retiré de la séquence. `is_alphanum` : est-ce un mot du tout (lettres ou
    chiffres), indépendamment de sa significativité — sert côté JS à calculer l'offset entre mots
    sans compter la ponctuation (cf. tokens -> t dans le SELECT de `tokens_from`). Réécriture
    complète de la section à chaque appel : l'ordre d'insertion (donc `id`) redonne l'ordre du
    texte, un offset absolu n'a jamais besoin d'être stocké."""
    conn.execute("DELETE FROM tokens")
    for tok in doc:
        is_verb = tok.pos_ in ('VERB', 'AUX')
        significatif = tok.is_alpha and (len(tok.text) > 3 or is_verb)
        is_alphanum = tok.is_alpha or tok.is_digit
        canon_id = _canon_id(conn, tok.lemma_.lower())
        conn.execute(
            "INSERT INTO tokens(mot, longueur, wspace, canon_id, ignored, is_alphanum) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (tok.text, len(tok.text), tok.whitespace_, canon_id,
             0 if significatif else 1, 1 if is_alphanum else 0),
        )
    conn.commit()


def first_token_id(conn: sqlite3.Connection):
    """Id du premier token du segment actuellement chargé (le plus petit id de `tokens`, vu que
    replace_tokens() réécrit toute la section dans l'ordre du texte à chaque appel)."""
    row = conn.execute("SELECT MIN(id) FROM tokens").fetchone()
    return row[0]


def char_offset_before(conn: sqlite3.Connection, token_id: int) -> int:
    """Position caractère EXACTE (pas approximative — somme `longueur + LENGTH(wspace)` réels,
    pas un +1 supposé) du début du token `token_id`, en sommant tous les tokens qui le précèdent
    dans la base. Usage : affichage seulement (ex. position dans la pageline) — jamais pour
    découper le texte brut (cf. suppression d'`offset_of_mot`, 2026-07-16)."""
    row = conn.execute(
        "SELECT COALESCE(SUM(longueur + LENGTH(wspace)), 0) FROM tokens WHERE id < ?",
        (token_id,),
    ).fetchone()
    return row[0]


def tokens_from(conn: sqlite3.Connection, start_id: int, limit: int) -> list:
    """Les `limit` tokens de `tokens` à partir de `start_id` (inclus), dans l'ordre — alias
    courts posés directement dans le SELECT (cf. table en tête de fichier). Chaque ligne EST un
    token entier — aucune coupure possible en cours de fenêtre. `c` = texte du canon (jointure sur
    `canons`), pas `canon_id` : `canon_id` est un entier auto-incrémenté à l'insertion, dépendant
    de l'ordre d'apparition dans CETTE base — inutilisable comme clé stable côté JS (ex.
    SEUIL_PER_CANON). Le texte du canon, lui, est stable quel que soit l'ordre d'insertion."""
    rows = conn.execute(
        "SELECT tok.id AS i, tok.mot AS m, tok.longueur AS w, tok.wspace AS s, can.canon AS c, "
        "tok.ignored AS x, tok.is_alphanum AS t "
        "FROM tokens tok JOIN canons can ON can.id = tok.canon_id "
        "WHERE tok.id >= ? ORDER BY tok.id LIMIT ?",
        (start_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def prox_taux(prox, seuil=1500) -> float:
    """Moyenne inversée des distances : 1500 -> 0.00 (mini), 0 -> 1.00 (maxi), 2 décimales
    (cf. décision utilisateur 2026-07-15). 0.00 si aucune proximité trouvée."""
    if not prox:
        return 0.0
    valeurs = [1 - (r.distance / seuil) for r in prox]
    return round(sum(valeurs) / len(valeurs), 2)


def start_session(conn: sqlite3.Connection, first_token_id: int, prox_count: int, taux: float) -> int:
    cur = conn.execute(
        "INSERT INTO historique_lecture(first_token_id, start_prox_count, start_prox_taux) "
        "VALUES (?, ?, ?)",
        (first_token_id, prox_count, taux),
    )
    conn.commit()
    return cur.lastrowid


def update_session_end(conn: sqlite3.Connection, session_id: int, prox_count: int, taux: float) -> None:
    conn.execute(
        "UPDATE historique_lecture SET end_prox_count = ?, end_prox_taux = ? WHERE id = ?",
        (prox_count, taux, session_id),
    )
    conn.commit()
