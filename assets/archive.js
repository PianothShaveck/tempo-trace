/* Dependency-free ZIP storage for exporting already-compressed PNGs and SVGs.
 * TempoArchive.zip([{name, data}], {onProgress?}) -> Promise<Blob>.
 * data accepts a string, Uint8Array / other byte view, ArrayBuffer or Blob.
 * UTF-8 names, CRC-32, deterministic timestamps; no ZIP64 or compression.
 */
(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.TempoArchive=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const encoder=new TextEncoder(),MAX_UINT32=0xffffffff;
 const table=new Uint32Array(256);
 for(let i=0;i<256;i++){let value=i;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;table[i]=value>>>0;}
 function crc32(bytes){let crc=0xffffffff;for(let i=0;i<bytes.length;i++)crc=table[(crc^bytes[i])&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
 async function bytesOf(data){
  if(typeof data==='string')return encoder.encode(data);
  if(data instanceof ArrayBuffer)return new Uint8Array(data);
  if(ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
  if(typeof Blob!=='undefined'&&data instanceof Blob)return new Uint8Array(await data.arrayBuffer());
  throw new TypeError('Invalid ZIP file data.');
 }
 function header(length){const bytes=new Uint8Array(length),view=new DataView(bytes.buffer);return {bytes,u16:(at,value)=>view.setUint16(at,value,true),u32:(at,value)=>view.setUint32(at,value,true)};}
 async function zip(entries,options={}){
  if(!Array.isArray(entries)||entries.length>65535)throw new Error('Too many files for a ZIP archive.');
  const chunks=[],directory=[],names=new Set();let offset=0,directorySize=0;
  for(let i=0;i<entries.length;i++){
   const entry=entries[i],name=entry?.name;
   if(typeof name!=='string'||!name||name.includes('\0')||/^[\\/]|^[a-z]:/i.test(name)||name.split(/[\\/]/).includes('..')||names.has(name))throw new Error('Invalid or duplicate ZIP filename.');
   const nameBytes=encoder.encode(name);
   if(nameBytes.length>65535)throw new Error('ZIP filename is too long.');
   names.add(name);
   const data=await bytesOf(entry.data),size=data.byteLength;
   if(size>MAX_UINT32||offset+30+nameBytes.length+size>MAX_UINT32)throw new Error('The export exceeds the ZIP size limit.');
   const crc=crc32(data),local=header(30),central=header(46);
   local.u32(0,0x04034b50);local.u16(4,20);local.u16(6,0x0800);local.u16(12,33);
   local.u32(14,crc);local.u32(18,size);local.u32(22,size);local.u16(26,nameBytes.length);
   central.u32(0,0x02014b50);central.u16(4,20);central.u16(6,20);central.u16(8,0x0800);central.u16(14,33);
   central.u32(16,crc);central.u32(20,size);central.u32(24,size);central.u16(28,nameBytes.length);central.u32(42,offset);
   chunks.push(local.bytes,nameBytes,data);directory.push(central.bytes,nameBytes);
   offset+=local.bytes.length+nameBytes.length+size;directorySize+=central.bytes.length+nameBytes.length;
   if(typeof options.onProgress==='function')options.onProgress((i+1)/entries.length);
  }
  if(offset+directorySize+22>MAX_UINT32)throw new Error('The export exceeds the ZIP size limit.');
  const end=header(22);end.u32(0,0x06054b50);end.u16(8,entries.length);end.u16(10,entries.length);end.u32(12,directorySize);end.u32(16,offset);
  return new Blob([...chunks,...directory,end.bytes],{type:'application/zip'});
 }
 return {zip,crc32};
});
