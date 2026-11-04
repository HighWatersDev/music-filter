"""Builds labelled scenes: speech, sound effects and music in known places and at known levels.

Writes scenes/<n>.wav (48 kHz mono) and scenes/<n>.json with per-0.5 s frame labels.
"""
import glob
import json
import os
import random
import subprocess

import numpy as np
import soundfile as sf
import soxr

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../listening/detector")
RATE = 48000
FRAME = RATE // 2
SEGMENT_SECONDS = 7
SEGMENTS_PER_SCENE = 8
SCENES = 40
SPEECH_DBFS = -26.0
MUSIC_LEVELS_DB = [0, -10, -20, -30]
MUSIC_LIKE_EFFECTS = {"church_bells", "clock_alarm", "chirping_birds", "crickets", "siren", "insects"}
SEGMENT_TYPES = ["S", "SE", "SE", "E", "SM", "SM", "SEM", "M", "EM"]


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)


def active_rms_db(x):
    blocks = x[: len(x) // 480 * 480].reshape(-1, 480)
    levels = 20 * np.log10(np.sqrt((blocks ** 2).mean(axis=1)) + 1e-12)
    active = levels > levels.max() - 30
    return 20 * np.log10(np.sqrt((blocks[active] ** 2).mean()) + 1e-12)


def gain_to(x, target_db, measure=active_rms_db):
    return x * 10 ** ((target_db - measure(x)) / 20)


def load(path):
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    return soxr.resample(audio, rate, RATE) if rate != RATE else audio


def speech_tracks():
    by_speaker = {}
    for path in sorted(glob.glob(os.path.join(WORK, "data/LibriSpeech/test-clean/*/*/*.flac"))):
        by_speaker.setdefault(path.split("/")[-3], []).append(path)
    for speaker, paths in sorted(by_speaker.items()):
        yield speaker, np.concatenate([load(p) for p in paths[:40]])


def effects():
    meta = os.path.join(WORK, "data/ESC-50-master/meta/esc50.csv")
    rows = [line.strip().split(",") for line in open(meta)][1:]
    for filename, _fold, _target, category, *_ in rows:
        yield category, os.path.join(WORK, "data/ESC-50-master/audio", filename)


def stem(path, stream):
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", f"0:{stream}", "-f", "f32le", "-ac", "1",
                          "-ar", str(RATE), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).copy()


def music_clips():
    for path in sorted(glob.glob(os.path.join(WORK, "data/musdb/**/*.stem.mp4"), recursive=True)):
        mixture, drums, bass, other, vocals = (stem(path, i) for i in range(5))
        n = min(map(len, (mixture, drums, bass, other, vocals)))
        name = os.path.basename(path).removesuffix(".stem.mp4")
        yield name, {"accompaniment": drums[:n] + bass[:n] + other[:n], "soft": other[:n], "song": mixture[:n]}


def place(track, clip, start, fade_in=0.0):
    clip = clip[: len(track) - start].copy()
    edge = int(0.02 * RATE)
    ramp = np.ones(len(clip))
    ramp[:edge] = np.linspace(0, 1, edge)
    ramp[-edge:] = np.linspace(1, 0, edge)
    if fade_in:
        n = min(len(clip), int(fade_in * RATE))
        ramp[:n] *= np.linspace(0, 1, n) ** 2
    track[start: start + len(clip)] += clip * ramp
    return clip * ramp


def frame_levels(x, frames):
    padded = np.zeros(frames * FRAME)
    padded[: len(x)] = x[: frames * FRAME]
    power = (padded.reshape(frames, FRAME) ** 2).mean(axis=1)
    return 10 * np.log10(power + 1e-20)


def build(seed, speech, sfx, music):
    rng = random.Random(seed)
    length = SEGMENT_SECONDS * SEGMENTS_PER_SCENE * RATE
    frames = length // FRAME
    tracks = {"speech": np.zeros(length), "effects": np.zeros(length), "music": np.zeros(length)}
    musiclike = np.zeros(frames, dtype=bool)
    segments = []
    speaker, voice = rng.choice(speech)
    voice = gain_to(voice, SPEECH_DBFS)
    voice_pos = rng.randrange(0, max(1, len(voice) - length))
    for index in range(SEGMENTS_PER_SCENE):
        start = index * SEGMENT_SECONDS * RATE
        end = start + SEGMENT_SECONDS * RATE
        kind = rng.choice(SEGMENT_TYPES)
        segment = {"start": index * SEGMENT_SECONDS, "kind": kind}
        if "S" in kind:
            tracks["speech"][start:end] = voice[voice_pos + start: voice_pos + end]
        if "E" in kind:
            category, path = rng.choice(sfx)
            level = SPEECH_DBFS + rng.uniform(-6, 6)
            offset = start + rng.randrange(0, RATE)
            placed = place(tracks["effects"], gain_to(load(path), level), offset)
            if category in MUSIC_LIKE_EFFECTS:
                first, last = offset // FRAME, min(frames, (offset + len(placed)) // FRAME + 1)
                musiclike[first:last] = True
            segment["effect"] = category
        if "M" in kind:
            name, variants = rng.choice(music)
            variant = rng.choice(["accompaniment", "accompaniment", "soft", "song"])
            relative = 0 if kind == "M" else rng.choice(MUSIC_LEVELS_DB)
            fade_in = rng.choice([0.0, 0.0, 3.0])
            clip = gain_to(variants[variant], SPEECH_DBFS + relative, rms_db)
            place(tracks["music"], clip, start, fade_in)
            segment.update(music=name, variant=variant, relativeDb=relative, fadeIn=fade_in)
        segments.append(segment)
    mix = tracks["speech"] + tracks["effects"] + tracks["music"]
    peak = np.abs(mix).max()
    if peak > 0.99:
        mix *= 0.99 / peak
        for key in tracks:
            tracks[key] *= 0.99 / peak
    reference = SPEECH_DBFS + 20 * np.log10(min(1, 0.99 / peak))
    labels = {
        "speaker": speaker,
        "segments": segments,
        "musicDb": (frame_levels(tracks["music"], frames) - reference).round(1).tolist(),
        "effectsDb": (frame_levels(tracks["effects"], frames) - reference).round(1).tolist(),
        "speechDb": (frame_levels(tracks["speech"], frames) - reference).round(1).tolist(),
        "musicLikeEffect": musiclike.tolist(),
    }
    labels_residual = (tracks["effects"] + tracks["music"]).astype(np.float32)
    labels["_residual"] = labels_residual
    return mix.astype(np.float32), labels


def main():
    out = os.path.join(WORK, "scenes")
    os.makedirs(out, exist_ok=True)
    speech = list(speech_tracks())
    sfx = list(effects())
    music = list(music_clips())
    print(f"{len(speech)} speakers, {len(sfx)} effects, {len(music)} music clips")
    for n in range(SCENES):
        mix, labels = build(n, speech, sfx, music)
        sf.write(os.path.join(out, f"{n:02d}.wav"), mix, RATE, subtype="FLOAT")
        sf.write(os.path.join(out, f"{n:02d}.residual.wav"), labels.pop("_residual"), RATE, subtype="FLOAT")
        json.dump(labels, open(os.path.join(out, f"{n:02d}.json"), "w"))
    print(f"wrote {SCENES} scenes to {out}")


if __name__ == "__main__":
    main()
