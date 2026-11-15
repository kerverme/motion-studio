export type ByteRange={start:number;end:number};

/** One RFC 9110 byte range. Reject malformed/multipart ranges rather than serving wrong bytes. */
export function parseByteRange(header:string|undefined,size:number):ByteRange|null{
 if(header===undefined)return null;
 const match=/^bytes=(\d*)-(\d*)$/.exec(header.trim());
 if(!Number.isSafeInteger(size)||size<1||!match||(!match[1]&&!match[2]))throw Error('Unsatisfiable byte range');
 const value=(text:string)=>{const n=Number(text);if(!Number.isSafeInteger(n))throw Error('Unsatisfiable byte range');return n;};
 if(!match[1]){const suffix=value(match[2]);if(suffix<1)throw Error('Unsatisfiable byte range');return {start:Math.max(0,size-suffix),end:size-1};}
 const start=value(match[1]),end=match[2]?Math.min(value(match[2]),size-1):size-1;
 if(start>=size||start>end)throw Error('Unsatisfiable byte range');
 return {start,end};
}
