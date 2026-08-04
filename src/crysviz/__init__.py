"""Python packaging and launch support for CrysViz.

The browser application itself lives in :mod:`crysviz.web`.  Importing this
module deliberately stays small: the optional GUI dependency is imported only
when the command launcher is asked to use it.
"""

from ._payload import Payload
from ._viewer import (
    BrowserCommandError,
    LoadResult,
    PositionUpdateResult,
    StructureInfo,
    Viewer,
    ViewerClosedError,
    ViewerCommandTimeout,
    ViewerError,
    ViewerEvent,
    ViewerProtocolError,
    ViewerReentrancyError,
    ViewerStartupError,
    show,
)

# Short names are retained as the public error taxonomy.  The longer names
# make tracebacks and type annotations self-explanatory.
StartupError = ViewerStartupError
ClosedViewerError = ViewerClosedError
CommandTimeoutError = ViewerCommandTimeout
ProtocolError = ViewerProtocolError

__version__ = "0.1.0"

__all__ = [
    "Payload", "Viewer", "show", "StructureInfo", "LoadResult", "PositionUpdateResult",
    "ViewerEvent",
    "ViewerError", "ViewerStartupError", "ViewerClosedError", "ViewerCommandTimeout",
    "ViewerProtocolError", "BrowserCommandError", "ViewerReentrancyError", "__version__",
    "StartupError", "ClosedViewerError", "CommandTimeoutError", "ProtocolError",
]
