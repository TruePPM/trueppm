"""Pickle and copy support for the ``slots=True`` dataclasses (#4548).

A dataclass without ``__slots__`` pickles as ``{field: value}`` in ``__dict__``.
``slots=True`` removes ``__dict__``, so without help (a) protocols 0 and 1 refuse
to pickle the class and (b) a pickle written by an unslotted release — a
``ScheduleResult`` holding ``Task`` objects, say — fails to load with
``AttributeError: no attribute '__dict__'``. This decorator keeps the wire format
a plain field dict, in both directions, so a pickle crosses the slots change.

It also installs a straight-line ``__copy__``. ``schedule()`` shallow-copies every
task (``copy.copy``), and the stock slots path goes through ``__reduce_ex__`` and a
Python-level ``setattr`` loop, which cost ~15% of ``schedule()`` at 20k tasks; the
unslotted ``__dict__.update`` was a single C call.
"""

from __future__ import annotations

from dataclasses import MISSING, fields
from typing import Any, TypeVar

_T = TypeVar("_T", bound=type)


def pickle_as_field_dict(cls: _T) -> _T:
    """Make ``cls`` (a ``slots=True`` dataclass) pickle as a ``{field: value}`` dict.

    Args:
        cls: A dataclass declared with ``slots=True``.

    Returns:
        ``cls``, with ``__getstate__`` and ``__setstate__`` installed.
    """
    names = tuple(f.name for f in fields(cls))
    defaults = {
        f.name: f
        for f in fields(cls)
        if f.default is not MISSING or f.default_factory is not MISSING
    }

    def __getstate__(self: Any) -> dict[str, Any]:
        return {n: getattr(self, n) for n in names if hasattr(self, n)}

    def __setstate__(self: Any, state: Any) -> None:
        # ``object.__getstate__`` (used by a slots class with no override) emits
        # ``(dict_state, slots_state)``; accept it as well as the plain dict.
        if isinstance(state, tuple):
            merged: dict[str, Any] = {}
            for part in state:
                if part:
                    merged.update(part)
            state = merged
        # object.__setattr__: frozen dataclasses refuse ``setattr``, and Calendar's
        # ``__setattr__`` would re-normalize a value that is already normalized.
        for n in names:
            if n in state:
                object.__setattr__(self, n, state[n])
            elif n in defaults:
                # A pickle from a release before this field existed: take the default,
                # or the slot would stay unset and raise AttributeError on first read.
                f = defaults[n]
                object.__setattr__(
                    self,
                    n,
                    f.default if f.default is not MISSING else f.default_factory(),  # type: ignore[misc]
                )

    # Generated once per class from its own field names (never from input), so the
    # copy is N plain STORE_ATTRs with no loop or dispatch. A frozen class, or one with
    # its own ``__setattr__`` (Calendar normalizes ``exceptions``), must go through
    # ``object.__setattr__`` instead.
    direct = not cls.__dataclass_params__.frozen and "__setattr__" not in vars(cls)  # type: ignore[attr-defined]
    body = "\n".join(
        f"    n.{n} = s.{n}" if direct else f"    _set(n, {n!r}, s.{n})" for n in names
    )
    namespace: dict[str, Any] = {"_new": object.__new__, "_set": object.__setattr__}
    exec(f"def __copy__(s):\n    n = _new(s.__class__)\n{body}\n    return n\n", namespace)

    setattr(cls, "__getstate__", __getstate__)  # noqa: B010
    setattr(cls, "__setstate__", __setstate__)  # noqa: B010
    setattr(cls, "__copy__", namespace["__copy__"])  # noqa: B010
    return cls
