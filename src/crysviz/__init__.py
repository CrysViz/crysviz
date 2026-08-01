"""Python packaging and launch support for CrysViz.

The browser application itself lives in :mod:`crysviz.web`.  Importing this
module deliberately stays small: the optional GUI dependency is imported only
when the command launcher is asked to use it.
"""

from ._payload import Payload

__version__ = "0.1.0"

__all__ = ["Payload", "__version__"]
