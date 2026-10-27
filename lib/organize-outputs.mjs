import{readFile,writeFile,mkdir,readdir,lstat,realpath,copyFile,rename,rmdir,unlink}from'node:fs/promises';
import{join,resolve,relative,isAbsolute,dirname,sep}from'node:path';
import{createHash,randomUUID}from'node:crypto';
import{validOutputDate}from'./output-date.mjs';
import{collectionCsv}from'./collection-archive.mjs';
import{InputError}from'./domain.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function inside(root,path){const rel=relative(root,resolve(path));return rel!==''&&!isAbsolute(rel)&&!rel.split(/[\\/]/u).includes('..');}
async function checked(root,path){if(!inside(root,path))throw Error('整理路径超出指定日期目录');let current=root;if((await lstat(root)).isSymbolicLink())throw Error('整理目录不能是链接');for(const part of relative(root,path).split(sep)){current=join(current,part);try{if((await lstat(current)).isSymbolicLink())throw Error('整理路径不能经过链接');}catch(error){if(error.code!=='ENOENT')throw error;}}return path;}
async function walk(root,directory){await checked(root,directory);const out=[];for(const row of await readdir(directory,{withFileTypes:true})){const path=await checked(root,join(directory,row.name));if(row.isSymbolicLink())throw Error('原资料中存在链接，未移动');if(row.isDirectory())out.push(...await walk(root,path));else if(row.isFile())out.push(path);}return out;}
async function removeEmpty(root,directory){await checked(root,directory);for(const row of await readdir(directory,{withFileTypes:true}))if(row.isDirectory()&&!row.isSymbolicLink())await removeEmpty(root,join(directory,row.name));if(!(await readdir(directory)).length)await rmdir(directory);}

// Copy and verify first, then update both indexes. Original bytes are moved to
// the rollback backup only after all new paths exist. CSVs keep their location.
export async function organizeOutputDay(store,archive,raw){
 if(!raw||Object.keys(raw).some(k=>!['day','updateSummary'].includes(k))||!validOutputDate(raw.day)||raw.updateSummary!==true)throw new InputError('整理须指定有效日期并同步汇总路径');
 return archive.serial(async()=>{
  await archive.assertIdle();if(archive.choosing)throw new InputError('已有文件整理或文件夹选择正在执行');archive.choosing=true;try{const day=raw.day,dayRoot=await store.artifactDirectory({folder:day}),before=await store.readState(),oldRecords=structuredClone(archive.records),backup=join(store.root,'backups','output-organization',day,Date.now()+'-'+randomUUID()),copies=[],moves=[],created=new Set(),retouched=[];
  await checked(store.root,backup);await mkdir(backup,{recursive:true});if((await lstat(backup)).isSymbolicLink())throw Error('整理备份目录不能是链接');
  await writeFile(join(backup,'state-before.json'),JSON.stringify(before,null,2));await writeFile(join(backup,'collection-index-before.json'),JSON.stringify({version:1,folders:archive.folders,records:oldRecords},null,2));
  const journal={day,dayRoot,backup,status:'copying',copies,moves};const persist=()=>store.atomic(join(backup,'organization.json'),JSON.stringify(journal,null,2));
  const state=structuredClone(before),groups=new Map(),products=new Map(state.products.map(p=>[p.id,p]));for(const row of oldRecords)if(row.outputDay===day&&!products.has(row.productId))products.set(row.productId,row.product||{id:row.productId,brand:row.brand});
  const ordered=[...products.values()].filter(p=>p.outputDay===day||oldRecords.some(r=>r.productId===p.id&&r.outputDay===day)).sort((a,b)=>{const time=p=>oldRecords.filter(r=>r.productId===p.id&&r.outputDay===day).map(r=>r.capturedAt).sort()[0]||p.capturedAt||'';return time(a).localeCompare(time(b))||a.id.localeCompare(b.id);});
  for(const product of ordered){const location=await store.productLocation(state,product,day);groups.set(product.id,location);if(product.outputDay===day)product.outputGroup=location.group;}
  const locationFor=async id=>{if(!groups.has(id)){const p=products.get(id)||{id,brand:'未标注品牌'},location=await store.productLocation(state,p,day);groups.set(id,location);}return groups.get(id);};
  const add=async(source,target,{move=false,version}={})=>{
   await checked(dayRoot,target);const info=await lstat(source);if(info.isSymbolicLink()||!info.isFile())throw Error('整理只处理普通文件');const bytes=await readFile(source),sha256=hash(bytes);let actual=target;
   try{const existing=await readFile(actual);if(hash(existing)!==sha256){if(!version)throw Error('目标存在不同内容，已停止以避免覆盖：'+relative(dayRoot,target));actual=join(dirname(target),'历史采集',version,relative(dirname(target),target));await checked(dayRoot,actual);try{if(hash(await readFile(actual))!==sha256)throw Error('历史文件冲突');}catch(error){if(error.code!=='ENOENT')throw error;}}}catch(error){if(error.code!=='ENOENT')throw error;}
   const prior=copies.find(row=>row.target===actual);if(prior&&prior.sha256!==sha256)throw Error('整理目标内容冲突');
   if(!prior){let exists=true;try{await lstat(actual);}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}if(!exists){await mkdir(dirname(actual),{recursive:true});await checked(dayRoot,actual);await copyFile(source,actual,1);created.add(actual);}if(hash(await readFile(actual))!==sha256)throw Error('整理校验失败');copies.push({source,target:actual,sha256,created:!exists});}
   if(move&&source!==actual&&!moves.some(row=>row.source===source))moves.push({source,backup:join(backup,'originals',relative(dayRoot,source)),sha256});return actual;
  };
  try{
   for(const [id,record]of Object.entries(state.artifacts)){if(record.folder!==day)continue;const productId=id.replace(/(?:-01)?\.(?:png|jpe?g|pptx)$/u,''),location=await locationFor(productId),source=join(dayRoot,record.name),target=join(await store.artifactDirectory(location,{create:true}),record.name);try{await checked(dayRoot,source);await add(source,target,{move:true,version:record.group?'整理前':undefined});}catch(error){if(error.code!=='ENOENT')throw error;}Object.assign(record,location);const key=day+'/'+id;if(state.artifactHistory[key])Object.assign(state.artifactHistory[key],location);}
   for(const [name,record]of Object.entries(state.documents)){if(record.folder!==day)continue;const source=join(dayRoot,name);let id=name.endsWith('.html')?name.slice(0,-5):null;try{if(!id){const doc=JSON.parse(await readFile(source,'utf8'));id=doc.products?.[0]?.id;}if(!/^[a-f0-9]{24}$/u.test(id||''))continue;const location=await locationFor(id),target=join(await store.artifactDirectory(location,{create:true}),name);await add(source,target,{move:true});Object.assign(record,location);}catch(error){if(error.code!=='ENOENT')throw error;}}
   const pathChanges=[];
   for(const record of archive.records){if(record.outputDay!==day||!inside(dayRoot,record.archivePath)||!relative(dayRoot,record.archivePath).startsWith('采集资料'+sep))continue;const original=record.archivePath,location=await locationFor(record.productId),directory=await store.artifactDirectory(location,{create:true});for(const source of await walk(dayRoot,original))await add(source,join(directory,relative(original,source)),{move:true,version:record.taskId});pathChanges.push([original,directory]);record.archivePath=directory;record.productFolder=location.group;if(record.product)record.product.outputGroup=location.group;
    const task=state.productTasks.find(t=>t.id===record.taskId);if(task?.collectionRecord)task.collectionRecord.archivePath=directory;
   }
   for(const [id,location]of groups){const task=state.productTasks.find(t=>t.productId===id&&t.status==='completed'),directory=await store.artifactDirectory(location,{create:true});for(let i=1;i<=3;i++){const source=join(store.root,'cards',id,'detail-'+i+'.png'),name='细节图-'+String(i).padStart(2,'0')+(/未取得/u.test(task?.fields?.detailTitles?.[i-1]||'')?'-未取得':'')+'.png';try{await add(source,join(directory,name));}catch(error){if(error.code!=='ENOENT')throw error;}}}
   await persist();
   // Update embedded archive locations, retaining their original bytes in backup.
   for(const row of copies.filter(row=>row.target.endsWith('.json'))){let value;try{value=JSON.parse(await readFile(row.target,'utf8'));}catch{continue;}let text=JSON.stringify(value,null,2),changed=false;for(const [oldPath,newPath]of pathChanges){const from=JSON.stringify(oldPath).slice(1,-1),to=JSON.stringify(newPath).slice(1,-1);if(text.includes(from)){text=text.replaceAll(from,to);changed=true;}}if(changed){retouched.push({path:row.target,body:await readFile(row.target)});await store.atomic(row.target,text);}}
   await store.mutate(next=>{if(next.jobs.some(j=>['ready','running'].includes(j.status))||next.productTasks.some(t=>['ready','queued','running','cooldown','publishing'].includes(t.status)))throw Error('整理期间出现新任务，已停止');Object.assign(next,{artifacts:state.artifacts,artifactHistory:state.artifactHistory,documents:state.documents,outputGroups:state.outputGroups,products:state.products,productTasks:state.productTasks});});await archive.persist();
   for(const platform of new Set(archive.records.filter(r=>r.outputDay===day).map(r=>r.platform))){const labels={jd:'京东',taobao:'淘宝',tmall:'天猫',xiaohongshu:'小红书'},targets=[[join(dayRoot,labels[platform]+'-当日汇总.csv'),archive.records.filter(r=>r.platform===platform&&r.outputDay===day)],[archive.settings().tables[platform],archive.records.filter(r=>r.platform===platform)]];for(const [path,rows]of targets){let bytes;try{const info=await lstat(path);if(info.isSymbolicLink()||!info.isFile())throw Error('汇总表不是普通文件');bytes=await readFile(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}const saved=join(backup,'summaries',randomUUID()+'.csv');await mkdir(dirname(saved),{recursive:true});await writeFile(saved,bytes);retouched.push({path,body:bytes});await store.atomic(path,collectionCsv(rows));}}
   journal.status='indexes-committed';await persist();
   for(const row of moves){await checked(dayRoot,row.source);if(!inside(backup,row.backup))throw Error('备份路径越界');await mkdir(dirname(row.backup),{recursive:true});if(hash(await readFile(row.source))!==row.sha256)throw Error('原文件在整理期间发生变化，已停止');await rename(row.source,row.backup);}
   try{await removeEmpty(dayRoot,join(dayRoot,'采集资料'));}catch(error){if(error.code!=='ENOENT')throw error;}
   journal.status='completed';await persist();return{day,products:groups.size,files:copies.length,moved:moves.length,folders:[...groups.values()].map(r=>r.group),backup,summaryLocationUnchanged:true};
  }catch(error){
   for(const row of [...moves].reverse())try{await lstat(row.backup);await checked(dayRoot,row.source);await mkdir(dirname(row.source),{recursive:true});await rename(row.backup,row.source);}catch(e){if(e.code!=='ENOENT')throw e;}
   for(const row of retouched)await store.atomic(row.path,row.body);archive.records=oldRecords;await archive.persist();await store.mutate(next=>Object.assign(next,before));
   for(const path of created)try{await checked(dayRoot,path);await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}
   journal.status='rolled-back';journal.error=error.message;await persist();throw error;
  }
  }finally{archive.choosing=false;}
 });
}
