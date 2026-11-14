// code: links requirements to the source lines that carry their tags. // [guard-check:R2.4]
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cmpCodePoint, globFiles } from './config.js';
import { makeResolver } from './tags.js';
/** Tagged lines of one source text (line numbers from 1, CR removed). */
export function taggedLines(text, index) {
    const resolve = makeResolver(index);
    const out = [];
    text.split('\n').forEach((raw, i) => {
        const line = raw.replace(/\r$/, '');
        const links = resolve(line);
        if (links.length > 0)
            out.push({ n: i + 1, text: line.trim(), links });
    });
    return out;
}
/** Build the report `code` block from the source globs. // [guard-check:R2.4][guard-check:R2.5] */
export function extractCode(root, sourceGlobs, index) {
    const files = globFiles(root, sourceGlobs)
        .filter((f) => !/\.(?:test|spec)\./.test(basename(f)))
        .sort(cmpCodePoint);
    const found = [];
    for (const f of files) {
        let text;
        try {
            text = readFileSync(join(root, f), 'utf8');
        }
        catch {
            continue;
        }
        const lines = taggedLines(text, index);
        if (lines.length > 0)
            found.push({ file: f, lines });
    }
    if (found.length === 0)
        return { file: null, lines: [] };
    let main = found[0];
    for (const c of found)
        if (c.lines.length > main.lines.length)
            main = c;
    const lines = [...main.lines];
    for (const c of found) {
        if (c === main)
            continue;
        for (const l of c.lines)
            lines.push({ n: l.n, text: l.text, links: l.links, file: c.file });
    }
    return { file: main.file, lines };
}
