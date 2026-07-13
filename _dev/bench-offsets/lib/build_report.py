"""Assemble results_python.json + results_js.json (produits par bench.py et bench.js) en un
seul tableau comparatif : report.html. À lancer après les deux bancs.
  /opt/homebrew/opt/python@3.11/bin/python3.11 _dev/bench-offsets/lib/build_report.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Ordre exact des 12 tests, tel que listé dans README.md.
ORDRE = [
    "READ-FULL-TEXT/SPLIT-SPACE/JS", "READ-FULL-TEXT/SPLIT-SPACE/PY",
    "READ-STREAMING/SPLIT-SPACE/JS", "READ-STREAMING/SPLIT-SPACE/PY",
    "READ-FULL-TEXT/SPACE-CSS/JS", "READ-FULL-TEXT/SPACE-CSS/PY",
    "READ-STREAMING/SPACE-CSS/JS", "READ-STREAMING/SPACE-CSS/PY",
    "READ-FULL-TEXT/SPACE-CALC/JS", "READ-FULL-TEXT/SPACE-CALC/PY",
    "READ-STREAMING/SPACE-CALC/JS", "READ-STREAMING/SPACE-CALC/PY",
]

COLONNES = (
    ("spacy_analyse_loading_ms", "Spacy analyse loading"),
    ("tokens_fullfillment_ms", "Tokens Fullfillment"),
    ("html_building_ms", "HTML building"),
    ("html_doc_loading_ms", "Html doc loading"),
    ("total_ms", "Total"),
)


def main():
    lignes = {}
    for fichier in ("results_python.json", "results_js.json"):
        p = HERE / fichier
        if p.exists():
            for ligne in json.loads(p.read_text(encoding="utf-8")):
                lignes[ligne["nom"]] = ligne

    manquants = [nom for nom in ORDRE if nom not in lignes]

    disponibles = [lignes[nom] for nom in ORDRE if nom in lignes]
    disponibles.sort(key=lambda l: l["total_ms"])

    meilleurs = {
        cle: min(l[cle] for l in disponibles if cle in l)
        for cle, _ in COLONNES
        if any(cle in l for l in disponibles)
    }

    rows_html = []
    for ligne in disponibles:
        cells = ''.join(
            f'<td class="best">{round(ligne[cle])}</td>' if cle in ligne and ligne[cle] == meilleurs.get(cle)
            else (f'<td>{round(ligne[cle])}</td>' if cle in ligne else '<td>—</td>')
            for cle, _ in COLONNES
        )
        rows_html.append(f'<tr><td>{ligne["nom"]}</td>{cells}</tr>')
    for nom in manquants:
        rows_html.append(f'<tr class="manquant"><td>{nom}</td>'
                          + '<td colspan="5">— pas encore lancé —</td></tr>')

    headers = ''.join(f'<th>{titre}</th>' for _, titre in COLONNES)

    html = f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Bancs d'essais — tableau comparatif</title>
<style>
  body {{ font-family: -apple-system, sans-serif; margin: 2em; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ border: 1px solid #ccc; padding: 6px 10px; text-align: right; }}
  th, td:first-child {{ text-align: left; }}
  th {{ background: #222; color: #fff; }}
  tr:nth-child(even) {{ background: #f5f5f5; }}
  tr.manquant td {{ color: #b00; font-style: italic; }}
  td:last-child {{ font-weight: bold; }}
  td.best {{ background: #7be07b; font-weight: bold; }}
</style>
</head>
<body>
<h1>Bancs d'essais — tableau comparatif (12 tests, temps en ms)</h1>
<table>
<thead><tr><th>Test</th>{headers}</tr></thead>
<tbody>
{''.join(rows_html)}
</tbody>
</table>
</body>
</html>
"""
    (HERE.parent / "report.html").write_text(html, encoding="utf-8")
    print(f"-> {HERE.parent / 'report.html'}")
    if manquants:
        print(f"Manquants ({len(manquants)}) : " + ", ".join(manquants))


if __name__ == '__main__':
    main()
