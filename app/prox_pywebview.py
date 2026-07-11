"""
Proximity — lanceur PyWebview
Point d'entrée : python -m app.prox_pywebview
"""

import re, sys, json
from pathlib import Path

# NSWindowStyleMaskTitled = 1 (constante stable macOS)
_TITLED_MASK = 1

def _set_titlebar(ns_win, visible: bool):
    """Affiche ou cache la barre de titre via PyObjC (main thread requis)."""
    try:
        from Foundation import NSOperationQueue
        mask = ns_win.styleMask()
        new_mask = (mask | _TITLED_MASK) if visible else (mask & ~_TITLED_MASK)
        NSOperationQueue.mainQueue().addOperationWithBlock_(
            lambda: ns_win.setStyleMask_(new_mask)
        )
    except Exception:
        pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import webview
from app.engine import ProxEngine
from app import config

ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets"
STATIC_DIR = Path(__file__).resolve().parent / "static"
TEST_FILE  = ASSETS_DIR / "texte-modele.txt"


class ProxAPI:
    """API Python exposée à JS via window.pywebview.api.*"""

    def __init__(self):
        self._nlp    = None
        self._engine = None
        self._window = None

    # Appelé par PyWebview après création de la fenêtre
    def _set_window(self, window):
        self._window = window

    # ── Chargement spaCy (thread de démarrage) ────────────────────────────────
    def _load_model(self):
        import spacy
        for model in ('fr_core_news_lg', 'fr_core_news_md', 'fr_core_news_sm'):
            try:
                self._nlp = spacy.load(model, disable=['parser', 'ner'])
                break
            except OSError:
                continue
        if self._nlp is None:
            self._window.evaluate_js("alert('Aucun modèle spaCy trouvé.')")
            return

        self._engine = ProxEngine(self._nlp, config.SEUIL_DEFAUT)

        # Charger le texte de test
        if TEST_FILE.exists():
            raw  = TEST_FILE.read_text(encoding='utf-8')
            text = re.sub(r'\s+', ' ', raw).strip()[:6000]  # 4 pages, essais plus rapides
        else:
            text = ''

        words = re.findall(r'\S+', text)
        data  = json.dumps({
            'text':        text,
            'total_words': len(words),
            'total_chars': len(text),
            'seuil':       config.SEUIL_DEFAUT,
        })
        self._window.evaluate_js(f"proxJS.init({data})")
        title = f"Proximity — {TEST_FILE.stem}" if TEST_FILE.exists() else "Proximity"
        self._window.set_title(title)
        _set_titlebar(self._window.native, True)

    # ── API JS → Python : analyse d'un passage ────────────────────────────────
    def analyze(self, text: str) -> list:
        """Analyse le texte et retourne les répétitions."""
        if not self._engine or not text.strip():
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
    api    = ProxAPI()
    window = webview.create_window(
        title      = "",
        url        = str(STATIC_DIR / "index.html"),
        js_api     = api,
        width      = 1879,
        height     = 1284,
        min_size   = (800, 600),
    )
    api._set_window(window)

    def on_loaded():
        import threading
        _set_titlebar(window.native, False)
        try:
            window.native.setAcceptsMouseMovedEvents_(True)
        except Exception:
            pass
        threading.Thread(target=api._load_model, daemon=True).start()

    window.events.loaded += on_loaded
    webview.start(debug=False)


if __name__ == '__main__':
    main()
