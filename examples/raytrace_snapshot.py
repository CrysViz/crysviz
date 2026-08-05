"""Select ray tracing, rotate the view, and save a PNG."""

from pathlib import Path

from crysviz import Payload, Viewer


POSCAR = """Si cell
1.0
5.43 0 0
0 5.43 0
0 0 5.43
Si
1
Direct
0 0 0
"""


def main() -> None:
    output = Path.cwd() / "crysviz-raytrace.png"
    with Viewer([Payload("snapshot.POSCAR", POSCAR)], command_timeout=180) as viewer:
        viewer.set_render_pipeline("raytrace")
        viewer.rotate_camera(18, axis="y")
        written = viewer.save_image(output, width=640, height=480, timeout=180)
    print(f"Saved {written.resolve()}; the CrysViz window has closed.")


if __name__ == "__main__":
    main()
