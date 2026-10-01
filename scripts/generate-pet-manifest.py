"""List the built-in pet sheets served by the static site."""

import json
import re
from pathlib import Path


root = Path(__file__).resolve().parents[1]
pets = root / "resources" / "pets"
files = sorted(
    file.name
    for file in pets.iterdir()
    if file.is_file() and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.(?:webp|png)", file.name, re.I)
)
(pets / "manifest.json").write_text(json.dumps(files, indent=2) + "\n", encoding="utf-8")
