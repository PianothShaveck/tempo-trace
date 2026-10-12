'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createDOM}=require('./dom-stub.cjs'),I18n=require('../assets/i18n.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
test('all declared HTML translations exist and roundtrip without replacing nested controls',()=>{
 const document=createDOM(html),controlIds=document.querySelectorAll('input,button,select,svg').map(n=>n.id).filter(Boolean);
 for(const language of ['it','en']){
  I18n.setLanguage(language);I18n.apply(document);
  for(const node of document.querySelectorAll('[data-i18n]')){assert.ok(Object.hasOwn(I18n.messages,node.dataset.i18n),node.dataset.i18n);assert.equal(node.textContent,I18n.translate(node.dataset.i18n,language));}
  for(const attr of ['aria-label','data-tip'])for(const node of document.querySelectorAll('[data-i18n-'+attr+']')){const key=node.getAttribute('data-i18n-'+attr);assert.ok(Object.hasOwn(I18n.messages,key),key);assert.equal(node.getAttribute(attr),I18n.translate(key,language));}
  assert.deepEqual(document.querySelectorAll('input,button,select,svg').map(n=>n.id).filter(Boolean),controlIds);
 }
});
test('worker errors and engine review labels have English translations',()=>{
 for(const name of ['analysis','beat-detection','detection-client','click-track','audio-export','export-client']){
  const source=fs.readFileSync(path.join(__dirname,'../assets/'+name+'.js'),'utf8');
  for(const match of source.matchAll(/(?:new Error\(|\.anomaly = )'([^']+)'/g))assert.ok(Object.hasOwn(I18n.messages,match[1]),name+': '+match[1]);
 }
 for(const key of ['Fermata o tap mancanti?','Conferma fermata','Da confermare','BPM dal beat successivo: {0}'])assert.notEqual(I18n.translate(key,'en',120),I18n.translate(key,'it',120));
});
test('language defaults safely to English when preferences are invalid or storage is unavailable',()=>{
 for(const storage of [{getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('blocked');}},{getItem:()=>'{bad',setItem(){}}]){
  const context=vm.createContext({localStorage:storage});vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/i18n.js'),'utf8'),context);
  assert.equal(context.TempoI18n.language,'en');assert.equal(context.TempoI18n.firstVisit,true);context.TempoI18n.setLanguage('it');assert.equal(context.TempoI18n.t('Applica'),'Applica');
 }
});
