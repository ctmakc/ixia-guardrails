#!/usr/bin/env python3
"""Builds the submission video (MP4, 1920x1080, burned-in subtitles + .srt).

Slides: docs/slides/out/slide-NN.png (run docs/slides/build.py first).
Clips:  screen recordings of the live demo (Playwright webm), dir given by CLIPS env.
Voice:  edge-tts (en-US-AndrewNeural); gTTS if edge-tts is refused.
Usage:  CLIPS=/path/to/rec python3 docs/video/build.py
"""
import json, os, pathlib, re, subprocess, shutil

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SLIDES = ROOT / 'docs/slides/out'
CLIPS = pathlib.Path(os.environ.get('CLIPS', '/data/projects/techex-hack/rec'))
WORK = pathlib.Path(os.environ.get('WORK', '/data/projects/techex-hack/video-work'))
OUT = pathlib.Path(os.environ.get('OUT', '/data/projects/techex-hack/out'))
EDGE = os.environ.get('EDGE_TTS', '/data/venvs/edge-tts/bin/edge-tts')
VOICE, RATE = 'en-US-AndrewNeural', '+4%'
FPS, W, H = 30, 1920, 1080
WORK.mkdir(parents=True, exist_ok=True); OUT.mkdir(parents=True, exist_ok=True)

_lj = ROOT / 'eval/results/latest.json'
S = json.loads((_lj if _lj.exists() else ROOT / 'playground/public/eval.json').read_text())
VARS = {'cases': S['cases'], 'mh_auto': len(S['must_hold']['auto_sent']) or 'None', 'mh_n': S['must_hold']['n'],
        'ms_auto': S['must_send']['auto_sent'], 'ms_n': S['must_send']['n'], 'p50': f"{S['latency_ms']['p50']/1000:.1f}"}
scenes = json.loads((HERE / 'scenes.json').read_text())


def run(*a):
    subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def dur(p):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)]).decode().strip())


def tts(text, mp3):
    if mp3.exists() and mp3.stat().st_size > 1000:
        return
    try:
        run(EDGE, '--voice', VOICE, f'--rate={RATE}', '--text', text, '--write-media', str(mp3))
    except Exception:
        run('gtts-cli', text, '--lang', 'en', '--output', str(mp3))


def chunks(text, n=84):
    words, out, cur = text.split(), [], ''
    for w in words:
        if len(cur) + len(w) + 1 > n and cur:
            out.append(cur); cur = w
        else:
            cur = f'{cur} {w}'.strip()
        if re.search(r'[.!?:]$', w) and len(cur) > 40:
            out.append(cur); cur = ''
    if cur: out.append(cur)
    return out


SPOKEN = {'B G E M 3': 'bge-m3', 'Llama 3.3 seventy B': 'Llama 3.3 70B', 'G P T O S S one twenty B': 'gpt-oss-120b',
          'ixia-guardrails dot pages dot dev': 'ixia-guardrails.pages.dev'}


def written(text):
    for k, v in SPOKEN.items():
        text = text.replace(k, v)
    return text


def ts(t):
    h, r = divmod(t, 3600); m, s = divmod(r, 60)
    return f'{int(h):02d}:{int(m):02d}:{int(s):02d},{int((s % 1) * 1000):03d}'


LABEL = WORK / 'label-wait.png'


def make_label():
    from PIL import Image, ImageDraw, ImageFont
    im = Image.new('RGBA', (560, 64), (12, 15, 22, 215))
    d = ImageDraw.Draw(im)
    try:
        f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 26)
    except Exception:
        f = ImageFont.load_default()
    d.text((22, 16), 'waiting for the models · 4x speed', fill=(240, 243, 248, 255), font=f)
    im.save(LABEL)


def compress_wait(src, m, out):
    """Keeps the click and the result at real speed; plays the model wait faster, labelled."""
    if out.exists():
        return out
    make_label()
    ws, we, total = max(0.0, m['wait_start']), m['wait_end'], dur(src)
    a0 = max(0.0, ws - 2.5)
    sp = max(4.0, (we - ws) / 3.0)
    fc = (f"[0:v]trim={a0:.3f}:{ws:.3f},setpts=PTS-STARTPTS[a];"
          f"[0:v]trim={ws:.3f}:{we:.3f},setpts=(PTS-STARTPTS)/{sp:.3f}[b0];[b0][1:v]overlay=W-w-40:40[b];"
          f"[0:v]trim={we:.3f}:{total:.3f},setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0,fps={FPS}[v]")
    run('ffmpeg', '-y', '-i', str(src), '-i', str(LABEL), '-filter_complex', fc, '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', str(out))
    return out


segs, srt, t0, idx = [], [], 0.0, 1
for i, sc in enumerate(scenes):
    text = sc['text'].format(**VARS)
    mp3 = WORK / f'{i:02d}-{sc["id"]}.mp3'
    tts(text, mp3)
    a = dur(mp3)
    lead, tail = 0.35, 0.65
    d = lead + a + tail
    seg = WORK / f'{i:02d}-{sc["id"]}.mp4'
    if 'slide' in sc:
        img = SLIDES / f'slide-{sc["slide"]:02d}.png'
        run('ffmpeg', '-y', '-loop', '1', '-t', f'{d:.3f}', '-i', str(img), '-vf', f'scale={W}:{H},fps={FPS},format=yuv420p,fade=in:st=0:d=0.25',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', str(seg))
    else:
        clip = CLIPS / f'{sc["clip"]}.webm'
        marks = CLIPS / f'{sc["clip"]}.json'
        if marks.exists():
            clip = compress_wait(clip, json.loads(marks.read_text()), WORK / f'{sc["clip"]}-cw.mp4')
        c = dur(clip)
        speed = 1.0
        if c > d:
            speed = min(c / d, 1.6)
        vf = f'setpts=PTS/{speed:.4f},scale={W}:{H}:flags=lanczos,fps={FPS},format=yuv420p'
        eff = c / speed
        if eff > d:  # still too long: cut the tail (the result has been on screen for a while)
            pre = []
        else:
            pre = []
            vf += f',tpad=stop_mode=clone:stop_duration={d - eff + 0.1:.3f}'
        run('ffmpeg', '-y', *pre, '-i', str(clip), '-vf', vf + ',fade=in:st=0:d=0.2', '-t', f'{d:.3f}',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', str(seg))
    segs.append((seg, mp3, d, lead))
    parts = chunks(written(text))
    total_chars = sum(len(p) for p in parts)
    t = t0 + lead
    for p in parts:
        pd = a * len(p) / total_chars
        srt.append(f'{idx}\n{ts(t)} --> {ts(t + pd)}\n{p}\n'); idx += 1; t += pd
    t0 += d

# video concat
lst = WORK / 'list.txt'
lst.write_text(''.join(f"file '{s[0]}'\n" for s in segs))
silent = WORK / 'video.mp4'
run('ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', str(silent))
# audio: each narration delayed by its lead, padded to its scene duration
filt, inputs = [], []
for k, (seg, mp3, d, lead) in enumerate(segs):
    inputs += ['-i', str(mp3)]
    filt.append(f'[{k}:a]aresample=48000,adelay={int(lead*1000)}|{int(lead*1000)},apad,atrim=0:{d:.3f}[a{k}]')
filt.append(''.join(f'[a{k}]' for k in range(len(segs))) + f'concat=n={len(segs)}:v=0:a=1,loudnorm=I=-16:TP=-1.5[out]')
audio = WORK / 'audio.m4a'
run('ffmpeg', '-y', *inputs, '-filter_complex', ';'.join(filt), '-map', '[out]', '-c:a', 'aac', '-b:a', '160k', str(audio))
srt_path = OUT / 'ixia-guardrails.srt'
srt_path.write_text('\n'.join(srt))
final = OUT / 'ixia-guardrails-demo.mp4'
style = "FontName=DejaVu Sans,FontSize=11,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&HB0101318,BorderStyle=4,Outline=0,Shadow=0,MarginV=26"
run('ffmpeg', '-y', '-i', str(silent), '-i', str(audio), '-vf', f"subtitles={srt_path}:force_style='{style}'",
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', str(final))
print(f'{final}  {dur(final):.1f}s  scenes={len(segs)}')
