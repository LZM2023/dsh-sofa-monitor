import{mkdir,lstat}from'node:fs/promises';
import{join}from'node:path';

// A checkpoint is source evidence, never a completed product or specification card.
export async function saveCaptureCheckpoint(tasks,task,capture){
 tasks.check();if((await tasks.get(task.id)).status!=='running')throw Error('任务已停止，未接收迟到阶段资料');const directory=tasks.directory(task.id);await mkdir(directory,{recursive:true});
 if((await lstat(directory)).isSymbolicLink())throw Error('阶段资料目录不能是链接');
 if(capture.product.sourceUrl!==task.sourceUrl)throw Error('阶段资料不属于本次商品');
 const path=join(directory,'browser-capture.json'),outputPath=join(task.outputDir||directory,'browser-capture.json');
 const savedAt=new Date().toISOString(),data=JSON.stringify({version:1,taskId:task.id,status:'checkpoint-only',savedAt,product:capture.product,evidence:capture.evidence},null,2);
 await tasks.store.atomic(path,data);if(outputPath!==path)await tasks.store.atomic(outputPath,data);
 await tasks.store.mutate(state=>{const row=state.productTasks.find(t=>t.id===task.id);if(row)row.browserCheckpoint={path,outputPath,savedAt,stage:capture.evidence.readDiagnostics?.stage,officialRowCount:capture.evidence.readDiagnostics?.officialRowCount||0,detailImages:capture.evidence.detailDocument?.images?.length||0};});
}
