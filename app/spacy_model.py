"""Détection + cache du modèle spaCy français disponible sur cette machine.

Évite de retenter, à chaque lancement, les modèles absents (fr_core_news_lg/md souvent pas
installés) — utilisé par app/test_pywebview.py et app/prox_pywebview.py.
"""

from pathlib import Path

CANDIDATS  = ('fr_core_news_lg', 'fr_core_news_md', 'fr_core_news_sm')
CACHE_FILE = Path(__file__).resolve().parent / '.spacy_model_cache'


def load_best_model(disable=('parser', 'ner')):
    """Charge le meilleur modèle spaCy français disponible. Essaie d'abord celui du cache
    (dernier qui a fonctionné sur cette machine) ; s'il est absent ou plus installé, reprend la
    liste complète et remet le cache à jour. Retourne None si aucun modèle n'est installé."""
    import spacy

    cached = CACHE_FILE.read_text().strip() if CACHE_FILE.exists() else None
    ordre = ([cached] if cached in CANDIDATS else []) + [m for m in CANDIDATS if m != cached]

    for model in ordre:
        try:
            nlp = spacy.load(model, disable=list(disable))
            CACHE_FILE.write_text(model)
            return nlp
        except OSError:
            continue
    return None
