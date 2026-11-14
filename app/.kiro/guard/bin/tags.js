/** Tag regex source; a fresh RegExp per use because it is global. */
const TAG_SOURCE = String.raw `\[(?:([A-Za-z0-9_-]+):)?(R\d+\.\d+)\]`;
/** Resolver from title or line text to full requirement IDs (order of appearance, unique). */
export function makeResolver(index) {
    const full = new Set();
    const owners = new Map();
    for (const s of index.specs) {
        for (const r of s.requirements) {
            full.add(`${s.spec}:${r.id}`);
            const list = owners.get(r.id) ?? [];
            list.push(s.spec);
            owners.set(r.id, list);
        }
    }
    return (text) => {
        const out = [];
        for (const m of text.matchAll(new RegExp(TAG_SOURCE, 'g'))) {
            let id = null;
            if (m[1] !== undefined) {
                if (full.has(`${m[1]}:${m[2]}`))
                    id = `${m[1]}:${m[2]}`;
            }
            else {
                const o = owners.get(m[2]);
                if (o && o.length === 1)
                    id = `${o[0]}:${m[2]}`;
            }
            if (id !== null && !out.includes(id))
                out.push(id);
        }
        return out;
    };
}
/** True when the text holds any tag, resolvable or not. */
export function hasTag(text) {
    return new RegExp(TAG_SOURCE).test(text);
}
