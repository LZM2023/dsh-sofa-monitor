export function isDimensionValue(value,key=''){
  return typeof value==='string'&&/[0-9]/u.test(value)&&(/[0-9]\s*(?:mm|cm|m|毫米|厘米|米)(?![a-z])/iu.test(value)||/[0-9]\s*[×xX*]\s*[0-9]/u.test(value)&&/(?:mm|cm|毫米|厘米)/iu.test(key));
}
export function dimensionsFromSpecs(specs){
  const rank=key=>/产品尺寸|规格尺寸|长宽高|整[体机]尺寸/u.test(key)?0:/尺寸/u.test(key)?1:/尺码/u.test(key)?2:/规格/u.test(key)?3:10;
  const entries=Object.entries(specs).filter(([key,value])=>!/^页面选项_/u.test(key)&&rank(key)<10&&isDimensionValue(value,key)&&!/(?:接触面|皮胚|皮料|厚度|顶光|半青皮|海绵|乳胶)/u.test(value)).sort((a,b)=>rank(a[0])-rank(b[0]));
  if(entries.length)return entries[0][1];
  return isDimensionValue(specs['产品长度'],'尺寸')?'长 '+specs['产品长度']+'（仅长度）':'未标注';
}
