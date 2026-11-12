const IDS=['vodopian','denysiuk','kyshkina','kopychynskyi','nahirniak','pospelova','tsebro','yanishyna'];
const REACTIONS=['heart','clap','spark','rocket','flower','luck'];
const parse=value=>{try{return JSON.parse(value||'{}');}catch{return {};}};
const json=(status,code,extra={})=>Response.json({ok:status===200,code,...extra},{status});
const validId=value=>typeof value==='string'&&/^[-a-zA-Z0-9_]{16,80}$/.test(value);

function configuration(env){
  const testChat=Number(env.KIOSK_TEST_CHAT_ID),testMode=Number.isSafeInteger(testChat)&&testChat>0;
  const recipients=parse(env.KIOSK_RECIPIENTS_JSON),stickers=parse(env.KIOSK_STICKERS_JSON);
  const recipient=id=>testMode?testChat:recipients?.[id]?.optedIn===true?recipients[id].chatId:null;
  const sticker=key=>testMode?(env.KIOSK_TEST_STICKER_ID||stickers?.[key]):stickers?.[key];
  const ready=id=>Number.isSafeInteger(recipient(id))&&recipient(id)>0;
  return {testMode,recipient,sticker,ready,status:{enabled:Boolean(env.TELEGRAM_BOT_TOKEN),testMode,recipientIds:IDS.filter(ready),stickerKeys:REACTIONS.filter(key=>typeof sticker(key)==='string'&&sticker(key).length>0)}};
}

export default {
  async fetch(request,env){
    const origin=request.headers.get('Origin');
    if(!env.ALLOWED_ORIGIN||origin!==env.ALLOWED_ORIGIN)return json(403,'ORIGIN_DENIED');
    const cors={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Cache-Control':'no-store','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Kiosk-Key'};
    const wrap=response=>{const r=new Response(response.body,response);for(const [k,v]of Object.entries(cors))r.headers.set(k,v);return r;};
    if(request.method==='OPTIONS')return wrap(new Response(null,{status:204}));
    const authorized=Boolean(env.KIOSK_DEVICE_KEY&&env.KIOSK_DEVICE_KEY.length>=24&&request.headers.get('X-Kiosk-Key')===env.KIOSK_DEVICE_KEY);
    const pathname=new URL(request.url).pathname;
    
    // Новий маршрут для Google Drive API
    if(request.method==='GET'&&pathname==='/api/photos') {
      const FOLDER_ID = '1t_BARt8tK5WGIruat6c7u06qPc77OLCO'; // Замініть на свій ID папки
      if(!env.GOOGLE_API_KEY) return wrap(json(500, 'GOOGLE_API_KEY_MISSING'));
      
      const driveUrl = `https://www.googleapis.com/drive/v3/files?q='${FOLDER_ID}'+in+parents+and+mimeType+contains+'image/'&fields=files(id,name)&key=${env.GOOGLE_API_KEY}`;
      try {
    const driveRes = await fetch(driveUrl);
    const driveData = await driveRes.json();
    if (driveData.error) throw new Error(driveData.error.message);

    // Тепер повертаємо і URL, і назву файлу (в нижньому регістрі для зручного пошуку)
    const photos = driveData.files.map(file => ({
      url: `https://lh3.googleusercontent.com/d/${file.id}`,
      name: file.name.toLowerCase()
    }));
    return wrap(new Response(JSON.stringify(photos), { status: 200, headers: {'Content-Type': 'application/json'} }));
  } catch (err) {
    return wrap(json(500, 'DRIVE_ERROR', { details: err.message }));
  }
    }

    if(request.method==='GET'&&pathname==='/api/support/status')return wrap(Response.json({...configuration(env).status,deviceAuthorized:authorized,...(!authorized?{enabled:false,recipientIds:[],stickerKeys:[]}: {})}));
    if(request.method!=='POST'||pathname!=='/api/support')return wrap(json(404,'NOT_FOUND'));
    if(!authorized)return wrap(json(403,'DEVICE_DENIED'));
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))return wrap(json(415,'JSON_REQUIRED'));
    if(Number(request.headers.get('Content-Length')||0)>2048)return wrap(json(413,'TOO_LARGE'));
    try{
      const reader=request.body?.getReader();if(!reader)return wrap(json(400,'INVALID_REQUEST'));
      let size=0,chunks=[];while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048){await reader.cancel();return wrap(json(413,'TOO_LARGE'));}chunks.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
      const raw=new TextDecoder().decode(bytes),input=JSON.parse(raw);
      if(!IDS.includes(input.recipientId)||!REACTIONS.includes(input.reactionKey)||input.kind!=='sticker'||!validId(input.requestId)||!validId(input.sessionId))return wrap(json(400,'INVALID_REQUEST'));
      const stub=env.SUPPORT.get(env.SUPPORT.idFromName('kiosk-support-v1'));
      return wrap(await stub.fetch('https://support.internal/send',{method:'POST',headers:{'Content-Type':'application/json'},body:raw}));
    }catch{return wrap(json(503,'SERVICE_UNAVAILABLE'));}
  }
};

export class Support {
  constructor(ctx,env){this.ctx=ctx;this.env=env;}
  async fetch(request){
    const input=await request.json(),config=configuration(this.env),now=Date.now();
    if(!config.status.enabled)return json(503,'DEMO_MODE');
    if(!config.ready(input.recipientId))return json(409,'RECIPIENT_NOT_READY');
    
    // Тут sticker — це вже текстове повідомлення з ваших секретів
    const sticker=config.sticker(input.reactionKey);if(typeof sticker!=='string'||!sticker)return json(409,'STICKER_NOT_CONFIGURED');
    const sessionKey='session:'+input.sessionId+':'+input.recipientId,requestKey='request:'+input.requestId;
    const recipientKey='cooldown:'+config.recipient(input.recipientId),fingerprint=[input.sessionId,input.recipientId,input.reactionKey].join(':');
    const reservation=await this.ctx.storage.transaction(async tx=>{
      const previous=await tx.get(requestKey);if(previous)return previous.fingerprint===fingerprint?{response:previous.response||{status:409,code:'DELIVERY_UNKNOWN'}}:{response:{status:409,code:'REQUEST_CONFLICT'}};
      const session=await tx.get(sessionKey);if(session)return {response:{status:409,code:'SESSION_LIMIT'}};
      const global=await tx.get('global'),recipient=await tx.get(recipientKey);
      if(global&&now-global.at<1500||recipient&&now-recipient.at<30000)return {response:{status:429,code:'RATE_LIMIT'}};
      await tx.put(sessionKey,{at:now});await tx.put(requestKey,{at:now,fingerprint});await tx.put('global',{at:now});await tx.put(recipientKey,{at:now});return {reserved:true};
    });
    const responseFor=r=>json(r.status,r.code,r.status===200?{delivered:true}:{});
    if(!reservation.reserved)return responseFor(reservation.response);
    
    if(!(await this.ctx.storage.getAlarm()))await this.ctx.storage.setAlarm(now+3600000);
    let outcome={status:502,code:'DELIVERY_UNKNOWN'},confirmedFailure=false;
    try{
      // Повертаємо sendSticker замість sendMessage
      const r=await fetch('https://api.telegram.org/bot'+this.env.TELEGRAM_BOT_TOKEN+'/sendSticker',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:config.recipient(input.recipientId), sticker: sticker}),
        signal:AbortSignal.timeout(10000)
      });
      const data=await r.json();if(r.ok&&data.ok===true&&Number.isInteger(data.result?.message_id)&&data.result.message_id>0)outcome={status:200,code:'DELIVERED'};
      else if(data.ok===false){outcome={status:502,code:'DELIVERY_FAILED'};confirmedFailure=true;}
    }catch{}
    await this.ctx.storage.transaction(async tx=>{await tx.put(requestKey,{at:now,fingerprint,response:outcome});if(confirmedFailure)await tx.delete(sessionKey);});
    return responseFor(outcome);
  }
  async alarm(){
    const cutoff=Date.now()-86400000;let after;
    while(true){const entries=await this.ctx.storage.list({limit:500,...(after?{startAfter:after}:{})});if(!entries.size)break;const remove=[...entries].filter(([,v])=>v.at<cutoff).map(([k])=>k);if(remove.length)await this.ctx.storage.delete(remove);after=[...entries.keys()].at(-1);if(entries.size<500)break;}
    if((await this.ctx.storage.list({limit:1})).size)await this.ctx.storage.setAlarm(Date.now()+3600000);
  }
}
