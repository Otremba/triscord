"""Exercise shared native signaling via the development tool; local only."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--node", default="node")
    parser.add_argument("--voice-exe", help="Optional native 2/3/10-client voice integration executable")
    parser.add_argument("--screen-exe", help="Optional native room screen/voice integration executable")
    parser.add_argument("--dual-video-exe", help="Native simultaneous camera/screen integration executable")
    args = parser.parse_args()
    fixture = Path(__file__).with_name("signaling_fixture.cjs")
    with tempfile.TemporaryDirectory(prefix="triscord-native-test-") as directory:
        port_file = Path(directory) / "port"
        report_file = Path(directory) / "report.json"
        log_file = Path(directory) / "server.log"
        with log_file.open("w", encoding="utf-8") as log:
            server = subprocess.Popen([args.node, str(fixture), str(port_file)], stdout=log,
                                      stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                deadline = time.monotonic() + 10
                while not port_file.exists():
                    if server.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Local server did not start: " + log_file.read_text(encoding="utf-8"))
                    time.sleep(0.05)
                port = int(port_file.read_text())
                result = subprocess.run([str(Path(args.exe).resolve()), "--signaling-smoke",
                    f"http://127.0.0.1:{port}", "--smoke-report", str(report_file)],
                    timeout=15, capture_output=True, text=True,
                    creationflags=subprocess.CREATE_NO_WINDOW)
                if result.returncode:
                    raise RuntimeError(f"Native smoke exited {result.returncode}: {result.stderr}\n" +
                                       log_file.read_text(encoding="utf-8"))
                report = json.loads(report_file.read_text())
                assert report["connected"] and report["roomJoined"] and report["chatRoundTrip"]
                print(json.dumps(report))
                if args.voice_exe:
                    for count in (2, 3, 10):
                        voice = subprocess.run([str(Path(args.voice_exe).resolve()), f"http://127.0.0.1:{port}", str(count)],
                            timeout=30, capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
                        if voice.returncode:
                            raise RuntimeError(f"Voice integration failed ({count} clients): {voice.stdout}\n{voice.stderr}\n" +
                                               log_file.read_text(encoding="utf-8"))
                        print(voice.stdout.strip())
                if args.screen_exe:
                    screen_output = Path(directory) / "screen-output.txt"
                    screen_errors = Path(directory) / "screen-errors.txt"
                    try:
                        with screen_output.open("w", encoding="utf-8") as output, screen_errors.open("w", encoding="utf-8") as errors:
                            screen = subprocess.run([str(Path(args.screen_exe).resolve()), f"http://127.0.0.1:{port}"],
                                timeout=40, stdout=output, stderr=errors, creationflags=subprocess.CREATE_NO_WINDOW)
                    except subprocess.TimeoutExpired as error:
                        raise RuntimeError("Screen room integration timed out: " + screen_output.read_text(encoding="utf-8") + "\n" +
                                           screen_errors.read_text(encoding="utf-8") + "\n" + log_file.read_text(encoding="utf-8")) from error
                    if screen.returncode:
                        raise RuntimeError("Screen room integration failed: " + screen_output.read_text(encoding="utf-8") + "\n" +
                                           screen_errors.read_text(encoding="utf-8") + "\n" + log_file.read_text(encoding="utf-8"))
                    print(screen_output.read_text(encoding="utf-8").strip())
                if args.dual_video_exe:
                    dual_output = Path(directory) / "dual-output.txt"
                    dual_errors = Path(directory) / "dual-errors.txt"
                    with dual_output.open("w", encoding="utf-8") as output, dual_errors.open("w", encoding="utf-8") as errors:
                        dual = subprocess.run([str(Path(args.dual_video_exe).resolve()), f"http://127.0.0.1:{port}"],
                            timeout=30, stdout=output, stderr=errors, creationflags=subprocess.CREATE_NO_WINDOW)
                    if dual.returncode:
                        raise RuntimeError("Dual video integration failed: " + dual_output.read_text(encoding="utf-8") + "\n" +
                                           dual_errors.read_text(encoding="utf-8") + "\n" + log_file.read_text(encoding="utf-8"))
                    print(dual_output.read_text(encoding="utf-8").strip())
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)


if __name__ == "__main__":
    main()
