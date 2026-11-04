// Race discovery work against caller cancellation and a bounded timeout.
export async function withTimeoutAbort(signal,ms,messages,run) {
  const controller=new AbortController(),cancel=()=>controller.abort('cancelled');
  let rejectAbort;
  const aborted=new Promise((_,reject)=>{
    rejectAbort=()=>reject(new Error(controller.signal.reason==='timeout' ? messages.timeout : messages.cancelled));
    controller.signal.addEventListener('abort',rejectAbort,{once:true});
  });
  const timer=setTimeout(()=>controller.abort('timeout'),ms);
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  try {
    if(controller.signal.aborted){rejectAbort();return await aborted;}
    return await Promise.race([run(controller.signal),aborted]);
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',cancel);
    controller.signal.removeEventListener('abort',rejectAbort);
  }
}
