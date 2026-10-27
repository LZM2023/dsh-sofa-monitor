import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {drawSpecCard} from './spec-layout.mjs';
import {imageFocus} from './image-focus.mjs';
import {cardAsset,validateCardFields,pngSize} from './cards.mjs';

// Replay the shared card layout as native PowerPoint text, shapes and pictures.
// Canvas supplies font metrics only. No flattened card is embedded in the deck.
export async function renderEditablePptx(product,fields,photos){
 fields=validateCardFields(fields);
 if(photos.length!==fields.features.length+1)throw Error('PPTX图片与细节数量不一致');
 for(const bytes of photos){const size=pngSize(bytes);if(!size.width||!size.height||Math.max(size.width,size.height)>8192||bytes.length>24*1024*1024)throw Error('PPTX图片无效或过大');}
 const pptx=new PptxGenJS();pptx.defineLayout({name:'SOFA',width:20,height:11.25});pptx.layout='SOFA';
 pptx.author='SofaMonitor';pptx.subject=product.sourceUrl;pptx.title=product.title;pptx.lang='zh-CN';
 pptx.theme={headFontFace:'Microsoft YaHei',bodyFontFace:'Microsoft YaHei',lang:'zh-CN'};
 const slide=pptx.addSlide(),images=await Promise.all(photos.map(bytes=>loadImage(bytes))),metrics=createCanvas(192,192).getContext('2d'),stack=[],crops=[];
 let transform={x:0,y:0,sx:1,sy:1},clip=null,path=[];
 const pos=(x,y,w,h)=>({x:(transform.x+x*transform.sx)/96,y:(transform.y+y*transform.sy)/96,w:w*transform.sx/96,h:h*transform.sy/96});
 const tint=value=>String(value||'#282c2d').replace('#','');
 const ctx={font:'18px "Microsoft YaHei"',fillStyle:'#282c2d',strokeStyle:'#282c2d',
  save(){stack.push({transform:{...transform},clip,fill:this.fillStyle,stroke:this.strokeStyle,font:this.font});},
  restore(){const s=stack.pop();transform=s.transform;clip=s.clip;this.fillStyle=s.fill;this.strokeStyle=s.stroke;this.font=s.font;},
  translate(x,y){transform.x+=x*transform.sx;transform.y+=y*transform.sy;},scale(x,y){transform.sx*=x;transform.sy*=y;},
  beginPath(){path=[];},rect(x,y,w,h){clip=pos(x,y,w,h);},clip(){},
  measureText(text){metrics.font=this.font;return metrics.measureText(String(text));},
  fillText(text,x,y){
   metrics.font=this.font;const size=Number(this.font.match(/([\d.]+)px/u)?.[1]||18),width=metrics.measureText(String(text)).width+2,p=pos(x,y-size*.92,width,size*1.3);
   if(clip){if(p.y>=clip.y+clip.h||p.x>=clip.x+clip.w)return;p.w=Math.max(.01,Math.min(p.w,clip.x+clip.w-p.x));p.h=Math.max(.01,Math.min(p.h,clip.y+clip.h-p.y));}
   slide.addText(String(text),{...p,fontFace:'Microsoft YaHei',fontSize:size*transform.sy*.75,bold:/^700 /u.test(this.font),color:tint(this.fillStyle),margin:0,breakLine:false,wrap:false,fit:'resize',valign:'top',paraSpaceAfterPt:0,objectName:'文字 '+String(text).slice(0,48)});
  },
  fillRect(x,y,w,h){slide.addShape(pptx.ShapeType.rect,{...pos(x,y,w,h),fill:{color:tint(this.fillStyle)},line:{color:tint(this.fillStyle),transparency:100},objectName:'版式色块'});},
  strokeRect(x,y,w,h){slide.addShape(pptx.ShapeType.rect,{...pos(x,y,w,h),fill:{color:'FFFFFF',transparency:100},line:{color:tint(this.strokeStyle),width:.5},objectName:'表格边框'});},
  moveTo(x,y){path.push([x,y]);},lineTo(x,y){path.push([x,y]);},
  stroke(){if(path.length<2)return;const [a,b]=path;slide.addShape(pptx.ShapeType.line,{...pos(a[0],a[1],b[0]-a[0],b[1]-a[1]),line:{color:tint(this.strokeStyle),width:.75}});},
  drawImage(image,...args){
   const index=images.indexOf(image);let sx=0,sy=0,sw=image.width,sh=image.height,dx,dy,dw,dh;
   if(args.length===8)[sx,sy,sw,sh,dx,dy,dw,dh]=args;else [dx,dy,dw,dh]=args;
   slide.addImage({data:'image/png;base64,'+photos[index].toString('base64'),...pos(dx,dy,dw,dh),altText:index?'商品细节 '+index:'商品主图',objectName:index?'细节图 '+index:'商品主图'});
   crops.push({l:sx/image.width,t:sy/image.height,r:1-(sx+sw)/image.width,b:1-(sy+sh)/image.height});
  }
 };
 drawSpecCard({product,fields,mainCrop:imageFocus(images[0],createCanvas(192,192))},images,{getContext:()=>ctx});
 slide.addNotes('商品来源：'+product.sourceUrl+'\n采集时间：'+fields.priceAt+'\n'+(fields.notes||'未公开参数保留未标注，价格及功能以商品页面为准。'));
 const zip=await JSZip.loadAsync(await pptx.write({outputType:'nodebuffer',compression:true}));
 // Keep original image data and encode the exact shared crop as native srcRect.
 let i=0;const key='ppt/slides/slide1.xml',xml=await zip.file(key).async('string');
 zip.file(key,xml.replace(/<p:pic>[\s\S]*?<\/p:pic>/gu,picture=>{const crop=crops[i++],attrs=Object.entries(crop).map(([k,v])=>k+'="'+Math.round(Math.max(0,Math.min(1,v))*100000)+'"').join(' ');return picture.replace('<a:stretch>','<a:srcRect '+attrs+'/><a:stretch>');}));
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}

export async function exportEditableCard(store,id,fields){
 fields=validateCardFields(fields);
 const product=(await store.readState()).products.find(row=>row.id===id);
 if(!product)throw Error('商品不存在');
 const photos=await Promise.all(['main.png',...fields.features.map((_,i)=>'detail-'+(i+1)+'.png')].map(name=>cardAsset(store,id,name)));
 return store.writePresentation(id+'.pptx',await renderEditablePptx(product,fields,photos));
}
