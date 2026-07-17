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

# NSWindowStyleMaskTitled = 1 (constante stable macOS) — même mécanisme que
# app/prox_pywebview.py::_set_titlebar, porté ici (existait déjà là-bas, manqué par une recherche
# trop étroite — cf. session 2026-07-15).
_TITLED_MASK = 1


def _log_titlebar(msg: str) -> None:
    # Instrumentation temporaire (2026-07-16) : l'app meurt systématiquement au moment où
    # _set_titlebar(..., True) est appelé (~4-6s, fin de _load_model) — sans trace Python, ce qui
    # évoque un fatal côté ObjC dans le bloc async (le try/except autour de la programmation du
    # bloc ne peut rien attraper de ce qui se passe DANS le bloc, exécuté plus tard sur la main
    # queue). Ces logs servent à voir jusqu'où le bloc va avant que le process ne meure.
    with open('/tmp/prox_test_debug.log', 'a', encoding='utf-8') as f:
        f.write(f"[PY {time.time():.3f}] TITLEBAR {msg}\n")


def _set_titlebar(ns_win, visible: bool):
    """Affiche ou cache la barre de titre via PyObjC (main thread requis)."""
    try:
        from Foundation import NSOperationQueue
        mask = ns_win.styleMask()
        new_mask = (mask | _TITLED_MASK) if visible else (mask & ~_TITLED_MASK)
        _log_titlebar(f"programmation bloc, visible={visible}, mask={mask} -> {new_mask}")

        def _apply():
            _log_titlebar("bloc: avant setStyleMask_")
            try:
                ns_win.setStyleMask_(new_mask)
            except Exception as e:
                _log_titlebar(f"bloc: EXCEPTION Python {e!r}")
                raise
            _log_titlebar("bloc: apres setStyleMask_")

        NSOperationQueue.mainQueue().addOperationWithBlock_(_apply)
        _log_titlebar("bloc programme (addOperationWithBlock_ est revenu)")
    except Exception as e:
        _log_titlebar(f"EXCEPTION Python (programmation) {e!r}")


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import webview
from app.engine import ProxEngine
from app import config, db
from app.spacy_model import load_best_model

STATIC_DIR = Path(__file__).resolve().parent / "static"
TEXTE_SOURCE = Path(__file__).resolve().parent.parent / "assets" / "texte-modele.txt"
DB_PATH = TEXTE_SOURCE.with_suffix(".db")

WINDOW_TOKENS = 7200  # tokens chargés à partir du point de départ (visible + portion cachée pour
# les proximités) — remplace le découpage par nombre de caractères (VISIBLE_LEN/HIDDEN_AFTER,
# supprimés 2026-07-16 : un compte de caractères ne tombe jamais forcément sur une frontière de
# mot, d'où les mots coupés en début/fin de fenêtre). Le partage visible/caché (anciennement
# 1500/1500/2000) se fait maintenant côté JS, par accumulation d'offset token par token — jamais
# en tranchant une chaîne de caractères.

# Débogage/tests (2026-07-15) : force le démarrage sur ce token (id de `tokens`) au lieu de la
# position 0 — sert à observer le comportement ailleurs que dans le tout premier segment. None =
# comportement normal (position 0). N'existe que si ce token a déjà été vu dans un segment
# analysé précédemment (la base ne couvre pas encore tout le livre d'un coup).
DEBUG_START_TOKEN_ID = 356


class TestAPI:
    def __init__(self):
        self._nlp = None
        self._window = None
        self._db  = db.open_document_db(DB_PATH)
        self._session_id = None  # id de la ligne historique_lecture de cette ouverture

    def _set_window(self, window):
        self._window = window

    def load_window(self) -> dict:
        """Charge WINDOW_TOKENS tokens depuis un id de départ (0 en usage normal,
        DEBUG_START_TOKEN_ID en test/débogage) — jamais un découpage du texte brut par
        caractères : chaque ligne de `tokens` EST un token entier, donc aucune coupure possible
        en tête ni en fin de fenêtre. Le partage visible/caché et le calcul des proximités se
        font côté JS (cf. test.js) à partir de ces tokens bruts.
        Limite connue (signalée, pas résolue) : si DEBUG_START_TOKEN_ID n'a pas encore été vu
        dans un segment déjà analysé, retombe sur le premier token actuellement en base — pas
        sur le tout début du livre, que la base ne couvre pas forcément.
        Cas `tokens` totalement vide (tout premier lancement sur cette base) : bootstrap borné —
        tokenise un fragment généreux (pas le livre entier, cf. __SPEC__.md) du début du fichier
        pour peupler `tokens` avant de relire la fenêtre. Seul endroit de ce fichier qui attend
        encore le modèle spaCy (self._nlp) ; sans effet sur les lancements suivants, une fois la
        base peuplée."""
        requested = DEBUG_START_TOKEN_ID if DEBUG_START_TOKEN_ID is not None else 0
        start = requested
        tokens = db.tokens_from(self._db, start, WINDOW_TOKENS)
        if not tokens and db.first_token_id(self._db) is None:
            self.debug_log("PY load_window: base tokens vide, bootstrap depuis le fichier source")
            while self._nlp is None:
                time.sleep(0.05)
            texte = TEXTE_SOURCE.read_text(encoding="utf-8")
            budget = WINDOW_TOKENS * 8  # marge large (~8 caractères/token, espaces inclus)
            fragment = texte[:budget]
            frag_tokens = list(self._nlp(fragment))
            if len(fragment) < len(texte):
                frag_tokens = frag_tokens[:-1]  # dernier token potentiellement tronqué par la coupe
            db.replace_tokens(self._db, frag_tokens)
            tokens = db.tokens_from(self._db, start, WINDOW_TOKENS)  # retente le point demandé
        if not tokens and start != 0:
            self.debug_log(f"PY load_window: token {start} absent de la base, retombe sur first_token_id")
            start = db.first_token_id(self._db) or 0
            tokens = db.tokens_from(self._db, start, WINDOW_TOKENS)
        # total_chars/start_offset : uniquement pour affichage (pageline du footer) — jamais pour
        # découper le texte brut (cf. suppression d'offset_of_mot 2026-07-16, toujours valable).
        total_chars = len(TEXTE_SOURCE.read_text(encoding="utf-8"))
        start_offset = db.char_offset_before(self._db, start) if tokens else 0
        # TOKENS/firstTokenId : noms attendus par textRender() (test.js) — start = id du premier
        # token réellement chargé (recalculé plus haut si repli sur first_token_id).
        return {'TOKENS': tokens, 'total_chars': total_chars, 'start_offset': start_offset,
                'firstTokenId': start}

    def debug_log(self, msg: str) -> None:
        # msg vient déjà préfixé "[Nms] ..." côté JS (performance.now()) — préfixe ici avec
        # time.time() (horloge Python) pour situer un délai côté IPC pywewbview <-> Python, pas
        # seulement côté DOM/JS.
        with open('/tmp/prox_test_debug.log', 'a', encoding='utf-8') as f:
            f.write(f"[PY {time.time():.3f}] {msg}\n")

    def _load_model(self):
        self._nlp = load_best_model()
        if self._window is not None:
            _set_titlebar(self._window.native, True)

    def is_model_ready(self) -> bool:
        return self._nlp is not None

    def analyze(self, text: str) -> list:
        """Analyse le texte et retourne les proximités."""
        self.debug_log(f"PY analyze: entree, len={len(text)}, nlp={'ok' if self._nlp else 'None'}")
        if not self._nlp or not text.strip():
            self.debug_log("PY analyze: sortie anticipee (pas de nlp ou texte vide)")
            return []
        try:
            engine = ProxEngine(self._nlp, config.SEUIL_DEFAUT)
            self.debug_log("PY analyze: ProxEngine cree")
            engine.load_text(text)
            self.debug_log("PY analyze: load_text termine")
            # Doc spaCy récupéré séparément (engine.py ne l'expose pas, et ne doit pas être
            # modifié) : re-tokenise le même texte, coût redondant mais nécessaire pour avoir
            # TOUS les tokens (mots+ponctuation), pas seulement ceux qu'engine.index a retenus.
            doc = self._nlp(text)
            db.replace_tokens(self._db, doc)
            self.debug_log("PY analyze: base tokens/canons mise a jour")
            prox = engine.get_repetitions()  # nom imposé par engine.py, ne pas modifier
            self.debug_log(f"PY analyze: get_repetitions termine, {len(prox)} prox")

            taux = db.prox_taux(prox, config.SEUIL_DEFAUT)
            if self._session_id is None:
                self._session_id = db.start_session(self._db, db.first_token_id(self._db), len(prox), taux)
                self.debug_log(f"PY analyze: historique_lecture demarree, id={self._session_id}")
            else:
                db.update_session_end(self._db, self._session_id, len(prox), taux)
                self.debug_log(f"PY analyze: historique_lecture mise a jour (fin), id={self._session_id}")
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
            for r in prox
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

    api._set_window(window)

    def on_loaded():
        _set_titlebar(window.native, False)
        threading.Thread(target=api._load_model, daemon=True).start()

    window.events.loaded += on_loaded
    webview.start(debug=False)


if __name__ == '__main__':
    main()
