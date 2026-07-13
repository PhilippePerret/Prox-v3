"""Construit une fois pour toutes l'analyse spaCy du texte source (texte.txt, dans ce même
dossier) et la sauve dans spacy_cache.json. Les 12 bancs d'essai (bench.py / bench.js)
rechargent ce fichier — spaCy ne tourne jamais dans la boucle chronométrée d'un banc.

Le canon (lemme, minuscule) est calculé pour chaque token éligible à la détection de
proximité — même filtre que ProxEngine.load_text (app/engine.py, non modifié) : alpha et
(longueur > 3 ou verbe/auxiliaire). Token non éligible -> canon = sa propre forme, en
minuscules (un canon n'est jamais vide).

Lancer une seule fois (ou après changement de texte.txt) :
  /opt/homebrew/opt/python@3.11/bin/python3.11 _dev/bench-offsets/lib/build_spacy_cache.py
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE_TXT = HERE / "texte.txt"
CACHE_JSON = HERE / "spacy_cache.json"


def main():
    import spacy

    text = SOURCE_TXT.read_text(encoding="utf-8")

    nlp = None
    for model in ('fr_core_news_lg', 'fr_core_news_md', 'fr_core_news_sm'):
        try:
            nlp = spacy.load(model, disable=['parser', 'ner'])
            break
        except OSError:
            continue
    if nlp is None:
        sys.exit("Aucun modèle spaCy français trouvé (fr_core_news_lg/md/sm).")

    nlp.max_length = len(text) + 10
    doc = nlp(text)

    tokens = []
    for t in doc:
        is_verb = t.pos_ in ('VERB', 'AUX')
        eligible = t.is_alpha and (len(t.text) > 3 or is_verb)
        canon = t.lemma_.lower() if eligible else t.text.lower()
        # [forme, offset, espace_suivante, canon]
        tokens.append([t.text, t.idx, t.whitespace_, canon])

    CACHE_JSON.write_text(json.dumps({
        "source": SOURCE_TXT.name,
        "chars": len(text),
        "tokens": tokens,
    }, ensure_ascii=False), encoding="utf-8")

    print(f"Cache construit : {SOURCE_TXT.name} — {len(text)} caractères, {len(tokens)} tokens spaCy")
    print(f"-> {CACHE_JSON}")


if __name__ == '__main__':
    main()
