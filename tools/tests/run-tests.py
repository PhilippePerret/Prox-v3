#!/usr/bin/env python3
"""
Tests Prox — text_analyzer.py

Cet outil (text_analyzer) calcule le poids statistique des canons dans un corpus
(fréquence, distances, densité par page). Ces données alimentent les profils de poids
utilisés ensuite par l'application Prox. Ce n'est PAS Prox lui-même.

Sans spaCy  : python run-tests.py       (tests unitaires uniquement)
Avec spaCy  : python run-tests.py       (tests spaCy + intégration s'ajoutent)
Verbose     : python run-tests.py -v

─── Convention fixtures ────────────────────────────────────────────────────────
Les fichiers .txt peuvent contenir des commentaires /*** ... ***/ ignorés à
l'analyse. Pour les tests d'intégration, les résultats attendus sont encodés
dans un bloc :

    /*** EXPECTECTATIONS: {"clé": valeur, ...} ***/

Clés valides dans POIDS-EXPECTED :
  total_words   : int   — nombre exact de mots alpha (len > 1)
  total_canons  : int   — nombre exact de canons distincts
  canons        : dict  — par canon (str) :
      count         : int   — occurrences exactes
      count_min     : int   — occurrences ≥ N
      count_max     : int   — occurrences ≤ N
      min_dist_max  : int   — min_dist ≤ N  (répétition proche)
      min_dist_min  : int   — min_dist ≥ N  (répétition éloignée)
      avg_dist_max  : float — avg_dist ≤ N
      avg_dist_min  : float — avg_dist ≥ N
      nb_forms      : int   — formes de surface exactes
  density       : dict  — par page (str(int)) :
      score         : int   — score exact

Toute clé inconnue dans POIDS-EXPECTED lève une erreur immédiate.
"""

import sys
import re
import json
import math
import unittest
import sqlite3
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from text_analyzer import (
    slugify, db_name,
    strip_comments,
    _chunks,
    compute_canon_stats, compute_page_density,
    init_db, save, analyze,
    PAGE_SIZE, SCHEMA,
)

FIXTURES = Path(__file__).parent / 'fixtures'

# ── Couleurs ANSI ─────────────────────────────────────────────────────────────
_G = '\033[92m'   # vert
_R = '\033[91m'   # rouge
_Y = '\033[93m'   # jaune
_B = '\033[1m'    # gras
_X = '\033[0m'    # reset

_CLASS_LABELS = {
    'TestSlugify':            'Slugify',
    'TestDbName':             'Nom de base de données',
    'TestStripComments':      'Strip comments',
    'TestChunks':             'Découpage en blocs',
    'TestComputeCanonStats':  'Statistiques par canon',
    'TestComputePageDensity': 'Densité de répétitions par page',
    'TestDatabase':           'Base de données SQLite',
    'TestAvecSpacy':          'Tokenisation spaCy',
    'TestIntegration':        'Intégration (fichiers réels)',
}

def _test_label(test):
    s = str(test)
    m = re.search(r"\[fixture='(.+?)'\]", s)
    if m:
        return m.group(1)
    m = re.match(r"(test_\w+)", s)
    if m:
        return m.group(1)[5:].replace('_', ' ')
    return s

def _test_class(test):
    if hasattr(test, '_test'):
        return type(test._test).__name__
    return type(test).__name__


class ColorTestResult(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self._current_class = None
        self._shown   = 0   # total lignes affichées (méthodes + subtests)
        self._n_fail  = 0   # échecs affichés
        self._recap   = []  # (label, msg) pour le récapitulatif final

    def _header(self, test):
        cls = _test_class(test)
        if cls != self._current_class:
            self._current_class = cls
            print(f"\n{_B}{_CLASS_LABELS.get(cls, cls)}{_X}")

    def startTest(self, test):
        super().startTest(test)

    def addSuccess(self, test):
        super().addSuccess(test)
        self._header(test)
        print(f"  {_G}✓{_X} {_test_label(test)}")
        self._shown += 1

    def addSubTest(self, test, subtest, outcome):
        # NE PAS appeler super() — évite le double dispatch vers addFailure/addError
        self._header(subtest)
        params = getattr(subtest, 'params', {})
        title  = params.get('fixture', _test_label(subtest))
        fname  = params.get('file', '')
        label  = f"{title} [{fname}]" if fname else title
        self._shown += 1
        if outcome is None:
            print(f"  {_G}✓{_X} {label}")
        else:
            exc_type, exc_val, _ = outcome
            msg = str(exc_val).split('\n')[0]
            is_failure = issubclass(exc_type, AssertionError)
            color = _R if is_failure else _Y
            kind  = '✗' if is_failure else '! ERREUR'
            print(f"  {color}{kind}{_X} {label}")
            print(f"    {color}↳ {msg}{_X}")
            self._n_fail += 1
            self._recap.append((title, fname, msg, is_failure))
            if is_failure:
                self.failures.append((subtest, msg))
            else:
                self.errors.append((subtest, msg))

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._header(test)
        label = _test_label(test)
        msg   = str(err[1]).split('\n')[0]
        print(f"  {_R}✗{_X} {label}")
        print(f"    {_R}↳ {msg}{_X}")
        self._shown  += 1
        self._n_fail += 1
        self._recap.append((label, '', msg, True))

    def addError(self, test, err):
        super().addError(test, err)
        self._header(test)
        label = _test_label(test)
        msg   = str(err[1]).split('\n')[0]
        print(f"  {_Y}! ERREUR{_X} {label}")
        print(f"    {_Y}↳ {msg}{_X}")
        self._shown  += 1
        self._n_fail += 1
        self._recap.append((label, '', msg, False))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)

    def printErrors(self):
        pass

    def stopTestRun(self):
        n_ok = self._shown - self._n_fail
        if self._recap:
            print(f"\n{_R}{'━' * 50}{_X}")
            print(f"{_R}{_B}Récapitulatif des échecs :{_X}")
            for title, fname, msg, is_failure in self._recap:
                color = _R if is_failure else _Y
                print(f"{_R}  ✗ {_B}{title}{_X}")
                if fname:
                    print(f"{_R}    fichier : {fname}{_X}")
                print(f"{_R}    ↳ {msg}{_X}")
        print(f"\n{'─' * 50}")
        print(
            f"{_B}Tests: {self._shown}{_X}  "
            f"{_G}Success: {n_ok}{_X}  "
            f"{_R}Failures: {self._n_fail}{_X}\n"
        )


class ColorTestRunner:
    def run(self, suite):
        result = ColorTestResult()
        result.startTestRun()
        suite.run(result)
        result.stopTestRun()
        return result


# Clés valides pour POIDS-EXPECTED
POIDS_EXPECTED_TOP_KEYS   = {'test-title', 'total_words', 'total_canons', 'canons', 'density'}
POIDS_EXPECTED_CANON_KEYS = {'count', 'count_min', 'count_max',
                              'min_dist_max', 'min_dist_min',
                              'avg_dist_max', 'avg_dist_min',
                              'nb_forms'}
POIDS_EXPECTED_DENSITY_KEYS = {'score'}


def parse_poids_expected(path):
    """
    Extrait le bloc /*** POIDS_EXPECTATIONS: {...} ***/ d'un fichier fixture.
    Peut se trouver n'importe où dans le fichier.
    Retourne un dict ou {} si absent.
    Lève ValueError sur clé inconnue.
    """
    raw = Path(path).read_text(encoding='utf-8')
    m = re.search(r'/\*\*\*\s*EXPECTECTATIONS\s*:\s*(\{.*?\})\s*\*\*\*/', raw, re.DOTALL)
    if not m:
        return {}
    data = json.loads(m.group(1))

    unknown_top = set(data.keys()) - POIDS_EXPECTED_TOP_KEYS
    if unknown_top:
        raise ValueError(f"{path.name} — clés EXPECTECTATIONS inconnues : {unknown_top}")

    for canon, cdata in data.get('canons', {}).items():
        unknown = set(cdata.keys()) - POIDS_EXPECTED_CANON_KEYS
        if unknown:
            raise ValueError(f"{path.name} — canon '{canon}' clés inconnues : {unknown}")

    return data


def assert_poids_expected(test_case, expected, stats, density, total_words, total_canons):
    """Vérifie les résultats contre le dict POIDS-EXPECTED."""
    if 'total_words' in expected:
        test_case.assertEqual(total_words, expected['total_words'],
            f"total_words : attendu {expected['total_words']}, obtenu {total_words}")

    if 'total_canons' in expected:
        test_case.assertEqual(total_canons, expected['total_canons'],
            f"total_canons : attendu {expected['total_canons']}, obtenu {total_canons}")

    for canon, cexp in expected.get('canons', {}).items():
        test_case.assertIn(canon, stats, f"Canon '{canon}' absent des résultats")
        s = stats[canon]
        if 'count'        in cexp: test_case.assertEqual(s['count'], cexp['count'],
            f"'{canon}' count : attendu {cexp['count']}, obtenu {s['count']}")
        if 'count_min'    in cexp: test_case.assertGreaterEqual(s['count'], cexp['count_min'],
            f"'{canon}' count < {cexp['count_min']}")
        if 'count_max'    in cexp: test_case.assertLessEqual(s['count'], cexp['count_max'],
            f"'{canon}' count > {cexp['count_max']}")
        if 'min_dist_max' in cexp: test_case.assertLessEqual(s['min_dist'], cexp['min_dist_max'],
            f"'{canon}' min_dist={s['min_dist']} > {cexp['min_dist_max']}")
        if 'min_dist_min' in cexp: test_case.assertGreaterEqual(s['min_dist'], cexp['min_dist_min'],
            f"'{canon}' min_dist={s['min_dist']} < {cexp['min_dist_min']}")
        if 'avg_dist_max' in cexp: test_case.assertLessEqual(s['avg_dist'], cexp['avg_dist_max'],
            f"'{canon}' avg_dist={s['avg_dist']} > {cexp['avg_dist_max']}")
        if 'avg_dist_min' in cexp: test_case.assertGreaterEqual(s['avg_dist'], cexp['avg_dist_min'],
            f"'{canon}' avg_dist={s['avg_dist']} < {cexp['avg_dist_min']}")
        if 'nb_forms'     in cexp: test_case.assertEqual(s['nb_forms'], cexp['nb_forms'],
            f"'{canon}' nb_forms : attendu {cexp['nb_forms']}, obtenu {s['nb_forms']}")

    for page_str, dexp in expected.get('density', {}).items():
        page = int(page_str)
        if 'score' in dexp:
            test_case.assertEqual(density.get(page, 0), dexp['score'],
                f"density[{page}] : attendu {dexp['score']}, obtenu {density.get(page, 0)}")


# ─────────────────────────────────────────────────────────────────────────────
# slugify / db_name
# ─────────────────────────────────────────────────────────────────────────────

class TestSlugify(unittest.TestCase):

    def test_espaces(self):
        self.assertEqual(slugify("Victor Hugo"), "victor_hugo")

    def test_accents(self):
        self.assertEqual(slugify("Émile Zola"),   "emile_zola")
        self.assertEqual(slugify("Châtiment"),     "chatiment")
        self.assertEqual(slugify("À rebours"),     "a_rebours")

    def test_tirets(self):
        self.assertEqual(slugify("Notre-Dame de Paris"), "notre_dame_de_paris")

    def test_chiffres_conserves(self):
        self.assertIn("2", slugify("XIXe 2e siècle"))

    def test_deja_ascii_minuscules(self):
        self.assertEqual(slugify("germinal"), "germinal")

    def test_caracteres_speciaux(self):
        self.assertEqual(slugify("L'Assommoir !"), "l_assommoir")

    def test_pas_d_underscore_en_bord(self):
        result = slugify("  Crime et Châtiment  ")
        self.assertFalse(result.startswith('_'))
        self.assertFalse(result.endswith('_'))


class TestDbName(unittest.TestCase):

    def test_format_titre_auteur_annee(self):
        self.assertEqual(
            db_name("Germinal", "Émile Zola", 1885),
            "germinal_emile_zola_1885.db"
        )

    def test_titre_avec_tiret(self):
        self.assertEqual(
            db_name("Notre-Dame de Paris", "Victor Hugo", 1831),
            "notre_dame_de_paris_victor_hugo_1831.db"
        )

    def test_extension_db(self):
        self.assertTrue(db_name("T", "A", 2000).endswith('.db'))


# ─────────────────────────────────────────────────────────────────────────────
# strip_comments
# ─────────────────────────────────────────────────────────────────────────────

class TestStripComments(unittest.TestCase):

    def test_sans_commentaire(self):
        text = "Le chat mange la souris."
        self.assertEqual(strip_comments(text), text)

    def test_commentaire_simple(self):
        result = strip_comments("/*** ceci est ignoré ***/ Le chat dort.")
        self.assertEqual(result.strip(), "Le chat dort.")

    def test_commentaire_en_fin(self):
        result = strip_comments("Le chat dort. /*** fin ***/ ")
        self.assertIn("Le chat dort.", result)
        self.assertNotIn("fin", result)

    def test_commentaire_au_milieu(self):
        result = strip_comments("Avant. /*** commentaire ***/ Après.")
        self.assertIn("Avant.", result)
        self.assertIn("Après.", result)
        self.assertNotIn("commentaire", result)

    def test_commentaire_multilignes(self):
        text = "Début.\n/*** ligne 1\nligne 2\nligne 3 ***/\nFin."
        result = strip_comments(text)
        self.assertIn("Début.", result)
        self.assertIn("Fin.", result)
        self.assertNotIn("ligne 1", result)

    def test_plusieurs_commentaires(self):
        text = "/*** A ***/ texte /*** B ***/ suite"
        result = strip_comments(text)
        self.assertIn("texte", result)
        self.assertIn("suite", result)
        self.assertNotIn("A", result)
        self.assertNotIn("B", result)

    def test_fichier_100_pourcent_commentaire(self):
        result = strip_comments("/*** tout est commentaire ***/")
        self.assertEqual(result.strip(), "")

    def test_ne_confond_pas_avec_js(self):
        text = "code /* commentaire js */ suite"
        self.assertEqual(strip_comments(text), text)

    def test_ne_confond_pas_doublee(self):
        text = "//** pas un commentaire prox **// suite"
        self.assertEqual(strip_comments(text), text)


# ─────────────────────────────────────────────────────────────────────────────
# _chunks
# ─────────────────────────────────────────────────────────────────────────────

class TestChunks(unittest.TestCase):

    def test_texte_court_un_seul_chunk(self):
        text = "Le chat noir mange la souris."
        chunks = list(_chunks(text, size=1000))
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0][0], 0)
        self.assertEqual(chunks[0][1], text)

    def test_offsets_couvrent_tout_le_texte(self):
        text = "un deux trois quatre cinq six sept huit neuf dix " * 10
        chunks = list(_chunks(text, size=50))
        reconstructed = ''.join(c[1] for c in chunks)
        self.assertEqual(reconstructed, text)

    def test_offsets_contigus(self):
        text = "a b c d e f g h i j k l m n o " * 10
        chunks = list(_chunks(text, size=30))
        self.assertGreater(len(chunks), 1)
        for i in range(len(chunks) - 1):
            end_of_current = chunks[i][0] + len(chunks[i][1])
            start_of_next  = chunks[i + 1][0]
            self.assertEqual(end_of_current, start_of_next,
                             f"Gap entre chunk {i} et {i+1}")

    def test_sans_espace_pas_de_boucle_infinie(self):
        text = "a" * 200
        chunks = list(_chunks(text, size=50))
        reconstructed = ''.join(c[1] for c in chunks)
        self.assertEqual(reconstructed, text)

    def test_offset_tok_idx_dans_texte_original(self):
        text = "alpha beta gamma delta epsilon"
        chunks = list(_chunks(text, size=12))
        for chunk_start, chunk_text in chunks:
            self.assertEqual(text[chunk_start: chunk_start + len(chunk_text)], chunk_text)


# ─────────────────────────────────────────────────────────────────────────────
# compute_canon_stats
# ─────────────────────────────────────────────────────────────────────────────

class TestComputeCanonStats(unittest.TestCase):

    def test_une_seule_occurrence(self):
        tokens = [('faire', 'faire', 100, 0)]
        s = compute_canon_stats(tokens)['faire']
        self.assertEqual(s['count'], 1)
        self.assertIsNone(s['avg_dist'])
        self.assertIsNone(s['min_dist'])
        self.assertIsNone(s['max_dist'])
        self.assertIsNone(s['std_dist'])

    def test_deux_occurrences(self):
        tokens = [
            ('faire', 'faire', 100, 0),
            ('faire', 'fait',  600, 1),
        ]
        s = compute_canon_stats(tokens)['faire']
        self.assertEqual(s['count'], 2)
        self.assertAlmostEqual(s['avg_dist'], 500.0)
        self.assertEqual(s['min_dist'], 500)
        self.assertEqual(s['max_dist'], 500)
        self.assertAlmostEqual(s['std_dist'], 0.0)
        self.assertEqual(s['nb_forms'], 2)

    def test_trois_occurrences_distances_variables(self):
        tokens = [
            ('aller', 'aller',  100, 0),
            ('aller', 'va',     300, 1),
            ('aller', 'allait', 900, 2),
        ]
        s = compute_canon_stats(tokens)['aller']
        self.assertEqual(s['count'], 3)
        self.assertEqual(s['min_dist'], 200)
        self.assertEqual(s['max_dist'], 600)
        self.assertAlmostEqual(s['avg_dist'], 400.0)
        self.assertAlmostEqual(s['std_dist'], 200.0)
        self.assertEqual(s['nb_forms'], 3)

    def test_canons_independants(self):
        tokens = [
            ('chat',  'chat',   10,  0),
            ('chat',  'chats',  110, 1),
            ('chien', 'chien',  50,  2),
            ('chien', 'chiens', 250, 3),
        ]
        stats = compute_canon_stats(tokens)
        self.assertEqual(stats['chat']['min_dist'],  100)
        self.assertEqual(stats['chien']['min_dist'], 200)

    def test_formes_distinctes_comptees_correctement(self):
        tokens = [
            ('faire', 'fait',    0,    0),
            ('faire', 'ferait',  500,  1),
            ('faire', 'faisant', 1000, 2),
            ('faire', 'fait',    1500, 3),
        ]
        s = compute_canon_stats(tokens)['faire']
        self.assertEqual(s['nb_forms'], 3)

    def test_std_nul_distances_identiques(self):
        tokens = [
            ('mot', 'mot', 0,    0),
            ('mot', 'mot', 500,  1),
            ('mot', 'mot', 1000, 2),
            ('mot', 'mot', 1500, 3),
        ]
        s = compute_canon_stats(tokens)['mot']
        self.assertAlmostEqual(s['std_dist'], 0.0)
        self.assertAlmostEqual(s['avg_dist'], 500.0)


# ─────────────────────────────────────────────────────────────────────────────
# compute_page_density
# ─────────────────────────────────────────────────────────────────────────────

class TestComputePageDensity(unittest.TestCase):

    def test_meme_page_vaut_deux(self):
        tokens = [
            ('faire', 'faire', 0,   0),
            ('faire', 'fait',  100, 10),
        ]
        density = compute_page_density(tokens)
        self.assertEqual(density[1], 2)

    def test_pages_differentes_vaut_un_chacune(self):
        tokens = [
            ('aller', 'aller', 0,    10),
            ('aller', 'va',    5000, 260),
        ]
        density = compute_page_density(tokens)
        self.assertEqual(density[1], 1)
        self.assertEqual(density[2], 1)

    def test_trois_occurrences(self):
        tokens = [
            ('mot', 'mot', 0,    5),
            ('mot', 'mot', 100,  10),
            ('mot', 'mot', 5000, 260),
        ]
        density = compute_page_density(tokens)
        self.assertEqual(density[1], 3)
        self.assertEqual(density[2], 1)

    def test_une_seule_occurrence_pas_de_density(self):
        tokens = [('seul', 'seul', 0, 0)]
        self.assertEqual(len(compute_page_density(tokens)), 0)

    def test_plusieurs_canons_s_accumulent(self):
        tokens = [
            ('chat',  'chat',  0,   0),
            ('chat',  'chats', 100, 5),
            ('chien', 'chien', 50,  2),
            ('chien', 'chien', 150, 7),
        ]
        density = compute_page_density(tokens)
        self.assertEqual(density[1], 4)

    def test_page_size_respectee(self):
        tokens = [
            ('bord', 'bord', 0,     249),
            ('bord', 'bord', 10000, 250),
        ]
        density = compute_page_density(tokens)
        self.assertEqual(density[1], 1)
        self.assertEqual(density[2], 1)


# ─────────────────────────────────────────────────────────────────────────────
# SQLite : init_db / save
# ─────────────────────────────────────────────────────────────────────────────

class TestDatabase(unittest.TestCase):

    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()

    def _save(self, **kwargs):
        defaults = dict(
            author='Hugo', title='Hernani', year=1830, lang='fr',
            source='hernani.txt', analyzed_at='2026-06-16T12:00:00',
            total_chars=50000, total_words=8000, total_pages=32,
            canon_stats={}, page_density={},
        )
        defaults.update(kwargs)
        return save(self.conn, **defaults)

    def test_tables_creees(self):
        tables = {r[0] for r in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertIn('texts',        tables)
        self.assertIn('canons',       tables)
        self.assertIn('page_density', tables)

    def test_metadonnees_sauvegardees(self):
        tid = self._save()
        row = self.conn.execute(
            "SELECT author, title, year, lang FROM texts WHERE id=?", (tid,)
        ).fetchone()
        self.assertEqual(row, ('Hugo', 'Hernani', 1830, 'fr'))

    def test_canons_sauvegardes(self):
        stats = {
            'faire': {'count': 5, 'avg_dist': 300.0, 'std_dist': 50.0,
                      'min_dist': 200, 'max_dist': 450, 'nb_forms': 2},
            'le':    {'count': 100, 'avg_dist': 15.0, 'std_dist': 5.0,
                      'min_dist': 5,   'max_dist': 30,  'nb_forms': 1},
        }
        tid = self._save(canon_stats=stats)
        rows = self.conn.execute(
            "SELECT canon, count, avg_dist FROM canons WHERE text_id=?", (tid,)
        ).fetchall()
        by_canon = {r[0]: r for r in rows}
        self.assertEqual(len(by_canon), 2)
        self.assertEqual(by_canon['faire'][1], 5)
        self.assertAlmostEqual(by_canon['faire'][2], 300.0)

    def test_page_density_sauvegardee(self):
        tid = self._save(page_density={0: 3, 1: 7, 5: 2})
        rows = self.conn.execute(
            "SELECT page_num, score FROM page_density WHERE text_id=? ORDER BY page_num",
            (tid,)
        ).fetchall()
        self.assertEqual(dict(rows), {0: 3, 1: 7, 5: 2})

    def test_valeurs_nulles_acceptees(self):
        stats = {'hapax': {'count': 1, 'avg_dist': None, 'std_dist': None,
                           'min_dist': None, 'max_dist': None, 'nb_forms': 1}}
        tid = self._save(canon_stats=stats)
        row = self.conn.execute(
            "SELECT avg_dist FROM canons WHERE text_id=? AND canon='hapax'", (tid,)
        ).fetchone()
        self.assertIsNone(row[0])

    def test_deux_textes_isoles(self):
        id1 = self._save(author='Zola',  year=1885,
                         canon_stats={'mot': {'count': 2, 'avg_dist': 100.0,
                                              'std_dist': 0.0, 'min_dist': 100,
                                              'max_dist': 100, 'nb_forms': 1}})
        id2 = self._save(author='Colette', year=1920,
                         canon_stats={'mot': {'count': 3, 'avg_dist': 200.0,
                                              'std_dist': 10.0, 'min_dist': 180,
                                              'max_dist': 220, 'nb_forms': 1}})
        self.assertNotEqual(id1, id2)
        count = self.conn.execute("SELECT COUNT(*) FROM canons").fetchone()[0]
        self.assertEqual(count, 2)
        c1 = self.conn.execute("SELECT count FROM canons WHERE text_id=?", (id1,)).fetchone()[0]
        c2 = self.conn.execute("SELECT count FROM canons WHERE text_id=?", (id2,)).fetchone()[0]
        self.assertEqual(c1, 2)
        self.assertEqual(c2, 3)


# ─────────────────────────────────────────────────────────────────────────────
# Tests avec spaCy (ignorés si spaCy absent)
# ─────────────────────────────────────────────────────────────────────────────

try:
    import spacy
    SPACY_AVAILABLE = True
except ImportError:
    SPACY_AVAILABLE = False


@unittest.skipUnless(SPACY_AVAILABLE, "spaCy non installé — tests ignorés")
class TestAvecSpacy(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        from text_analyzer import load_spacy
        cls.nlp = load_spacy()

    def test_tokenize_retourne_des_tokens(self):
        from text_analyzer import tokenize
        text = "Le chat mange la souris. Le chien dort."
        tokens, total_words = tokenize(text, self.nlp)
        self.assertGreater(len(tokens), 0)
        self.assertGreater(total_words, 0)

    def test_canons_en_minuscules(self):
        from text_analyzer import tokenize
        text = "Le Président parle. Un président écoute."
        tokens, _ = tokenize(text, self.nlp)
        for canon, form, offset, _ in tokens:
            self.assertEqual(canon, canon.lower(), f"Canon non lowercase : {canon}")

    def test_offsets_dans_le_texte(self):
        from text_analyzer import tokenize
        text = "Il fait beau aujourd'hui. Il fera beau demain."
        tokens, _ = tokenize(text, self.nlp)
        for canon, form, offset, _ in tokens:
            self.assertGreaterEqual(offset, 0)
            self.assertLess(offset, len(text),
                            f"Offset {offset} hors texte (len={len(text)})")

    def test_offset_correspond_au_mot_dans_le_texte(self):
        from text_analyzer import tokenize
        text = "Bonjour monde. Comment allez vous."
        tokens, _ = tokenize(text, self.nlp)
        for canon, form, offset, _ in tokens:
            extrait = text[offset: offset + len(form)].lower()
            self.assertEqual(extrait, form,
                             f"'{form}' attendu à offset {offset}, trouvé '{extrait}'")

    def test_lemmatisation_formes_verbales(self):
        from text_analyzer import tokenize
        text = "Il fait cela. Il ferait cela demain. En faisant cela hier."
        tokens, _ = tokenize(text, self.nlp)
        canons = {t[0] for t in tokens if t[1] in ('fait', 'ferait', 'faisant')}
        self.assertLessEqual(len(canons), 2,
                             f"Trop de canons distincts pour fait/ferait/faisant : {canons}")

    def test_word_idx_croissant(self):
        from text_analyzer import tokenize
        text = "Un deux trois quatre cinq six sept huit neuf dix."
        tokens, _ = tokenize(text, self.nlp)
        indices = [t[3] for t in tokens]
        self.assertEqual(indices, sorted(indices))
        self.assertEqual(indices, list(range(len(indices))))

    def test_pipeline_complet(self):
        from text_analyzer import tokenize, compute_canon_stats, compute_page_density
        text = ("Le chat mange la souris verte. " * 10 +
                "Le grand chat court après la petite souris. " * 5)
        tokens, total_words = tokenize(text, self.nlp)
        stats   = compute_canon_stats(tokens)
        density = compute_page_density(tokens)
        self.assertIn('chat', stats)
        self.assertGreater(stats['chat']['count'], 1)
        self.assertIsNotNone(stats['chat']['avg_dist'])

    def test_pipeline_complet_avec_db(self):
        from text_analyzer import tokenize, compute_canon_stats, compute_page_density
        text = "Il fait beau. Il fera beau encore. Il faisait beau avant. " * 20
        tokens, total_words = tokenize(text, self.nlp)
        stats   = compute_canon_stats(tokens)
        density = compute_page_density(tokens)
        conn = sqlite3.connect(':memory:')
        conn.executescript(SCHEMA)
        conn.commit()
        text_id = save(
            conn,
            author='Test', title='Test Pipeline', year=2026, lang='fr',
            source='test.txt', analyzed_at='2026-06-16T00:00:00',
            total_chars=len(text), total_words=total_words,
            total_pages=(total_words // PAGE_SIZE) + 1,
            canon_stats=stats, page_density=density,
        )
        count = conn.execute(
            "SELECT COUNT(*) FROM canons WHERE text_id=?", (text_id,)
        ).fetchone()[0]
        self.assertGreater(count, 0)
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# Tests d'intégration sur fichiers réels
# ─────────────────────────────────────────────────────────────────────────────

@unittest.skipUnless(SPACY_AVAILABLE, "spaCy non installé — tests ignorés")
class TestIntegration(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        from text_analyzer import load_spacy
        cls.nlp = load_spacy()

    TMP = Path(__file__).parent / '_tmp'

    @classmethod
    def setUpClass(cls):
        from text_analyzer import load_spacy
        cls.nlp = load_spacy()
        cls.TMP.mkdir(exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.TMP, ignore_errors=True)

    def _run(self, fixture_name):
        path     = FIXTURES / fixture_name
        db_path  = self.TMP / (fixture_name + '.db')
        json_path= self.TMP / (fixture_name + '.json')
        result   = analyze(path, author='Test', title=fixture_name, year=2026, lang='fr',
                           db_path=db_path, json_path=json_path, nlp=self.__class__.nlp)
        result['expected'] = parse_poids_expected(path)
        return result

    def _check_outputs(self, r):
        """Vérifie que SQLite et JSON ont été produits et sont cohérents."""
        self.assertTrue(r['db_path'].exists(),   "Fichier SQLite absent")
        self.assertTrue(r['json_path'].exists(),  "Fichier JSON absent")
        jdata = json.loads(r['json_path'].read_text(encoding='utf-8'))
        self.assertEqual(jdata['total_words'], r['total_words'])
        self.assertEqual(len(jdata['canons']), len(r['canon_stats']))
        conn = sqlite3.connect(r['db_path'])
        count = conn.execute("SELECT COUNT(*) FROM canons WHERE text_id=?",
                             (r['text_id'],)).fetchone()[0]
        conn.close()
        self.assertEqual(count, len(r['canon_stats']))

    def test_fichier_vide(self):
        r = self._run('vide.txt')
        self.assertEqual(r['text'].strip(), "")
        self.assertEqual(len(r['tokens']), 0)
        self.assertEqual(r['total_words'], 0)
        self.assertEqual(len(r['canon_stats']), 0)
        self.assertEqual(len(r['page_density']), 0)
        self._check_outputs(r)

    def test_fichier_100_pourcent_commentaire(self):
        r = self._run('commentaire-seul.txt')
        self.assertEqual(r['text'].strip(), "")
        self.assertEqual(r['total_words'], 0)
        self._check_outputs(r)

    def test_un_seul_mot(self):
        r = self._run('un-mot.txt')
        self.assertEqual(r['total_words'], 1)
        canon = list(r['canon_stats'].keys())[0]
        self.assertEqual(r['canon_stats'][canon]['count'], 1)
        self.assertIsNone(r['canon_stats'][canon]['avg_dist'])
        self._check_outputs(r)
        assert_poids_expected(self, r['expected'], r['canon_stats'],
                              r['page_density'], r['total_words'], len(r['canon_stats']))

    def test_hapax_aucun_canon_repete(self):
        r = self._run('hapax.txt')
        for canon, s in r['canon_stats'].items():
            self.assertEqual(s['count'], 1,
                f"Canon '{canon}' apparaît {s['count']} fois — attendu 1")
        self.assertEqual(len(r['page_density']), 0)
        self._check_outputs(r)
        assert_poids_expected(self, r['expected'], r['canon_stats'],
                              r['page_density'], r['total_words'], len(r['canon_stats']))

    def test_repetition_proche_detectee(self):
        r = self._run('repetition-proche.txt')
        canons_repetes = {c: s for c, s in r['canon_stats'].items() if s['count'] >= 2}
        self.assertGreater(len(canons_repetes), 0, "Aucune répétition détectée")
        self._check_outputs(r)
        assert_poids_expected(self, r['expected'], r['canon_stats'],
                              r['page_density'], r['total_words'], len(r['canon_stats']))

    def test_commentaire_dans_texte_ignore(self):
        r = self._run('commentaire-dans-texte.txt')
        self.assertIn('obscur', r['canon_stats'], "Canon 'obscur' absent")
        self.assertEqual(r['canon_stats']['obscur']['count'], 2,
            f"'obscur' doit apparaître 2 fois, trouvé {r['canon_stats'].get('obscur', {}).get('count')}")
        self._check_outputs(r)
        assert_poids_expected(self, r['expected'], r['canon_stats'],
                              r['page_density'], r['total_words'], len(r['canon_stats']))

    def test_all_fixtures(self):
        """Découverte automatique de tous les .txt dans fixtures/."""
        for path in sorted(FIXTURES.glob('*.txt')):
            # Pré-extraire test-title sans validation complète (pour label subTest)
            raw = path.read_text(encoding='utf-8')
            m   = re.search(r'/\*\*\*\s*EXPECTECTATIONS\s*:\s*(\{.*?\})\s*\*\*\*/', raw, re.DOTALL)
            title = path.name
            if m:
                try:
                    title = json.loads(m.group(1)).get('test-title', path.name)
                except (json.JSONDecodeError, KeyError):
                    pass
            with self.subTest(fixture=title, file=path.name):
                expected = parse_poids_expected(path)
                r = self._run(path.name)
                self._check_outputs(r)
                assert_poids_expected(self, expected, r['canon_stats'],
                                      r['page_density'], r['total_words'], len(r['canon_stats']))


# ─────────────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    import argparse as _ap
    parser = _ap.ArgumentParser(add_help=False)
    parser.add_argument('-k', '--keep', action='store_true',
                        help='Conserver les fichiers _tmp/ après les tests')
    known, _ = parser.parse_known_args()

    if known.keep:
        TestIntegration.tearDownClass = classmethod(lambda cls: None)
        print(f"({_Y}mode -k : _tmp/ conservé{_X})\n")

    print(f"{_B}PAGE_SIZE{_X} = {PAGE_SIZE} mots/page  |  "
          f"{_B}spaCy{_X} : {'oui' if SPACY_AVAILABLE else _R+'non'+_X}")

    loader = unittest.TestLoader()
    suite  = loader.loadTestsFromModule(sys.modules[__name__])
    result = ColorTestRunner().run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
