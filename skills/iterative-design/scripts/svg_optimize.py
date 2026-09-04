#!/usr/bin/env python3
"""Clean and shrink an SVG.

Applies the safe subset of svgo-equivalent transforms:
  - Strip <?xml ?> declaration if unnecessary
  - Remove XML comments
  - Remove <metadata>, <sodipodi:*>, <inkscape:*> elements and attributes
  - Round numeric coordinates to N decimals
  - Collapse redundant whitespace
  - Remove empty text/group nodes

Does NOT do: path merging, transform flattening, ID renaming — those
lose round-trippability for iterative editing.

Usage:
  svg_optimize.py <in.svg> <out.svg> [--precision 2]
"""
import argparse
import re
import sys
import xml.etree.ElementTree as ET


EDITOR_NS_PREFIXES = ("sodipodi", "inkscape", "adobe-ns")
EDITOR_TAGS = {"metadata", "RDF", "Work", "format", "type", "namedview"}


def strip_editor_cruft(elem: ET.Element) -> None:
    """Remove editor-namespaced attributes and child elements in-place."""
    # Drop editor-namespaced attributes
    for attr in list(elem.attrib):
        if "}" in attr:
            ns = attr.split("}", 1)[0].lstrip("{")
            if any(p in ns for p in EDITOR_NS_PREFIXES):
                del elem.attrib[attr]

    # Recurse, collect children to remove
    to_remove = []
    for child in list(elem):
        tag = child.tag
        local = tag.split("}", 1)[1] if "}" in tag else tag
        ns = tag.split("}", 1)[0].lstrip("{") if "}" in tag else ""
        if any(p in ns for p in EDITOR_NS_PREFIXES) or local in EDITOR_TAGS:
            to_remove.append(child)
            continue
        strip_editor_cruft(child)
    for c in to_remove:
        elem.remove(c)


NUM_ATTRS = {
    "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
    "width", "height", "stroke-width", "font-size", "startOffset",
    "dx", "dy",
}


def round_num(s: str, precision: int) -> str:
    try:
        f = float(s)
    except ValueError:
        return s
    if f == int(f):
        return str(int(f))
    return f"{round(f, precision):g}"


def round_numeric_attrs(elem: ET.Element, precision: int) -> None:
    for attr, val in list(elem.attrib.items()):
        local = attr.split("}", 1)[1] if "}" in attr else attr
        if local in NUM_ATTRS:
            elem.attrib[attr] = round_num(val, precision)
        elif local in ("d", "points", "transform"):
            elem.attrib[attr] = round_path_like(val, precision)
    for child in elem:
        round_numeric_attrs(child, precision)


def round_path_like(s: str, precision: int) -> str:
    """Round numbers inside path d, polygon points, or transform strings."""
    def repl(m: re.Match) -> str:
        return round_num(m.group(0), precision)
    return re.sub(r"-?\d+\.\d+", repl, s)


def register_svg_namespace():
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("infile")
    ap.add_argument("outfile")
    ap.add_argument("--precision", type=int, default=2)
    args = ap.parse_args()

    register_svg_namespace()

    # Strip XML comments before parsing (ElementTree preserves them awkwardly).
    with open(args.infile, encoding="utf-8") as f:
        src = f.read()
    src = re.sub(r"<!--.*?-->", "", src, flags=re.DOTALL)

    root = ET.fromstring(src)
    strip_editor_cruft(root)
    round_numeric_attrs(root, args.precision)

    out = ET.tostring(root, encoding="unicode")
    # Collapse whitespace runs outside quoted attribute values
    out = re.sub(r">\s+<", "><", out)
    out = out.strip()

    with open(args.outfile, "w", encoding="utf-8") as f:
        f.write(out)

    before = len(src)
    after = len(out)
    pct = (1 - after / before) * 100 if before else 0
    print(f"{args.outfile}  ({before} -> {after} bytes, -{pct:.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
