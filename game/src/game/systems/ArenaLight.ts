import { BlendModes, Display, GameObjects, Scene } from 'phaser';
import { GAME } from '../core/Constants';
import type { Fighter } from '../objects/Fighter';

const LANTERNS = [{ x: 424, y: 300 }, { x: 917, y: 300 }];
/** How dark the arena gets behind a fight. */
const DIM = 0.34;
/** The closest the camera comes to a fight; it backs off as the two part, so nobody leaves the picture. */
const MAX_ZOOM = 1.3;
/** Room around the two fighters, px. */
const FRAME = 560;

/** Radial white-to-nothing disc; everything soft (glows, shadows, the vignette's hole) is made of it. */
function glowTexture(scene: Scene) {
    if (scene.textures.exists('glow')) return;
    const size = 256;
    const canvas = scene.textures.createCanvas('glow', size, size);
    const ctx = canvas?.getContext();
    if (!canvas || !ctx) return;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    canvas.refresh();
}

function vignetteTexture(scene: Scene) {
    if (scene.textures.exists('vignette')) return;
    const [w, h] = [640, 360];
    const canvas = scene.textures.createCanvas('vignette', w, h);
    const ctx = canvas?.getContext();
    if (!canvas || !ctx) return;
    const g = ctx.createRadialGradient(w / 2, h * 0.62, h * 0.3, w / 2, h * 0.55, w * 0.62);
    g.addColorStop(0, 'rgba(2,3,10,0)');
    g.addColorStop(0.6, 'rgba(2,3,10,0.35)');
    g.addColorStop(1, 'rgba(2,3,10,0.82)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    canvas.refresh();
}

/** Light of the arena: flickering lanterns, drifting embers, a vignette, ground shadows, and a spotlight on whoever fights. */
export class ArenaLight {
    private dim: GameObjects.Rectangle;
    private spot: GameObjects.Image;
    private beam: GameObjects.Image;
    private auras = new Map<Fighter, GameObjects.Image>();
    private shadows = new Map<Fighter, GameObjects.Image>();
    private focused: Fighter[] = [];

    constructor(private scene: Scene, private fighters: Fighter[]) {
        glowTexture(scene);
        vignetteTexture(scene);
        this.dim = scene.add.rectangle(GAME.WIDTH / 2, GAME.HEIGHT / 2, GAME.WIDTH, GAME.HEIGHT, 0x03040c, 1).setAlpha(0.16).setDepth(10);
        scene.add.image(GAME.WIDTH / 2, GAME.HEIGHT / 2, 'vignette').setDisplaySize(GAME.WIDTH, GAME.HEIGHT).setDepth(1500);
        this.spot = scene.add.image(640, 660, 'glow').setDisplaySize(760, 170).setTint(0xffd9a0).setBlendMode(BlendModes.ADD).setAlpha(0).setDepth(20);
        this.beam = scene.add.image(640, 330, 'glow').setDisplaySize(620, 980).setTint(0x9fb8ff).setBlendMode(BlendModes.ADD).setAlpha(0).setDepth(19);

        for (const at of LANTERNS) {
            const glow = scene.add.image(at.x, at.y, 'glow').setDisplaySize(330, 330).setTint(0xff9a3c).setBlendMode(BlendModes.ADD).setAlpha(0.5).setDepth(12);
            const floor = scene.add.image(at.x, 610, 'glow').setDisplaySize(420, 110).setTint(0xff8a30).setBlendMode(BlendModes.ADD).setAlpha(0.22).setDepth(12);
            scene.tweens.add({ targets: [glow, floor], alpha: '*=0.72', duration: 900 + Math.random() * 500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
        }
        scene.add.particles(0, 0, 'glow', {
            x: { min: 0, max: GAME.WIDTH }, y: GAME.HEIGHT + 10, lifespan: { min: 5000, max: 9000 }, speedY: { min: -90, max: -40 }, speedX: { min: -18, max: 26 },
            scale: { start: 0.045, end: 0.01 }, alpha: { start: 0.9, end: 0 }, tint: [0xffb056, 0xff7a2e, 0xffd9a0], blendMode: 'ADD', frequency: 160,
        }).setDepth(1400);

        for (const fighter of fighters) {
            this.shadows.set(fighter, scene.add.image(0, 0, 'glow').setTint(0x000000).setAlpha(0));
            const color = Display.Color.HexStringToColor(fighter.def.color).color;
            this.auras.set(fighter, scene.add.image(0, 0, 'glow').setTint(color).setBlendMode(BlendModes.ADD).setAlpha(0));
        }
        scene.events.on('update', this.follow, this);
        scene.events.once('shutdown', () => scene.events.off('update', this.follow, this));
    }

    /** Darkens the arena and lights these fighters; everybody else steps into the shade. Empty list = lights back up. */
    focus(list: Fighter[], x = 640, y = 660) {
        this.focused = list;
        const on = list.length > 0;
        this.scene.tweens.killTweensOf([this.dim, this.spot, this.beam]);
        this.scene.tweens.add({ targets: this.dim, alpha: on ? DIM : 0.16, duration: 350 });
        this.spot.setPosition(x, y + 6);
        this.beam.setPosition(x, y - 330);
        this.scene.tweens.add({ targets: this.spot, alpha: on ? 0.8 : 0, duration: 350 });
        this.scene.tweens.add({ targets: this.beam, alpha: on ? 0.26 : 0, duration: 350 });
        for (const fighter of this.fighters) fighter.setShade(on && !list.includes(fighter));
    }

    /** A hard flash of the spotlight: a heavy blow landed. */
    pulse() {
        this.scene.tweens.add({ targets: this.beam, alpha: 0.45, duration: 60, yoyo: true });
    }

    /** A fighting-game camera: frames both fighters, glides, and never shows anything beyond the arena. (Its origin is the top-left corner.) */
    private frame(deltaMs: number) {
        const cam = this.scene.cameras.main;
        const xs = this.focused.map(f => f.x);
        const on = xs.length > 0;
        const min = on ? Math.min(...xs) : 0;
        const max = on ? Math.max(...xs) : GAME.WIDTH;
        const zoom = on ? Math.min(MAX_ZOOM, Math.max(1, GAME.WIDTH / (max - min + FRAME))) : 1;
        const k = 1 - Math.exp(-deltaMs / 190);
        const now = cam.zoom / GAME.RENDER_SCALE;
        const next = Math.abs(zoom - now) < 0.0005 ? zoom : now + (zoom - now) * k;
        const viewW = GAME.WIDTH / next;
        const viewH = GAME.HEIGHT / next;
        const wantX = Math.min(GAME.WIDTH - viewW, Math.max(0, (min + max) / 2 - viewW / 2));
        cam.setZoom(GAME.RENDER_SCALE * next);
        cam.setScroll(Math.min(GAME.WIDTH - viewW, Math.max(0, cam.scrollX + (wantX - cam.scrollX) * k)), GAME.HEIGHT - viewH);
        if (!on) return;
        const mid = (min + max) / 2;
        this.spot.x += (mid - this.spot.x) * k;
        this.beam.x = this.spot.x;
    }

    private follow(_time: number, delta: number) {
        this.frame(Math.min(50, delta));
        for (const fighter of this.fighters) {
            const shadow = this.shadows.get(fighter);
            const aura = this.auras.get(fighter);
            if (!shadow || !aura) continue;
            const air = Math.min(1, Math.max(0, (fighter.groundY - fighter.y) / 220));
            const w = fighter.standWidth * (fighter.isLying ? 2 : 1.25) * (1 - air * 0.4);
            shadow.setPosition(fighter.x, fighter.groundY).setDisplaySize(w, w * 0.24).setDepth(fighter.groundY - 2)
                .setAlpha(fighter.visible ? fighter.alpha * (0.75 - air * 0.4) : 0);
            const lit = fighter.visible && this.focused.includes(fighter);
            aura.setPosition(fighter.x, fighter.y - fighter.bodyHeight * 0.5).setDisplaySize(fighter.bodyHeight * 1.5, fighter.bodyHeight * 1.5)
                .setDepth(fighter.groundY - 1).setAlpha(aura.alpha + ((lit ? 0.42 : 0) - aura.alpha) * 0.12);
        }
    }
}
