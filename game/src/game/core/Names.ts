/** "Иванова Мария Сергеевна" -> "Иванова М.С.": what the wall display shows. */
export function shortName(full: string): string {
    const parts = full.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return full.trim();
    const [surname, ...rest] = parts;
    return `${surname} ${rest.slice(0, 2).map(p => `${p[0].toUpperCase()}.`).join('')}`;
}

/** The surname alone: what the bars and titles show. */
export const surname = (full: string): string => full.trim().split(/\s+/)[0] ?? '';
