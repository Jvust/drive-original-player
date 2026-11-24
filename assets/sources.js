/* Local aggregation UI. Remote documents are data only, never used as the app interface. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id), H = window.AndroidHost;
  const names = {all:'全部',x:'X',pornhub:'Pornhub',missav:'MissAV',hanime:'Hanime1',r34:'3D',danbooru:'Danbooru',gelbooru:'Gelbooru',e621:'e621'};
  const sources = ['x','pornhub','missav','hanime','r34','danbooru','gelbooru','e621'];
  let site = new URLSearchParams(location.search).get('site') || 'all', page = 1, items = [], selected = null, media = [], chosen = 0, busy = false, manualPick = false;
  if (!names[site]) site = 'all';
  const pending = new Map(), tasks = new Map();
  // Re-opening a card within ten minutes should not re-load the remote page at all.
  const detailCache = new Map();
  let savedAuthors = new Set(JSON.parse(localStorage.getItem('hoshi_source_authors') || '[]'));
  let savedTags = new Set(JSON.parse(localStorage.getItem('hoshi_source_tags') || '[]'));
  // Gelbooru's DAPI now answers 401 unless an account api_key + user_id accompany the request.
  let gelbooruKey = localStorage.getItem('hoshi_gelbooru_key') || '';
  let gelbooruUser = localStorage.getItem('hoshi_gelbooru_user') || '';
  function paintBooruAuth(){
    const form = $('booruAuth'); if(!form) return;
    form.hidden = site !== 'gelbooru';
    if(form.hidden) return;
    $('gelbooruKey').value = gelbooruKey;
    $('gelbooruUser').value = gelbooruUser;
    $('booruAuthState').textContent = gelbooruKey && gelbooruUser ? '已保存，采集将带上凭据。' : '未填写时 Gelbooru 接口会返回 401。';
  }
  function wireBooruAuth(){
    const form = $('booruAuth'); if(!form) return;
    form.addEventListener('submit', event => {
      event.preventDefault();
      gelbooruKey = $('gelbooruKey').value.trim();
      gelbooruUser = $('gelbooruUser').value.trim();
      localStorage.setItem('hoshi_gelbooru_key', gelbooruKey);
      localStorage.setItem('hoshi_gelbooru_user', gelbooruUser);
      paintBooruAuth();
      page = 1; load(false);
    });
    paintBooruAuth();
  }
  function say(s) { $('status').textContent = s; }
  function node(tag, text, cls) { const e=document.createElement(tag); if(text!=null)e.textContent=text;if(cls)e.className=cls;return e; }
  function button(text, fn) { const b=node('button',text);b.type='button';b.onclick=fn;return b; }
  function persist() {localStorage.setItem('hoshi_source_authors',JSON.stringify([...savedAuthors]));localStorage.setItem('hoshi_source_tags',JSON.stringify([...savedTags]));}
  function dateRange(){
    const p=$('period').value, now=new Date();let from=null,to=null;
    if(p==='week'||p==='month'){to=new Date(now);to.setHours(23,59,59,999);from=new Date(now);from.setHours(0,0,0,0);from.setDate(from.getDate()-(p==='week'?6:29));}
    if(p==='custom'){if($('from').value)from=new Date($('from').value+'T00:00:00');if($('to').value)to=new Date($('to').value+'T23:59:59.999');}
    return {from,to};
  }
  function day(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
  function sourceUrlFor(s, p) {
    const q=$('search').value.trim();
    if(s==='x'){const r=dateRange();let dates='';if(r.from)dates+=' since:'+day(r.from);if(r.to){const next=new Date(r.to);next.setDate(next.getDate()+1);dates+=' until:'+day(next);}return 'https://x.com/search?q='+encodeURIComponent(q+' min_faves:'+Math.max(0,Number($('likes').value))+dates)+'&src=typed_query&f=top';}
    if(s==='pornhub')return 'https://www.pornhub.com/video'+(q?'/search?search='+encodeURIComponent(q)+'&':'?')+'o=tr&page='+p;
    if(s==='missav')return q?'https://missav.ws/cn/search/'+encodeURIComponent(q)+'?page='+p:'https://missav.ws/cn?page='+p;
    if(s==='r34')return q?'https://rule34video.com/search/'+encodeURIComponent(q)+'/'+p+'/':'https://rule34video.com/latest-updates/'+p+'/';
    if(s==='danbooru')return 'https://danbooru.donmai.us/posts.json?limit=40&page='+p+'&tags='+encodeURIComponent((q||'rating:e')+' order:score');
    if(s==='gelbooru'){
      // Gelbooru's DAPI rejects anonymous calls with 401 since it began requiring account keys.
      let u='https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&limit=100&pid='+Math.max(0,p-1)+'&tags='+encodeURIComponent(q||'rating:explicit');
      if(gelbooruKey)u+='&api_key='+encodeURIComponent(gelbooruKey);
      if(gelbooruUser)u+='&user_id='+encodeURIComponent(gelbooruUser);
      return u;
    }
    if(s==='e621')return 'https://e621.net/posts.json?limit=40&page='+p+'&tags='+encodeURIComponent((q||'rating:e')+' order:favcount');
    return 'https://hanime1.me/search?query='+encodeURIComponent(q)+'&sort='+encodeURIComponent('最近熱門')+'&genre='+encodeURIComponent('全部')+'&page='+p;
  }
  function sourceUrl() { return sourceUrlFor(site, page); }
  function requestFor(s, url, mode) {
    return new Promise((resolve,reject)=>{
      if(!H||typeof H.sourceRequest!=='function'){reject(new Error('此页面需要星映新版 APK 的采集服务'));return;}
      const id='s'+Date.now()+Math.random().toString(36).slice(2), timer=setTimeout(()=>{pending.delete(id);reject(new Error('来源响应超时，可点“来源登录 / 验证”完成站点验证后重试'));},150000);
      pending.set(id,{resolve,reject,timer});H.sourceRequest(id,s,url,mode);
    });
  }
  function request(url, mode) { return requestFor(site, url, mode); }
  window.addEventListener('hoshi:source-result',event=>{
    let r=event.detail;if(typeof r==='string')try{r=JSON.parse(r);}catch(_){return;}
    const p=pending.get(r.id);if(!p)return;clearTimeout(p.timer);pending.delete(r.id);
    if(r.ok)p.resolve(r);else p.reject(new Error(r.error||'来源暂时没有返回内容'));
  });
  // The verification dialog closed on native side: retry the same query with the fresh cookies.
  window.addEventListener('hoshi:source-verified',()=>{if(!busy){page=1;load(false);}});
  function stat(item,key){let v=item[key];return v==null||v===''||!Number.isFinite(Number(v))?null:Number(v);}
  function label(v,suffix){return v==null?'未公开':Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(v)+(suffix||'');}
  function metrics(i){return '赞 '+label(stat(i,'likes'))+' · 播放 '+label(stat(i,'views'))+' · 好评 '+label(stat(i,'percent'),'%');}
  function filterItems(list){
    const unknown=$('unknown').checked, range=dateRange();
    return list.filter(i=>{
      if(range.from||range.to){const timestamp=Date.parse(i.date);if(!Number.isFinite(timestamp)){if(!$('unknownDate').checked)return false;}else if(range.from&&timestamp<range.from.getTime()||range.to&&timestamp>range.to.getTime())return false;}
      // Search is performed by the source; its indexed text can differ from the visible card title.
      for(const key of ['likes','views','percent']){const threshold=Number($(key).value)||0,v=stat(i,key);if(threshold>0&&(v==null?!unknown:v<threshold))return false;}
      const f=$('favorite').value;const owner=i.site||site;if(f==='author'&&!savedAuthors.has(owner+':'+i.author))return false;
      if(f==='tag'&&!(i.tags||[]).some(t=>savedTags.has(owner+':'+t)))return false;
      return true;
    }).sort((a,b)=>{const key=$('sort').value;return key==='date'?(Date.parse(b.date)||0)-(Date.parse(a.date)||0):(stat(b,key)??-1)-(stat(a,key)??-1);});
  }
  // Remote CDNs are frequently unreachable from the WebView's own resolver (VPN/hotspot split DNS)
  // while the app's native stack still works. An <img> cannot carry headers, so on a load failure
  // retry through the app's media proxy, which fetches with the site as referer.
  function proxiedThumb(url, site) {
    if (!url || !H || typeof H.httpRequest !== 'function') return null;
    if (!/^https?:\/\//i.test(url)) return null;
    const host = (() => { try { return new URL(url).host; } catch (_) { return ''; } })();
    if (!host) return null;
    const referer = site === 'e621' ? 'https://e621.net/' :
      site === 'danbooru' ? 'https://danbooru.donmai.us/' :
      site === 'gelbooru' ? 'https://gelbooru.com/' : '';
    return '/media?u=' + encodeURIComponent(url) + (referer ? '&r=' + encodeURIComponent(referer) : '');
  }
  function paint(){
    const grid=$('grid');grid.replaceChildren();const shown=filterItems(items);
    $('stats').textContent='采集 '+items.length+' · 筛选后 '+shown.length;$('empty').hidden=shown.length>0;
    for(const i of shown){
      const card=node('article',null,'card');if(i.thumbnail){const img=node('img');const direct=i.thumbnail;img.referrerPolicy='no-referrer';img.loading='lazy';img.alt=i.title||'';img.onclick=()=>open(i);img.onerror=()=>{const via=proxiedThumb(direct,i.site||site);if(via&&img.src!==new URL(via,location.href).href){img.src=via;}};img.src=direct;card.append(img);}
      const body=node('div',null,'body');
      if(site==='all'&&i.site)body.append(node('span',names[i.site]||i.site,'badge'));
      body.append(node('h3',i.title||'未命名'),node('p',metrics(i),'metrics'));
      if(i.author){const key=(i.site||site)+':'+i.author;body.append(button((savedAuthors.has(key)?'♥ ':'☆ ')+i.author,()=>{savedAuthors.has(key)?savedAuthors.delete(key):savedAuthors.add(key);persist();paint();}));}
      const tags=node('div',null,'tags');for(const t of (i.tags||[]).slice(0,8)){const key=(i.site||site)+':'+t;tags.append(button((savedTags.has(key)?'♥ ':'#')+t,()=>{savedTags.has(key)?savedTags.delete(key):savedTags.add(key);persist();paint();}));}body.append(tags);
      const actions=node('div',null,'actions');actions.append(button('预览',()=>open(i)),button('下载',()=>open(i,'local')),button('存 Drive',()=>open(i,'drive')));body.append(actions);card.append(body);grid.append(card);
    }
  }
  async function load(append){
    if(busy)return;busy=true;$('refresh').disabled=true;
    try{
      if(site==='all'){
        // One list, four sources: each origin is collected in turn and merged locally, so the
        // unified view never becomes four separate site windows.
        say('正在依次采集各来源并合并为统一列表…');
        const merged=new Map(), failed=[];
        for(const s of sources){
          try{
            const r=await requestFor(s,sourceUrlFor(s,1),'list');
            const list=(r.items||[]).map(it=>({...it,site:s}));
            for(const it of list)merged.set(s+':'+(it.url||it.pageUrl||it.id),it);
            if(list.length)localStorage.setItem('hoshi_source_cache_'+s,JSON.stringify({items:list,time:Date.now()}));
          }catch(e){failed.push(names[s]+'：'+e.message);}
        }
        items=[...merged.values()];paint();
        say('已合并 '+items.length+' 条统一列表'+(failed.length?'；未取到 → '+failed.join(' / '):'')+'\n可切换来源标签单独查看，或在那里完成登录 / 验证。');
      }else{
        lastQuery=sourceUrl();say('正在后台采集 '+names[site]+' 第 '+page+' 页；主界面保持在星映…');
        const r=await request(sourceUrl(),site==='x'&&append?'list_next':'list');
        const incoming=(r.items||[]).map(i=>({...i,site}));
        const map=new Map((append?items:[]).map(i=>[i.url||i.pageUrl||i.id,i]));
        for(const i of incoming)map.set(i.url||i.pageUrl||i.id,i);
        items=[...map.values()];
        localStorage.setItem('hoshi_source_cache_'+site,JSON.stringify({items,time:Date.now()}));
        paint();say('采集完成。仅按已取得的数值筛选，缺失项不会自动视为高赞。'+(r.message||''));
      }
    }
    catch(e){say(e.message+'\n可用“来源登录 / 验证”处理站点登录或验证。');}
    finally{busy=false;$('refresh').disabled=false;}
  }
  const MEDIA_EXT=/\.(mp4|m3u8|mpd|webm|mkv|m4v|mov|ts|flv|zip|jpe?g|png|webp|gif|avif)(\?|#|$)/i;
  // Pornhub's detail page occasionally lists its own view_video.php URL among the sources; picking
  // that entry makes the downloader save an HTML page instead of the original file.
  function isMediaUrl(u){
    if(!/^https?:\/\//i.test(u||''))return false;
    if(MEDIA_EXT.test(u))return true;
    const lower=u.toLowerCase();
    if(/\/(view_video|view_video\.php|watch|search|embed|login|signup)(\/|\?|$)/.test(lower))return false;
    if(/\.(php|html?|json)(\?|#|$)/.test(lower))return false;
    return true;
  }
  function normalizeMedia(list){return (list||[]).filter(m=>m&&isMediaUrl(m.url)).map(m=>({...m,height:Number(m.height)||0,bitrate:Number(m.bitrate)||0})).sort((a,b)=>b.height-a.height||b.bitrate-a.bitrate);}
  let hlsPlayer=null;
  function stopHls(){if(hlsPlayer){try{hlsPlayer.destroy();}catch(_){}hlsPlayer=null;}}
  // surrit.com and similar CDNs do not answer the appassets origin with CORS headers, so the player
  // pulls manifests and fragments through the collector page instead of the page's own fetch.
  function nativeFetch(url){
    return new Promise((resolve,reject)=>{
      if(!(H&&typeof H.fetchMedia==='function')){reject(new Error('此版本未启用来源会话读取'));return;}
      const id='f'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
      const parts=[];let expected=0;
      const finish=(error)=>{
        window.removeEventListener('hoshi:media-chunk',onChunk);
        if(error){reject(new Error(error));return;}
        const bin=atob(parts.join('')),bytes=new Uint8Array(bin.length);
        for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
        resolve(bytes);
      };
      const onChunk=event=>{
        let d=event.detail;if(typeof d==='string'){try{d=JSON.parse(d);}catch(_){return;}}
        if(!d||d.id!==id)return;
        if(d.error){finish(d.error);return;}
        if(d.seq!==expected){finish('来源会话分片乱序');return;}
        expected=d.seq+1;parts.push(d.chunk||'');
        if(d.done)finish('');
      };
      window.addEventListener('hoshi:media-chunk',onChunk);
      try{H.fetchMedia(id,url);}catch(e){finish(e.message||'来源会话不可用');}
    });
  }
  function nativeHlsLoader(){
    return class{
      constructor(cfg){
        this.config=cfg||{};
        this.context=null;
        // hls.js mutates these nested timing objects directly, so they must exist up front.
        this.stats={aborted:false,loaded:0,total:0,retry:0,chunkCount:0,
          loading:{start:0,first:0,end:0},parsing:{start:0,end:0},buffering:{start:0,first:0,end:0}};
      }
      destroy(){}
      abort(){this.stats.aborted=true;}
      load(context,config,callbacks){
        this.context=context;
        this.stats.loading.start=performance.now();
        nativeFetch(context.url).then(bytes=>{
          this.stats.loaded=this.stats.total=bytes.length;
          this.stats.loading.first=this.stats.loading.end=performance.now();
          this.stats.parsing.start=this.stats.parsing.end=performance.now();
          // hls.js parses playlists as text and fragments as bytes; returning the wrong shape
          // throws "s.indexOf is not a function" deep inside its playlist parser.
          const type=(context&&context.responseType)||'arraybuffer';
          const data=type==='arraybuffer'?bytes.buffer:new TextDecoder('utf-8').decode(bytes);
          callbacks.onSuccess({url:context.url,data:data},this.stats,context,{});
        }).catch(e=>setTimeout(()=>callbacks.onError({code:0,text:e.message||'来源会话读取失败'},context,{},{}),0));
      }
    };
  }
  const VIDEO_EXT=/\.(mp4|m3u8|mpd|webm|mkv|m4v|mov|ts|flv)(\?|#|$)/i;
  const IMAGE_EXT=/\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i;
  // Phncdn splits stills and streams across different hosts, and the video URLs often carry no file
  // extension at all (/hls/…, /mp4_720), so classification has to look at the hostname first.
  const IMAGE_HOSTS=/^(pix-egi|pix-cdn|ei|ci|img)(-\w+)?\.phncdn\.com$/i;
  const VIDEO_HOSTS=/^(evtubescms|km-h|hv-h|ev-h|dv-h|ss-h|video)\b.*\.phncdn\.com$/i;
  function hostOf(u){ try { return new URL(u, location.href).hostname; } catch(_) { return ''; } }
  function looksLikeVideo(m){
    if(!m)return false;
    const u=m.url||'', host=hostOf(u);
    if(IMAGE_EXT.test(u)||IMAGE_HOSTS.test(host))return false;
    if(VIDEO_EXT.test(u)||/\.m3u8/i.test(u))return true;
    if(VIDEO_HOSTS.test(host))return true;
    if(/\/(hls|pre_videos|videos)\//i.test(u)&&/mp4_|hls|\d{3,4}p/i.test(u))return true;
    return m.type==='video';
  }
  function looksLikeImage(m){
    if(!m)return false;
    const u=m.url||'', host=hostOf(u);
    if(IMAGE_EXT.test(u)||IMAGE_HOSTS.test(host))return true;
    if(VIDEO_EXT.test(u)||VIDEO_HOSTS.test(host))return false;
    return m.type==='image';
  }
  function renderMedia(){
    stopHls();
    $('choices').replaceChildren();$('media').replaceChildren();
    media.forEach((m,n)=>$('choices').append(button((n===chosen?'✓ ':'')+(m.height?m.height+'p':m.type==='image'?'原图':/m3u8/.test(m.url)?'HLS 自适应源':'源文件')+(m.bitrate?' · '+Math.round(m.bitrate/1000)+'kbps':''),()=>{chosen=n;manualPick=true;renderMedia();})));
    // Preview stays on a light rendition so the first frame shows up quickly; the quality buttons
    // still pick the best file for download, and tapping any button switches the preview to it.
    let playIndex=chosen;
    if(!manualPick){
      const light=media.findIndex(x=>looksLikeVideo(x)&&x.height&&x.height<=720);
      const anyVideo=media.findIndex(looksLikeVideo);
      if(light>=0)playIndex=light; else if(anyVideo>=0)playIndex=anyVideo;
    }
    const m=media[playIndex];if(!m)return;const image=looksLikeImage(m);
    const el=node(image?'img':'video');if(!image){el.controls=true;el.playsInline=true;el.preload='metadata';}
    const isHls=!image&&/\.m3u8(?:$|\?)/i.test(m.url);
    if(isHls&&window.Hls&&window.Hls.isSupported()){
      const Loader=nativeHlsLoader();
      hlsPlayer=new window.Hls({maxBufferLength:30,pLoader:Loader,fLoader:Loader});
      hlsPlayer.on(window.Hls.Events.ERROR,(_,data)=>{if(data&&data.fatal)$('detailStatus').textContent='HLS 预览中断：'+data.details+(data.reason?'（'+data.reason+'）':'')+'；仍可保存到本地';});
      hlsPlayer.loadSource(m.url);hlsPlayer.attachMedia(el);
    }else if(!image){
      // Signed mp4 links reject the appassets Referer; the native /media endpoint replays the
      // request with the source Referer, Origin and cookies and streams the bytes back.
      const ref=(selected&&(selected.pageUrl||selected.url))||'';
      el.src='https://appassets.androidplatform.net/media?u='+encodeURIComponent(m.url)+'&r='+encodeURIComponent(ref);
    }else el.src=m.url;
    el.onerror=()=>{
      // Signed CDN links (e.g. Hanime1's hembed mp4) reject the appassets Referer, so the first
      // direct attempt fails. Pull the same bytes through the source session and play a blob.
      if(!image&&!isHls&&el.dataset.blob!=='1'){
        el.dataset.blob='1';
        $('detailStatus').textContent='直连播放被拒，正在改用来源会话读取预览…';
        nativeFetch(m.url).then(bytes=>{
          if(bytes.length>96*1024*1024){$('detailStatus').textContent='预览文件 '+(bytes.length/1048576).toFixed(0)+'MB 过大，请直接保存到本地后播放。';return;}
          el.src=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
          $('detailStatus').textContent='已通过来源会话载入预览（'+(bytes.length/1048576).toFixed(1)+'MB）。';
        }).catch(e=>{$('detailStatus').textContent=/超过|过大|内存/.test(e.message)?'该源是签名大文件，超出预览内存上限：请点“下载原文件”保存后用本地播放器打开。':'预览未加载：'+e.message+'；仍可尝试原文件保存。';});
        return;
      }
      $('detailStatus').textContent='预览未加载：此源可能要求站点 Referer 或格式支持；仍可尝试原文件保存。';
    };$('media').append(el);
  }
  async function waitIdle(){let waited=0;while(busy&&waited<60){await new Promise(r=>setTimeout(r,500));waited++;}}
  // Default the selection to a real video rendition: some sources mix stills and preview clips into
  // the same candidate list, and picking a still first breaks both the player and the save path.
  function preferVideo(){ const i=media.findIndex(looksLikeVideo); if(i>0&&!manualPick)chosen=i; }
  async function open(item,action){
    selected=item;chosen=0;manualPick=false;media=normalizeMedia(item.media);$('detailTitle').textContent=item.title||'媒体预览';$('detailStats').textContent=metrics(item);$('detailStatus').textContent='正在后台解析可用清晰度…';$('download').disabled=$('drive').disabled=true;
    const cacheKey=item.pageUrl||item.url;
    const hit=detailCache.get(cacheKey);
    if(hit&&Date.now()-hit.t<600000&&hit.media.length){
      media=[...new Map([...hit.media,...media].map(m=>[m.url,m])).values()].sort((a,b)=>(b.height||0)-(a.height||0)||(b.bitrate||0)-(a.bitrate||0));preferVideo();
      $('detailStatus').textContent='已取得 '+media.length+' 个媒体源（本地缓存，10 分钟内不重复解析）。';
      $('download').disabled=$('drive').disabled=false;
      if(!$('viewer').open)$('viewer').showModal();renderMedia();
      if(action)await transfer(action);
      return;
    }
    if(!$('viewer').open)$('viewer').showModal();renderMedia();
    // The collector handles one request at a time, so opening a card while the unified list is
    // still merging would cancel its own detail request.
    if(busy){$('detailStatus').textContent='正在完成采集，稍后自动解析此条目…';await waitIdle();}
    try{const r=await requestFor(item.site||site,item.pageUrl||item.url,'detail');let list=r.media||(r.items&&r.items[0]&&r.items[0].media)||[];media=normalizeMedia([...list,...media]);media=[...new Map(media.map(m=>[m.url,m])).values()];preferVideo();renderMedia();if(!media.length)throw new Error('此条目尚未解析到可保存的媒体源；可先完成来源登录/验证后重试');detailCache.set(cacheKey,{t:Date.now(),media:media.slice()});$('detailStatus').textContent='已取得 '+media.length+' 个媒体源，默认按已公开的分辨率/码率降序选择。HLS 保存时解析最高变体并保存完整分片。';$('download').disabled=$('drive').disabled=false;if(action)await transfer(action);}
    catch(e){$('detailStatus').textContent=e.message;if(media.length)$('download').disabled=$('drive').disabled=false;}
  }
  function token(){return new Promise((resolve,reject)=>{if(!H||typeof H.requestDriveToken!=='function'){reject(new Error('此版本未启用 Android 原生 Drive 授权'));return;}const id='d'+Date.now()+Math.random().toString(36).slice(2);const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Google Drive 授权超时，请重试'));},120000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v.accessToken);},reject:e=>{clearTimeout(timer);reject(e);}});H.requestDriveToken(id);});}
  window.addEventListener('hoshi:drive-token',event=>{let d=event.detail;if(typeof d==='string')try{d=JSON.parse(d);}catch(_){return;}const p=pending.get(d.id);if(!p)return;pending.delete(d.id);if(d.error)p.reject(new Error(d.error));else if(d.accessToken)p.resolve(d);else p.reject(new Error('Android 未返回 Drive 访问令牌'));});
  async function transfer(target){
    const m=media[chosen];if(!m||!selected)return;if(!H||typeof H.startTransfer!=='function')return;
    let mode=target, accessToken='';
    if(target==='drive'){
      try{ accessToken=await token(); }
      catch(e){
        // Google rejected the API token (Android OAuth client not registered for this package).
        // Hand the finished file to the Drive app instead of failing the save.
        mode='driveapp';
        $('detailStatus').textContent='Drive API 授权不可用（'+e.message+'），改为交给 Drive 应用保存…';
      }
    }
    try{const id='t'+Date.now()+Math.random().toString(36).slice(2);const p={id,url:m.url,referer:selected.pageUrl||selected.url,title:selected.title||'media',site:selected.site||site,target:mode,accessToken,type:m.type||''};tasks.set(id,{title:p.title,text:'等待下载…'});paintTasks();H.startTransfer(JSON.stringify(p));$('detailStatus').textContent=mode==='driveapp'?'正在下载原文件，完成后交给 Drive 应用：'+p.title:'保存任务已启动，进度见列表底部。';}
    catch(e){$('detailStatus').textContent=e.message;}
  }
  function paintTasks(){$('tasks').replaceChildren();for(const t of tasks.values())$('tasks').append(node('div',t.title+' · '+t.text,'task'));}
  window.addEventListener('hoshi:transfer-result',e=>{let d=e.detail;if(typeof d==='string')try{d=JSON.parse(d);}catch(_){return;}const t=tasks.get(d.id);if(!t)return;t.text=d.error?'失败：'+d.error:d.message||'处理中';paintTasks();});
  function connect(){if(H&&typeof H.authorizeDrive==='function')H.authorizeDrive();else location.href='../index.html';}
  $('connect').onclick=connect;$('close').onclick=()=>{const v=$('media').querySelector('video');if(v)v.pause();stopHls();$('viewer').close();};$('download').onclick=()=>transfer('local');$('drive').onclick=()=>transfer('drive');
  let lastQuery='';
  $('filters').onsubmit=e=>{e.preventDefault();if($('period').value==='custom'&&$('from').value&&$('to').value&&$('from').value>$('to').value){say('起始日期应早于结束日期');return;}if(site==='all'||lastQuery!==sourceUrl()){page=1;load(false);}else paint();};$('refresh').onclick=()=>{page=1;load(false);};$('next').onclick=()=>{page++;load(true);};$('login').hidden=site==='all'||['gelbooru','e621'].includes(site);$('login').onclick=()=>{if(H&&typeof H.sourceLogin==='function')H.sourceLogin(site,lastQuery);};
  $('cookies').hidden=site!=='x';
  $('cookies').onclick=()=>{if(H&&typeof H.sourceCookies==='function')H.sourceCookies(site);};
  $('next').hidden=site==='all';
  document.querySelectorAll('[data-site]').forEach(b=>{b.classList.toggle('active',b.dataset.site===site);b.onclick=()=>{location.href='index.html?site='+b.dataset.site;};});
  $('heading').textContent=site==='all'?'全部来源统一长廊':names[site]+' · 星映长廊';
  wireBooruAuth();
  // Start unfiltered for every source. Metrics vary by site and many cards omit them;
  // users can opt into explicit thresholds without hiding every valid result by default.
  $('likes').value=0;$('views').value=0;$('percent').value=0;
  if(site==='all'){
    const seed=[];
    for(const s of sources){try{const c=JSON.parse(localStorage.getItem('hoshi_source_cache_'+s)||'null');if(c&&c.items)for(const it of c.items)seed.push({...it,site:s});}catch(_){}}
    if(seed.length){items=seed;paint();say('显示四个来源的本地缓存，正在后台合并刷新…');}
  }else{
    try{const cache=JSON.parse(localStorage.getItem('hoshi_source_cache_'+site)||'null');if(cache&&cache.items){items=cache.items;paint();say('显示上次采集缓存，正在刷新…');}}catch(_){}
  }
  function driveLabel(){
    const session=localStorage.getItem('drive_oauth_session');
    const native=H&&typeof H.driveConnected==='function'&&H.driveConnected();
    const account=H&&typeof H.driveAccount==='function'?H.driveAccount():'';
    // The phone-side account token and the browser session are independent login paths; either one
    // means Drive is usable, and neither may claim a connection the other cleared.
    if(!session&&!native&&H&&typeof H.clearDrive==='function')H.clearDrive();
    $('connect').textContent=(session||native)?(account?'Drive · '+account:'Drive 已连接'):'连接 Drive';
  }
  window.addEventListener('hoshi:auth-changed',driveLabel);driveLabel();load(false);
  window.__hoshiSourceModel={filterItems,normalizeMedia};
})();


