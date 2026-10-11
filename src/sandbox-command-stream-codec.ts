// Keep this standalone codec identical in shared and sandbox-sdk (parity test).
/** Sandbox command stream v1: NDJSON byte events, not complete-output JSON. */
export type SandboxCommandEvent =
  | { type: 'start'; commandId: string }
  | { type: 'stdout' | 'stderr'; encoding: 'base64'; data: string }
  | { type: 'keepalive' }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; status: number; message: string; code?: string; providerCode?: string };

/** One-frame budget matches the existing JSON transport budget, never total output. */
export async function* decodeCommandFrames(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SandboxCommandEvent> {
  let pages: Uint8Array[] = [], size = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const append = (bytes: Uint8Array) => {
    if(size + bytes.length > 16 * 1024 * 1024)throw new Error('Command stream frame exceeds the existing JSON receive budget');
    let offset=0;
    while(offset<bytes.length){const index=Math.floor(size/65536),position=size%65536;const page=pages[index]??=new Uint8Array(65536);const count=Math.min(page.length-position,bytes.length-offset);page.set(bytes.subarray(offset,offset+count),position);offset+=count;size+=count;}
  };
  const parse = () => {
    const frame=new Uint8Array(size);let offset=0;
    for(const page of pages){const count=Math.min(page.length,size-offset);frame.set(page.subarray(0,count),offset);offset+=count;}
    pages=[];size=0;
    const event=JSON.parse(decoder.decode(frame));
    if(event?.type==='stdout'||event?.type==='stderr'){
      if(event.encoding!=='base64'||typeof event.data!=='string'||event.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(event.data))throw new Error('Invalid command stream byte event');
    } else if(event?.type==='exit'){if(!Number.isInteger(event.exitCode))throw new Error('Invalid native command exit code');}
    else if(event?.type==='start'){if(typeof event.commandId!=='string')throw new Error('Invalid native command identity');}
    else if(event?.type==='error'){if(typeof event.message!=='string'||!Number.isInteger(event.status))throw new Error('Invalid command stream error');}
    else if(event?.type!=='keepalive')throw new Error('Unknown command stream event');
    return event as SandboxCommandEvent;
  };
  let exited=false;
  for await(const chunk of chunks){let offset=0;for(;;){const end=chunk.indexOf(10,offset);if(end<0){append(chunk.subarray(offset));break;}append(chunk.subarray(offset,end));offset=end+1;if(!size)continue;const event=parse();if(exited&&event.type!=='keepalive'&&event.type!=='error')throw new Error('Command stream returned output after exit');if(event.type==='exit')exited=true;yield event;}}
  if(size)throw new Error('Command stream ended with an incomplete frame');
  if(!exited)throw new Error('Command stream ended without an exit result; the command was not replayed');
}
