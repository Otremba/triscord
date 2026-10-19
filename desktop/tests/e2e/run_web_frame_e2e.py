"""End-to-end test of the frameless main window of the new client (no system frame, like Discord).

One triscord-web instance, signed out (the login screen shows the window bar over it), no backend needed. The real
cursor is used for a few seconds (the window is made topmost meanwhile; the cursor goes back where it was):
  1. no system frame: the window has no WS_CAPTION / WS_THICKFRAME and its client area is the whole window;
  2. dragging the bar moves the window (startSystemMove);
  3. dragging the right edge resizes it (startSystemResize);
  4. a double click on the bar maximizes it to the work area (the taskbar stays visible) and another restores it.

Usage (from desktop/): ../.toolchain/venv/Scripts/python.exe tests/e2e/run_web_frame_e2e.py --exe out/build-claude/triscord-web.exe
"""
import argparse
import ctypes
import os
import shutil
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e2e import DESKTOP, TOOLCHAIN  # noqa: E402
from run_web_popout_e2e import top_windows  # noqa: E402

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()


def rect(hwnd):
    r = wintypes.RECT(); user32.GetWindowRect(hwnd, ctypes.byref(r)); return [r.left, r.top, r.right, r.bottom]


def drag(x0, y0, dx, dy):
    user32.SetCursorPos(x0, y0); time.sleep(0.25)
    user32.mouse_event(0x0002, 0, 0, 0, 0); time.sleep(0.3)   # left down
    # A real drag starts with small moves: the page starts the system move after 3px.
    step = (1 if dx > 0 else -1 if dx < 0 else 0, 1 if dy > 0 else -1 if dy < 0 else 0)
    for i in range(1, 5):
        user32.SetCursorPos(x0 + step[0] * i, y0 + step[1] * i); time.sleep(0.05)
    for i in range(1, 11):
        user32.SetCursorPos(x0 + dx * i // 10, y0 + dy * i // 10); time.sleep(0.04)
    time.sleep(0.2)
    user32.mouse_event(0x0004, 0, 0, 0, 0); time.sleep(0.6)   # left up


def double_click(x, y):
    user32.SetCursorPos(x, y); time.sleep(0.2)
    for _ in range(2):
        user32.mouse_event(0x0002, 0, 0, 0, 0); user32.mouse_event(0x0004, 0, 0, 0, 0); time.sleep(0.08)
    time.sleep(1.2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--assets", default=str(DESKTOP / "web" / "dist"))
    args = parser.parse_args()
    work = Path(tempfile.mkdtemp(prefix="triscord-web-frame-"))
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(TOOLCHAIN / "Qt" / "6.8.3" / "mingw_64" / "bin"), str(TOOLCHAIN / "Qt" / "Tools" / "mingw1310_64" / "bin"), env["PATH"]])
    env["TRISCORD_SETTINGS_PATH"] = str(work / "settings")
    process = subprocess.Popen([str(Path(args.exe).resolve()), "--assets", args.assets, "--quit-after", "40"], env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    before = wintypes.POINT(); user32.GetCursorPos(ctypes.byref(before))
    passed, checks = False, {}
    try:
        time.sleep(7)
        windows = top_windows(process.pid)
        hwnd = windows[0][0]
        user32.SetWindowPos(hwnd, -1, 200, 120, 0, 0, 0x0001 | 0x0010)   # topmost, at a known place, no size change
        time.sleep(0.8)
        style = user32.GetWindowLongW(hwnd, -16)
        client = wintypes.RECT(); user32.GetClientRect(hwnd, ctypes.byref(client))
        r0 = rect(hwnd)
        checks["no system frame: no caption or sizing border, client area = window"] = not (style & 0x00C00000) == 0x00C00000 and not (style & 0x00040000) \
            and [client.right, client.bottom] == [r0[2] - r0[0], r0[3] - r0[1]]
        drag(r0[0] + 300, r0[1] + 14, 120, 60)
        r1 = rect(hwnd)
        checks["dragging the bar moves the window"] = abs(r1[0] - r0[0] - 120) <= 4 and abs(r1[1] - r0[1] - 60) <= 4 and r1[2] - r1[0] == r0[2] - r0[0]
        drag(r1[2] - 2, r1[1] + 300, 80, 0)
        r2 = rect(hwnd)
        checks["dragging the right edge resizes it"] = abs((r2[2] - r2[0]) - (r1[2] - r1[0]) - 80) <= 4 and r2[0] == r1[0]
        double_click(r2[0] + 300, r2[1] + 14)
        work_area = wintypes.RECT(); user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(work_area), 0)
        r3 = rect(hwnd)
        zoomed = bool(user32.IsZoomed(hwnd))
        # A frameless Qt window is maximized by geometry: Windows does not flag it IsZoomed, so the rect is what counts.
        checks["double click maximizes to the work area (taskbar visible)"] = r3 == [work_area.left, work_area.top, work_area.right, work_area.bottom]
        double_click(r3[0] + 300, r3[1] + 14)
        r4 = rect(hwnd)
        checks["another double click restores it"] = r4 == r2
        print(f"  rects: start {r0} moved {r1} resized {r2} maximized {r3} (work area {[work_area.left, work_area.top, work_area.right, work_area.bottom]}) restored {r4}", flush=True)
        for name, ok in checks.items():
            print(f"  {'ok' if ok else 'FAIL'}: {name}", flush=True)
        passed = all(checks.values())
    except Exception as error:
        print("FAIL:", error, flush=True)
    finally:
        user32.SetCursorPos(before.x, before.y)
        if process.poll() is None:
            process.kill()
        shutil.rmtree(work, ignore_errors=True)
    print(f"WEB FRAME E2E {'PASSED' if passed else 'FAILED'}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
