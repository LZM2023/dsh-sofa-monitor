import{createHash,randomUUID}from'node:crypto';
import{readFile,writeFile,mkdir,rename,lstat}from'node:fs/promises';
import{join}from'node:path';
import{IMAGE_CLEAN_PROMPT}from'./qwen-api.mjs';
export const ALI_IMAGE_URL='https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export async function readLimited(response,max=24*1024*1024){let size=0;const chunks=[];for await(const part of response.body){size+=part.length;if(size>max)throw Error('图片服务返回文件过大');chunks.push(Buffer.from(part));}return Buffer.concat(chunks);}
export function imagePrompt({role='main',part='',adjustAngle=false}={}){return (adjustAngle?IMAGE_CLEAN_PROMPT.replace('与原拍摄角度','').replace('不生成新的款式或视角','不生成新的款式'):IMAGE_CLEAN_PROMPT)+(adjustAngle?' 允许仅将同款沙发调整为45度三分之四视角，保持结构与配色，不能生成新款式。':'')+(role==='detail'?' 本张是'+part+'近景，保持同一完整部件和近景机位，禁止生成整张沙发或额外部件。':' 本张为商品主图，保持完整沙发、扶手和支撑脚。');}
export async function normalizedPng(bytes){const{loadImage,createCanvas}=await import('@napi-rs/canvas'),im=await loadImage(bytes);if(im.width<64||im.height<64||im.width>8192||im.height>8192)throw Error('图片处理结果尺寸无效');const canvas=createCanvas(im.width,im.height);canvas.getContext('2d').drawImage(im,0,0);return canvas.toBuffer('image/png');}
export class CloudImages{
 constructor(root,config,{fetcher=fetch}={}){Object.assign(this,{root,config,fetcher});}
 async clean(bytes,options={}){
  const{url,model,apiKey}=this.config,prompt=imagePrompt(options),digest=createHash('sha256').update(url).update(model).update(prompt).update(bytes).digest('hex'),directory=join(this.root,'image-clean-cache'),cache=join(directory,digest+'.png');await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink())throw Error('图片缓存目录不可用');
  try{if((await lstat(cache)).isSymbolicLink())throw Error('图片缓存不能是链接');return{bytes:await readFile(cache),edited:true,cached:true,model};}catch(error){if(error.code!=='ENOENT')throw error;}
  const signal=AbortSignal.any([options.signal,AbortSignal.timeout(120000)].filter(Boolean)),ali=/\/multimodal-generation\/generation\/?$/u.test(new URL(url).pathname);let endpoint=url,body,headers={Authorization:'Bearer '+apiKey};
  if(ali){headers['Content-Type']='application/json';body=JSON.stringify({model,input:{messages:[{role:'user',content:[{image:'data:image/png;base64,'+bytes.toString('base64')},{text:prompt}]}]},parameters:{n:1,watermark:false,prompt_extend:false}});}
  else{const u=new URL(url);if(!/\/images\/edits\/?$/u.test(u.pathname))u.pathname=(u.pathname==='/'?'/v1':u.pathname.replace(/\/$/u,''))+'/images/edits';endpoint=u.href;const form=new FormData();form.set('model',model);form.set('prompt',prompt);form.set('n','1');if(!/^gpt-image/iu.test(model))form.set('response_format','b64_json');form.set('image',new Blob([bytes],{type:'image/png'}),'source.png');body=form;}
  const response=await this.fetcher(endpoint,{method:'POST',headers,body,signal,redirect:'error'});if(!response.ok)throw Object.assign(Error('云端图片处理失败（HTTP '+response.status+'），保留原图'),{code:'image-service-error',status:response.status});
  let data;try{data=JSON.parse((await readLimited(response,40*1024*1024)).toString());}catch{throw Error('云端图片处理返回格式无效');}
  let output;const b64=data.data?.[0]?.b64_json;if(typeof b64==='string'&&b64.length<=34*1024*1024&&/^[A-Za-z0-9+/=\r\n]+$/u.test(b64))output=Buffer.from(b64,'base64');
  else{const raw=ali?data.output?.choices?.[0]?.message?.content?.find(row=>typeof row.image==='string')?.image:data.data?.[0]?.url;let target;try{target=new URL(raw);}catch{throw Error('云端服务没有返回图片');}const requestUrl=new URL(url),same=target.origin===requestUrl.origin,known=ali&&target.hostname.endsWith('.aliyuncs.com')||!ali&&target.hostname.endsWith('.blob.core.windows.net');if(target.protocol!=='https:'||target.username||target.password||(!same&&!known))throw Error('云端服务返回了未允许的图片地址，请使用返回Base64图片的接口');const result=await this.fetcher(target,{signal,redirect:'error'});if(!result.ok)throw Error('云端处理结果下载失败');output=await readLimited(result);}
  signal.throwIfAborted();const png=await normalizedPng(output),tmp=cache+'.'+randomUUID()+'.tmp';await writeFile(tmp,png,{flag:'wx'});await rename(tmp,cache);return{bytes:png,edited:true,model};
 }
}
