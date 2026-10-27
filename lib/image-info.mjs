import {open} from 'node:fs/promises';
import {InputError} from './domain.mjs';

// Metadata is read from the image, never inferred from its extension or a recipe.
export function imageInfo(bytes){
  const dimensions=(width,height,format,type)=>{
    if(!width||!height)throw new InputError('图片尺寸无效');
    return{width,height,format,type};
  };
  if(bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR')return dimensions(bytes.readUInt32BE(16),bytes.readUInt32BE(20),'PNG','image/png');
  if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216){
    let at=2;
    while(at+4<=bytes.length){
      if(bytes[at++]!==255)break;
      while(bytes[at]===255)at++;
      if(at+3>bytes.length)break;
      const marker=bytes[at++];
      if(marker===217||marker===218)break;
      if(marker===1||marker>=208&&marker<=215)continue;
      const length=bytes.readUInt16BE(at);
      if(length<2||at+length>bytes.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=8)return dimensions(bytes.readUInt16BE(at+5),bytes.readUInt16BE(at+3),'JPG','image/jpeg');
      at+=length;
    }
  }
  throw new InputError('无法读取PNG或JPG图片尺寸');
}
export async function readImageInfo(path){
  const handle=await open(path,'r');
  try{const bytes=Buffer.alloc(256*1024),{bytesRead}=await handle.read(bytes,0,bytes.length,0);return imageInfo(bytes.subarray(0,bytesRead));}
  finally{await handle.close();}
}
