#!/usr/bin/env node
// Builds the USB site into dist/, ready for any static host that serves https.
//
//   node build.mjs [--apk path/to/shinonome.apk]
//
// The web client is the same one the phone serves, and the APK is what the site pushes to the phone.
// Build the APK first with ./gradlew :app:assembleRelease.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '../app/src/main/assets');
const dist = join(here, 'dist');

const { values: args } = parseArgs({
    options: {
        apk: { type: 'string', default: join(here, '../app/build/outputs/apk/release/app-release.apk') },
    },
});

// The bundle contains these libraries, and their MIT licenses ask for the notice to go with them.
function thirdPartyNotices() {
    const scope = join(here, 'node_modules/@yume-chan');
    return readdirSync(scope).map((name) => {
        const license = readdirSync(join(scope, name)).find((file) => /^licen[sc]e/i.test(file));
        if (!license) {
            throw new Error(`@yume-chan/${name} has no license file`);
        }
        return `@yume-chan/${name}\n\n${readFileSync(join(scope, name, license), 'utf8').trim()}\n`;
    }).join('\n----------\n\n');
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

await build({
    entryPoints: [join(here, 'usb.js')],
    outfile: join(dist, 'usb.js'),
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    minify: true,
});

copyFileSync(join(here, 'index.html'), join(dist, 'index.html'));
copyFileSync(join(assets, 'start.sh'), join(dist, 'start.sh'));
for (const name of ['client.js', 'style.css', 'logo.webp']) {
    copyFileSync(join(assets, 'web', name), join(dist, name));
}
copyFileSync(args.apk, join(dist, 'server.apk'));
writeFileSync(join(dist, 'third-party-licenses.txt'), thirdPartyNotices());
console.log(`built ${dist}`);
