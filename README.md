# taleup-content

TaleUp uygulamasının içerik deposu ve üretim pipeline'ı. Hikayeler, quizler, sesler, kelime zamanlamaları ve kapaklar burada üretilir; GitHub + jsDelivr CDN üzerinden statik olarak sunulur. Backend yoktur, çalışma anında ücretli API yoktur.

## CDN

Yayınlanan her şey şu kökten çekilir:

```
https://cdn.jsdelivr.net/gh/mustafaksit/taleup-content@main/content/
```

Örnek: `content/index.json`, `content/stories/st-0001.json`, `content/audio/a1/st-0001.mp3`, `content/covers/st-0001.webp`

## Kurulum (bir kez)

1. **Node 18+** kurulu olmalı. Repo kökünde:
   ```bash
   npm install
   ```
2. **Python 3.9+** için sanal ortam (edge-tts buradan çalışır):
   ```bash
   python3 -m venv pipeline/.venv
   pipeline/.venv/bin/pip install edge-tts openpyxl
   ```
3. **Gemini API anahtarı** (ücretsiz): https://aistudio.google.com/apikey adresinden alın, repo kökünde `.env` dosyası oluşturun:
   ```
   GEMINI_API_KEY=buraya-anahtar
   ```
   `.env` asla commit edilmez (.gitignore'da).

## Tek komutla hikaye üretimi

```bash
node pipeline/run-all.mjs --genre horror --auto
```

Zincir: Gemini ile 4 seviyeli hikaye + quiz üretimi → NGSL doğrulaması (geçemezse Gemini'ye maks 3 düzeltme turu, yine geçemezse `rejected/`e taşınır) → edge-tts ile MP3 + kelime zamanlamaları → prosedürel kapak → `index.json` güncellemesi.

Geçerli türler: `horror, mystery, adventure, romance, scifi, daily, classic`

Kendi konseptinizle: `--auto` yerine `--title "The Old Key" --concept "Kısa konsept..."`.
Ses adımını atlamak için: `--skip-audio`. Mevcut hikayeyi zincirden geçirmek için: `--story content/stories/st-0001.json`.

## Adım adım (ayrı ayrı çalıştırma)

```bash
node pipeline/generate-story.mjs --genre mystery --auto        # hikaye + quiz JSON
node pipeline/validate-level.mjs --story content/stories/st-0001.json --fix
pipeline/.venv/bin/python pipeline/generate-audio.py --story content/stories/st-0001.json
node pipeline/generate-cover.mjs --story content/stories/st-0001.json
node pipeline/build-index.mjs                                   # contentVersion +1
```

## Yayınlama

```bash
git add -A
git commit -m "content: yeni hikaye st-XXXX"
git push
```

jsDelivr `@main` etiketini 12 saate kadar cache'leyebilir. Anında tazelemek için:
`https://purge.jsdelivr.net/gh/mustafaksit/taleup-content@main/content/index.json`

## Seviye kuralları (validate-level bunları denetler)

| Seviye | Havuz | Maks cümle | Uzunluk |
|---|---|---|---|
| A1 | NGSL ilk 500 + özel isimler | 8 kelime | 250-400 |
| A2 | NGSL ilk 1000 | 12 kelime | 400-600 |
| B1 | NGSL ilk 2000 | 16 kelime | 600-900 |
| B2 | NGSL ilk 2800 | 22 kelime | 900-1400 |

Kural: kelimelerin en az %95'i havuzda olmalı (özel isimler ve NGSL ek listesi — sayılar, günler, aylar — havuza dahildir; çekim ekleri tanınır).

## Kelime listeleri ve lisans

`wordlists/ngsl-*.txt` dosyaları **New General Service List (NGSL) 1.01** kesitleridir
(Browne, C., Culligan, B. & Phillips, J., https://www.newgeneralservicelist.com/ — Creative Commons Attribution 3.0).
Kaynak veri: `NGSL 1.01 with SFI` Excel dosyası; kesitler `Rank` sütununa göre alınmıştır.

Kapak başlık fontu: Bricolage Grotesque (SIL Open Font License, `pipeline/assets/fonts/`).

## Klasör yapısı

```
pipeline/            üretim scriptleri (+ prompts/, lib/, assets/)
content/index.json   ana katalog (contentVersion + adConfig + hikaye listesi)
content/stories/     hikaye JSON'ları (4 seviye, quiz, ses referansları)
content/audio/       a1/a2/b1/b2 MP3 + *.timings.json
content/covers/      600x900 WebP kapaklar
wordlists/           NGSL kesitleri (500/1000/2000/2800 + supplemental)
rejected/            doğrulamayı geçemeyen hikayeler + raporları (commit edilmez)
```
