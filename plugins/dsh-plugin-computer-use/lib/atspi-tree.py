#!/usr/bin/env python3
"""Dump the AT-SPI2 accessibility tree as JSON for dsh-plugin-computer-use.

Reads the a11y bus on the session D-Bus (org.a11y.Bus). Uses the
gi.repository.Atspi GIR shipped with at-spi2-core, so the separate
python-atspi package is not needed.

Usage:
  atspi-tree.py [--app NAME] [--focused] [--max-depth N] [--max-nodes N]

Output (stdout): {"apps": [...], "total_nodes": N, "truncated": bool}
Each node: {"id", "role", "name", "st" (states), "ext" ([x, y, w, h]),
"act" (action names), "text" (leaf text, capped), "ch" (children)}.
Node ids are "appIndex:path" where path is the child-index chain.
"""

import argparse
import json
import signal
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

TEXT_CAP = 240
INTERESTING_STATES = [
    "ACTIVE", "FOCUSED", "FOCUSABLE", "EDITABLE", "ENABLED",
    "CHECKED", "PRESSED", "SELECTED", "EXPANDED", "SENSITIVE",
    "SHOWING", "VISIBLE", "OPAQUE", "MULTI_LINE",
]


class Budget:
    def __init__(self, max_nodes):
        self.max_nodes = max_nodes
        self.count = 0
        self.truncated = False

    def take(self):
        self.count += 1
        if self.max_nodes > 0 and self.count > self.max_nodes:
            self.truncated = True
            return False
        return True


def states_of(obj):
    try:
        state_set = obj.get_state_set()
        names = []
        for state in INTERESTING_STATES:
            try:
                if state_set.contains(getattr(Atspi.StateType, state)):
                    names.append(state.lower())
            except AttributeError:
                continue
        return names
    except Exception:
        return []


def extents_of(obj):
    try:
        rect = obj.get_extents(Atspi.CoordType.SCREEN)
        return [rect.x, rect.y, rect.width, rect.height]
    except Exception:
        return None


def actions_of(obj):
    try:
        count = obj.get_n_actions()
        names = []
        for index in range(count):
            try:
                names.append(obj.get_action_name(index))
            except Exception:
                continue
        return names
    except Exception:
        return []


def text_of(obj):
    try:
        count = obj.get_character_count()
        if count <= 0:
            return None
        return obj.get_text(0, min(count, TEXT_CAP)) or None
    except Exception:
        return None


def walk(obj, path, depth, max_depth, budget):
    if not budget.take():
        return None
    node = {
        "id": f"{path}",
        "role": obj.get_role_name() or "unknown",
        "name": obj.get_name() or "",
        "st": states_of(obj),
        "ext": extents_of(obj),
    }
    actions = actions_of(obj)
    if actions:
        node["act"] = actions
    text = text_of(obj)
    if text:
        node["text"] = text

    children = []
    if depth < max_depth and not budget.truncated:
        try:
            child_count = obj.get_child_count()
        except Exception:
            child_count = 0
        for index in range(child_count):
            try:
                child = obj.get_child_at_index(index)
            except Exception:
                continue
            if child is None:
                continue
            child_node = walk(child, f"{path}.{index}", depth + 1, max_depth, budget)
            if child_node is not None:
                children.append(child_node)
    if children:
        node["ch"] = children
    return node


def has_active(node):
    return "active" in node.get("st", []) or any(has_active(c) for c in node.get("ch", []))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default=None, help="only applications whose name contains NAME (case-insensitive)")
    parser.add_argument("--focused", action="store_true", help="only applications that contain an active window")
    parser.add_argument("--max-depth", type=int, default=12)
    parser.add_argument("--max-nodes", type=int, default=400)
    args = parser.parse_args()

    signal.alarm(25)

    desktop = Atspi.get_desktop(0)
    apps = []
    total = 0
    truncated = False

    for app_index in range(desktop.get_child_count()):
        try:
            app = desktop.get_child_at_index(app_index)
        except Exception:
            continue
        if app is None:
            continue
        name = app.get_name() or ""
        if args.app and args.app.lower() not in name.lower():
            continue

        budget = Budget(args.max_nodes)
        node = walk(app, f"{app_index}", 0, args.max_depth, budget)
        total += budget.count
        truncated = truncated or budget.truncated
        if node is None:
            continue
        if args.focused and not has_active(node):
            continue
        apps.append({"name": name, "node": node, "nodes": budget.count})

    json.dump({"apps": apps, "total_nodes": total, "truncated": truncated}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - report any failure as JSON-free stderr line
        print(f"atspi-tree: {error}", file=sys.stderr)
        sys.exit(1)
