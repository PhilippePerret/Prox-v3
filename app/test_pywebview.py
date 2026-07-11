"""
Prox — lanceur pour les pages de test isolées (app/static/test.html).
Point d'entrée : python -m app.test_pywebview
Ne charge pas spaCy, ne dépend pas de ProxEngine — juste une fenêtre PyWebview
qui affiche test.html, pour valider les comportements DOM un par un.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import webview

STATIC_DIR = Path(__file__).resolve().parent / "static"


class TestAPI:
    def debug_log(self, msg: str) -> None:
        with open('/tmp/prox_test_debug.log', 'a', encoding='utf-8') as f:
            f.write(msg + '\n')


def main():
    webview.create_window(
        title    = "Test — Prox",
        url      = str(STATIC_DIR / "test.html"),
        js_api   = TestAPI(),
        width    = 1000,
        height   = 700,
        min_size = (600, 400),
    )
    webview.start(debug=False)


if __name__ == '__main__':
    main()
