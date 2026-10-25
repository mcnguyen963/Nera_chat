"""Reject private documents and reference-art folders in public pet assets."""

import argparse
import re
from pathlib import Path


def check_pets(pets):
    invalid = []
    for file in pets.rglob("*"):
        if file.name == ".DS_Store" or file.name.endswith(":Zone.Identifier"):
            continue
        if file.is_dir() and not file.is_symlink():
            continue
        allowed = file.parent == pets and (
            file.name == "manifest.json"
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.(?:webp|png)", file.name, re.I)
        )
        if file.is_symlink() or not allowed:
            invalid.append(str(file.relative_to(pets)))
    return sorted(invalid)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pets-dir", type=Path,
        default=Path(__file__).resolve().parents[1] / "resources" / "pets",
    )
    pets = parser.parse_args().pets_dir
    if not pets.is_dir():
        parser.exit(1, "Pet assets directory is missing.\n")
    invalid = check_pets(pets)
    if invalid:
        parser.exit(1, "Private or unsupported public pet assets:\n" + "\n".join(invalid) + "\n")
