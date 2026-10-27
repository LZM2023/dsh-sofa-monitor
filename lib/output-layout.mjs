import{readdir,mkdir,lstat,realpath}from'node:fs/promises';
import{join,dirname}from'node:path';
import{validOutputDate}from'./output-date.mjs';
import{InputError}from'./domain.mjs';
export function validProductFolder(value){return typeof value==='string'&&value.length<=96&&/^[^<>:"/\\|?*\x00-\x1f\x7f]+-[0-9]{2,}$/u.test(value)&&!/[. ]$/u.test(value)&&!/^\.+/u.test(value);}
export function folderBrand(brand){return String(brand||'未标注品牌').replace(/[（(][^）)]*[A-Za-z][^）)]*[）)]/gu,'').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/gu,'-').replace(/\s+/gu,' ').replace(/[. ]+$/u,'').trim().slice(0,72)||'未标注品牌';}
export async function allocateProductFolder(store,state,product,day){
 if(!validOutputDate(day)||!/^[a-f0-9]{24}$/u.test(product?.id))throw new InputError('商品归档编号无效');
 state.outputGroups??={};const key=day+'/'+product.id,known=state.outputGroups[key];if(known){if(!validProductFolder(known))throw new InputError('商品文件夹索引无效');return known;}
 const brand=folderBrand(product.brand),used=new Set(Object.entries(state.outputGroups).filter(([key])=>key.startsWith(day+'/')).map(([,value])=>value.toLowerCase()));
 try{for(const name of await readdir(join(store.root,'outputs',day)))used.add(name.toLowerCase());}catch(error){if(error.code!=='ENOENT')throw error;}
 let number=1,group;do{group=brand+'-'+String(number++).padStart(2,'0');}while(used.has(group.toLowerCase()));
 state.outputGroups[key]=group;return group;
}
export async function productSubdirectory(parent,group,{create=false}={}){
 if(!validProductFolder(group))throw new InputError('商品文件夹名称无效');const directory=join(parent,group);if(create)await mkdir(directory,{recursive:true});
 if((await lstat(directory)).isSymbolicLink()||!(await lstat(directory)).isDirectory()||dirname(await realpath(directory))!==await realpath(parent))throw new InputError('商品文件夹不可用',404);return directory;
}
