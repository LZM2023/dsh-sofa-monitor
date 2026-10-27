import{PhotoSelection}from'./photo-selection.mjs';
import{desktopBrowserHealth}from'./desktop-health.mjs';
import{DetailReview}from'./detail-review.mjs';
import{TaskDispatcher}from'./task-dispatcher.mjs';
import{ImageProcessing}from'./image-processing.mjs';
import{ensureCollectionPacer}from'./collection-pacer.mjs';
import{TemplateLibrary}from'./template-library.mjs';
import{repairCardPoints}from'./repair-card-points.mjs';
import{repairCardQuality}from'./repair-card-quality.mjs';
import {CollectionArchive} from './collection-archive.mjs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Store } from './storage.mjs';
import { handler, PREFIX } from './http.mjs';
import { VERSION } from './domain.mjs';
import { registerAgentTools } from './agent-tools.mjs';
import {BatchRunner} from './batch.mjs';
import {NativeBatchBridge} from './native-batch.mjs';
import {HelperConnection} from './helper-connection.mjs';
import {CardBatches} from './card-batch.mjs';
import {ProductTasks} from './product-task.mjs';
export const name = 'sofa-monitor';
export const inject = ['webServer'];
export async function apply(ctx, config={}) {
  await ctx.effect(async()=> {
    const profile=ctx.get('desktopProfiles')?.current;
    // Desktop profile identity comes from its supported service, never guessed.
    const root=config.dataDir ? resolve(config.dataDir) : profile ? join(profile.dir,'.sofa-monitor') : join(process.env.DSH_HOME || join(homedir(),'.dsh'),'sofa-monitor');
    const started=performance.now(),store=await new Store(root).init(),storageReady=performance.now();
    await ensureCollectionPacer(store).initialize();
    await store.collectionPacer.recover();
    store.templateLibrary=await new TemplateLibrary(join(root,'template-library')).init();
    store.desktopBrowser=await desktopBrowserHealth();
    const runner=new BatchRunner(store);
    const nativeBatch=new NativeBatchBridge(store,runner);
    const getPicker=()=>ctx.get('directoryPicker')?.capability();
    const archive=new CollectionArchive(store,{canChoose:()=>getPicker()?.kind==='native',pickDirectory:signal=>{const picker=getPicker();if(picker?.kind!=='native')throw Error('DSH本机文件夹选择器尚未加载');return picker.pick(signal);}});await archive.init();
    const productTasks=new ProductTasks(store,{archive}),cardBatches=new CardBatches(store,productTasks);
    const dispatcher=new TaskDispatcher(ctx,store,productTasks,cardBatches);
    productTasks.dispatcher=cardBatches.dispatcher=dispatcher;
    store.collectionPacer.onPause=async()=>{for(const controller of productTasks.controllers.values())controller.abort();for(const controller of cardBatches.controllers.values())controller.abort();};
    dispatcher.start();
    productTasks.detailReview=new DetailReview(ctx);productTasks.photoSelector=new PhotoSelection(productTasks.detailReview);
    productTasks.imageCleaner=productTasks.imageProcessing=await new ImageProcessing(root,{review:productTasks.detailReview}).init();
    await productTasks.recoverStoredArtifacts();
    await productTasks.recoverAutomaticPublications();
    const repairedCards=await repairCardPoints(store);if(repairedCards.repaired.length)ctx.logger.info('已修复 '+repairedCards.repaired.length+' 张旧规格卡的占位卖点');if(repairedCards.skipped.length)ctx.logger.warn('有 '+repairedCards.skipped.length+' 张原规格卡保持不变，未能自动修复');
    // Package installation may evaluate plugin metadata in another process.
    // Defer this migration until the running panel requests its own bootstrap;
    // never rewrite shared product state from an installation probe.
    let qualityRepairPromise;
    store.ensureCardQuality=async()=>{if(qualityRepairPromise)return qualityRepairPromise;const state=await store.readState();if(state.productTasks.some(row=>['ready','queued','running','cooldown','publishing'].includes(row.status))||state.jobs.some(row=>['ready','running'].includes(row.status)))return{deferred:true};return qualityRepairPromise=(async()=>{const result=await repairCardQuality(store,archive);if(result.repaired.length)ctx.logger.info('已用本地资料修正规格卡 '+result.repaired.length+' 张；原卡已备份，不访问平台');if(result.skipped.length)ctx.logger.warn('规格卡本地修复未完成 '+result.skipped.length+' 张，下次启动可重试');return result;})();};
    const artifactsReady=performance.now();
    const connector=new HelperConnection({getExtensionPath:async()=>{const response=await fetch('http://127.0.0.1:'+ctx.webServer.port+'/ext/bridge-config',{signal:AbortSignal.timeout(5000)});if(!response.ok)return;const config=await response.json();return config.extensionPath;}});
    const disposeRoute=ctx.webServer.register({name:'sofa-monitor',kind:'prefix',path:PREFIX.slice(0,-1),handler:handler(store,runner,nativeBatch,connector,{productTasks,cardBatches,archive})});
    ctx.inject(['tools'],toolCtx=>toolCtx.effect(()=>registerAgentTools(toolCtx,store,runner,connector,productTasks,cardBatches),'sofa-monitor: agent tools'));
    ctx.logger.info(`SofaMonitor ${VERSION} ready; storage ${Math.round(storageReady-started)}ms; archive recovery ${Math.round(artifactsReady-storageReady)}ms; initialization ${Math.round(performance.now()-started)}ms`);
    const disposeProbe=ctx.reflect.provide('sofaMonitor',{version:VERSION,profile:profile ? {name:profile.name,dir:profile.dir} : null,dataDir:root,templateLibrary:store.templateLibrary,snapshot:()=>store.snapshot()});
    return async()=> {disposeRoute();disposeProbe();store.collectionPacer.close();connector.close();await dispatcher.close();await cardBatches.close();await productTasks.close();await nativeBatch.close();await runner.close();await archive.queue;await store.queue;await store.templateLibrary.queue;};
  },'sofa-monitor: storage and routes');
}
