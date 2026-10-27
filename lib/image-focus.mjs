// Remove empty white margins only when a dominant connected product silhouette
// can be found on a white background. Source files and product pixels stay intact.
export function imageFocus(image,sample){
  const n=192;sample.width=n;sample.height=n;const c=sample.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,n,n);c.drawImage(image,0,0,n,n);const data=c.getImageData(0,0,n,n).data,mask=new Uint8Array(n*n),seen=new Uint8Array(n*n);let lightEdges=0,edges=0;
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){const i=y*n+x,k=i*4,white=data[k]>235&&data[k+1]>235&&data[k+2]>235;mask[i]=white?0:1;if(x<3||x>=n-3||y<3||y>=n-3){edges++;if(white)lightEdges++;}}
  if(lightEdges/edges<.8)return null;
  let largest=null;const components=[];const queue=new Int32Array(n*n);
  for(let start=0;start<mask.length;start++){if(!mask[start]||seen[start])continue;let head=0,tail=1,count=0,left=n,top=n,right=0,bottom=0;queue[0]=start;seen[start]=1;while(head<tail){const i=queue[head++],x=i%n,y=Math.floor(i/n);count++;left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);for(const j of [x?i-1:-1,x<n-1?i+1:-1,y?i-n:-1,y<n-1?i+n:-1])if(j>=0&&mask[j]&&!seen[j]){seen[j]=1;queue[tail++]=j;}}const component={count,left,top,right,bottom};if(count>2)components.push(component);if(!largest||count>largest.count)largest=component;}
  if(!largest||largest.count<n*n*.035||largest.count>n*n*.8)return null;
  const b={...largest},padX=Math.max(5,(b.right-b.left)*.08),padY=Math.max(6,(b.bottom-b.top)*.12);b.left=Math.max(0,b.left-padX);b.top=Math.max(0,b.top-padY);b.right=Math.min(n-1,b.right+padX);b.bottom=Math.min(n-1,b.bottom+padY);
  // Include complete nearby annotations when a crop would otherwise bisect them.
  for(let pass=0;pass<3;pass++)for(const part of components)if(part.left<=b.right&&part.right>=b.left&&part.top<=b.bottom&&part.bottom>=b.top){b.left=Math.max(0,Math.min(b.left,part.left-2));b.top=Math.max(0,Math.min(b.top,part.top-2));b.right=Math.min(n-1,Math.max(b.right,part.right+2));b.bottom=Math.min(n-1,Math.max(b.bottom,part.bottom+2));}
  const l=b.left/n,t=b.top/n,r=(b.right+1)/n,bot=(b.bottom+1)/n;
  if((r-l)*(bot-t)>.85||r-l<.2||bot-t<.15)return null;return[l,t,r,bot];
}
