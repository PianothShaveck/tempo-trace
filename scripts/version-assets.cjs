'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const hash = name => createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex').slice(0, 12);
const update = (name, transform) => {
  const before = read(name), after = transform(before);
  if (before !== after) fs.writeFileSync(path.join(root, name), after);
};
// Update dependencies before hashing their consumers.
update('assets/analysis-worker.js', text => text.replace(/importScripts\('analysis\.js(?:\?v=[^']*)?'\)/,
  `importScripts('analysis.js?v=${hash('assets/analysis.js')}')`));
update('assets/app.js', text => text.replace(/new Worker\('assets\/analysis-worker\.js(?:\?v=[^']*)?'\)/,
  `new Worker('assets/analysis-worker.js?v=${hash('assets/analysis-worker.js')}')`));
update('index.html', text => text.replace(/((?:src|href)=")(assets\/[^"?]+\.(?:js|css|svg))(?:\?v=[^"]*)?"/g,
  (_, prefix, file) => `${prefix}${file}?v=${hash(file)}"`));
