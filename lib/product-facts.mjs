// Normalize only text already captured from this product. Every derived value
// retains its literal quote and source; layout must never invent measurements.
import {dimensionsFromSpecs,isDimensionValue} from './dimensions.mjs';
const missing=value=>!value||/^(?:未标注|未提供|暂无|未知|不详)$/u.test(String(value).trim());
const aliases={坐深:'座深',坐高:'座高',坐宽:'座宽',座位宽度:'座宽',坐面宽度:'座宽',座面宽度:'座宽',坐面深度:'座深',座面深度:'座深',坐面高度:'座高',座面高度:'座高'};
const brands=['林氏家居','林氏木业','源氏木语','顾家家居','芝华仕','左右家私','左右沙发','慕思','全友家居','全友','喜临门','曲美家居','联邦家私','斯可馨'];
const colors=value=>String(value||'').match(/(?:黑茶|椰岛棕|焦糖|奶油|米白|暖白|高级白|象牙白|月光白|星翼黑|星曜黑|曜石黑|深灰|浅灰|烟灰|栗棕|栗杏棕|栗杏|咖啡|奶咖|棕褐|墨绿|奶白|黑|白|灰|棕|蓝|绿|橙|米)(?:色)?/gu)||[];
function colorValue(value){const text=String(value||'').trim();if(!text||/[0-9]|[【】\[\]++]|海绵|乳胶|太空棉|人位|人座|接触面|MM|mm/u.test(text))return'';return text.length<=16&&colors(text).length?text:'';}
export function modelFromTitle(title){
 const text=String(title||'');const code=text.match(/(?:\d{1,3}\.)?[A-Za-z]{1,8}(?:[._-][A-Za-z]{1,8})?[._-]?\d{2,6}(?:[A-Za-z]+\d{1,6})*(?:-[A-Za-z0-9]{1,6})?(?![A-Za-z0-9])/u)?.[0]||'';
 return code&&!/^(?:ISO|GB|QB|EN|USB)\d/iu.test(code)?code:'';
}
export function normalizeProductFacts(product){
 const source={...(product.fieldEvidence||{})},specs={...(product.specs||{})},title=String(product.title||'');
 const add=(key,value,kind,quote,imageIndex)=>{if(missing(value)||!missing(specs[key]))return;if(Object.keys(specs).length>=30)return;specs[key]=value;source['specs.'+key]={kind,quote,...(imageIndex===undefined?{}:{imageIndex})};};
 for(const[key,value]of Object.entries(specs))if(aliases[key])add(aliases[key],value,'official-parameter',key+'：'+value);
 let brand=product.brand,model=product.model,modelSource=product.modelSource;
 if(missing(brand)){
  const named=specs['品牌']||specs['商品品牌'],known=brands.find(name=>title.startsWith(name)),latin=title.match(/^([A-Za-z][A-Za-z0-9]{1,18})(?=[\u3400-\u9fff])/u)?.[1];
  if(!missing(named)||known||latin){brand=!missing(named)?named:known||latin;source.brand={kind:!missing(named)?'official-parameter':'product-title',quote:!missing(named)?named:brand};}
 }
 if(missing(model)||modelSource==='title'||model===title||model===specs['货号']&&!specs['型号']&&modelFromTitle(title)&&!model.toUpperCase().startsWith(modelFromTitle(title).toUpperCase())){const named=specs['型号'],code=modelFromTitle(title),fallback=specs['货号'];if(!missing(named)||code||!missing(fallback)){model=!missing(named)?named:code||fallback;modelSource=!missing(named)||!code?'official-parameter':'product-title';source.model={kind:modelSource,quote:model};}else{model=title;modelSource='title';}}
 const selectedDimension=specs['尺寸']||specs['页面选项_尺寸'],selection=[specs['款式'],specs['颜色']||specs['页面选项_颜色'],specs['尺码'],specs['系列品'],selectedDimension].filter(Boolean).join('；'),literal=selection+'；'+title;
 if(selectedDimension&&/电动|旗舰款|头枕|沙发床/u.test(selectedDimension)){delete specs['尺寸'];add('页面选项_尺寸',selectedDimension,'selected-option',selectedDimension);}
 // JD labels a configuration group "颜色" even if it contains length/material.
 if(specs['颜色']&&!colorValue(specs['颜色'])){add('页面选项_颜色',specs['颜色'],'selected-option',specs['颜色']);delete specs['颜色'];}
 const selectedColor=colorValue(specs['颜色'])||selection.match(/(?:黑茶色|椰岛棕|焦糖色|奶油色|米白色|暖白色|高级白|象牙白|月光白|星曜黑|曜石黑|深灰色|浅灰色|栗杏棕|咖啡色|奶咖色|墨绿色|黑色|白色|灰色|棕色|蓝色|米色)/u)?.[0];
 if(selectedColor)add('颜色',selectedColor,'selected-option',selection);
 const leather=literal.match(/(?:加厚)?头层牛皮|(?:顶光)?半青皮|头层皮|科技布|绒布|棉麻/u)?.[0];if(leather){add('面料材质',leather,'selected-option-or-title',leather);if(specs['面料材质']!==leather)add('选中面料',leather,'selected-option-or-title',leather);}
 const fills=[...literal.matchAll(/竹炭海绵|天然乳胶|太空棉|紫罗兰(?:海绵)?|乳胶|海绵|羽绒|公仔棉/gu)].map(m=>m[0]);if(fills.length)add('填充物',[...new Set(fills)].filter(v=>!fills.some(long=>long!==v&&long.includes(v))).join(' + '),'selected-option-or-title',selection||title);
 if(/电动/u.test(title))add('附加功能','电动调节','product-title',title);
 const explicitTriple=selection.match(/([0-9]+(?:\.[0-9]+)?\s*[*×x]\s*[0-9]+(?:\.[0-9]+)?\s*[*×x]\s*[0-9]+(?:\.[0-9]+)?)\s*(mm|cm|毫米|厘米)/iu);if(explicitTriple)add('产品尺寸',explicitTriple[1].replace(/[*x]/gu,'×')+explicitTriple[2],'selected-option',explicitTriple[0]);
 const selectedLength=selection.match(/(?<![0-9.])([0-9]+(?:\.[0-9]+)?)\s*(米|m|M)\s*(?:大?单人|大?双人|三人|四人|直排|沙发)/u)||String(selectedDimension||'').match(/(?<![0-9.])([0-9]+(?:\.[0-9]+)?)\s*(米|m|M)(?!m)/u);
 if(selectedLength)add('产品长度',selectedLength[1]+(selectedLength[2]==='米'?'米':'m'),'selected-option',selectedLength[0]);
 // Reuse already captured image quotes. Never substitute "大坐深" for its
 // number, and never treat a leather thickness as a furniture measurement.
 for(const fact of product.visual?.imageFacts||[]){const quote=String(fact.quote||'');for(const[key,label]of[['座深','(?:坐深|座深)'],['座高','(?:坐高|座高)'],['座宽','(?:坐宽|座宽|坐面宽度|座面宽度)']]){
   const number='([0-9]+(?:\\.[0-9]+)?(?:\\s*[-—–~～至]\\s*[0-9]+(?:\\.[0-9]+)?)?)\\s*(cm|mm|厘米|毫米|米|m)',before=quote.match(new RegExp(number+'\\s*(?:大)?'+label,'iu')),after=quote.match(new RegExp(label+'[^0-9]{0,5}'+number,'iu')),match=before||after;
   if(match)add(key,match[1].replace(/\s/gu,'')+match[2],'image-text',quote,fact.imageIndex??0);
  }}
 const dataConflicts=(product.dataConflicts||[]).filter(row=>row.kind==='image-parameter'),selectedMotor=selection.match(/([单双三四1-4])电动/u)?.[1],motorCount=selectedMotor?({单:1,双:2,三:3,四:4}[selectedMotor]||Number(selectedMotor)):null,officialMotor=Number(String(specs['电动位数量']||'').match(/[1-4]/u)?.[0]);
 if(motorCount&&officialMotor&&motorCount!==officialMotor)dataConflicts.push({field:'电动位数量',officialValue:specs['电动位数量'],selectedValue:selectedMotor+'电动',reason:'参数表与当前选项的电动位口径不一致'});
 return{...product,brand:missing(brand)?'未标注':brand,model,modelSource,specs,fieldEvidence:source,dataConflicts};
}
export function measurementSummary(product){
 const p=normalizeProductFacts(product),s=p.specs,get=(...keys)=>keys.map(key=>s[key]).find(value=>!missing(value)&&isDimensionValue(value,'尺寸'))||'未标注';
 return{dimensions:dimensionsFromSpecs(s),seatDepth:get('座深','坐深'),seatHeight:get('座高','坐高'),seatWidth:get('座宽','坐宽','座位宽度','坐面宽度'),overallHeight:get('总高','整体高度','高度')};
}
export function productDataQuality(product){
 const p=normalizeProductFacts(product),m=measurementSummary(p),absent=[];
 if(p.visual?.imageMissing===true)absent.push('主图');if(p.visual?.price==null&&p.price==null&&!Object.entries(p.specs).some(([key,value])=>/价|price/iu.test(key)&&/[0-9]/u.test(value)))absent.push('价格');
 if(missing(p.brand))absent.push('品牌');if(p.modelSource==='title')absent.push('型号');
 for(const[key,label]of[['dimensions','整体尺寸'],['seatDepth','座深'],['seatHeight','座高'],['seatWidth','座宽']])if(missing(m[key]))absent.push(label);
 if(m.dimensions.includes('仅长度'))absent.push('整体宽高');
 for(const row of p.dataConflicts)if(!absent.includes(row.field+'口径核对'))absent.push(row.field==='电动位数量'?'电动位口径核对':row.field+'口径核对');
 if(p.detailReview&&p.detailReview.complete!==true)absent.push('详情图核对未完整');
 return{level:absent.length?'partial':'complete',missing:absent,measurements:m,version:1};
}
export function applyImageSpecifications(product,rows,{maxImages=3}={}){
 let p=normalizeProductFacts(product);const accepted=[],specs={...p.specs},fieldEvidence={...p.fieldEvidence};
 const names=['品牌','型号','颜色','面料材质','填充物','附加功能','产品尺寸','座深','座高','座宽','产品长度','总高'];
 const compact=value=>String(value).normalize('NFKC').replace(/[\s—–~～至]/gu,m=>/\s/u.test(m)?'':'-').toLowerCase();
 for(const row of Array.isArray(rows)?rows.slice(0,Math.min(200,maxImages*20)):[]){
  if(!names.includes(row?.field)||typeof row.value!=='string'||typeof row.quote!=='string'||!row.value.trim()||row.value.length>120||row.quote.length>240||!Number.isInteger(row.imageIndex)||row.imageIndex<0||row.imageIndex>=maxImages||!compact(row.quote).includes(compact(row.value)))continue;
  if(['座深','座高','座宽','总高','产品长度','产品尺寸'].includes(row.field)){
   const label={座深:/(?:坐深|座深|座面深度|坐面深度)/u,座高:/(?:坐高|座高|座面高度|坐面高度)/u,座宽:/(?:坐宽|座宽|座面宽度|坐面宽度)/u,总高:/(?:总高|整体高度)/u,产品长度:/(?:总长|长度|沙发长)/u,产品尺寸:/(?:尺寸|长.{0,25}宽.{0,25}高)/u}[row.field];
   if(!label.test(row.quote)||!isDimensionValue(row.value,'尺寸')||/皮.{0,8}(?:厚|mm|毫米)|厚度/iu.test(row.quote))continue;
  }
  if(row.field==='颜色'&&!colorValue(row.value))continue;
  if(!missing(specs[row.field])){if(compact(specs[row.field])!==compact(row.value)&&['座深','座高','座宽','产品尺寸','总高'].includes(row.field)&&!p.dataConflicts.some(c=>c.field===row.field&&c.selectedValue===row.value))p.dataConflicts.push({kind:'image-parameter',field:row.field,officialValue:specs[row.field],selectedValue:row.value,quote:row.quote,imageIndex:row.imageIndex,reason:'官方参数与同款详情图原文不一致；分别保留，不自行选择'});if(row.field==='面料材质'&&specs[row.field]==='其他'&&!specs['选中面料']&&Object.keys(specs).length<30){specs['选中面料']=row.value;fieldEvidence['specs.选中面料']={kind:'image-text',quote:row.quote,imageIndex:row.imageIndex};}continue;}if(Object.keys(specs).length>=30)continue;
  specs[row.field]=row.value.trim();fieldEvidence['specs.'+row.field]={kind:'image-text',quote:row.quote,imageIndex:row.imageIndex};accepted.push(row);
 }
 p=normalizeProductFacts({...p,specs,fieldEvidence});return{product:p,accepted};
}
