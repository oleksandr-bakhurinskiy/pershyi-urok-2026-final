const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const site=path.resolve(__dirname,'../site');
const ids=['vodopian','denysiuk','kyshkina','kopychynskyi','nahirniak','pospelova','tsebro','yanishyna'];
function scan(dir,max){const absolute=path.join(site,'photos',dir);if(!fs.existsSync(absolute))return [];return fs.readdirSync(absolute,{withFileTypes:true}).filter(x=>x.isFile()&&/\.(jpg|jpeg|png|webp|avif)$/i.test(x.name)).sort((a,b)=>a.name.localeCompare(b.name,'uk',{numeric:true})).slice(0,max).map(x=>{const relative='photos/'+dir+'/'+x.name,hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(absolute,x.name))).digest('hex').slice(0,12);return {id:relative+'|'+hash,url:'./'+relative.split('/').map(encodeURIComponent).join('/')+'?v='+hash,name:x.name};});}
const manifest={event:scan('event',120),people:Object.fromEntries(ids.map(id=>[id,scan('finalists/'+id,30)]))};
fs.mkdirSync(path.join(site,'data'),{recursive:true});fs.writeFileSync(path.join(site,'data/photos.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Photo manifest generated. Event photos: '+manifest.event.length);
