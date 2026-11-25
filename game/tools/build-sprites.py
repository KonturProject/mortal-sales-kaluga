"""Cuts the 4x2 fighter sheets (tools/agent-bridge jobs) into game sprites and builds the arena background.

    python tools/build-sprites.py        (run from game/)
"""
import json
import pathlib
import sys

import numpy as np
from PIL import Image

GAME = pathlib.Path(__file__).resolve().parent.parent
JOBS = GAME.parent / 'work/agent-exchange/jobs'
OUT = GAME / 'public/assets/sprites'
POSES = {'a': ['', '_walk', '_punch', '_kick'], 'b': ['_uppercut', '_special', '_hurt', '_fly'], 'c': ['_flip', '_sweep', '_ko', '_win']}
STANDING = 450  # px
BUILD = {'hero_foundry': 1.1}  # the giant
TUCKED = 0.62  # a tucked somersault is at most this share of the standing height
# sprite name -> bridge job (the job ids stay local: work/ is not in git)
SHEETS = json.loads((GAME.parent / 'work/sheets.json').read_text(encoding='utf-8'))


def asset(job: str) -> Image.Image:
    folder = JOBS / job / 'workspace'
    manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    return Image.open(folder / manifest['assets'][0]['path'])


def clean(cell: Image.Image) -> Image.Image:
    """Drops the nearly transparent haze around a figure and trims the cell to it."""
    a = np.array(cell.convert('RGBA'))
    alpha = a[..., 3].astype(np.float32)
    alpha = np.clip((alpha - 60) / (200 - 60), 0, 1) * 255
    a[..., 3] = alpha.astype(np.uint8)
    img = Image.fromarray(a)
    box = img.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
    if not box:
        raise SystemExit('empty cell')
    return img.crop(box)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, job in SHEETS['heroes'].items():
        factor = None
        sizes = []
        for part, poses in POSES.items():
            if not (JOBS / f'{job}-{part}' / 'workspace/manifest.json').exists():
                print(name, part, 'missing')
                continue
            sheet = asset(f'{job}-{part}').convert('RGBA')
            cw, ch = sheet.width // 2, sheet.height // 2
            cells = [clean(sheet.crop(((i % 2) * cw, (i // 2) * ch, (i % 2 + 1) * cw, (i // 2 + 1) * ch))) for i in range(4)]
            if factor is None:
                factor = STANDING * BUILD.get(name, 1) / cells[0].height
            for pose, cell in zip(poses, cells):
                k = factor
                if pose == '_flip':
                    k = min(k, STANDING * BUILD.get(name, 1) * TUCKED / max(cell.size))
                sprite = cell.resize((max(1, round(cell.width * k)), max(1, round(cell.height * k))), Image.LANCZOS)
                sprite.save(OUT / f'{name}{pose}.png', optimize=True)
                sizes.append(sprite.size)
        print(name, sizes)
    faces = GAME / 'public/assets/portraits'
    faces.mkdir(parents=True, exist_ok=True)
    for name in SHEETS['heroes']:
        im = Image.open(GAME.parent / f'work/faces/{name}.png').convert('RGB')
        side = min(im.size)
        left, top = (im.width - side) // 2, int((im.height - side) * 0.62)
        im.crop((left, top, left + side, top + side)).resize((300, 300), Image.LANCZOS).save(faces / f'{name}.jpg', quality=90)
    arena = asset(SHEETS['arena']).convert('RGB').resize((1920, 1080), Image.LANCZOS)
    arena.save(OUT / 'bg_arena.jpg', quality=86)


if __name__ == '__main__':
    main()
