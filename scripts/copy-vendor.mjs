import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('assets/vendor', { recursive: true });
await copyFile('node_modules/alpinejs/dist/cdn.min.js', 'assets/vendor/alpine.min.js');
await copyFile('node_modules/chart.js/dist/chart.umd.js', 'assets/vendor/chart.umd.js');
