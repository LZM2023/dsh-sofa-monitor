import{imageFocus}from'./image-focus.mjs';
// Loading the native renderer is unnecessary until the first card is requested.
let canvasModule;
const getCanvas=()=>canvasModule ||= import('@napi-rs/canvas').catch(error=>{canvasModule=undefined;throw error;});
import {drawSpecCard,CARD_TEMPLATE} from './spec-layout.mjs';
import {pngSize} from './cards.mjs';
import {InputError} from './domain.mjs';
export async function renderStandardCard(product,fields,photos){
  if(photos.length!==fields.features.length+1)throw new InputError('模板主图与细节数量不一致');
  for(const bytes of photos){const size=pngSize(bytes);if(!size.width||!size.height||Math.max(size.width,size.height)>8192||bytes.length>24*1024*1024)throw new InputError('模板图片无效或过大');}
  const {createCanvas,loadImage}=await getCanvas();
  const images=await Promise.all(photos.map(bytes=>loadImage(bytes))),canvas=drawSpecCard({product,fields,mainCrop:imageFocus(images[0],createCanvas(192,192))},images,createCanvas(1920,1080));
  return{bytes:await canvas.encode('png'),template:fields.templateDefinition?fields.templateDefinition.id+':'+fields.templateDefinition.revision:CARD_TEMPLATE,width:1920,height:1080};
}
