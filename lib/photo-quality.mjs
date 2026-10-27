// Test the actual pixels, including model edits and fallback originals. A model's
// assertion that a part is present cannot turn a blank crop into a photograph.
export async function photoQuality(bytes){
 const{loadImage,createCanvas}=await import('@napi-rs/canvas'),image=await loadImage(bytes),canvas=createCanvas(48,48),ctx=canvas.getContext('2d');
 ctx.fillStyle='#ffffff';ctx.fillRect(0,0,48,48);ctx.drawImage(image,0,0,48,48);
 const pixels=ctx.getImageData(0,0,48,48).data,channels=[[],[],[]];
 for(let i=0;i<pixels.length;i+=4)for(let c=0;c<3;c++)channels[c].push(pixels[i+c]);
 const ranges=channels.map(values=>{values.sort((a,b)=>a-b);return values[Math.floor(values.length*.95)]-values[Math.floor(values.length*.05)];});
 return{usable:Math.min(image.width,image.height)>=80&&image.width*image.height>=16000&&Math.max(...ranges)>=24,width:image.width,height:image.height,contrast:Math.max(...ranges)};
}
