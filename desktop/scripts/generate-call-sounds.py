"""Generate Triscord's original short call cues, without external audio assets."""
from pathlib import Path
import math
import struct
import wave

folder = Path(__file__).resolve().parents[1] / 'assets' / 'call-sounds'
folder.mkdir(parents=True, exist_ok=True)
for name, frequencies in {'join': (520, 780), 'leave': (780, 520),
                          'mute': (440, 330), 'unmute': (330, 660)}.items():
    samples = []
    for frequency in frequencies:
        duration = 0.105
        count = int(48000 * duration)
        for i in range(count):
            t = i / 48000
            envelope = math.sin(math.pi * i / (count - 1)) ** 2
            samples.append(round(32767 * 0.16 * envelope * math.sin(2 * math.pi * frequency * t)))
        samples.extend([0] * 480)
    with wave.open(str(folder / f'{name}.wav'), 'wb') as output:
        output.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
        output.writeframes(struct.pack(f'<{len(samples)}h', *samples))
