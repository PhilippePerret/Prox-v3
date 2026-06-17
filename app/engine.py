"""
ProxEngine — moteur d'analyse des proximités lexicales.

Index : {canon: [(offset, forme), ...]} trié par offset croissant.
Répétition : paire consécutive du même canon dont la distance < seuil effectif.
Seuil effectif d'un canon = profil.get(canon, seuil_defaut).
"""

from dataclasses import dataclass
from collections import defaultdict


@dataclass
class Repetition:
    canon:    str
    forme_a:  str
    offset_a: int
    forme_b:  str
    offset_b: int
    distance: int


class ProxEngine:

    def __init__(self, nlp, seuil_defaut: int = 1500, profil: dict = None):
        self._nlp          = nlp
        self.seuil_defaut  = seuil_defaut
        self._profil       = profil or {}
        self.index: dict   = {}

    def load_text(self, text: str) -> None:
        """Tokenise le texte et reconstruit l'index."""
        idx = defaultdict(list)
        if text:
            doc = self._nlp(text)
            for tok in doc:
                is_verb = tok.pos_ in ('VERB', 'AUX')
                if tok.is_alpha and (len(tok.text) > 3 or is_verb):
                    canon = tok.lemma_.lower()
                    forme = tok.text.lower()
                    idx[canon].append((tok.idx, forme))
        self.index = dict(idx)

    def get_repetitions(self) -> list[Repetition]:
        """Retourne toutes les répétitions détectées dans le texte indexé."""
        reps = []
        for canon, occurrences in self.index.items():
            seuil = self._profil.get(canon, self.seuil_defaut)
            for i in range(len(occurrences) - 1):
                offset_a, forme_a = occurrences[i]
                offset_b, forme_b = occurrences[i + 1]
                distance = offset_b - offset_a
                if distance < seuil:
                    reps.append(Repetition(
                        canon=canon,
                        forme_a=forme_a, offset_a=offset_a,
                        forme_b=forme_b, offset_b=offset_b,
                        distance=distance,
                    ))
        return reps
