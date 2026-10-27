// Keep repeated-source suppression, without merging distinct colours, sizes,
// models or platforms merely because their titles differ by a few characters.
export function normalizeTitle(value){return String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}\p{Z}]+/gu,'');}
function specsKey(value){return JSON.stringify(Object.entries(value||{}).sort(([a],[b])=>a.localeCompare(b)));}
export function findDuplicateTitle(product,products,{excludeSelf=true}={}){
  if(!product||product.recordType==='note'||!Array.isArray(products))return null;
  return products.find(row=>{
    if(!row||row.recordType==='note'||row.platform!==product.platform||excludeSelf&&row.id===product.id)return false;
    if(row.sourceUrl===product.sourceUrl)return true;
    return !!product.model&&product.model===row.model&&normalizeTitle(product.brand)===normalizeTitle(row.brand)&&normalizeTitle(product.title)===normalizeTitle(row.title)&&specsKey(product.specs)===specsKey(row.specs);
  })||null;
}
