"""Packs effect sheets rendered by pixelfx (MIT, see public/assets/fx/NOTICE.md) into small game strips.

    python tools/build-fx.py <folder with rendered sheets>      (run from game/)
"""
import json
import pathlib
import sys

import numpy as np
from PIL import Image

OUT = pathlib.Path(__file__).resolve().parent.parent / 'public/assets/fx'
MAX_FRAMES = 22


def main(src: pathlib.Path) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    index = {}
    for meta_path in sorted(src.glob('*/*/*.json')):
        meta = json.loads(meta_path.read_text(encoding='utf-8'))['meta']['pixelfx']
        sheet = Image.open(meta_path.with_suffix('.png')).convert('RGBA')
        w, h = meta['frameSize']
        frames = [sheet.crop(((i % meta['columns']) * w, (i // meta['columns']) * h, (i % meta['columns'] + 1) * w, (i // meta['columns'] + 1) * h))
                  for i in range(meta['frames'])]
        alive = [f for f in frames if f.getchannel('A').getbbox()]
        if not alive:
            continue
        step = max(1, int(np.ceil(len(alive) / MAX_FRAMES)))
        alive = alive[::step]
        boxes = np.array([f.getchannel('A').getbbox() for f in alive])
        l, t, r, b = boxes[:, 0].min(), boxes[:, 1].min(), boxes[:, 2].max(), boxes[:, 3].max()
        fw, fh = int(r - l), int(b - t)
        cols = max(1, min(len(alive), 2048 // fw))
        rows = -(-len(alive) // cols)
        strip = Image.new('RGBA', (cols * fw, rows * fh))
        for i, f in enumerate(alive):
            strip.paste(f.crop((l, t, r, b)), ((i % cols) * fw, (i // cols) * fh))
        name = meta_path.stem
        strip.save(OUT / f'{name}.png', optimize=True)
        px, py = meta['pivot']
        index[name] = {'w': fw, 'h': fh, 'frames': len(alive), 'fps': round(meta['fps'] / step * 1.15, 1),
                       'ox': round((px - int(l)) / fw, 3), 'oy': round((py - int(t)) / fh, 3)}
    (OUT / 'index.json').write_text(json.dumps(index, indent=1), encoding='utf-8')
    print(json.dumps(index))


if __name__ == '__main__':
    main(pathlib.Path(sys.argv[1]))
