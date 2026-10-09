// Iterable extrema without the engine's argument-count limit on spread calls.
export function minOf(values) {
  let result=Infinity;
  for(const item of values) {
    const value=+item;
    if(Number.isNaN(value))return NaN;
    if(value<result || value===0 && result===0 && Object.is(value,-0))result=value;
  }
  return result;
}
export function maxOf(values) {
  let result=-Infinity;
  for(const item of values) {
    const value=+item;
    if(Number.isNaN(value))return NaN;
    if(value>result || value===0 && result===0 && !Object.is(value,-0))result=value;
  }
  return result;
}
