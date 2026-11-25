import { BlendModes, GameObjects, Loader, Scene, Textures } from 'phaser';
import index from '../../../public/assets/fx/index.json';

/** Effects prerendered from pixelfx (MIT, public/assets/fx/NOTICE.md) by tools/build-fx.py. */
export type FxName = keyof typeof index;
interface FxMeta { w: number; h: number; frames: number; ox: number; oy: number }
const META = index as Record<string, FxMeta>;

export function loadPixelFx(load: Loader.LoaderPlugin) {
    load.setPath('assets/fx');
    for (const [name, m] of Object.entries(META)) load.spritesheet(`fx_${name}`, `${name}.png`, { frameWidth: m.w, frameHeight: m.h });
}

export function createPixelFx(scene: Scene) {
    for (const [name, m] of Object.entries(META)) {
        const key = `fx_${name}`;
        if (!scene.textures.exists(key) || scene.anims.exists(key)) continue;
        scene.textures.get(key).setFilter(Textures.FilterMode.NEAREST);
        scene.anims.create({ key, frames: scene.anims.generateFrameNumbers(key, { start: 0, end: m.frames - 1 }), duration: 600, repeat: 0 });
    }
}

export interface FxOptions { scale?: number; ms?: number; depth?: number; flip?: boolean; tint?: number; add?: boolean; angle?: number }

/** Plays an effect once at its own pivot (the contact point or the ground under it) and removes it. */
export function playFx(scene: Scene, name: FxName, x: number, y: number, o: FxOptions = {}): GameObjects.Sprite | null {
    const key = `fx_${name}`;
    const m = META[name];
    if (!scene.anims.exists(key)) return null;
    const s = scene.add.sprite(x, y, key).setOrigin(o.flip ? 1 - m.ox : m.ox, m.oy).setScale(o.scale ?? 2).setDepth(o.depth ?? 3000)
        .setFlipX(o.flip ?? false).setAngle(o.angle ?? 0);
    if (o.tint !== undefined) s.setTint(o.tint);
    if (o.add ?? true) s.setBlendMode(BlendModes.ADD);
    s.play({ key, duration: o.ms ?? 520 });
    s.once('animationcomplete', () => s.destroy());
    return s;
}

/** What a fighter's special looks like where it lands. */
export const SPECIAL_FX: Record<string, { hit: FxName; ground: FxName; tint?: number }> = {
    hero_jade: { hit: 'plasma-explosion', ground: 'fire-ring', tint: 0x5dff9a },
    hero_storm: { hit: 'zap-hit', ground: 'thunderclap' },
    hero_sun: { hit: 'sunburst', ground: 'crit-hit' },
    hero_foundry: { hit: 'heavy-cleave', ground: 'flame-pillar' },
    hero_steel: { hit: 'crit-hit', ground: 'ground-slam', tint: 0xffa860 },
    hero_raven: { hit: 'feather-burst', ground: 'dark-explosion', tint: 0xff5566 },
};
