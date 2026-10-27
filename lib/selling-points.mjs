const empty=/^(?:未标注|未提供|暂无|无|不详)$/u;
export function genericFeature(value){return typeof value!=='string'||!value.trim()||/^(?:(?:(?:官方|商品|产品)?(?:图片)?细节(?:图)?|官方图片|主图局部|卖点)\s*[0-9一二三A-Za-z]*|商品图片内容未标注)$/u.test(value.trim());}
export function productSellingPoints(product,raw={},count=2){
 const specs=product.specs||{},facts=[];
 const groups=[[/^(?:面料材质|坐面材质|面料|材质)$/u,'面料材质'],[/^(?:附加功能|功能)$/u,'功能设计'],[/^(?:电动位数量)$/u,'电动位'],[/^(?:填充物|填充材质)$/u,'内部填充'],[/^(?:主体材质|框架材质|支架材质)$/u,'支撑结构'],[/^(?:座深|坐深)$/u,'座深'],[/^(?:座高|坐高)$/u,'座高'],[/^(?:座宽|坐宽)$/u,'座宽'],[/^(?:附加组件)$/u,'组件设计']];
 for(const[pattern,label]of groups){if(product.dataConflicts?.some(row=>row.field===(label==='电动位'?'电动位数量':label)))continue;const entry=label==='面料材质'&&specs['选中面料']?['选中面料',specs['选中面料']]:Object.entries(specs).find(([key,value])=>pattern.test(key)&&typeof value==='string'&&!empty.test(value.trim()));if(entry)facts.push({text:label+'：'+entry[1],title:label,subtitle:entry[1],source:entry[0],quote:entry[1]});}
 const title=String(product.title||'');for(const[phrase,label]of[['头层牛皮','面料材质'],['半青皮','面料材质'],['零靠墙','功能设计'],['电动','功能设计'],['乳胶','内部填充'],['海绵','内部填充'],['储物袋','组件设计'],['USB接口','组件设计']])if(title.includes(phrase)&&!facts.some(row=>row.text.includes(phrase)))facts.push({text:label+'：'+phrase,title:label,subtitle:phrase,source:'商品标题',quote:phrase});
 const imagePoints=[];
 for(const row of product.visual?.imageFacts||[]){if(!row.text||!row.quote||/产品名称|商品名称|产品类型|产品名称及类型/u.test(row.text))continue;const value=row.text.trim();if(value.length>60||!row.quote.replace(/\s/gu,'').includes(value.replace(/\s/gu,'')))continue;
  const label=/头枕.*(?:调|折)|可调头枕/u.test(value)?'头枕调节':/扶手.*(?:调|变化)/u.test(value)?'扶手调节':/靠背.*(?:调|变化)|两档.*高靠/u.test(value)?'靠背调节':/座深|坐深/u.test(value)?'图示座深范围':/填充|海绵|公仔棉|羽毛|羽绒|乳胶/u.test(value)?'内部填充':/牛皮|真皮|PVC|皮革/u.test(value)?'面料材质':/白蜡木|黑胡桃木|实木|框架|龙骨|弹簧|绷带/u.test(value)?'支撑结构':/质保|保修/u.test(value)?'服务保障':/储物|USB|电动|调节/u.test(value)?'功能设计':null;
  if(!label||label==='服务保障'&&!/(?:框架|电机|皮革|面料|整机|整椅|整套|全品).{0,12}(?:质保|保修)/u.test(row.quote)||label==='图示座深范围'&&product.dataConflicts?.some(row=>row.field==='座深'))continue;
  const score=value.length+( /头枕|扶手|靠背/u.test(label)?100:0),old=imagePoints.find(point=>point.title===label);
  if(!old||score>old.score){const point={text:label+'：'+value,title:label,subtitle:value,source:'原图文字',quote:row.quote,score};if(old)imagePoints.splice(imagePoints.indexOf(old),1,point);else imagePoints.push(point);}
 }
 const supplied=(Array.isArray(raw.sellingPoints)?raw.sellingPoints:Array.isArray(raw.features)?raw.features:[]).map((text,index)=>({text,title:raw.detailTitles?.[index],subtitle:raw.detailSubtitles?.[index]})).filter(row=>!genericFeature(row.text)&&!/^标题标注|^图文标注/u.test(row.text));
 const grouped=[];for(const row of facts){const existing=grouped.find(item=>item.title===row.title);if(existing){if(!existing.subtitle.includes(row.subtitle)){existing.subtitle+='；'+row.subtitle;existing.text=existing.title+'：'+existing.subtitle;}}else grouped.push({...row});}
 const replaced=grouped.map(row=>imagePoints.find(point=>point.title===row.title)||row),extras=imagePoints.filter(row=>!grouped.some(point=>point.title===row.title)).sort((a,b)=>b.score-a.score),ordered=extras.length?[...replaced.slice(0,1),...extras,...replaced.slice(1)]:replaced;
 const points=[],seen=new Set();for(const row of [...ordered,...supplied]){const value=String(row.text).trim().slice(0,100);if(!seen.has(value)&&!points.some(previous=>previous.text.includes(value))){seen.add(value);points.push({...row,text:value});}}
 const sellingPoints=points.slice(0,6).map(row=>row.text),captions=points.slice(0,count);
 while(captions.length<count)captions.push({text:'商品图片内容未标注',title:'图片内容未标注',subtitle:'未取得对应官方卖点'});
 return{features:captions.map(row=>row.text),sellingPoints,detailTitles:captions.map((row,i)=>(!genericFeature(raw.detailTitles?.[i])?raw.detailTitles[i]:genericFeature(row.title)?row.text.split(/[:：]/u)[0]:row.title).slice(0,30)),detailSubtitles:captions.map((row,i)=>(raw.detailSubtitles?.[i]||row.subtitle||row.text.split(/[:：]/u).slice(1).join('：')).slice(0,80))};
}
