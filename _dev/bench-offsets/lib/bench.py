"""Bancs d'essai PY — 6 des 12 tests définis dans README.md :
  READ-FULL-TEXT/SPLIT-SPACE/PY   READ-STREAMING/SPLIT-SPACE/PY
  READ-FULL-TEXT/SPACE-CSS/PY     READ-STREAMING/SPACE-CSS/PY
  READ-FULL-TEXT/SPACE-CALC/PY    READ-STREAMING/SPACE-CALC/PY
Les 6 bancs JS (mêmes noms, suffixe /JS) sont dans bench.js.

Nécessite spacy_cache.json (build_spacy_cache.py, à lancer une fois avant). Pour chaque test,
4 étapes chronométrées séparément (noms imposés par README.md) :
  - Spacy analyse loading : chargement du cache spaCy (+ texte.txt en plus, pour SPLIT-SPACE
    seulement, qui ignore les offsets spaCy mais a besoin du texte brut pour son split() naïf)
  - Tokens Fullfillment   : TOKENS = tokens spaCy + gap propre à la technique + proximité
    (canon identique à moins de 1501 caractères, même logique que ProxEngine.get_repetitions)
  - HTML building         : construction du document HTML final, spans data-canon
  - Html doc loading      : chargement réel de ce document dans un navigateur (pywebview,
    déjà une dépendance du projet), jusqu'à l'évènement `loaded`

  /opt/homebrew/opt/python@3.11/bin/python3.11 _dev/bench-offsets/lib/bench.py
"""
import json
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE_TXT = HERE / "texte.txt"
CACHE_JSON = HERE / "spacy_cache.json"
CHUNK_SIZE = 65536


def read_full(path):
    return path.read_text(encoding="utf-8")


def read_streaming(path):
    parts = []
    with path.open("r", encoding="utf-8") as f:
        while True:
            chunk = f.read(CHUNK_SIZE)
            if not chunk:
                break
            parts.append(chunk)
    return "".join(parts)


def load_cache_full(path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_cache_streaming(path):
    return json.loads(read_streaming(path))


LOAD_MODES = (
    ("READ-FULL-TEXT", read_full, load_cache_full),
    ("READ-STREAMING", read_streaming, load_cache_streaming),
)


# ─── Techniques — Tokens Fullfillment (identique en JS) ───────────────────────

def split_space_tokens(text, spacy_tokens):
    """SPLIT-SPACE : split('\\n') puis split(' '), n'utilise pas les offsets spaCy pour le gap
    — mais réutilise le canon déjà calculé dans le cache spaCy (le canon est un fait linguistique,
    pas un offset ; le reste (gap) reste 100% indépendant de spaCy). Si le découpage naïf ne
    retombe pas exactement sur un offset spaCy (ponctuation collée différemment), fallback sur
    la forme elle-même en minuscules : un canon n'est jamais vide."""
    canon_par_forme_offset = {(f, o): c for f, o, ws, c in spacy_tokens}
    out = []
    offset = 0
    paragraphs = text.split('\n')
    for pi, para in enumerate(paragraphs):
        words = para.split(' ') if para != '' else []
        for wi, forme in enumerate(words):
            gap = 0 if wi == len(words) - 1 else 1
            canon = canon_par_forme_offset.get((forme, offset), forme.lower())
            out.append((forme, offset, gap, canon))
            offset += len(forme) + gap
        if pi < len(paragraphs) - 1:
            offset += 1
    return out


def space_css_tokens(text, spacy_tokens):
    """SPACE-CSS : classe s0/s1 par mot, depuis offset/longueur spaCy déjà en cache."""
    return [(forme, offset, 's1' if ws else 's0', canon) for forme, offset, ws, canon in spacy_tokens]


def space_calc_tokens(text, spacy_tokens):
    """SPACE-CALC : même formule, mais l'espace (chaîne réelle) est le gap porté par le token."""
    return [(forme, offset, ws, canon) for forme, offset, ws, canon in spacy_tokens]


# ─── HTML building (PY seulement — l'équivalent JS construit un DOM, cf. bench.js) ────────────

def html_split_space(tokens_out):
    html = ['<p>']
    for forme, offset, gap, canon in tokens_out:
        html.append(f'<span data-canon="{canon or ""}">{forme}</span>')
        if gap:
            html.append(' ')
    html.append('</p>')
    return ''.join(html)


def html_space_css(tokens_out):
    return ''.join(
        f'<span class="{cls}" data-canon="{canon or ""}">{forme}</span>'
        for forme, offset, cls, canon in tokens_out
    )


def html_space_calc(tokens_out):
    return ''.join(
        f'<span data-canon="{canon or ""}">{forme}</span>{ws}'
        for forme, offset, ws, canon in tokens_out
    )


TECHNIQUES = (
    ("SPLIT-SPACE", split_space_tokens, html_split_space, True),   # True = a besoin du texte brut
    ("SPACE-CSS", space_css_tokens, html_space_css, False),
    ("SPACE-CALC", space_calc_tokens, html_space_calc, False),
)


def charger_dans_navigateur(htmls):
    """Ouvre chaque document HTML dans un vrai navigateur (pywebview, fenêtre cachée) et mesure
    le temps jusqu'à l'évènement `loaded` — le "Html doc loading" de README.md."""
    import webview

    resultats = [None] * len(htmls)
    etat = {"t0": None, "i": 0}

    def on_loaded():
        etat["resultat"] = (time.perf_counter() - etat["t0"]) * 1000
        resultats[etat["i"]] = etat["resultat"]
        etat["i"] += 1
        if etat["i"] < len(htmls):
            etat["t0"] = time.perf_counter()
            window.load_html(htmls[etat["i"]])
        else:
            window.destroy()

    def main():
        window.events.loaded += lambda: on_loaded()
        etat["t0"] = time.perf_counter()
        window.load_html(htmls[0])

    window = webview.create_window('bench', html='<html><body></body></html>', hidden=True)
    webview.start(main)
    return resultats


def main():
    if not CACHE_JSON.exists():
        raise SystemExit(f"Cache manquant : {CACHE_JSON}. Lancer d'abord build_spacy_cache.py.")

    lignes = []       # pour affichage + JSON, sans le Html doc loading (rempli après coup)
    htmls = []         # documents HTML construits, dans l'ordre des 6 tests

    for mode_name, read_text_fn, read_cache_fn in LOAD_MODES:
        for tech_name, tokens_fn, html_fn, besoin_texte in TECHNIQUES:
            t0 = time.perf_counter()
            text = read_text_fn(SOURCE_TXT) if besoin_texte else None
            cache = read_cache_fn(CACHE_JSON)
            spacy_analyse_ms = (time.perf_counter() - t0) * 1000
            spacy_tokens = cache["tokens"]

            t0 = time.perf_counter()
            tokens_out = tokens_fn(text, spacy_tokens)
            tokens_ms = (time.perf_counter() - t0) * 1000

            t0 = time.perf_counter()
            html = html_fn(tokens_out)
            html_ms = (time.perf_counter() - t0) * 1000

            nom = f"{mode_name}/{tech_name}/PY"
            htmls.append(html)
            lignes.append({
                "nom": nom,
                "spacy_analyse_loading_ms": round(spacy_analyse_ms, 1),
                "tokens_fullfillment_ms": round(tokens_ms, 1),
                "html_building_ms": round(html_ms, 1),
                "tokens": len(tokens_out),
                "html_chars": len(html),
            })

    doc_loading_ms = charger_dans_navigateur(htmls)

    print("BANCS D'ESSAIS — PY (6/12)")
    for ligne, doc_ms in zip(lignes, doc_loading_ms):
        ligne["html_doc_loading_ms"] = round(doc_ms, 1)
        ligne["total_ms"] = round(
            ligne["spacy_analyse_loading_ms"] + ligne["tokens_fullfillment_ms"]
            + ligne["html_building_ms"] + ligne["html_doc_loading_ms"], 1)
        print(f"{ligne['nom']:32s} "
              f"Spacy analyse loading {ligne['spacy_analyse_loading_ms']:7.1f} ms | "
              f"Tokens Fullfillment {ligne['tokens_fullfillment_ms']:7.1f} ms | "
              f"HTML building {ligne['html_building_ms']:7.1f} ms | "
              f"Html doc loading {ligne['html_doc_loading_ms']:7.1f} ms | "
              f"total {ligne['total_ms']:8.1f} ms")

    (HERE / "results_python.json").write_text(
        json.dumps(lignes, ensure_ascii=False, indent=2), encoding="utf-8")

    texte_py = HERE.parent / "texte_py.html"
    texte_py.write_text(
        f'<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>{htmls[0]}</body></html>',
        encoding="utf-8")
    print(f"-> {texte_py}")


if __name__ == '__main__':
    main()
