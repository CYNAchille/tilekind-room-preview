import sharp from 'sharp';
export function requireSharp() { return sharp; }
export async function prepareRoomImage(bytes) {
  const image = requireSharp();
  const metadata = await image(bytes, { limitInputPixels: 40_000_000 }).metadata();
  if (metadata.pages && metadata.pages > 1) throw new Error('Animated room images are not supported.');
  if (metadata.orientation && metadata.orientation !== 1) {
    return { bytes: await image(bytes, { limitInputPixels: 40_000_000 }).rotate().png().toBuffer(), orientationNormalised: true };
  }
  return { bytes, orientationNormalised: false };
}
export async function webPreview(bytes){
  if(!sharp)return {bytes,converted:false,reason:'Optional Sharp image library unavailable',processingMs:0};
  const started=performance.now();
  try{
    const webp=await sharp(bytes,{limitInputPixels:40_000_000}).webp({quality:90,effort:4}).toBuffer();
    if(webp.length>=bytes.length)return {bytes,converted:false,reason:'Original is already smaller',processingMs:performance.now()-started};
    return {bytes:webp,converted:true,processingMs:performance.now()-started};
  }catch{return {bytes,converted:false,reason:'Preview conversion unavailable; original preserved',processingMs:performance.now()-started};}
}

