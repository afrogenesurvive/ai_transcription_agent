"""Runtime service singleton registry (extracted for Phase 0 of the main.py refactor).

main.py is executed as ``python main.py`` — i.e. as the ``__main__`` module, NOT
as an importable ``main`` module. This means helper modules that moved out of
main.py must NOT do ``from main import uploader`` at module top: a later
``import main`` inside a function body would re-execute the whole file (with its
heavy module-level code), and that second copy never runs ``lifespan()``, so its
singletons would stay at ``None``.

Instead, main.py's ``lifespan()`` assigns the live instances here right after
constructing them, and the moved helper modules read them lazily at call time via
``import services; services.<name>``. Because ``import services`` only binds the
module object (not a value), attribute access at call time always sees the
current, populated instances.

Only ``uploader``, ``vp_manager`` and ``ephemeral_memory`` are consumed by the
modules extracted in Phase 0 (reconciliation.py / helpers.py). The rest mirror
main.py's globals for parity and as a stepping stone toward the Phase-4
AppContext/Services container.
"""

uploader = None
vp_manager = None
engine = None
agent_bridge = None
semantic_memory = None
ephemeral_memory = None
