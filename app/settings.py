"""Réglages utilisateur persistés hors du repo (~/Library/Application Support/Proximity/settings.json)."""

import json
from pathlib import Path

SETTINGS_DIR  = Path.home() / "Library" / "Application Support" / "Proximity"
SETTINGS_FILE = SETTINGS_DIR / "settings.json"

DEFAULTS = {
    "exergue_prox_when_cursor_in_mot": False,
}


def load() -> dict:
    if not SETTINGS_FILE.exists():
        return dict(DEFAULTS)
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULTS)
    return {**DEFAULTS, **data}


def save(values: dict) -> None:
    SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(values, indent=2, ensure_ascii=False), encoding="utf-8")


def set_value(key: str, value) -> dict:
    values = load()
    values[key] = value
    save(values)
    return values
