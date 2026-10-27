export function seatLabel(product){
 const specs=product.specs||{},groups=[...['款式','尺码','规格','座位数','座位数量','沙发类型'].map(key=>specs[key]).filter(Boolean),product.title||''];
 for(const text of groups){const found=[...String(text).matchAll(/(?:单人(?:位|座)?|单座|一人(?:位|座)?|1人(?:位|座)?|双人(?:位|座)?|二人(?:位|座)?|两人(?:位|座)?|2人(?:位|座)?|三人(?:位|座)?|3人(?:位|座)?|四人(?:位|座)?|4人(?:位|座)?)/gu)].map(match=>match[0]);const seats=[...new Set(found.map(value=>/单|一|1/u.test(value)?'单人沙发':/双|二|两|2/u.test(value)?'双人沙发':/三|3/u.test(value)?'三人沙发':'四人沙发'))];if(seats.length===1)return seats[0];if(seats.length>1)return'组合沙发';}
 const composition=String(specs['国补备案型号']||'').split(/皮号|颜色|面料/u)[0].trim(),parts=composition.split(/[+＋]/u).map(value=>value.trim());
 if(parts.length>=2&&parts.length<=4&&parts.every(value=>/单人|双人|三人|四人/u.test(value))){const total=parts.reduce((sum,value)=>sum+(/单人/u.test(value)?1:/双人/u.test(value)?2:/三人/u.test(value)?3:4),0);if(total<=4)return['','单人沙发','双人沙发','三人沙发','四人沙发'][total];}
 if(/沙发椅|单椅|摇椅/u.test(product.title||''))return'单人沙发';return'未标注';
}
