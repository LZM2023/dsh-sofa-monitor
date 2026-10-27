import{organizeOutputDay}from'./organize-outputs.mjs';
import{join}from'node:path';
import{exportEditableCard}from'./editable-pptx.mjs';
import{revealManagedPath}from'./file-manager.mjs';
import{templatePreview}from'./template-preview.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { InputError, VERSION } from './domain.mjs';
import {validateNativeCapture} from './native-capture.mjs';
import {cardRecipe,cardAsset,saveCard,productImage} from './cards.mjs';
import {PLATFORM_INFO} from './platforms.mjs';
import {validateNativeNote} from './notes.mjs';
import {revealFile} from './file-manager.mjs';
export const PREFIX = '/sofa-monitor/v1/';
function localAddress(address='') { return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'; }
function authority(raw) {
  try { const url = new URL(`http://${raw}`); return ['localhost','127.0.0.1','[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' ? url.host : null; } catch { return null; }
}
function json(res, status, body) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(body)); }
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new InputError('请求须为 JSON',415);
  let size=0; const chunks=[];
  for await (const chunk of req) { size+=chunk.length; if(size>256*1024) throw new InputError('数据超过 256 KB 限制',413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('JSON 格式不正确'); }
}
export function handler(store,runner,nativeBatch,connector,{reveal=revealFile,revealSummary=revealManagedPath,productTasks,cardBatches,archive}={}) {
  const token = randomBytes(32).toString('hex');
  return async (req,res)=> {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    try {
      const host=authority(req.headers.host);
      if (!localAddress(req.socket.remoteAddress) || !host) throw new InputError('仅允许本机访问',403);
      if(req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin); } catch { throw new InputError('请求来源无效',403); }
        if (!['http:','https:'].includes(origin.protocol) || origin.host !== host) throw new InputError('跨站请求已拒绝',403);
      }
      if (['cross-site','same-site'].includes(req.headers['sec-fetch-site'])) throw new InputError('跨站请求已拒绝',403);
      const path = new URL(req.url,`http://${host}`).pathname;
      if(req.method==='GET'&&path===`${PREFIX}platform-access/events`&&store.collectionPacer){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive'});const send=access=>{if(!res.destroyed)res.write('data: '+JSON.stringify(access)+'\n\n');},unsubscribe=store.collectionPacer.subscribe(send,()=>res.end()),timer=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},15000);timer.unref();res.once('close',()=>{unsubscribe();clearInterval(timer);});send(await store.collectionPacer.inspect());return;}
      if(req.method==='GET'&&path===`${PREFIX}templates`&&store.templateLibrary)return json(res,200,{version:VERSION,editorSchemaVersion:3,...store.templateLibrary.snapshot()});
      if(req.method==='GET' && path===`${PREFIX}bootstrap`){await store.ensureCardQuality?.();await productTasks?.expire();await cardBatches?.expire();await productTasks?.recoverAutomaticPublications();return json(res,200,{version:VERSION,token,desktopBrowser:store.desktopBrowser,platformAccess:await store.collectionPacer?.inspect(),activeTemplate:store.templateLibrary?.selected(),platforms:PLATFORM_INFO,archiveSettings:archive?.settings()||null,imageProcessing:productTasks?.imageProcessing?.status()||null,helperConnection:connector?.snapshot()||{phase:'unknown',message:'连接服务未加载'},onlineCollection:store.collectionPacer?'paced-jd-auto-card':runner?'browser-helper-and-native-review':'manual-jd-review',features:{backgroundDispatch:!!productTasks?.dispatcher?.enabled,platformSafety:!!store.collectionPacer,automaticProductCards:!!productTasks,automaticCardBatch:!!cardBatches,currentProductTask:!!productTasks,helperReconnect:!!connector,browserHelperBatch:!!runner&&!store.collectionPacer,jdLinkBatch:!!runner&&!store.collectionPacer,nativeCurrentCapture:true,nativeSearchBatch:!!nativeBatch&&!store.collectionPacer},state:await store.snapshot()});}
      const taskImage=path.match(/^\/sofa-monitor\/v1\/product-tasks\/([a-f0-9-]{36})\/(card|main)\.png$/u);
      if(req.method==='GET'&&taskImage&&productTasks){const task=await productTasks.get(taskImage[1]);if(!['awaiting-confirmation','card-error','completed'].includes(task.status))throw new InputError('任务图片尚未完成',404);res.writeHead(200,{'Content-Type':'image/png'});return res.end(await productTasks.asset(task.id,taskImage[2]+'.png'));}
      const recipe=path.match(/^\/sofa-monitor\/v1\/cards\/([a-f0-9]{24})$/u);
      if(req.method==='GET'&&recipe)return json(res,200,await cardRecipe(store,recipe[1]));
      const asset=path.match(/^\/sofa-monitor\/v1\/card-assets\/([a-f0-9]{24})\/(main|detail-[1-3])\.png$/u);
      if(req.method==='GET'&&asset){const bytes=await cardAsset(store,asset[1],asset[2]+'.png');res.writeHead(200,{'Content-Type':'image/png'});return res.end(bytes);}
      const galleryImage=path.match(/^\/sofa-monitor\/v1\/product-images\/([a-f0-9]{24})\/([0-9]{1,2})$/u);
      if(req.method==='GET'&&galleryImage){const result=await productImage(store,galleryImage[1],Number(galleryImage[2]));res.writeHead(200,{'Content-Type':result.type});return res.end(result.body);}
      if(req.method==='GET' && path.startsWith(`${PREFIX}files/`)) {
        const name = decodeURIComponent(path.slice(`${PREFIX}files/`.length));
        const file = await store.file(name);
        res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; sandbox allow-popups; base-uri 'none'; form-action 'none'");
        res.writeHead(200,{'Content-Type':file.type,'Content-Disposition':`${file.type.startsWith('image/')?'inline':'attachment'}; filename="sofa-artifact.${file.type==='image/jpeg'?'jpg':file.type==='image/png'?'png':file.name.endsWith('.pptx')?'pptx':'txt'}"; filename*=UTF-8''${encodeURIComponent(file.name)}`}); return res.end(file.body);
      }
      if(req.method!=='POST') throw new InputError('接口不存在',404);
      const actual=req.headers['x-sofa-monitor-token'];
      if(typeof actual!=='string' || !/^[a-f0-9]{64}$/u.test(actual) || !timingSafeEqual(Buffer.from(actual),Buffer.from(token))) throw new InputError('操作授权已过期，请刷新面板',403);
      const upload=path.match(/^\/sofa-monitor\/v1\/cards\/([a-f0-9]{24})\/(card|main|detail-[1-3])$/u);
      if(upload){
        if(req.headers['content-type']!=='image/png')throw new InputError('规格卡上传须为PNG',415);
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>24*1024*1024)throw new InputError('图片超过24MB',413);chunks.push(chunk);}
        let fields;try{fields=JSON.parse(decodeURIComponent(req.headers['x-sofa-card-fields']||'{}'));}catch{throw new InputError('规格卡字段无效');}
        const result=await saveCard(store,upload[1],upload[2],Buffer.concat(chunks),fields);
        return json(res,200,{result,state:await store.snapshot()});
      }
      const raw=await body(req);
      if(path===`${PREFIX}platform-access/pause`&&store.collectionPacer){if(!raw||!['verification-page','user'].includes(raw.reason)||Object.keys(raw).some(key=>key!=='reason'))throw new InputError('暂停参数无效');const result=await store.collectionPacer.pause(raw.reason==='verification-page'?'京东出现频控或验证页面，已停止所有自动访问':'用户暂停京东访问');return json(res,200,{result,platformAccess:result,state:await store.snapshot()});}
      if(path===`${PREFIX}platform-access/acknowledge`&&store.collectionPacer){const result=await store.collectionPacer.acknowledge(raw);return json(res,200,{result,platformAccess:await store.collectionPacer.inspect(),state:await store.snapshot()});}
      if(store.collectionPacer&&[`${PREFIX}batches`,`${PREFIX}helper-tasks`,`${PREFIX}plans`].includes(path)||store.collectionPacer&&path.startsWith(`${PREFIX}native-batches/`))throw new InputError('旧版采集入口已停用，请使用统一的商品任务或品牌批次',410);
      if(path===`${PREFIX}templates/preview`&&store.templateLibrary){const result=await templatePreview(store,raw);res.writeHead(200,{'Content-Type':'image/png'});return res.end(result.bytes);}
      if(path===`${PREFIX}templates`&&store.templateLibrary)return json(res,200,{result:await store.templateLibrary.change(raw),state:await store.snapshot()});
      if(path===`${PREFIX}archive-settings/open`&&archive){if(!raw||Object.keys(raw).some(key=>key!=='platform')||!['jd','taobao','tmall','xiaohongshu'].includes(raw.platform))throw new InputError('汇总表平台无效');await archive.serial(()=>archive.writeSummary(raw.platform));return json(res,200,{result:await revealSummary(archive.settings().tables[raw.platform]),state:await store.snapshot()});}
      if(path===`${PREFIX}archive-settings/choose`&&archive){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),300000);const cancel=()=>{if(!res.writableEnded)controller.abort();};res.once('close',cancel);try{return json(res,200,{result:await archive.choose(raw,controller.signal),archiveSettings:archive.settings(),state:await store.snapshot()});}finally{clearTimeout(timer);res.removeListener('close',cancel);}}

      if(path===`${PREFIX}image-processing`&&productTasks?.imageProcessing){await archive?.assertIdle();const state=await store.readState();if(state.jobs.some(j=>['running','ready'].includes(j.status))||state.productTasks.some(t=>['ready','queued','running','cooldown','publishing'].includes(t.status)))throw new InputError('请先结束当前采集，再更换图片处理方式',409);const result=await productTasks.imageProcessing.save(raw);return json(res,200,{result,imageProcessing:result,state:await store.snapshot()});}
      if(path===`${PREFIX}image-processing/test-comfy`&&productTasks?.imageProcessing)return json(res,200,{result:await productTasks.imageProcessing.inspectComfy(raw),state:await store.snapshot()});
      if(path===`${PREFIX}outputs/organize-day`&&archive)return json(res,200,{result:await organizeOutputDay(store,archive,raw),archiveSettings:archive.settings(),state:await store.snapshot()});

      if(path===`${PREFIX}card-batches`&&cardBatches)return json(res,200,{result:await cardBatches.create(raw),state:await store.snapshot()});
      if(path===`${PREFIX}card-batches/claim`&&cardBatches)return json(res,200,{result:await cardBatches.claim(raw),state:await store.snapshot()});
      if(path===`${PREFIX}card-batches/cancel`&&cardBatches)return json(res,200,{result:await cardBatches.stop(raw.id),state:await store.snapshot()});
      if(path===`${PREFIX}files/rename`)return json(res,200,{result:await store.renameImage(raw),state:await store.snapshot()});
      if(path===`${PREFIX}files/export-pptx`){
        if(!raw||Object.keys(raw).some(key=>key!=='id')||!/^[a-f0-9]{24}$/u.test(raw.id))throw new InputError('导出只接受商品编号');
        const recipe=await cardRecipe(store,raw.id),result=await exportEditableCard(store,raw.id,recipe.fields);
        return json(res,200,{result,state:await store.snapshot()});
      }
      if(path===`${PREFIX}product-tasks`&&productTasks)return json(res,200,{result:await productTasks.create(raw),state:await store.snapshot()});
      if(path===`${PREFIX}product-tasks/resume-local`&&productTasks)return json(res,200,{result:await productTasks.resumeLocal(raw),state:await store.snapshot()});
      if(path===`${PREFIX}product-tasks/refine-local`&&productTasks)return json(res,200,{result:await productTasks.refineLocal(raw),state:await store.snapshot()});
      if(path===`${PREFIX}product-tasks/claim`&&productTasks)return json(res,200,{result:await productTasks.claim(raw),state:await store.snapshot()});
      if(path===`${PREFIX}product-tasks/dispatched`&&productTasks)return json(res,200,{result:await productTasks.dispatched(raw.id),state:await store.snapshot()});
      if(path===`${PREFIX}product-tasks/cancel`&&productTasks)return json(res,200,{result:await productTasks.fail(raw.id,'用户已停止当前商品任务','cancelled'),state:await store.snapshot()});
      if(path===`${PREFIX}product-tasks/publish`&&productTasks)return json(res,200,{result:await productTasks.publish(raw.id),state:await store.snapshot()});
      if(path===`${PREFIX}product-tasks/details/reveal`&&productTasks){if(!raw||Object.keys(raw).some(key=>key!=='id'))throw new InputError('详情定位只接受任务编号');const task=await productTasks.get(raw.id);if(!task.detailArchive)throw new InputError('本任务没有详情存档',404);const index=join(productTasks.directory(task.id),'details','index.html');return json(res,200,{result:await revealSummary(index),state:await store.snapshot()});}
      if(path===`${PREFIX}files/reveal`){if(!raw||Object.keys(raw).some(key=>key!=='name'))throw new InputError('文件定位只接受文件名称');return json(res,200,{result:await reveal(store,raw.name),state:await store.snapshot()});}
      if(path===`${PREFIX}helper-connection/stop`&&connector)return json(res,200,{result:connector.cancel(),state:await store.snapshot()});
      if(path.startsWith(`${PREFIX}native-batches/`)&&nativeBatch){
        const action=path.slice(`${PREFIX}native-batches/`.length);
        if(!['start','pull','pulse','reply','stop'].includes(action))throw new InputError('中央任务接口不存在',404);
        const value=await nativeBatch[action](raw);
        return json(res,200,{result:value,...(action==='pulse'||action==='pull'?{}:{state:await store.snapshot()})});
      }
      let result;
      if(path===`${PREFIX}settings`) result=await store.saveSettings(raw);
      else if(path===`${PREFIX}plans`) result=await store.plan(raw);
      else if(path===`${PREFIX}batches`&&runner) result=await runner.create(raw);
      else if(path===`${PREFIX}helper-tasks`&&runner) result=await runner.create({mode:'helper-search',settings:raw.settings});
      else if(path===`${PREFIX}helper-tasks/cancel-ready`&&runner) result=await runner.cancelReady(raw.id);
      else if(path===`${PREFIX}batches/cancel`&&runner) result=runner.cancel(raw.id);
      else if(path===`${PREFIX}imports`) result=await store.import(raw);
      else if(path===`${PREFIX}captures/native-jd`) result=await store.prepareCapture(validateNativeCapture(raw));
      else if(path===`${PREFIX}captures/native-note`) result=await store.prepareCapture(validateNativeNote(raw));
      else if(path===`${PREFIX}captures/confirm`){const prepared=productTasks&&(await store.readState()).drafts.find(draft=>draft.id===raw.id)?.preparedCard;result=await store.confirmCapture(raw);if(prepared){try{result.artifact=await productTasks.publish(prepared.taskId);}catch(error){result.artifactError=error instanceof InputError?error.message:'商品已入库，但规格图发布失败，请在任务区重试发布';}}}
      else if(path===`${PREFIX}captures/dismiss`) result=await store.dismissCapture(raw);
      else throw new InputError('接口不存在',404);
      json(res,200,{result,state:await store.snapshot()});
    } catch(err) { if(!res.headersSent) json(res,err instanceof InputError ? err.status : 500,{error:err instanceof InputError ? err.message : 'SofaMonitor 本地处理失败，请检查 DSH 日志'}); else res.end(); }
  };
}
