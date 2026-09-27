const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { MessageChannel } = require('node:worker_threads');
const source = name => fs.readFileSync(new URL('../' + name, 'file://' + __filename), 'utf8');
const base = 'https://example.test/drive-original-player/';
const video = {id:'v1',mimeType:'video/mp4',resourceKey:'vk'};
const video2 = {id:'v2',mimeType:'video/mp4'};
const image = {id:'i1',mimeType:'image/jpeg',resourceKey:'ik'};
const state = f => ({action:'open',ids:[f.id],resourceKeys:f.resourceKey?{[f.id]:f.resourceKey}:{}});
function storage() {
  const data = new Map();
  return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};
}
function page(kind, file, shared=storage()) {
  const events = {}, winEvents = {}, anchors = [];
  const url = new URL(kind === 'player' ? './' : './gallery/', base);
  if(file) url.searchParams.set('state', JSON.stringify(state(file)));
  const context = {URL, console, location:url, sessionStorage:shared,
    document:{currentScript:{src:base+'assets/navigation.js?v=2'},
      body:{classList:{contains:c=>kind==='gallery'&&c==='gallery-page'}},
      querySelectorAll:()=>anchors,addEventListener:(type,fn)=>events[type]=fn},
    addEventListener:(type,fn)=>winEvents[type]=fn,
    isVideoFile:f=>f?.mimeType?.startsWith('video/'),isImageFile:f=>f?.mimeType?.startsWith('image/')};
  context.window=context;
  vm.createContext(context);
  vm.runInContext(source('assets/media-index.js'),context);
  vm.runInContext(source('assets/navigation.js'),context);
  function link(href) {
    let value=href;
    const a={getAttribute:n=>n==='href'?value:null,hasAttribute:()=>false,
      get href(){return new URL(value,url).href},set href(v){value=v}};
    anchors.push(a);return a;
  }
  return {context,events,winEvents,link,shared,remember:context.DriveNavigation.remember,
    click:a=>events.click({target:{closest:()=>a}})};
}
function seed(p,files=[video,video2,image],complete=true) {
  const root={id:'root',name:'1433223',mimeType:'application/vnd.google-apps.folder'};
  p.context.DriveMediaIndex.saveSnapshot(root,{file:root,scanned:complete,children:files.map(file=>({file,children:[]}))},complete);
}
const linkedState = a => JSON.parse(new URL(a.href).searchParams.get('state'));

test('video → gallery → video restores last video, with resource keys and correct types',()=>{
  const p=page('player',video);seed(p);p.remember(video2);
  const gallery=p.link('./gallery/');p.click(gallery);
  assert.equal(linkedState(gallery).ids[0],image.id);
  assert.equal(linkedState(gallery).resourceKeys.i1,'ik');
  const g=page('gallery',image,p.shared);g.remember(image);
  const back=g.link('../');g.click(back);
  assert.equal(linkedState(back).ids[0],video2.id);
  assert.equal(new URL(back.href).searchParams.get('view'),'player');
});
test('partial index carries library seed until destination discovers its media type',()=>{
  const p=page('player',video);seed(p,[video],false);p.remember(video);
  const a=p.link('./gallery/');p.click(a);
  assert.equal(linkedState(a).ids[0],video.id);
  assert.equal(new URL(a.href).searchParams.get('view'),'gallery');
});
test('new library does not restore a selection from a different library',()=>{
  const p=page('player',video);seed(p);p.remember(video2);
  const fresh={id:'fresh',mimeType:'image/png'};
  const g=page('gallery',fresh,p.shared);g.remember(fresh);
  const a=g.link('../');g.click(a);
  assert.equal(linkedState(a).ids[0],'fresh');
});
test('invalid state and non-app links are left without private state',()=>{
  const p=page('player');p.context.location.search='?state=%7Binvalid';
  for(const href of ['./gallery/','#mainContent','https://other.test/','./assets/star.svg']) {
    const a=p.link(href);const before=a.href;p.click(a);
    if(href==='./gallery/') assert.equal(new URL(a.href).searchParams.has('state'),false);
    else assert.equal(a.href,before);
  }
});
test('storage unavailable still allows navigation from the current selection',()=>{
  const blocked={getItem(){throw Error('disabled')},setItem(){throw Error('disabled')}};
  const p=page('player',video,blocked);p.remember(video);
  const a=p.link('./gallery/');p.click(a);assert.equal(linkedState(a).ids[0],video.id);
});
test('BFCache pageshow refreshes media authorization without reloading document',async()=>{
  const p=page('player',video);let refreshed=0;
  p.context.refreshWorkerAccessToken=async()=>{refreshed++};
  p.winEvents.pageshow({persisted:false});assert.equal(refreshed,0);
  p.winEvents.pageshow({persisted:true});assert.equal(refreshed,1);
});
function workerClient(controller) {
  const sw=new EventTarget();sw.controller=controller;let calls=0;
  sw.register=async()=>{calls++;return {active:controller}};
  // Regression: ready already resolves to the wrong root worker.
  sw.ready=Promise.resolve({active:controller});
  const context={URL,console,location:{href:base+'gallery/'},navigator:{serviceWorker:sw},
    MessageChannel,setTimeout,clearTimeout};context.window=context;
  vm.createContext(context);vm.runInContext(source('assets/worker-client.js'),context);
  return {sw,client:context.DriveWorkerClient,calls:()=>calls};
}
const correctURL=base+'gallery/sw.js?v=navigation-2';
test('root worker cannot receive gallery authorization; wait for controllerchange',async()=>{
  let wrongCalls=0,received;
  const wrong={scriptURL:base+'sw.js',state:'activated',postMessage(){wrongCalls++}};
  const {sw,client,calls}=workerClient(wrong);
  const pending=client.send({type:'SET_TOKEN',token:'test-only'});
  await new Promise(setImmediate);assert.equal(wrongCalls,0);
  // clients.claim may change the controller during the activating state.
  sw.controller={scriptURL:correctURL,state:'activating',postMessage(data,[port]){
    received=data;port.postMessage({ok:true});port.close();
  }};
  sw.dispatchEvent(new Event('controllerchange'));await pending;
  assert.equal(received.token,'test-only');assert.equal(wrongCalls,0);
  await client.ready();assert.equal(calls(),1);
});
test('fresh page waits for first controller without requiring reload',async()=>{
  const {sw,client}=workerClient(null);let done=false;
  const pending=client.ready().then(()=>done=true);
  await new Promise(setImmediate);assert.equal(done,false);
  sw.controller={scriptURL:correctURL,state:'activated'};
  sw.dispatchEvent(new Event('controllerchange'));await pending;assert.equal(done,true);
});
test('failed worker acknowledgement rejects media startup',async()=>{
  const {client}=workerClient({scriptURL:correctURL,state:'activated',postMessage(data,[port]){
    port.postMessage({ok:false});port.close();
  }});
  await assert.rejects(client.send({type:'SET_TOKEN',token:'test-only'}),/媒体授权失败/);
});
test('gallery worker acknowledges token synchronously before asynchronous persistence',()=>{
  let message,ack;
  const context={URL,Response,console,caches:{open:async()=>({put:async()=>{}})},
    self:{registration:{scope:base+'gallery/'},addEventListener:(type,fn)=>{if(type==='message')message=fn}}};
  vm.createContext(context);vm.runInContext(source('gallery/sw.js'),context);
  message({data:{type:'SET_TOKEN',token:'test-only'},ports:[{postMessage:v=>ack=v}],waitUntil:()=>{}});
  assert.equal(ack.ok,true);
});
