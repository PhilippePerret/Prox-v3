"""
Prox — lanceur pour les pages de test isolées (app/static/test.html).
Point d'entrée : python -m app.test_pywebview
Charge spaCy en arrière-plan (thread, ne bloque pas l'ouverture de la fenêtre) pour exposer
analyze() — pattern copié de app/prox_pywebview.py::ProxAPI, engine.py inchangé.
"""

import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import webview
from app.engine import ProxEngine
from app import config
from app.spacy_model import load_best_model

STATIC_DIR = Path(__file__).resolve().parent / "static"
TEXTE_SOURCE = Path(__file__).resolve().parent.parent / "assets" / "texte-modele.txt"

VISIBLE_LEN = 3000  # 2 pages affichées/éditables
HIDDEN_LEN  = 3000  # portion cachée après, chargée pour les proximités (pas affichée)


class TestAPI:
    def __init__(self):
        self._nlp = None

    def load_window(self) -> dict:
        """Première ouverture : depuis la position 0, pas de portion cachée avant (cf.
        __SPEC__.md). Retourne le texte visible + la fenêtre complète (visible + cachée après)
        à analyser pour les proximités."""
        texte = TEXTE_SOURCE.read_text(encoding="utf-8")
        fenetre = texte[:VISIBLE_LEN + HIDDEN_LEN]
        return {
            'texte_complet': fenetre,
            'fin_visible': min(VISIBLE_LEN, len(fenetre)),
        }

    def debug_log(self, msg: str) -> None:
        # msg vient déjà préfixé "[Nms] ..." côté JS (performance.now()) — préfixe ici avec
        # time.time() (horloge Python) pour situer un délai côté IPC pywewbview <-> Python, pas
        # seulement côté DOM/JS.
        with open('/tmp/prox_test_debug.log', 'a', encoding='utf-8') as f:
            f.write(f"[PY {time.time():.3f}] {msg}\n")

    def _load_model(self):
        self._nlp = load_best_model()

    def is_model_ready(self) -> bool:
        return self._nlp is not None

    def analyze(self, text: str) -> list:
        """Analyse le texte et retourne les répétitions."""
        self.debug_log(f"PY analyze: entree, len={len(text)}, nlp={'ok' if self._nlp else 'None'}")
        if not self._nlp or not text.strip():
            self.debug_log("PY analyze: sortie anticipee (pas de nlp ou texte vide)")
            return []
        try:
            engine = ProxEngine(self._nlp, config.SEUIL_DEFAUT)
            self.debug_log("PY analyze: ProxEngine cree")
            engine.load_text(text)
            self.debug_log("PY analyze: load_text termine")
            reps = engine.get_repetitions()
            self.debug_log(f"PY analyze: get_repetitions termine, {len(reps)} reps")
        except Exception as e:
            import traceback
            self.debug_log(f"PY analyze: EXCEPTION {e!r}\n{traceback.format_exc()}")
            raise
        result = [
            {
                'offset_a': r.offset_a,
                'forme_a':  r.forme_a,
                'offset_b': r.offset_b,
                'forme_b':  r.forme_b,
                'distance': r.distance,
            }
            for r in reps
        ]
        self.debug_log(f"PY analyze: retour, {len(result)} items")
        return result


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
