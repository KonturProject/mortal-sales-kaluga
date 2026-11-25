import { Display, GameObjects, Scene } from 'phaser';
import { GAME, LIFEBAR } from '../core/Constants';
import { hudText } from '../core/TextStyles';
import { percent, rubles } from '../systems/BattleRules';

interface SideView {
    color: number;
    name: GameObjects.Text;
    share: GameObjects.Text;
    money: GameObjects.Text;
    face: GameObjects.Image;
}

export interface SideData { slug: string; name: string; color: string; pct: number; amount: number; plan: number; count: number | null }

const FACE = 42;
const FACE_X = 12 + FACE / 2;

/** One row of the top HUD: a pair's two bars of plan completion, growing out of the centre (full = 100 % of the plan). */
export class PairLifebar extends GameObjects.Container {
    private g: GameObjects.Graphics;
    private views: Record<'left' | 'right', SideView>;
    private shown = { left: 0, right: 0 };

    constructor(scene: Scene, rowIndex: number) {
        super(scene, 0, LIFEBAR.TOP + rowIndex * (LIFEBAR.ROW_H + LIFEBAR.ROW_GAP));
        this.g = scene.add.graphics();
        this.add(this.g);
        this.add(scene.add.text(GAME.WIDTH / 2, LIFEBAR.ROW_H / 2, 'VS', hudText(19, '#ff8a5c')).setOrigin(0.5).setStroke('#2a0f00', 4));
        this.views = { left: this.buildSide('left'), right: this.buildSide('right') };
        scene.add.existing(this);
        this.draw();
    }

    private buildSide(side: 'left' | 'right'): SideView {
        const isLeft = side === 'left';
        const dir = isLeft ? -1 : 1;
        const midY = LIFEBAR.ROW_H / 2;
        const inner = GAME.WIDTH / 2 + dir * (LIFEBAR.CENTER_GAP + 10);
        const outer = GAME.WIDTH / 2 + dir * (LIFEBAR.CENTER_GAP + LIFEBAR.BAR_W - 10);
        const text = (x: number, size: number, color: string, origin: number) =>
            this.scene.add.text(x, midY, '', hudText(size, color)).setOrigin(origin, 0.5).setStroke('#0b1020', 4);
        const view: SideView = {
            color: 0x888888,
            share: text(inner, 24, '#ffffff', isLeft ? 1 : 0),
            money: text(outer, 13, '#e6eefc', isLeft ? 0 : 1),
            name: text(isLeft ? FACE_X + FACE / 2 + 8 : GAME.WIDTH - FACE_X - FACE / 2 - 8, 19, '#ffffff', isLeft ? 0 : 1),
            face: this.scene.add.image(isLeft ? FACE_X : GAME.WIDTH - FACE_X, midY, '__DEFAULT').setDisplaySize(FACE, FACE),
        };
        this.add([view.share, view.money, view.name, view.face]);
        return view;
    }

    setSides(left: SideData, right: SideData) {
        for (const [key, data] of [['left', left], ['right', right]] as const) {
            const view = this.views[key];
            view.color = Display.Color.HexStringToColor(data.color).color;
            const face = `face_${data.slug}`;
            if (view.face.texture.key !== face && this.scene.textures.exists(face)) view.face.setTexture(face).setDisplaySize(FACE, FACE);
            const name = data.name.toUpperCase();
            if (view.name.text !== name) view.name.setText(name);
            view.name.setScale(Math.min(1, LIFEBAR.NAME_ROOM / Math.max(1, view.name.width)), 1);
            const share = percent(data.pct);
            if (view.share.text !== share) view.share.setText(share);
            const money = `${rubles(data.amount)} из ${rubles(data.plan)}${data.count === null ? '' : ` · ${data.count} опл.`}`;
            if (view.money.text !== money) view.money.setText(money);
        }
        if (this.shown.left === left.pct && this.shown.right === right.pct) {
            this.draw();
            return;
        }
        this.scene.tweens.killTweensOf(this.shown);
        this.scene.tweens.add({
            targets: this.shown, left: left.pct, right: right.pct, duration: LIFEBAR.SETTLE_MS, ease: 'Sine.easeOut',
            onUpdate: () => this.draw(),
        });
    }

    private draw() {
        const g = this.g;
        g.clear();
        const h = LIFEBAR.ROW_H - 8;
        const w = LIFEBAR.BAR_W;
        for (const side of ['left', 'right'] as const) {
            const start = side === 'left' ? GAME.WIDTH / 2 - LIFEBAR.CENTER_GAP - w : GAME.WIDTH / 2 + LIFEBAR.CENTER_GAP;
            const fill = w * Math.min(1, Math.max(0, this.shown[side]));
            const x = side === 'left' ? start + w - fill : start;
            g.fillStyle(0x0b1020, 0.85).fillRoundedRect(start, 4, w, h, 5);
            if (fill > 4) {
                g.fillStyle(this.views[side].color, 1).fillRoundedRect(x + 1, 5, fill - 2, h - 2, 4);
                g.fillStyle(0xffffff, 0.18).fillRect(x + 3, 6, fill - 6, (h - 4) * 0.35);
            }
            const fx = side === 'left' ? FACE_X : GAME.WIDTH - FACE_X;
            g.lineStyle(4, this.views[side].color, 1).strokeRect(fx - FACE / 2, LIFEBAR.ROW_H / 2 - FACE / 2, FACE, FACE);
            g.lineStyle(2, this.shown[side] >= 1 ? 0xffd23a : 0xb9a875, 0.95).strokeRoundedRect(start, 4, w, h, 5);
        }
    }
}
