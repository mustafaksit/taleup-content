#!/usr/bin/env python3
"""Ses üretimi: edge-tts ile MP3 + kelime zamanlamaları (WordBoundary).

Kullanım:
    pipeline/.venv/bin/python pipeline/generate-audio.py --story content/stories/st-0001.json
    Opsiyonel: --voice en-US-JennyNeural  --levels A1,B2

Her seviye için:
  - content/audio/<seviye>/<id>.mp3
  - content/audio/<seviye>/<id>.timings.json  ([{word,start,end}] saniye)
  - story JSON içindeki cümle audioStart/audioEnd alanları doldurulur.
A1/A2 seviyelerinde konuşma hızı -%10 (daha yavaş ve net).
"""
import argparse
import asyncio
import json
import re
from pathlib import Path

import edge_tts

REPO_ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = REPO_ROOT / "content" / "audio"

DEFAULT_VOICE = "en-US-JennyNeural"
SLOW_LEVELS = {"A1", "A2"}
TICKS_PER_SECOND = 10_000_000  # WordBoundary offsetleri 100ns tick cinsinden gelir

WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’]*")


def sentence_word_count(text: str) -> int:
    return len(WORD_RE.findall(text))


def level_sentences(level_data: dict) -> list[dict]:
    return [s for p in level_data["paragraphs"] for s in p["sentences"]]


def level_full_text(level_data: dict) -> str:
    return " ".join(s["text"] for s in level_sentences(level_data))


async def synthesize(text: str, voice: str, rate: str, mp3_path: Path) -> list[dict]:
    """MP3 yazar, [{word,start,end}] listesi döndürür (saniye)."""
    communicate = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    timings: list[dict] = []
    with open(mp3_path, "wb") as f:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / TICKS_PER_SECOND
                end = (chunk["offset"] + chunk["duration"]) / TICKS_PER_SECOND
                # edge-tts bazen noktalama içeren parçalar döndürür; kelimeleri ayıkla
                for word in WORD_RE.findall(chunk["text"]) or [chunk["text"]]:
                    timings.append({"word": word, "start": round(start, 3), "end": round(end, 3)})
    return timings


def assign_sentence_times(level_data: dict, timings: list[dict]) -> None:
    """Her cümlenin audioStart/audioEnd değerini kelime zamanlamalarından hesaplar."""
    cursor = 0
    total = len(timings)
    for sentence in level_sentences(level_data):
        n = sentence_word_count(sentence["text"])
        if n == 0 or cursor >= total:
            continue
        chunk = timings[cursor : min(cursor + n, total)]
        sentence["audioStart"] = chunk[0]["start"]
        sentence["audioEnd"] = chunk[-1]["end"]
        cursor += n
    if cursor != total:
        print(f"    uyarı: kelime sayısı uyuşmadı (metin {cursor}, timing {total}); "
              f"cümle zamanları en yakın eşleşmeyle atandı")


async def process_level(story: dict, level: str, voice: str) -> None:
    level_data = story["levels"][level]
    level_dir = AUDIO_DIR / level.lower()
    level_dir.mkdir(parents=True, exist_ok=True)
    mp3_path = level_dir / f"{story['id']}.mp3"
    timings_path = level_dir / f"{story['id']}.timings.json"

    rate = "-10%" if level in SLOW_LEVELS else "+0%"
    text = level_full_text(level_data)
    print(f"  {level}: {sentence_word_count(text)} kelime, ses üretiliyor (rate {rate})...")

    timings = await synthesize(text, voice, rate, mp3_path)
    timings_path.write_text(json.dumps(timings, ensure_ascii=False) + "\n")
    assign_sentence_times(level_data, timings)

    text_words = sentence_word_count(text)
    print(f"    MP3: {mp3_path.relative_to(REPO_ROOT)} ({mp3_path.stat().st_size // 1024} KB), "
          f"timing kelime: {len(timings)} / metin kelime: {text_words}")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--story", required=True, help="story JSON yolu")
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--levels", default=None, help="virgüllü seviye listesi, örn. A1,B2")
    args = parser.parse_args()

    story_path = Path(args.story).resolve()
    story = json.loads(story_path.read_text())

    wanted = args.levels.split(",") if args.levels else list(story["levels"].keys())
    print(f"Ses üretimi: {story['id']} — {story['title']} ({', '.join(wanted)})")
    for level in wanted:
        if level not in story["levels"]:
            print(f"  {level}: hikayede yok, atlanıyor")
            continue
        await process_level(story, level, args.voice)

    story_path.write_text(json.dumps(story, ensure_ascii=False, indent=2) + "\n")
    print(f"Story JSON güncellendi: {story_path}")


if __name__ == "__main__":
    asyncio.run(main())
