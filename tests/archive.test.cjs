'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const Archive=require('../assets/archive.js');

test('ZIP stores UTF-8 page names and diverse byte inputs with independently verified CRCs',async()=>{
 const progress=[],view=new Uint8Array([0,1,2,3,4]).subarray(1,4);
 const blob=await Archive.zip([
  {name:'Piano – pagina 01.svg',data:'<svg>♩</svg>'},
  {name:'page-02.png',data:new Blob([view])},
  {name:'page-03.bin',data:view},
  {name:'empty.bin',data:new ArrayBuffer(0)}
 ],{onProgress:value=>progress.push(value)});
 assert.equal(blob.type,'application/zip');assert.deepEqual(progress,[.25,.5,.75,1]);
 const output=execFileSync('python3',['-c',
  'import io,json,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps([{ "name":i.filename,"method":i.compress_type,"utf8":bool(i.flag_bits&2048),"data":list(z.read(i))} for i in z.infolist()]))'
 ],{input:Buffer.from(await blob.arrayBuffer()),encoding:'utf8'});
 const files=JSON.parse(output);
 assert.deepEqual(files.map(f=>f.name),['Piano – pagina 01.svg','page-02.png','page-03.bin','empty.bin']);
 assert.equal(Buffer.from(files[0].data).toString(),'<svg>♩</svg>');
 assert.deepEqual(files[1].data,[1,2,3]);assert.deepEqual(files[2].data,[1,2,3]);assert.deepEqual(files[3].data,[]);
 assert.ok(files.every(f=>f.method===0&&f.utf8));
});

test('ZIP CRC32 matches the standard test vector and archives are deterministic',async()=>{
 assert.equal(Archive.crc32(new TextEncoder().encode('123456789')),0xcbf43926);
 assert.equal(Archive.crc32(new Uint8Array()),0);
 const entries=[{name:'page.svg',data:'<svg/>'}];
 assert.deepEqual(await(await Archive.zip(entries)).arrayBuffer(),await(await Archive.zip(entries)).arrayBuffer());
 const empty=await Archive.zip([]);assert.equal(empty.size,22);
});

test('ZIP rejects ambiguous or unsafe names and unsupported file data',async()=>{
 for(const name of ['', '../page.svg','/page.svg','C:\\page.svg','folder/../page.svg','bad\0.svg'])await assert.rejects(Archive.zip([{name,data:''}]),/filename/);
 await assert.rejects(Archive.zip([{name:'same.svg',data:''},{name:'same.svg',data:''}]),/duplicate/);
 await assert.rejects(Archive.zip([{name:'a'.repeat(65536),data:''}]),/too long/);
 await assert.rejects(Archive.zip([{name:'page.svg',data:{}}]),/Invalid ZIP file data/);
 await assert.rejects(Archive.zip(Array(65536)),/Too many/);
});
