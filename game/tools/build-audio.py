"""Builds the game's own sound: an original battle theme (synthesized here) and the announcer (Windows speech, lowered).

    python tools/build-audio.py        (run from game/, Windows)
"""
import pathlib
import subprocess
import tempfile
import wave

import numpy as np

OUT = pathlib.Path(__file__).resolve().parent.parent / 'public/assets/audio'
RATE = 22050
rng = np.random.default_rng(26)

LINES = {
    'round1': 'Round one', 'round2': 'Round two', 'round3': 'Round three', 'final-round': 'Final round',
    'fight': 'Begin', 'finish': 'End this', 'knockout': 'Knockout',
}


def save(name: str, x: np.ndarray, peak: float = 0.9) -> None:
    x = x / max(1e-9, np.abs(x).max()) * peak
    with wave.open(str(OUT / f'{name}.wav'), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((x * 32767).astype('<i2').tobytes())


def speak(text: str) -> np.ndarray:
    with tempfile.TemporaryDirectory() as d:
        path = pathlib.Path(d) / 'v.wav'
        script = (
            "Add-Type -AssemblyName System.Speech;"
            "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            "$v=$s.GetInstalledVoices()|?{$_.VoiceInfo.Culture.Name -like 'en*'}|Sort-Object {$_.VoiceInfo.Gender -ne 'Male'}|Select -First 1;"
            "if($v){$s.SelectVoice($v.VoiceInfo.Name)};$s.Rate=-1;"
            f"$s.SetOutputToWaveFile('{path}');$s.Speak('{text}');$s.Dispose()"
        )
        subprocess.run(['powershell', '-NoProfile', '-Command', script], check=True)
        with wave.open(str(path)) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), '<i2').astype(float) / 32768
            src = w.getframerate()
    # A heavy arena voice: slowed down, doubled an octave lower, driven, in a long dark hall.
    def slow(k: float) -> np.ndarray:
        n = int(len(x) * RATE / src / k)
        return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)
    main, low = slow(0.72), slow(0.60)
    low = np.interp(np.linspace(0, len(low) - 1, len(main)), np.arange(len(low)), low)  # same length, rougher
    sub = np.sin(2 * np.pi * 55 * np.arange(len(main)) / RATE) * np.abs(main)
    voice = np.tanh((main + 0.55 * low + 0.5 * sub) * 3.0)
    tail = int(RATE * 1.4)
    t = np.arange(tail) / RATE
    hall = rng.standard_normal(tail) * np.exp(-t * 3.4)
    hall = np.convolve(hall, np.ones(9) / 9, 'same') * 0.035
    size = len(voice) + tail
    wet = np.fft.irfft(np.fft.rfft(voice, size) * np.fft.rfft(hall, size), size)
    hit = np.sin(2 * np.pi * (46 * t + 6 * (1 - np.exp(-t * 30)))) * np.exp(-t * 4)  # a drum under the first word
    out = np.zeros(size)
    out[:len(voice)] += voice
    out += wet
    out[:tail] += hit * 0.6
    return out


def theme() -> np.ndarray:
    """40 bars at 140 bpm, E minor: war drums, double kick, driven power chords, a pulsing bass and a synth lead. Composed for this game."""
    beat = 60 / 140
    bars = 40
    total = int(RATE * beat * 4 * bars)
    drums, low, guitar, lead = (np.zeros(total) for _ in range(4))

    def put(bus: np.ndarray, sound: np.ndarray, at: float, gain: float) -> None:
        i = int(at * RATE)
        n = min(len(sound), total - i)
        if n > 0:
            bus[i:i + n] += sound[:n] * gain

    def saw(freq: float, sec: float, decay: float, partials: int = 10) -> np.ndarray:
        t = np.arange(int(RATE * sec)) / RATE
        x = sum(np.sin(2 * np.pi * freq * k * t + k) / k for k in range(1, partials))
        return x * np.exp(-t * decay) * np.minimum(1, t / 0.004)

    t = np.arange(int(RATE * 0.5)) / RATE
    noise = rng.standard_normal(len(t))
    kick = np.tanh(2.5 * np.sin(2 * np.pi * (46 * t + 11 * (1 - np.exp(-t * 40)))) * np.exp(-t * 13))
    snare = (noise * 0.8 + np.sin(2 * np.pi * 190 * t)) * np.exp(-t * 17)
    taiko = np.tanh(2 * np.sin(2 * np.pi * (62 * t + 5 * (1 - np.exp(-t * 18)))) * np.exp(-t * 7)) + noise * np.exp(-t * 60) * 0.3
    hat = np.diff(noise, prepend=0)[:1400] * np.exp(-np.arange(1400) / 220)
    crash = np.diff(rng.standard_normal(RATE * 2), prepend=0) * np.exp(-np.arange(RATE * 2) / RATE * 2.2)

    midi = lambda n: 440 * 2 ** ((n - 69) / 12)
    roots = [40, 40, 43, 38, 40, 40, 36, 38]
    chug = [0, 1, 1.5, 2, 3, 3.5]
    phrase = [(0, 76, 1), (1, 79, .5), (1.5, 78, .5), (2, 76, 1), (3, 74, 1), (4, 71, 2), (6, 74, 1), (7, 76, 1), (8, 79, 1.5), (9.5, 81, .5), (10, 79, 1), (11, 78, 1), (12, 76, 3)]
    for bar in range(bars):
        at = bar * 4 * beat
        root = roots[bar % 8]
        build = bar < 4
        breakdown = 20 <= bar < 24
        for q in range(4):
            put(drums, taiko, at + q * beat, 0.7 if build or breakdown else 0.35)
            if not build:
                put(drums, kick, at + q * beat, 1.0)
                if q % 2 and not breakdown:
                    put(drums, snare, at + q * beat, 0.55)
                for e in (0, 0.5):
                    put(drums, hat, at + (q + e) * beat, 0.13)
        if not build and bar % 4 == 3:
            for k in range(8):
                put(drums, kick, at + (3 + k / 8) * beat, 0.6)
                put(drums, taiko, at + (3 + k / 8) * beat, 0.12 * k)
        if bar % 8 == 0:
            put(drums, crash, at, 0.35)
        for s in range(16):
            put(low, saw(midi(root - 12 + (12 if s % 8 == 6 else 0)), 0.16, 11), at + s * beat / 4, 0.3)
        if not build:
            for c in chug:
                for interval in (0, 7, 12):
                    put(guitar, saw(midi(root + interval), 0.5 if c in (0, 2) else 0.2, 5, 14), at + c * beat, 0.22)
        if bar >= 8 and bar % 4 == 0 and not breakdown:
            for pos, note, length in phrase:
                for detune in (0.996, 1.004):
                    put(lead, saw(midi(note) * detune, length * beat + 0.1, 2.2, 7), at + pos * beat, 0.16)
    guitar = np.tanh(guitar * 5) * 0.32
    echo = np.zeros(total)
    d = int(beat * 0.75 * RATE)
    echo[d:] = lead[:-d] * 0.35
    return np.tanh(drums * 0.8 + low * 0.7 + guitar + lead + echo)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    for name, text in LINES.items():
        save(name, speak(text))
    save('theme', theme(), 0.8)
    for p in sorted(OUT.glob('*.wav')):
        print(p.name, p.stat().st_size // 1024, 'KB')
