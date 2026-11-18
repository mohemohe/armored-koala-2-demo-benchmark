import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=process.cwd();
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript','.ttf':'font/ttf'};
export async function serve(req,res){
  try {
    const url=new URL(req.url,'http://localhost');
    const name=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
    const path=resolve(root,'.'+name);
    const publicAsset=['/src/','/vendor/'].some(prefix=>name.startsWith(prefix)) || name==='/index.html'||name==='/styles.css';
    if(!publicAsset||!path.startsWith(root+sep)||name.split('/').includes('..'))throw Error();
    const data=await readFile(path);
    res.setHeader('Content-Type',types[extname(path)]||'application/octet-stream');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.end(data);
  }catch{res.writeHead(404);res.end('Not found')}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const arg=(key,def)=>process.argv.includes(key)?process.argv[process.argv.indexOf(key)+1]:def;
  const host=arg('--host','127.0.0.1'),port=Number(arg('--port',5173));
  http.createServer(serve).listen(port,host,()=>console.log('AK2 server ready on http://'+host+':'+port));
}
