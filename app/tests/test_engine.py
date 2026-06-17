#!/usr/bin/env python3
"""
Tests — ProxEngine
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app.engine import ProxEngine, Repetition

# ── Couleurs ──────────────────────────────────────────────────────────────────
_G = '\033[92m'; _R = '\033[91m'; _Y = '\033[93m'; _B = '\033[1m'; _X = '\033[0m'

def _label(test):
    s = str(test)
    import re
    m = re.match(r'(test_\w+)', s)
    return m.group(1)[5:].replace('_', ' ') if m else s

class _Result(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self._cls = None; self._shown = 0; self._nko = 0; self._recap = []

    def _head(self, test):
        cls = type(test).__name__
        if cls != self._cls:
            self._cls = cls
            labels = {'TestIndex': 'Index', 'TestRepetitions': 'Répétitions'}
            print(f"\n{_B}{labels.get(cls, cls)}{_X}")

    def addSuccess(self, test):
        super().addSuccess(test)
        self._head(test); self._shown += 1
        print(f"  {_G}✓{_X} {_label(test)}")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._head(test); self._shown += 1; self._nko += 1
        msg = str(err[1]).split('\n')[0]
        print(f"  {_R}✗{_X} {_label(test)}\n    {_R}↳ {msg}{_X}")
        self._recap.append((_label(test), msg))

    def addError(self, test, err):
        super().addError(test, err)
        self._head(test); self._shown += 1; self._nko += 1
        msg = str(err[1]).split('\n')[0]
        print(f"  {_Y}! ERREUR{_X} {_label(test)}\n    {_Y}↳ {msg}{_X}")
        self._recap.append((_label(test), msg))

    def addSkip(self, test, reason): super().addSkip(test, reason)
    def printErrors(self): pass

    def stopTestRun(self):
        if self._recap:
            print(f"\n{_R}{'━'*50}{_X}\n{_R}{_B}Échecs :{_X}")
            for lbl, msg in self._recap:
                print(f"{_R}  ✗ {_B}{lbl}{_X}\n{_R}    ↳ {msg}{_X}")
        n_ok = self._shown - self._nko
        print(f"\n{'─'*50}")
        print(f"{_B}Tests: {self._shown}{_X}  {_G}Success: {n_ok}{_X}  {_R}Failures: {self._nko}{_X}\n")

class _Runner:
    def run(self, suite):
        r = _Result(); r.startTestRun(); suite.run(r); r.stopTestRun(); return r


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _engine(nlp, seuil=1500, profil=None):
    return ProxEngine(nlp, seuil_defaut=seuil, profil=profil or {})


# ─────────────────────────────────────────────────────────────────────────────
# Index
# ─────────────────────────────────────────────────────────────────────────────

class TestIndex(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        import spacy
        cls.nlp = spacy.load('fr_core_news_lg', disable=['parser', 'ner'])

    def test_texte_vide_index_vide(self):
        e = _engine(self.nlp)
        e.load_text("")
        self.assertEqual(e.index, {})

    def test_canon_present(self):
        e = _engine(self.nlp)
        e.load_text("Il fait beau. Il ferait beau.")
        self.assertIn('faire', e.index)

    def test_occurrences_sont_tuples_offset_forme(self):
        e = _engine(self.nlp)
        e.load_text("Le chat dort.")
        for canon, occurrences in e.index.items():
            for occ in occurrences:
                self.assertIsInstance(occ, tuple, f"'{canon}' : occurrence n'est pas un tuple")
                self.assertEqual(len(occ), 2, f"'{canon}' : tuple doit avoir 2 éléments")
                offset, forme = occ
                self.assertIsInstance(offset, int,  f"'{canon}' : offset doit être int")
                self.assertIsInstance(forme,  str,  f"'{canon}' : forme doit être str")

    def test_offset_correspond_a_la_forme_dans_le_texte(self):
        e = _engine(self.nlp)
        text = "Le chat noir dort profondément."
        e.load_text(text)
        for canon, occurrences in e.index.items():
            for offset, forme in occurrences:
                extrait = text[offset: offset + len(forme)].lower()
                self.assertEqual(extrait, forme,
                    f"'{canon}' : forme '{forme}' attendue à offset {offset}, trouvé '{extrait}'")

    def test_plusieurs_occurrences_du_meme_canon(self):
        e = _engine(self.nlp)
        e.load_text("Il fait cela. Il ferait cela. Il faisait cela.")
        self.assertGreaterEqual(len(e.index.get('faire', [])), 2)

    def test_formes_distinctes_preservees(self):
        e = _engine(self.nlp)
        e.load_text("Il fait cela. Il ferait cela. Il faisait cela.")
        formes = {forme for _, forme in e.index.get('faire', [])}
        self.assertGreater(len(formes), 1, "Plusieurs formes de 'faire' attendues")

    def test_reload_remplace_index(self):
        e = _engine(self.nlp)
        e.load_text("Le chat dort.")
        e.load_text("Le chien court.")
        self.assertNotIn('chat', e.index)
        self.assertIn('chien', e.index)


# ─────────────────────────────────────────────────────────────────────────────
# Répétitions
# ─────────────────────────────────────────────────────────────────────────────

class TestRepetitions(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        import spacy
        cls.nlp = spacy.load('fr_core_news_lg', disable=['parser', 'ner'])

    def test_un_seul_mot_pas_de_repetition(self):
        e = _engine(self.nlp)
        e.load_text("Il fait cela.")
        reps = e.get_repetitions()
        self.assertNotIn('faire', [r.canon for r in reps])

    def test_repetition_proche_detectee(self):
        e = _engine(self.nlp, seuil=1500)
        e.load_text("Il marchait. Il marche encore.")
        reps = e.get_repetitions()
        self.assertGreater(len(reps), 0, "Répétition proche attendue")

    def test_repetition_lointaine_ignoree(self):
        e = _engine(self.nlp, seuil=5)
        e.load_text("Il fait cela. Il ferait cela.")
        reps = e.get_repetitions()
        faire_reps = [r for r in reps if r.canon == 'faire']
        self.assertEqual(len(faire_reps), 0, "Distance > seuil=5 → pas de répétition")

    def test_seuil_par_canon_declenche_repetition(self):
        e = _engine(self.nlp, seuil=1500, profil={'mais': 2000})
        # Deux "mais" à ~40 chars d'écart : < 2000 → répétition
        e.load_text("Il veut partir, mais il reste. Mais aussi, il hésite.")
        reps = e.get_repetitions()
        mais_reps = [r for r in reps if r.canon == 'mais']
        self.assertGreater(len(mais_reps), 0)

    def test_seuil_par_canon_ignore_repetition(self):
        e = _engine(self.nlp, seuil=1500, profil={'mais': 5})
        # Deux "mais" à ~40 chars d'écart : > seuil=5 → NON, attendu < seuil
        # Ici distance (~40) > seuil (5) → pas de répétition
        e.load_text("Il veut partir, mais il reste. Mais aussi, il hésite.")
        reps = e.get_repetitions()
        mais_reps = [r for r in reps if r.canon == 'mais']
        self.assertEqual(len(mais_reps), 0)

    def test_repetition_contient_champs_attendus(self):
        e = _engine(self.nlp, seuil=1500)
        e.load_text("Il marchait. Il marche encore.")
        reps = e.get_repetitions()
        self.assertGreater(len(reps), 0)
        r = reps[0]
        self.assertIsInstance(r, Repetition)
        self.assertIsInstance(r.canon,    str)
        self.assertIsInstance(r.forme_a,  str)
        self.assertIsInstance(r.forme_b,  str)
        self.assertIsInstance(r.offset_a, int)
        self.assertIsInstance(r.offset_b, int)
        self.assertIsInstance(r.distance, int)

    def test_distance_est_correcte(self):
        e = _engine(self.nlp, seuil=1500)
        e.load_text("Il marchait. Il marche encore.")
        reps = e.get_repetitions()
        for r in reps:
            self.assertEqual(r.distance, r.offset_b - r.offset_a,
                f"distance doit être offset_b - offset_a")
            self.assertGreater(r.distance, 0)

    def test_offset_a_inferieur_a_offset_b(self):
        e = _engine(self.nlp, seuil=1500)
        e.load_text("Il marchait lentement. Il marche encore vite.")
        reps = e.get_repetitions()
        for r in reps:
            self.assertLess(r.offset_a, r.offset_b,
                f"offset_a doit précéder offset_b")


if __name__ == '__main__':
    loader = unittest.TestLoader()
    suite  = loader.loadTestsFromModule(__import__('__main__'))
    sys.exit(0 if _Runner().run(suite).wasSuccessful() else 1)
