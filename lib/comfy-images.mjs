import{randomUUID,randomInt}from'node:crypto';
import{setTimeout as pause}from'node:timers/promises';
import{readLimited,normalizedPng,imagePrompt}from'./cloud-images.mjs';
const requiredNodes=['CheckpointLoaderSimple','LoadImage','CLIPTextEncode','VAEEncode','KSampler','VAEDecode','SaveImage'];
const leaf=value=>typeof value==='string'&&value.length<=240&&!/[\\/\x00-\x1f]/u.test(value)&&!['.','..'].includes(value);
export class ComfyImages{
 constructor(config,{fetcher=fetch,wait=pause}={}){Object.assign(this,{config,fetcher,wait});}
 endpoint(path){return this.config.url.replace(/\/$/u,'')+'/'+path;}
 async json(path,options={}){const response=await this.fetcher(this.endpoint(path),{...options,redirect:'error'});if(!response.ok)throw Error('ComfyUI请求失败（HTTP '+response.status+'）');try{return JSON.parse((await readLimited(response,4*1024*1024)).toString());}catch{throw Error('ComfyUI返回格式无效');}}
 async inspect({signal}={}){
  const combined=AbortSignal.any([signal,AbortSignal.timeout(10000)].filter(Boolean)),nodes={};for(const name of requiredNodes)Object.assign(nodes,await this.json('object_info/'+name,{signal:combined}));
  const missing=requiredNodes.filter(name=>!nodes[name]),models=nodes.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];if(missing.length||!Array.isArray(models)||!models.length)throw Error('ComfyUI已连接，但缺少可用的标准图生图节点或Checkpoint模型');
  return{connected:true,supported:true,checkpoint:models[0],modelCount:models.length};
 }
 async clean(bytes,options={}){
  const signal=AbortSignal.any([options.signal,AbortSignal.timeout(120000)].filter(Boolean)),info=this.info||(this.info=await this.inspect({signal})),name='sofa-'+randomUUID()+'.png',form=new FormData();form.set('image',new Blob([bytes],{type:'image/png'}),name);form.set('type','input');form.set('overwrite','false');
  const uploaded=await this.json('upload/image',{method:'POST',body:form,signal});if(!leaf(uploaded.name)||uploaded.subfolder&&(!/^[\w-]+(?:\/[\w-]+)*$/u.test(uploaded.subfolder)))throw Error('ComfyUI上传结果文件名无效');const input=(uploaded.subfolder?uploaded.subfolder+'/':'')+uploaded.name;
  const prompt={
   '1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:info.checkpoint}},
   '2':{class_type:'LoadImage',inputs:{image:input}},
   '3':{class_type:'CLIPTextEncode',inputs:{text:imagePrompt(options),clip:['1',1]}},
   '4':{class_type:'CLIPTextEncode',inputs:{text:'different sofa, altered structure, extra furniture, changed color, deformed parts, people, text, watermark',clip:['1',1]}},
   '5':{class_type:'VAEEncode',inputs:{pixels:['2',0],vae:['1',2]}},
   '6':{class_type:'KSampler',inputs:{seed:randomInt(0,2147483647),steps:16,cfg:5,sampler_name:'euler',scheduler:'normal',denoise:.18,model:['1',0],positive:['3',0],negative:['4',0],latent_image:['5',0]}},
   '7':{class_type:'VAEDecode',inputs:{samples:['6',0],vae:['1',2]}},
   '8':{class_type:'SaveImage',inputs:{images:['7',0],filename_prefix:'sofa-monitor/'+name.slice(0,-4)}}
  };
  const queued=await this.json('prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,client_id:randomUUID()}),signal});if(typeof queued.prompt_id!=='string'||!/^[\w-]{1,100}$/u.test(queued.prompt_id)||queued.error)throw Error('ComfyUI没有接受图片处理任务');
  for(;;){signal.throwIfAborted();const data=await this.json('history/'+encodeURIComponent(queued.prompt_id),{signal}),row=data[queued.prompt_id];if(row?.status?.status_str==='error')throw Error('ComfyUI工作流执行失败，保留原图');const result=row?.outputs?.['8']?.images?.[0];if(result){if(!leaf(result.filename)||!['output','temp'].includes(result.type)||result.subfolder&& !/^[\w-]+(?:\/[\w-]+)*$/u.test(result.subfolder))throw Error('ComfyUI结果文件名无效');const query=new URLSearchParams({filename:result.filename,type:result.type,subfolder:result.subfolder||''}),response=await this.fetcher(this.endpoint('view?'+query),{signal,redirect:'error'});if(!response.ok)throw Error('ComfyUI结果读取失败');const output=await normalizedPng(await readLimited(response));return{bytes:output,edited:true,model:'ComfyUI · '+info.checkpoint,promptId:queued.prompt_id};}await this.wait(1000,undefined,{signal});}
 }
}
