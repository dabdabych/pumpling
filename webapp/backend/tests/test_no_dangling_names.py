"""Names the workers use but nobody defines.

A worker is a long-lived process whose interesting code runs minutes or hours
after start-up. Importing the module proves almost nothing: a call to a
function that was deleted sits quietly inside `main` or inside a branch that
only a stuck round reaches, and the first sign of it is a container in a restart
loop on the stand.

That happened on 2026-09-20. The Switchboard machinery was removed and one call
to `_load_admin_vrf_config` stayed behind in `main`. Every test passed, the
module imported, and the phase worker died on start-up fourteen times before
anyone looked.

So this walks the modules and checks that every name they read is one they
could actually resolve: a builtin, an import, a module-level definition, or
something bound inside the function that reads it. It is not a type checker and
does not try to be. It answers one question, the one that bit us.
"""
from __future__ import annotations

import ast
import builtins
import os
import sys

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
_WORKERS = os.path.join(_ROOT, "workers")

MODULES = [
    os.path.join(_WORKERS, "lottery_phase_worker.py"),
    os.path.join(_WORKERS, "events_worker.py"),
    os.path.join(_ROOT, "webapp", "backend", "presentation", "lottery", "lottery_router.py"),
]


def _bound_names(node: ast.AST) -> set[str]:
    """Every name this node binds: assignments, imports, loops, handlers, args."""
    names: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, (ast.Import, ast.ImportFrom)):
            for alias in child.names:
                names.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
            names.add(child.id)
        elif isinstance(child, ast.ExceptHandler) and child.name:
            names.add(child.name)
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(child.name)
        elif isinstance(child, ast.Global) or isinstance(child, ast.Nonlocal):
            names.update(child.names)
    return names


def _arg_names(func: ast.AST) -> set[str]:
    names: set[str] = set()
    for child in ast.walk(func):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            a = child.args
            for arg in [*a.posonlyargs, *a.args, *a.kwonlyargs]:
                names.add(arg.arg)
            if a.vararg:
                names.add(a.vararg.arg)
            if a.kwarg:
                names.add(a.kwarg.arg)
    return names


def _dangling(path: str) -> list[tuple[str, int]]:
    with open(path, encoding="utf-8") as handle:
        tree = ast.parse(handle.read(), filename=path)

    module_level = set(dir(builtins)) | {"__name__", "__file__", "__doc__"}
    module_level |= _bound_names_top_level(tree)

    found: list[tuple[str, int]] = []
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        local = module_level | _bound_names(node) | _arg_names(node)
        for child in ast.walk(node):
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load):
                if child.id not in local:
                    found.append((child.id, child.lineno))
    return found


def _bound_names_top_level(tree: ast.Module) -> set[str]:
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.For, ast.With, ast.Try, ast.If)):
            for child in ast.walk(node):
                if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                    names.add(child.id)
                elif isinstance(child, (ast.Import, ast.ImportFrom)):
                    for alias in child.names:
                        names.add((alias.asname or alias.name).split(".")[0])
    return names


@pytest.mark.parametrize("path", MODULES, ids=lambda p: os.path.basename(p))
def test_every_name_resolves(path: str):
    dangling = _dangling(path)
    assert not dangling, "names with nothing behind them: " + ", ".join(
        f"{name} (line {line})" for name, line in dangling
    )
