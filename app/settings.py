"""Réglages utilisateur persistés hors du repo (~/Library/Application Support/Proximity/settings.yaml)."""

import yaml
from pathlib import Path

SETTINGS_DIR  = Path.home() / "Library" / "Application Support" / "Proximity"
SETTINGS_FILE = SETTINGS_DIR / "settings.yaml"

DEFAULTS = {
    "exergue_prox_when_cursor_in_mot": False,
}


def load() -> dict:
    if not SETTINGS_FILE.exists():
        return dict(DEFAULTS)
    try:
        data = yaml.safe_load(SETTINGS_FILE.read_text(encoding="utf-8")) or {}
    except (yaml.YAMLError, OSError):
        return dict(DEFAULTS)
    return {**DEFAULTS, **data}


def save(values: dict) -> None:
    # yaml.safe_dump réécrit le fichier entier : les commentaires du settings.yaml existant ne
    # survivent pas à un save() (limitation PyYAML, pas de préservation de commentaires).
    SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(yaml.safe_dump(values, allow_unicode=True, sort_keys=False), encoding="utf-8")


def set_value(key: str, value) -> dict:
    values = load()
    values[key] = value
    save(values)
    return values
