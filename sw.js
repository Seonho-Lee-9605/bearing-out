const CACHE='bearing-stock-shell-v3';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('bearing-stock-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;
 const base=new URL('./',self.location.href),url=new URL(e.request.url);
 if(!url.pathname.startsWith(base.pathname))return;
 if(e.request.mode==='navigate'){
  e.respondWith((async()=>{const cached=await caches.match('./index.html');const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),4000);
   try{const r=await fetch(e.request,{signal:controller.signal});if(r.ok)return r;if(cached)return cached;return r;}
   catch(error){if(cached)return cached;return new Response('인터넷 연결 후 처음 화면을 열어주세요.',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});}
   finally{clearTimeout(timer);}})());return;
 }
 const known=ASSETS.some(a=>new URL(a,base).pathname===url.pathname);if(!known)return;
 e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(cached=>cached||fetch(e.request)));
});
