'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createDOM}=require('./dom-stub.cjs'),I18n=require('../assets/i18n.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
test('all declared HTML translations exist and roundtrip without replacing nested controls',()=>{
 const document=createDOM(html),controlIds=document.querySelectorAll('input,button,select,svg').map(n=>n.id).filter(Boolean);
 for(const language of ['it','en']){
  I18n.setLanguage(language);I18n.apply(document);
  for(const node of document.querySelectorAll('[data-i18n]')){assert.ok(Object.hasOwn(I18n.messages,node.dataset.i18n),node.dataset.i18n);assert.equal(node.textContent,I18n.translate(node.dataset.i18n,language));}
  for(const attr of ['aria-label','data-tip','title','placeholder','content'])for(const node of document.querySelectorAll('[data-i18n-'+attr+']')){const key=node.getAttribute('data-i18n-'+attr);assert.ok(Object.hasOwn(I18n.messages,key),key);assert.equal(node.getAttribute(attr),I18n.translate(key,language));}
  assert.deepEqual(document.querySelectorAll('input,button,select,svg').map(n=>n.id).filter(Boolean),controlIds);
 }
});
test('worker errors and engine review labels have English translations',()=>{
 for(const name of ['analysis','beat-detection','detection-client','click-track','audio-export','export-client','musical']){
  const source=fs.readFileSync(path.join(__dirname,'../assets/'+name+'.js'),'utf8');
  for(const match of source.matchAll(/(?:new Error\(|\.anomaly = )'([^']+)'/g))assert.ok(Object.hasOwn(I18n.messages,match[1]),name+': '+match[1]);
 }
 for(const key of ['Fermata o tap mancanti?','Conferma fermata','Da confermare','BPM dal beat successivo: {0}'])assert.notEqual(I18n.translate(key,'en',120),I18n.translate(key,'it',120));
});
test('advanced controls and app diagnostics have translations, including dynamic meter labels',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../assets/app.js'),'utf8');
 for(const match of source.matchAll(/(?:\bt\(|new Error\()'([^']+)'/g)){
  if(!match[1])continue;
  assert.ok(Object.hasOwn(I18n.messages,match[1]),match[1]);
 }
 assert.equal(I18n.translate('Battuta {0} · {1}/{2}','en',-2,11,8),'Bar -2 · 11/8');
 assert.equal(I18n.translate('Levare · battuta {0} · {1}/{2}','it',0,3,1),'Levare · battuta 0 · 3/1');
 for(const key of ['Numeratore','Denominatore','Batt.','Levare','MIDI sintetizzato','Avvertenze MIDI']){
  assert.notEqual(I18n.translate(key,'en'),I18n.translate(key,'it'));
 }
});
test('English MIDI errors and fixed warnings translate in both directions',()=>{
 for(const name of ['midi','midi-audio']){
  const source=fs.readFileSync(path.join(__dirname,'../assets/'+name+'.js'),'utf8');
  for(const match of source.matchAll(/(?:fail\(|(?:new Error|DOMException)\(|warnings\.push\()(?:'([^']+)'|"([^"]+)")/g)){
   const english=match[1]||match[2],italian=I18n.translate(english,'it');
   assert.notEqual(italian,english,name+': '+english);
   assert.equal(I18n.translate(english,'en'),english);
   assert.equal(I18n.translate(italian,'en'),english);
  }
 }
});
test('parameterized MIDI warnings preserve exact meter and score position',()=>{
 const meter='Meter 11/3 is preserved in Tempo Trace metadata; standard MIDI time signatures cannot represent it.';
 assert.equal(I18n.translate(meter,'it'),'Il metro 11/3 è conservato nei metadati Tempo Trace; i metri MIDI standard non possono rappresentarlo.');
 assert.equal(I18n.translate(meter,'en'),meter);
 const midbar='The MIDI meter change at quarter 13.125 falls inside a bar. It and later meter changes were not added to the measure grid; set those changes manually.';
 assert.equal(I18n.translate(midbar,'it'),'Il cambio di metro MIDI alla semiminima 13.125 cade all’interno di una battuta. Questo e i cambi successivi non sono stati aggiunti alla griglia delle battute; impostali manualmente.');
 assert.equal(I18n.translate(midbar,'en'),midbar);
 const scientific=midbar.replace('13.125','1e+21');
 assert.match(I18n.translate(scientific,'it'),/semiminima 1e\+21/);
});
test('unknown text and MIDI metadata are not rewritten by diagnostic translation',()=>{
 for(const value of ['Etude {0}.mid','Bar 17; pickup 1.5 quarter notes','Meter 5/3 (Tempo Trace)','Allegro · tempo rubato','TempoTrace:1:{"firstBar":-2}',
  'File: Meter 11/3 is preserved in Tempo Trace metadata; standard MIDI time signatures cannot represent it.']){
  for(const language of ['it','en'])assert.equal(I18n.translate(value,language),value);
 }
 // Italian source keys take precedence over reverse English aliases.
 assert.equal(I18n.translate('Tempo di base','it'),'Tempo di base');
 assert.equal(I18n.translate('Tempo di base','en'),'Basic tempo');
});
test('language defaults safely to English when preferences are invalid or storage is unavailable',()=>{
 for(const storage of [{getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('blocked');}},{getItem:()=>'{bad',setItem(){}}]){
  const context=vm.createContext({localStorage:storage});vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/i18n.js'),'utf8'),context);
  assert.equal(context.TempoI18n.language,'en');assert.equal(context.TempoI18n.firstVisit,true);context.TempoI18n.setLanguage('it');assert.equal(context.TempoI18n.t('Applica'),'Applica');
 }
});
