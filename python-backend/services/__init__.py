"""Runtime service singleton registry (converted to a package in Phase 2).

This module used to be ``services.py``; it is now ``services/__init__.py`` so
the pipeline service can live in ``services/pipeline.py``. All consumers use
plain ``import services`` (never ``from services import X``), so the conversion
is invisible to them.

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

``engine`` is populated by the pipeline runners in ``services/pipeline.py`` (it
is created per job and unloaded by ``_cleanup_pipeline_resources``), not by
``lifespan()``.
"""

uploader = None
vp_manager = None
engine = None
agent_bridge = None
semantic_memory = None
ephemeral_memory = None

# Late-bound callables for the pipeline runners. services/pipeline.py assigns
# these at its own module bottom (after the runner defs exist); pipeline_state.py
# 's start_pipeline_async / start_resumed_pipeline call them via
# `services.<name>`. This avoids an import cycle AND the `__main__` re-execution
# problem (a later `import main` would create a fresh module copy that never runs
# lifespan()).
run_pipeline_async = None
run_resumed_pipeline_async = None
