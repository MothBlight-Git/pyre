// Generates build/icon.png (256px) from the same ember drawn for the tray.
const fs = require('node:fs');
const path = require('node:path');
const { emberIcon } = require('../dist/main/icon.js');
fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), emberIcon(256));
console.log('build/icon.png written');
