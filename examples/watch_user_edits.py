"""Print your edits in the CrysViz window as you make them.

Change an element, add or remove atoms, select atoms, rotate the view or switch
the renderer in the window: each change is printed about a quarter of a second
after you stop. The script ends after --seconds (default 120) or when you
close the window. Changes made by the script's own commands are never reported.
"""

import argparse
import json

from crysviz import Payload, Viewer

NACL = """NaCl
1.0
5.64 0 0
0 5.64 0
0 0 5.64
Na Cl
4 4
Direct
0 0 0
0 0.5 0.5
0.5 0 0.5
0.5 0.5 0
0.5 0.5 0.5
0.5 0 0
0 0.5 0
0 0 0.5
"""


def report(event) -> None:
    """Called on the viewer's event thread with what changed (the sinceLastCall shape)."""
    changes = event.data or {}
    print(changes.get("note") or json.dumps(changes))


def main(seconds: float) -> None:
    with Viewer([Payload("NaCl.vasp", NACL)]) as v:
        v.on("user_changed", report)
        print(f"Edit the structure in the window; watching for {seconds:g} s.")
        try:
            v.wait(timeout=seconds)
        except TimeoutError:
            pass
        # Anything not yet reported (e.g. an edit in the last moment) is collected here.
        for change in v.take_user_changes():
            print(change.get("note") or json.dumps(change))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seconds", type=float, default=120)
    main(parser.parse_args().seconds)
