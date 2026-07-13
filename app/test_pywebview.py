"""
Prox — lanceur pour les pages de test isolées (app/static/test.html).
Point d'entrée : python -m app.test_pywebview
Charge spaCy en arrière-plan (thread, ne bloque pas l'ouverture de la fenêtre) pour exposer
analyze() — pattern copié de app/prox_pywebview.py::ProxAPI, engine.py inchangé.
"""

import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import webview
from app.engine import ProxEngine
from app import config

STATIC_DIR = Path(__file__).resolve().parent / "static"


class TestAPI:
    def __init__(self):
        self._nlp = None

    def debug_log(self, msg: str) -> None:
        with open('/tmp/prox_test_debug.log', 'a', encoding='utf-8') as f:
            f.write(msg + '\n')

    def _load_model(self):
        import spacy
        for model in ('fr_core_news_lg', 'fr_core_news_md', 'fr_core_news_sm'):
            try:
                self._nlp = spacy.load(model, disable=['parser', 'ner'])
                break
            except OSError:
                continue

    def analyze(self, text: str) -> list:
        """Analyse le texte et retourne les répétitions."""
        if not self._nlp or not text.strip():
            return []
        engine = ProxEngine(self._nlp, config.SEUIL_DEFAUT)
        engine.load_text(text)
        reps = engine.get_repetitions()
        return [
            {
                'offset_a': r.offset_a,
                'forme_a':  r.forme_a,
                'offset_b': r.offset_b,
                'forme_b':  r.forme_b,
                'distance': r.distance,
            }
            for r in reps
        ]


def main():
    api = TestAPI()
    window = webview.create_window(
        title    = "Test — Prox",
        url      = str(STATIC_DIR / "test.html"),
        js_api   = api,
        width    = 2200,
        height   = 1300,
        min_size = (600, 400),
    )

    def on_loaded():
        threading.Thread(target=api._load_model, daemon=True).start()

    window.events.loaded += on_loaded
    webview.start(debug=False)


if __name__ == '__main__':
    main()
