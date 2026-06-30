from __future__ import annotations

import json
from pathlib import Path
from typing import Any, List, Tuple


def load_yaml(path: str | Path) -> Any:
    raw_lines = Path(path).read_text(encoding="utf-8").splitlines()
    lines: List[Tuple[int, str]] = []
    for raw in raw_lines:
        stripped = _strip_comment(raw).rstrip()
        if not stripped.strip():
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        lines.append((indent, stripped.strip()))
    value, index = _parse_block(lines, 0, 0)
    if index != len(lines):
        raise ValueError(f"Could not parse full YAML file: {path}")
    return value


def _parse_block(lines: List[Tuple[int, str]], index: int, indent: int) -> Tuple[Any, int]:
    if index >= len(lines):
        return {}, index
    current_indent, content = lines[index]
    if current_indent < indent:
        return {}, index
    if content.startswith("- "):
        return _parse_list(lines, index, current_indent)
    return _parse_mapping(lines, index, current_indent)


def _parse_list(lines: List[Tuple[int, str]], index: int, indent: int) -> Tuple[list, int]:
    items = []
    while index < len(lines):
        current_indent, content = lines[index]
        if current_indent != indent or not content.startswith("- "):
            break
        rest = content[2:].strip()
        index += 1
        if rest == "":
            child, index = _parse_block(lines, index, indent + 2)
            items.append(child)
            continue
        if _looks_like_key_value(rest):
            key, value = _split_key_value(rest)
            item = {key: _parse_scalar(value)}
            if value == "" and index < len(lines) and lines[index][0] > indent:
                child, index = _parse_block(lines, index, indent + 2)
                item[key] = child
            if index < len(lines) and lines[index][0] > indent:
                extra, index = _parse_mapping(lines, index, indent + 2)
                item.update(extra)
            items.append(item)
            continue
        items.append(_parse_scalar(rest))
    return items, index


def _parse_mapping(lines: List[Tuple[int, str]], index: int, indent: int) -> Tuple[dict, int]:
    mapping = {}
    while index < len(lines):
        current_indent, content = lines[index]
        if current_indent != indent or content.startswith("- "):
            break
        key, value = _split_key_value(content)
        index += 1
        if value == "":
            child, index = _parse_block(lines, index, indent + 2)
            mapping[key] = child
        else:
            mapping[key] = _parse_scalar(value)
    return mapping, index


def _strip_comment(line: str) -> str:
    in_single = False
    in_double = False
    for i, char in enumerate(line):
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif char == "#" and not in_single and not in_double:
            return line[:i]
    return line


def _looks_like_key_value(value: str) -> bool:
    return ":" in value and not value.startswith(("'", '"'))


def _split_key_value(content: str) -> Tuple[str, str]:
    if ":" not in content:
        raise ValueError(f"Expected key/value pair, got: {content}")
    key, value = content.split(":", 1)
    return key.strip(), value.strip()


def _parse_scalar(value: str) -> Any:
    if value == "":
        return ""
    if value == "[]":
        return []
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(part.strip()) for part in inner.split(",")]
    if value in ("true", "True"):
        return True
    if value in ("false", "False"):
        return False
    if value in ("null", "None"):
        return None
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        if value.startswith('"'):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                pass
        return value[1:-1]
    try:
        return int(value)
    except ValueError:
        return value
