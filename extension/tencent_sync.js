/*
 * 魔王S 腾讯文档同步助手
 * 这个脚本需要在 docs.qq.com 文档页面中运行（书签脚本/控制台）。
 * 不读取、不上传 Cookie；请求使用当前腾讯文档页面的登录态。
 */
(() => {
  if (window.__MAOWANGS_TENCENT_SYNC__) {
    window.__MAOWANGS_TENCENT_SYNC__.open();
    return;
  }

  const DOC_ID = (location.pathname.match(/\/sheet\/([^/?]+)/) || [])[1];
  const TAB_ID = new URLSearchParams(location.search).get('tab') || '';
  const LOCAL = 'http://localhost:8080';
  const PAGE_ID = 'mw-tencent-sync-panel';

  const state = { sheets: [], selected: new Set(), running: false };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function toast(msg, bad = false) {
    const el = document.getElementById('mw-sync-toast');
    if (!el) return;
    el.textContent = msg;
    el.style.background = bad ? '#8b1e2d' : '#151a2a';
    el.style.display = 'block';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.style.display = 'none', 2600);
  }

  function panel() {
    let old = document.getElementById(PAGE_ID);
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = PAGE_ID;
    box.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483646;font-family:Arial,'Microsoft YaHei',sans-serif">
        <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:520px;max-width:calc(100vw - 30px);max-height:82vh;overflow:auto;background:#15172a;color:#eee;border:1px solid #3b4260;border-radius:16px;box-shadow:0 20px 70px rgba(0,0,0,.5);padding:22px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div style="font-size:20px;font-weight:800">🔄 魔王S 腾讯文档同步 <span style="font-size:12px;color:#697394;font-weight:600">v8.3.19</span></div>
            <button id="mw-sync-close" style="border:0;background:transparent;color:#aaa;font-size:22px;cursor:pointer">×</button>
          </div>
          <div id="mw-sync-doc" style="font-size:12px;color:#8e97b7;margin-bottom:14px"></div>
          <div id="mw-sync-status" style="font-size:13px;color:#aeb6d1;margin-bottom:12px">正在读取 Sheet 列表…</div>
          <div style="display:flex;gap:8px;margin-bottom:10px">
            <button id="mw-sync-all" style="padding:7px 12px;border:1px solid #475078;background:#202640;color:#ddd;border-radius:8px;cursor:pointer">全选</button>
            <button id="mw-sync-none" style="padding:7px 12px;border:1px solid #475078;background:#202640;color:#ddd;border-radius:8px;cursor:pointer">全不选</button>
          </div>
          <div id="mw-sync-sheets" style="border:1px solid #303750;border-radius:10px;padding:8px;min-height:80px"></div>
          <div id="mw-sync-log" style="margin-top:12px;white-space:pre-wrap;font-size:12px;line-height:1.6;color:#8992b0;max-height:180px;overflow:auto"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px">
            <div style="display:flex;gap:8px;align-items:center">
            <button id="mw-sync-raw" style="padding:8px 12px;border:1px solid #465b8a;background:#18233d;color:#b9d1ff;border-radius:9px;cursor:pointer">查看原始解码数据</button>
            <button id="mw-sync-reset" style="padding:8px 12px;border:1px solid #7a3042;background:#2a1720;color:#ff9db3;border-radius:9px;cursor:pointer">清空腾讯同步数据</button>
          </div>
            <div style="display:flex;justify-content:flex-end;gap:10px">
            <button id="mw-sync-cancel" style="padding:9px 18px;border:1px solid #3e4662;background:transparent;color:#aaa;border-radius:9px;cursor:pointer">关闭</button>
            <button id="mw-sync-start" style="padding:9px 18px;border:0;background:linear-gradient(135deg,#ff3366,#ff6b9d);color:white;border-radius:9px;font-weight:800;cursor:pointer">开始同步</button>
            </div>
          </div>
        </div>
      </div>
      <div id="mw-sync-toast" style="display:none;position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:2147483647;color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.35)"></div>`;
    document.body.appendChild(box);
    box.querySelector('#mw-sync-close').onclick = () => box.remove();
    box.querySelector('#mw-sync-cancel').onclick = () => box.remove();
    box.querySelector('#mw-sync-all').onclick = () => { state.sheets.forEach(s => state.selected.add(s.id)); renderSheets(); };
    box.querySelector('#mw-sync-none').onclick = () => { state.selected.clear(); renderSheets(); };
    box.querySelector('#mw-sync-start').onclick = start;
    box.querySelector('#mw-sync-raw').onclick = diagnoseSelectedSheet;
    box.querySelector('#mw-sync-reset').onclick = resetTencentData;
    return box;
  }

  function log(msg) {
    const el = document.getElementById('mw-sync-log');
    if (!el) return;
    el.textContent += (el.textContent ? '\n' : '') + msg;
    el.scrollTop = el.scrollHeight;
  }

  function renderSheets() {
    const el = document.getElementById('mw-sync-sheets');
    if (!el) return;
    el.innerHTML = state.sheets.map(s => `
      <label style="display:flex;align-items:center;gap:9px;padding:9px 8px;border-radius:7px;cursor:pointer">
        <input type="checkbox" data-sheet-id="${esc(s.id)}" ${state.selected.has(s.id) ? 'checked' : ''}>
        <span style="flex:1">${esc(s.name)}</span>
        <span style="font-size:11px;color:#68718f">${esc(s.id)}</span>
      </label>`).join('');
    el.querySelectorAll('input[data-sheet-id]').forEach(cb => {
      cb.onchange = () => cb.checked ? state.selected.add(cb.dataset.sheetId) : state.selected.delete(cb.dataset.sheetId);
    });
  }

  function parseCallback(text) {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('腾讯文档返回格式异常');
    return JSON.parse(text.slice(a, b + 1));
  }

  function getVars(obj) {
    return obj?.clientVars?.collab_client_vars || obj?.clientVars?.collabClientVars || {};
  }

  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parseCallback(await r.text());
  }

  function makeUrl(tab, start, end, docId) {
    const p = new URLSearchParams();
    p.set('tab', tab);
    p.set('u', '');
    p.set('noEscape', '1');
    p.set('enableSmartsheetSplit', '1');
    p.set('startrow', String(start));
    p.set('endrow', String(end));
    p.set('frozenStartRow', '0');
    p.set('frozenEndRow', '20');
    p.set('needFrozen', '1');
    p.set('needSheetState', '1');
    p.set('sliceStates', '1');
    p.set('block_end_col', '63');
    p.set('block_end_row', String(end));
    p.set('block_start_col', '0');
    p.set('block_start_row', String(start));
    p.set('id', docId);
    p.set('normal', '1');
    p.set('outformat', '1');
    p.set('wb', '1');
    p.set('nowb', '0');
    p.set('callback', 'clientVarsCallback');
    const tok = (document.cookie.match(/(?:^|;\s*)TOK=([^;]+)/) || [])[1];
    if (tok) p.set('xsrf', decodeURIComponent(tok));
    p.set('t', Date.now().toString(36));
    return '/dop-api/opendoc?' + p.toString();
  }

  async function inflateBase64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!('DecompressionStream' in window)) throw new Error('当前浏览器不支持数据解压，请使用最新版 Edge/Chrome');
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const out = await new Response(stream).arrayBuffer();
    const outBytes = new Uint8Array(out);
    return { bytes: outBytes, text: new TextDecoder('utf-8').decode(outBytes) };
  }

  function downloadDebugText(sheetName, text) {
    try {
      const safe = String(sheetName || 'sheet').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
      const meta = [
        '魔王S腾讯同步助手 v8.3.19 腾讯结构解析',
        'Sheet: ' + sheetName,
        'URL: ' + location.href,
        '时间: ' + new Date().toISOString(),
        '长度: ' + text.length,
        '',
        text
      ].join('\n');
      const blob = new Blob([meta], {type:'text/plain;charset=utf-8'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '魔王S腾讯诊断-' + safe + '.txt';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      return true;
    } catch(e) { console.warn('debug download failed', e); return false; }
  }

  // fallback 解析：严格依据“下一条改枪码自身携带的枪名”识别枪名标题。
  // 不针对 P90、MP5 等具体枪名写规则，也不依赖固定枪械后缀。
  // 原始 related_sheet 可能把下一把枪的标题放在当前改枪码与下一条改枪码之间，
  // 因而当前记录的最后一个有效文本可能其实是“下一把枪标题”。
  function normalizeGunTitle(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
      .replace(/^[\s\/|｜、]+|[\s\/|｜、]+$/g, '')
      .replace(/^\d+/, '')
      .trim();
  }

  function getGunRawNameFromCode(code) {
    const m = String(code || '').match(/^(.+?)-烽火地带-[A-Z0-9]{10,}/);
    return m ? normalizeGunTitle(m[1]) : '';
  }

  function isStandaloneGunTitle(part, titleSet) {
    const x = normalizeGunTitle(part);
    if (!x || !titleSet || !titleSet.size) return false;
    if (titleSet.has(x)) return true;
    const upper = x.toLocaleUpperCase();
    for (const t of titleSet) {
      const tu = String(t).toLocaleUpperCase();
      // 独立标题可能是简称，例如“MP5”，真实改枪码枪名是“MP5冲锋枪”。
      // 只有整段文本本身就是标题/标题简称时才删除；复合备注不会进入这里。
      if (upper === tu || tu.startsWith(upper)) return true;
    }
    return false;
  }

  function extractRecords(text, sheetName) {
    const codeRe = /[^\x00-\x1F\x7F]{1,100}-烽火地带-[A-Z0-9]{10,}/g;
    const ms = [...String(text || '').matchAll(codeRe)];
    const result = [];
    const seen = new Set();
    const gunTitleSet = new Set();

    // 先收集所有真实改枪码对应的枪名。
    // 这样“单独一行的枪名”可以被识别为标题，而不是上一条记录的备注。
    for (const m of ms) {
      const title = getGunRawNameFromCode(m[0]);
      if (title) gunTitleSet.add(title);
    }

    const update = String(text || '').match(/改枪码更新时间\s*[:：]\s*(\d{1,2})[./月](\d{1,2})/) || [];
    const date = update[1] && update[2] ? `${update[1]}月${update[2]}日` : '';

    for (let i = 0; i < ms.length; i++) {
      const code = ms[i][0].trim();
      if (seen.has(code)) continue;
      seen.add(code);
      const nextCode = i + 1 < ms.length ? ms[i + 1][0].trim() : '';
      const end = nextCode ? ms[i + 1].index : Math.min(String(text || '').length, ms[i].index + 1200);
      const seg = String(text || '').slice(ms[i].index + ms[i][0].length, end);
      const parts = seg.split(/[\x00-\x1F\x7F]+/).map(x => x.trim()).filter(Boolean);
      const pricePart = parts.find(x => /^\d+(?:\.\d+)?w$/i.test(x) || /^(新兵|标准|精锐|特种|定制)$/.test(x));
      const ammoPart = parts.find(x => /^\d+(?:\+\d+)?发$/.test(x));

      let noteParts = parts
        .filter(x => x !== pricePart && x !== ammoPart && x.length > 1);

      // 关键修复：独立枪名行只能“整段删除”，绝不能从正常备注里抠掉枪名。
      // 例如：
      //   MP5
      //   MP5冲锋枪-烽火地带-XXXX
      // 上一条记录的区间里会出现一个独立的“MP5”，它属于下一条记录。
      // 但“满配红点可腰射 / MP5”是合法备注，必须原样保留。
      noteParts = noteParts.filter(part => !isStandaloneGunTitle(part, gunTitleSet));

      const price = pricePart || '';
      const ammo = ammoPart || '';
      const note = noteParts.slice(0, 4).join(' / ');
      const gunNameRaw = getGunRawNameFromCode(code);
      const isZhishi = /^(新兵|标准|精锐|特种|定制)$/.test(price);
      result.push({ code, gunNameRaw, price: isZhishi ? '制式-' + price : price, ammo, note, date, gunId: '', sheet: sheetName });
    }
    return result;
  }

  function decodeSheetCell(cell) {
    if (cell == null) return '';
    // Tencent Docs get/sheet: cell value is usually cell["2"] = [type, value].
    const v = cell['2'];
    if (Array.isArray(v) && v.length >= 2) {
      const x = v[1];
      if (x == null) return '';
      if (Array.isArray(x)) return x.length > 1 ? x[1] : '';
      return x;
    }
    // A few revisions place the primitive value in another slot.
    for (const k of ['1','4','5']) {
      const x = cell[k];
      if (typeof x === 'string' || typeof x === 'number') return x;
      if (Array.isArray(x) && x.length >= 2 && (typeof x[1] === 'string' || typeof x[1] === 'number')) return x[1];
    }
    return '';
  }

  function findCellMapDeep(obj) {
    let found = null; const seen = new WeakSet();
    function looks(v){ if(!v||typeof v!=='object'||Array.isArray(v)) return false; const k=Object.keys(v); return k.length>0 && k.slice(0,20).every(x=>/^\d+$/.test(x)); }
    function walk(v,d){
      if(found||v==null||d>20||typeof v!=='object') return;
      if(seen.has(v)) return; seen.add(v);
      if(Array.isArray(v)){
        if(v[0]?.c && Array.isArray(v[0].c) && looks(v[0].c[1])) { found=v[0].c[1]; return; }
        if(v[1] && looks(v[1])) { found=v[1]; return; }
        for(const x of v) walk(x,d+1);
      }else{
        if(v.c && Array.isArray(v.c) && looks(v.c[1])) { found=v.c[1]; return; }
        for(const x of Object.values(v)) walk(x,d+1);
      }
    }
    walk(obj,0); return found;
  }

  function decodeSheetCell(cell){
    if(cell==null) return '';
    const v=cell['2'];
    if(Array.isArray(v)&&v.length>=2) return v[1]==null?'':v[1];
    for(const k of ['1','4','5']){
      const x=cell[k];
      if(typeof x==='string'||typeof x==='number') return x;
      if(Array.isArray(x)&&x.length>=2&&(typeof x[1]==='string'||typeof x[1]==='number')) return x[1];
    }
    return '';
  }

  function findTencentCellMap(sheetJson) {
    // Tencent Docs has used two JSON layouts over time. Prefer the real cell map
    // returned by get/sheet; only fall back to the older deep scanner.
    const seen = new WeakSet();
    function looksMap(v) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
      const ks = Object.keys(v);
      if (!ks.length) return false;
      return ks.slice(0, 40).every(k => /^\d+$/.test(k));
    }
    function walk(v, depth) {
      if (!v || typeof v !== 'object' || depth > 30) return null;
      if (seen.has(v)) return null;
      seen.add(v);
      if (Array.isArray(v)) {
        // Known Tencent layout: ...[0].c[1] is the numeric-key cell map.
        for (const item of v) {
          if (item && typeof item === 'object' && Array.isArray(item.c) && looksMap(item.c[1])) return item.c[1];
        }
        for (const item of v) { const r = walk(item, depth + 1); if (r) return r; }
      } else {
        if (Array.isArray(v.c) && looksMap(v.c[1])) return v.c[1];
        // The map can also sit directly under a field named c in some revisions.
        if (looksMap(v.c)) return v.c;
        for (const x of Object.values(v)) { const r = walk(x, depth + 1); if (r) return r; }
      }
      return null;
    }
    return walk(sheetJson, 0);
  }

  function parseCellMap(sheetJson,maxCol,chunkStart){
    const cells=findTencentCellMap(sheetJson) || findCellMapDeep(sheetJson); if(!cells) return {rows:[],cellCount:0};
    let width=Math.max(1,Number(maxCol)+1);
    const keys=Object.keys(cells).map(Number).filter(Number.isFinite); const maxKey=keys.length?Math.max(...keys):-1;
    const maxRow=Math.floor(maxKey/width); const offset=chunkStart>0&&maxRow<chunkStart?chunkStart:0;
    const rows=[]; let cellCount=0;
    for(const [k,cell] of Object.entries(cells)){
      const idx=Number(k); if(!Number.isFinite(idx)||idx<0) continue;
      const r=Math.floor(idx/width)+offset, c=idx%width;
      if(!rows[r]) rows[r]={}; rows[r][c]=decodeSheetCell(cell); cellCount++;
    }
    return {rows,cellCount};
  }

  function normalizeTitleText(v){
    return String(v ?? '').replace(/[\u00a0\u200b]/g,' ').replace(/^[\s\/|｜、]+|[\s\/|｜、]+$/g,'').trim();
  }

  // 从当前 Sheet 自身的数据中收集“独立枪名行”。
  // 不写死 P90、MP5 等具体枪名：只有当某个文本在 Sheet 中独立成行，
  // 且同时能与某条实际改枪码的枪名前缀对应时，才把它视为枪名标题。
  function collectStandaloneGunTitles(dense, codeCol, header){
    const gunNames = new Set();
    for(let i=header+1;i<dense.length;i++){
      const r=dense[i]||[];
      const rawCode=normalizeTitleText(r[codeCol]);
      const m=rawCode.match(/([^\x00-\x1F\x7F]{1,100})-烽火地带-[A-Z0-9]{10,}/);
      if(m) gunNames.add(normalizeTitleText(m[1]).replace(/^\d+/,'').trim());
    }
    const standalone = new Set();
    for(let i=header+1;i<dense.length;i++){
      const r=dense[i]||[];
      const vals=r.map(normalizeTitleText).filter(Boolean);
      if(vals.length!==1) continue;
      const x=vals[0];
      if(!gunNames.has(x)) continue;
      // 只有独立行才进入集合；普通备注中的同名文本不会被误删。
      standalone.add(x);
    }
    return standalone;
  }

  function stripStandaloneGunTitle(note, standaloneGunTitles){
    let x=normalizeTitleText(note);
    if(!x) return '';
    // 仅检查末尾分隔段，且该段必须来自当前 Sheet 的独立枪名行。
    const m=x.match(/^(.*?)(?:\s*[/|｜、]\s*)([^/|｜、]+)\s*$/);
    if(m){
      const tail=normalizeTitleText(m[2]);
      if(standaloneGunTitles.has(tail)){
        return normalizeTitleText(m[1]);
      }
    }
    if(standaloneGunTitles.has(x)) return '';
    return x;
  }

  function cellRowsToRecords(rows,sheetName){
    const dense=rows.map(r=>{const a=[];if(r)for(const[k,v]of Object.entries(r))a[Number(k)]=v;return a;});
    let header=-1; const map={code:0,price:1,mirror:2,ammo:3,note:6,gunId:7,specialGunId:8};
    for(let i=0;i<Math.min(dense.length,80);i++){
      const row=dense[i]||[];
      row.forEach((v,j)=>{const x=String(v??'').trim();
        if(x.includes('改枪码')&&(x.includes('游戏')||x==='改枪码')){map.code=j;if(header<0)header=i;}
        else if(x==='价格')map.price=j; else if(x.includes('镜子'))map.mirror=j; else if(x.includes('弹夹'))map.ammo=j;
        else if(x.includes('备注'))map.note=j; else if(x.includes('特殊子弹ID'))map.specialGunId=j; else if(x.includes('网址使用')||/^ID$/i.test(x))map.gunId=j;
      });
      if(header>=0&&map.gunId>=0&&map.specialGunId>=0)break;
    }
    if(header<0) header=0;
    const standaloneGunTitles=collectStandaloneGunTitles(dense,map.code,header);
    const out=[],seen=new Set(); const top=dense.slice(0,15).flat().join(' '); const dm=top.match(/改枪码更新时间\s*[:：]?\s*(\d{1,2})[./月](\d{1,2})/); const date=dm?`${dm[1]}月${dm[2]}日`:'';
    for(let i=header+1;i<dense.length;i++){
      const r=dense[i]||[], raw=String(r[map.code]??'').trim(); const m=raw.match(/[^\x00-\x1F\x7F]{1,100}-烽火地带-[A-Z0-9]{10,}/); if(!m)continue;
      const code=m[0].trim(); if(seen.has(code))continue; seen.add(code);
      let gunId=String(r[map.gunId]??'').trim().replace(/\.0+$/,''); let specialGunId=String(r[map.specialGunId]??'').trim().replace(/\.0+$/,'');
      if(!/^\d+$/.test(gunId))gunId=''; if(!/^\d+$/.test(specialGunId))specialGunId='';
      const note=stripStandaloneGunTitle(String(r[map.note]??''),standaloneGunTitles);
      out.push({code,gunNameRaw:code.split('-烽火地带-')[0].replace(/^\d+/,'').trim(),price:String(r[map.price]??'').trim(),ammo:String(r[map.ammo]??'').trim(),note,date,gunId,specialGunId,sheet:sheetName});
    }
    return out;
  }

  async function getSheetChunk(sheet,start,end,meta){
    const p=new URLSearchParams(); p.set('tab',sheet.id);p.set('padId',meta.globalPadId||'');p.set('subId',sheet.id);p.set('outformat','1');p.set('startrow',String(start));p.set('endrow',String(end));p.set('normal','1');p.set('preview_token','');p.set('nowb','1');p.set('rev',String(meta.rev||''));p.set('enableSmartsheetSplit','1');
    const tok=(document.cookie.match(/(?:^|;\s*)TOK=([^;]+)/)||[])[1];if(tok)p.set('xsrf',decodeURIComponent(tok));
    const r=await fetch('/dop-api/get/sheet?'+p.toString(),{credentials:'include',cache:'no-store'});if(!r.ok)throw new Error(`get/sheet HTTP ${r.status}`);const t=await r.text();
    try{return JSON.parse(t);}catch(e){const a=t.indexOf('{'),b=t.lastIndexOf('}');if(a<0||b<=a)throw new Error('get/sheet 返回不是 JSON');return JSON.parse(t.slice(a,b+1));}
  }

  async function getSheetChunkCompat(sheet,start,end,meta) {
    // First use the current request shape. If Tencent returns only compressed
    // related_sheet metadata, retry the older non-split representation which
    // historically exposed the actual numeric-key cell map.
    const first = await getSheetChunk(sheet,start,end,meta);
    const p = parseCellMap(first, Number(meta.maxCol || 45), start);
    if (p.cellCount) return {obj:first, parsed:p, strategy:'current'};
    const q = new URLSearchParams();
    q.set('tab',sheet.id); q.set('padId',meta.globalPadId||''); q.set('subId',sheet.id);
    q.set('outformat','1'); q.set('startrow',String(start)); q.set('endrow',String(end));
    q.set('normal','1'); q.set('preview_token',''); q.set('nowb','0'); q.set('wb','0');
    q.set('rev',String(meta.rev||'')); q.set('enableSmartsheetSplit','0');
    const tok=(document.cookie.match(/(?:^|;\s*)TOK=([^;]+)/)||[])[1]; if(tok) q.set('xsrf',decodeURIComponent(tok));
    const r=await fetch('/dop-api/get/sheet?'+q.toString(),{credentials:'include',cache:'no-store'});
    if(r.ok){
      const t=await r.text(); let obj;
      try{obj=JSON.parse(t);}catch(e){const a=t.indexOf('{'),b=t.lastIndexOf('}');if(a>=0&&b>a)obj=JSON.parse(t.slice(a,b+1));}
      if(obj){const parsed=parseCellMap(obj,Number(meta.maxCol||45),start);if(parsed.cellCount)return {obj,parsed,strategy:'legacy'};}
    }
    return {obj:first,parsed:p,strategy:'compressed'};
  }

  async function loadSheet(sheet){
    const first=await getJSON(makeUrl(sheet.id,0,255,DOC_ID)); const vars=getVars(first); const maxRow=Number(vars.maxRow??0),maxCol=Number(vars.maxCol??45),meta={globalPadId:vars.globalPadId||'',rev:vars.rev||''};
    const allRows=[];let cells=0,chunks=0,ok=false;
    for(let start=0;start<=maxRow;start+=256){const end=Math.min(start+255,maxRow);meta.maxCol=maxCol;const q=await getSheetChunkCompat(sheet,start,end,meta);const p=q.parsed;if(p.cellCount){ok=true;cells+=p.cellCount;chunks++;p.rows.forEach((r,i)=>{if(r)allRows[i]=Object.assign(allRows[i]||{},r);});}}
    const records=ok?cellRowsToRecords(allRows,sheet.name):[];
    if(records.length)return{records,maxRow,blocks:chunks,cells,gunIds:records.filter(x=>x.gunId).length,specialGunIds:records.filter(x=>x.specialGunId).length};
    // Fallback to the proven opendoc parser so a Tencent API shape change cannot erase all codes.
    const blocks=findBlockDatas(first);let all='';let rawParts=[];for(const b of blocks)if(b?.related_sheet){const z=await inflateBase64(b.related_sheet);all+=z.text;rawParts.push(z.bytes);}
    const idHeader = all.includes('ID（网址使用）') || all.includes('ID(网址使用)') || /(^|\n)ID[（(]网址使用[）)]/.test(all);
    const specialHeader = all.includes('特殊子弹ID');
    const fallback=extractRecords(all,sheet.name).map(x=>({...x,specialGunId:''}));
    const ids = extractIdColumn(rawParts, all, fallback.length);
    ids.forEach((id,i)=>{ if(fallback[i] && id) fallback[i].gunId=id; });
    const gunIds = fallback.filter(x=>x.gunId).length;
    return{records:fallback,maxRow,blocks:blocks.length,cells,gunIds,specialGunIds:0,idWarning:'get/sheet 未返回可解析单元格，已回退改枪码读取；已从腾讯文档原始数据解析 ID（网址使用）',debugDownloaded:false,idHeader,specialHeader,idParsed:ids.length};
  }


  // 腾讯文档 related_sheet 中的“ID（网址使用）”不是普通文本，而是紧随“（网址使用）”列定义的一串 IEEE-754 double 单元格值。
  // 例如当前文档第一批记录为 7803、7798、7803……；直接从解压后的原始字节解析，避免 get/sheet 接口结构变化。
  function extractIdColumn(rawParts, text, maxCount) {
    const markers = [new TextEncoder().encode('（网址使用）'), new TextEncoder().encode('(网址使用)')];
    const ids = [];
    for (const bytes of rawParts) {
      let scanFrom = 0;
      while (scanFrom < bytes.length && ids.length < maxCount) {
        let pos = -1;
        for (const marker of markers) {
          const p = indexOfBytes(bytes, marker, scanFrom);
          if (p >= 0 && (pos < 0 || p < pos)) pos = p;
        }
        if (pos < 0) break;
        const start = findDoubleRunStart(bytes, pos);
        if (start < 0) { scanFrom = pos + 1; continue; }
        let p = start;
        let run = 0;
        while (p + 11 <= bytes.length && bytes[p] === 0x1a && bytes[p+1] === 0x09 && bytes[p+2] === 0x09) {
          const view = new DataView(bytes.buffer, bytes.byteOffset + p + 3, 8);
          const v = view.getFloat64(0, true);
          if (Number.isFinite(v) && v >= 0 && v <= 100000000 && Math.abs(v - Math.round(v)) < 1e-9) {
            ids.push(String(Math.round(v)));
            run++;
          } else {
            break;
          }
          p += 11;
          if (ids.length >= maxCount) break;
        }
        // Do not stop after the first raw block: Tencent Docs may split the ID column
        // across multiple related_sheet blocks (the previous version stopped early).
        scanFrom = Math.max(p, pos + 1);
        if (!run) scanFrom = pos + 1;
      }
    }
    return ids.slice(0, maxCount);
  }

  function indexOfBytes(haystack, needle, from = 0) {
    outer: for (let i = Math.max(0, from); i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (haystack[i+j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  function findDoubleRunStart(bytes, from) {
    const limit = Math.min(bytes.length - 11, from + 20000);
    for (let i = from; i <= limit; i++) {
      if (bytes[i] !== 0x1a || bytes[i+1] !== 0x09 || bytes[i+2] !== 0x09) continue;
      const v = new DataView(bytes.buffer, bytes.byteOffset + i + 3, 8).getFloat64(0, true);
      if (Number.isFinite(v) && v >= 0 && v <= 100000000 && Math.abs(v - Math.round(v)) < 1e-9) return i;
    }
    return -1;
  }

  function findBlockDatas(obj) {
    const out = [];
    function walk(v) {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v.block_datas)) {
        for (const b of v.block_datas) if (b?.related_sheet) out.push(b);
      }
      if (Array.isArray(v)) v.forEach(walk); else Object.values(v).forEach(walk);
    }
    walk(obj);
    return out;
  }

  async function loadSheetList() {
    if (!DOC_ID) throw new Error('当前页面不是腾讯文档 Sheet 页面');
    const obj = await getJSON(makeUrl(TAB_ID || 'BB08J2', 0, 255, DOC_ID));
    const vars = getVars(obj);
    const h = Array.isArray(vars.header) ? vars.header : [];
    const d = h.find(x => x?.type === 'ms')?.d || [];
    state.sheets = d.filter(x => x && x.id && x.name).map(x => ({ id: x.id, name: x.name, hidden: !!x.hidden }));
    state.selected.clear();
    if (TAB_ID && state.sheets.some(s => s.id === TAB_ID)) state.selected.add(TAB_ID);
    else if (state.sheets[0]) state.selected.add(state.sheets[0].id);
    renderSheets();
    const st = document.getElementById('mw-sync-status');
    if (st) st.textContent = `找到 ${state.sheets.length} 个 Sheet，默认选中当前 Sheet`;
  }

  function inferMode(sheetName) {
    const n = String(sheetName || '');
    if (/全面战场/.test(n)) return '全面战场';
    if (/爆破/.test(n)) return '爆破';
    return '烽火地带';
  }

  async function postSheet(sheet, records) {
    const r = await fetch(LOCAL + '/api/tencent-sync', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ docId: DOC_ID, sheetId: sheet.id, sheetName: sheet.name, mode: inferMode(sheet.name), records })
    });
    if (!r.ok) throw new Error(`本地服务 HTTP ${r.status}`);
    return r.json();
  }


  // ===== v8.3.12 二进制诊断：不要把 related_sheet 直接当 UTF-8 文本 =====
  function hexPreview(bytes, max=4096) {
    const n=Math.min(bytes.length,max), lines=[];
    for(let i=0;i<n;i+=16){
      const chunk=bytes.slice(i,Math.min(i+16,n));
      const hx=Array.from(chunk).map(x=>x.toString(16).padStart(2,'0')).join(' ');
      const ascii=Array.from(chunk).map(x=>(x>=32&&x<127)?String.fromCharCode(x):'.').join('');
      lines.push(i.toString(16).padStart(8,'0')+'  '+hx.padEnd(47,' ')+'  '+ascii);
    }
    if(bytes.length>max) lines.push(`……仅显示前 ${max} bytes；实际 ${bytes.length} bytes`);
    return lines.join('\n');
  }

  function printableUtf8Runs(bytes, minLen=3, maxItems=500) {
    const text=new TextDecoder('utf-8',{fatal:false}).decode(bytes);
    const out=[]; const re=/[\u0020-\u007e\u00a0-\uffff]{'+minLen+',}/g; let m;
    while((m=re.exec(text)) && out.length<maxItems){
      const x=m[0].replace(/[\u0000-\u001f\u007f]/g,' ').trim();
      if(x) out.push(x);
    }
    return [...new Set(out)];
  }

  function readVarint(bytes,pos){
    let v=0n, shift=0n, p=pos;
    for(let i=0;i<10 && p<bytes.length;i++,p++){
      const b=bytes[p]; v|=BigInt(b&0x7f)<<shift;
      if(!(b&0x80)) return {value:v,next:p+1};
      shift+=7n;
    }
    return null;
  }

  function looksTextBytes(a){
    if(!a.length) return false;
    let printable=0, zero=0;
    for(const b of a){ if(b===0) zero++; if((b>=32&&b<127)||b>=0x80) printable++; }
    return printable/a.length>.72 && zero/a.length<.15;
  }

  function decodeProto(bytes, maxDepth=2, maxFields=3000){
    const lines=[]; let count=0;
    function parse(buf,base,depth,label){
      if(depth>maxDepth || count>=maxFields) return;
      let p=0;
      while(p<buf.length && count<maxFields){
        const key=readVarint(buf,p); if(!key) break; p=key.next;
        const k=Number(key.value), field=Math.floor(k/8), wire=k%8;
        if(field<=0 || field>536870911 || ![0,1,2,5].includes(wire)) break;
        count++;
        if(wire===0){
          const v=readVarint(buf,p); if(!v) break; p=v.next;
          lines.push('  '.repeat(depth)+`${label} field=${field} wire=0 varint=${v.value.toString()}`);
        }else if(wire===1){
          if(p+8>buf.length) break;
          const dv=new DataView(buf.buffer,buf.byteOffset+p,8);
          const le=dv.getFloat64(0,true);
          lines.push('  '.repeat(depth)+`${label} field=${field} wire=1 fixed64=0x${Array.from(buf.slice(p,p+8)).map(x=>x.toString(16).padStart(2,'0')).join('')} float64LE=${Number.isFinite(le)?le:'NaN'}`);
          p+=8;
        }else if(wire===5){
          if(p+4>buf.length) break;
          const dv=new DataView(buf.buffer,buf.byteOffset+p,4);
          const le=dv.getFloat32(0,true);
          lines.push('  '.repeat(depth)+`${label} field=${field} wire=5 fixed32=0x${Array.from(buf.slice(p,p+4)).map(x=>x.toString(16).padStart(2,'0')).join('')} float32LE=${Number.isFinite(le)?le:'NaN'}`);
          p+=4;
        }else if(wire===2){
          const len=readVarint(buf,p); if(!len) break; p=len.next;
          const n=Number(len.value); if(!Number.isSafeInteger(n)||n<0||p+n>buf.length) break;
          const sub=buf.slice(p,p+n); p+=n;
          const txt=new TextDecoder('utf-8',{fatal:false}).decode(sub).replace(/[\u0000-\u001f\u007f]/g,'');
          const clean=txt.length>240?txt.slice(0,240)+'…':txt;
          lines.push('  '.repeat(depth)+`${label} field=${field} wire=2 len=${n}${looksTextBytes(sub)?` text=${JSON.stringify(clean)}`:''}`);
          if(depth<maxDepth && !looksTextBytes(sub) && n>=2 && n<=200000) parse(sub,base+p-n,depth+1,label+`.f${field}`);
        }
      }
    }
    parse(bytes,0,0,'root');
    if(count>=maxFields) lines.push(`……达到字段输出上限 ${maxFields}`);
    return lines.join('\n');
  }

  // v8.3.17：直接按实际 HEX 结构扫描 field=4（0x22）单元格记录。
  // 诊断数据已经证明真实记录形态类似：
  //   22 <len> 08 01 12 <n> 08 <row> 10 <col> 1a ...
  // 之前的通用递归 protobuf 解析器因为入口层级/字段类型假设不准确，导致候选数量一直为 0。
  // 这一版不再依赖“field=4 必须从通用 schema 递归找到”，而是直接定位 0x22 记录并解析其 payload。
  function parseProtoFieldsLoose(buf){
    const out=[]; let p=0;
    function vi(pos){
      let v=0n,shift=0n;
      for(let i=0;i<10 && pos<buf.length;i++){
        const b=buf[pos++]; v|=BigInt(b&127)<<shift;
        if(!(b&128)) return {value:v,next:pos};
        shift+=7n;
      }
      return null;
    }
    while(p<buf.length){
      const k=vi(p); if(!k) break; p=k.next;
      const key=Number(k.value), f=Math.floor(key/8), w=key%8;
      if(f<=0 || f>536870911) break;
      if(w===0){ const x=vi(p); if(!x) break; p=x.next; out.push({f,w,v:x.value}); }
      else if(w===1){ if(p+8>buf.length) break; out.push({f,w,b:buf.slice(p,p+8)}); p+=8; }
      else if(w===5){ if(p+4>buf.length) break; out.push({f,w,b:buf.slice(p,p+4)}); p+=4; }
      else if(w===2){ const n=vi(p); if(!n) break; p=n.next; const len=Number(n.value); if(!Number.isSafeInteger(len)||len<0||p+len>buf.length) break; out.push({f,w,b:buf.slice(p,p+len)}); p+=len; }
      else break;
    }
    return out;
  }

  function extractNestedValues(buf, depth=0, texts=[], numbers=[]){
    if(depth>12 || !buf?.length) return;
    const td=new TextDecoder('utf-8',{fatal:false});
    for(const x of parseProtoFieldsLoose(buf)){
      if(x.w===1 && x.b.length===8){
        const v=new DataView(x.b.buffer,x.b.byteOffset,8).getFloat64(0,true);
        if(Number.isFinite(v) && Math.abs(v)<1e15) numbers.push(v);
      }else if(x.w===2){
        if(x.b.length<=1000){
          const s=td.decode(x.b);
          if(s && !s.includes('\ufffd') && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)){
            const clean=s.trim();
            if(clean && clean.length<=500){
              let good=0; for(const c of clean){const n=c.charCodeAt(0);if((n>=32&&n<127)||n>=0x3000)good++;}
              if(good/Math.max(1,clean.length)>=.9 && !/^Microsoft YaHei$/i.test(clean)) texts.push(clean);
            }
          }
        }
        if(x.b.length>=2 && x.b.length<50000) extractNestedValues(x.b,depth+1,texts,numbers);
      }
    }
  }

  function directCellRecordScan(bytes, maxItems=10000){
    const out=[]; const seen=new Set();
    function vi(pos){
      let v=0n,shift=0n;
      for(let i=0;i<10 && pos<bytes.length;i++){
        const b=bytes[pos++]; v|=BigInt(b&127)<<shift;
        if(!(b&128)) return {value:v,next:pos};
        shift+=7n;
      }
      return null;
    }
    // 0x22 是 protobuf field=4 的 key。逐字节定位，避免上一版通用 parser 的层级假设。
    for(let i=0;i<bytes.length-2 && out.length<maxItems;i++){
      if(bytes[i]!==0x22) continue;
      const ln=vi(i+1); if(!ln) continue;
      const len=Number(ln.value), start=ln.next, end=start+len;
      if(!Number.isSafeInteger(len)||len<6||end>bytes.length) continue;
      const payload=bytes.slice(start,end);
      const fs=parseProtoFieldsLoose(payload);
      const outerType=fs.find(x=>x.f===1&&x.w===0);
      const posField=fs.find(x=>x.f===2&&x.w===2);
      if(!outerType || outerType.v!==1n || !posField) continue;
      const posFields=parseProtoFieldsLoose(posField.b);
      const rr=posFields.find(x=>x.f===1&&x.w===0);
      const cc=posFields.find(x=>x.f===2&&x.w===0);
      if(!rr || !cc) continue;
      const row=Number(rr.v), col=Number(cc.v);
      if(!Number.isSafeInteger(row)||!Number.isSafeInteger(col)||row<0||col<0||row>10000||col>1000) continue;
      const texts=[],numbers=[]; extractNestedValues(payload,0,texts,numbers);
      const uniqTexts=[...new Set(texts)].filter(x=>x!=='FF000000');
      const uniqNums=[...new Set(numbers)];
      const key=row+'|'+col+'|'+len+'|'+uniqTexts.join('|')+'|'+uniqNums.join(',');
      if(seen.has(key)) continue; seen.add(key);
      out.push({row,col,len,texts:uniqTexts.slice(0,30),numbers:uniqNums.slice(0,30),offset:i});
    }
    out.sort((a,b)=>a.row-b.row||a.col-b.col||a.offset-b.offset);
    return out;
  }

  function formatHumanCellCandidates(bytes){
    const a=directCellRecordScan(bytes), lines=[
      '=== v8.3.17：field=4（0x22）范围/格式记录候选（不视为真实单元格） ===',
      '候选数量：'+a.length,
      '说明：12 字段中的两个 varint 在本结构中表现为连续范围/位置；文本/Float64 为 payload 内的格式值，不代表真实表格行列。',''
    ];
    for(const x of a){
      lines.push(`ROW=${x.row}  COL=${x.col}  payload=${x.len} bytes  offset=0x${x.offset.toString(16)}`);
      if(x.texts.length) lines.push('  文本：'+x.texts.map(t=>JSON.stringify(t)).join(' | '));
      if(x.numbers.length) lines.push('  Float64：'+x.numbers.join(' | '));
    }
    return lines.join('\n');
  }

  function summarizeObject(obj,maxLines=700){
    const lines=[]; const seen=new WeakSet();
    function walk(v,path,depth){
      if(lines.length>=maxLines || depth>6) return;
      if(v===null || v===undefined){lines.push(`${path}: ${v}`);return;}
      if(typeof v!=='object'){ const s=String(v); lines.push(`${path}: ${s.length>300?s.slice(0,300)+'…':s}`);return; }
      if(seen.has(v)){lines.push(`${path}: [Circular/Seen]`);return;} seen.add(v);
      if(Array.isArray(v)){
        lines.push(`${path}: [Array len=${v.length}]`);
        for(let i=0;i<Math.min(v.length,20);i++) walk(v[i],`${path}[${i}]`,depth+1);
        if(v.length>20) lines.push(`${path}: … ${v.length-20} more items`);
      }else{
        const keys=Object.keys(v); lines.push(`${path}: {keys=${keys.length}}`);
        for(const k of keys.slice(0,60)) walk(v[k],`${path}.${k}`,depth+1);
        if(keys.length>60) lines.push(`${path}: … ${keys.length-60} more keys`);
      }
    }
    walk(obj,'root',0); return lines.join('\n');
  }

  function showRawDialog(title, payload) {
    const old = document.getElementById('mw-raw-dialog');
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'mw-raw-dialog';
    box.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:2147483647;font-family:Arial,'Microsoft YaHei',sans-serif">
        <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1100px,94vw);height:min(760px,90vh);background:#101522;color:#e8ecf5;border:1px solid #3d4868;border-radius:14px;box-shadow:0 24px 90px rgba(0,0,0,.65);display:flex;flex-direction:column;overflow:hidden">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #2c354d">
            <div><b style="font-size:16px">腾讯文档原始解码数据</b><div style="font-size:11px;color:#7f8ba9;margin-top:3px">这里只观察腾讯接口解码后的数据，不写入 data/tx，不修改现有同步结果</div></div>
            <div style="display:flex;gap:8px;align-items:center">
              <button id="mw-raw-copy" style="padding:7px 11px;border:1px solid #465b8a;background:#18233d;color:#c6d8ff;border-radius:7px;cursor:pointer">复制全部</button>
              <button id="mw-raw-download" style="padding:7px 11px;border:1px solid #465b8a;background:#18233d;color:#c6d8ff;border-radius:7px;cursor:pointer">下载诊断 TXT</button>
              <button id="mw-raw-close" style="padding:5px 10px;border:0;background:transparent;color:#aaa;font-size:22px;cursor:pointer">×</button>
            </div>
          </div>
          <pre id="mw-raw-content" style="flex:1;margin:0;padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-all;font:12px/1.55 Consolas,'Microsoft YaHei',monospace;color:#c9d2e8"></pre>
        </div>
      </div>`;
    document.body.appendChild(box);
    const content = box.querySelector('#mw-raw-content');
    content.textContent = payload;
    box.querySelector('#mw-raw-close').onclick = () => box.remove();
    box.querySelector('#mw-raw-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(payload); toast('原始数据已复制'); }
      catch(e) { toast('复制失败，请手动选择文本', true); }
    };
    box.querySelector('#mw-raw-download').onclick = () => {
      const blob = new Blob([payload], {type:'text/plain;charset=utf-8'});
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = '腾讯文档原始解码诊断.txt'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      toast('诊断 TXT 已生成');
    };
  }

  function rowsToDiagnosticText(rows, maxRows = 300) {
    const dense = rows.map(r => {
      const a=[]; if(r) for(const [k,v] of Object.entries(r)) a[Number(k)] = v; return a;
    });
    const lines=[];
    lines.push('=== get/sheet 解码后的二维单元格数据 ===');
    lines.push('说明：下面每一行对应腾讯文档接口解码后的行；[列号] 内容');
    lines.push('总行数：' + dense.length);
    lines.push('');
    for(let i=0;i<Math.min(dense.length,maxRows);i++){
      const r=dense[i]||[];
      const cells=[];
      for(let j=0;j<r.length;j++){
        if(r[j]===undefined || r[j]===null || String(r[j]).trim()==='') continue;
        cells.push(`[${j}] ${JSON.stringify(r[j])}`);
      }
      if(cells.length) lines.push(`ROW ${i}\n  ${cells.join('\n  ')}`);
    }
    if(dense.length>maxRows) lines.push(`\n……仅显示前 ${maxRows} 行；实际 ${dense.length} 行`);
    return lines.join('\n');
  }

  async function diagnoseSelectedSheet() {
    const selected = state.sheets.filter(s => state.selected.has(s.id));
    if(selected.length!==1){ toast('原始诊断请只选择一个 Sheet', true); return; }
    const sheet = selected[0];
    try {
      log(`🔎 ${sheet.name}：正在读取腾讯原始结构…`);
      const first = await getJSON(makeUrl(sheet.id,0,255,DOC_ID));
      const vars = getVars(first);
      const maxRow = Number(vars.maxRow??0), maxCol = Number(vars.maxCol??45);
      const meta = {globalPadId:vars.globalPadId||'', rev:vars.rev||''};
      const parts=[];
      parts.push(`Sheet: ${sheet.name}`);
      parts.push(`Sheet ID: ${sheet.id}`);
      parts.push(`文档 ID: ${DOC_ID}`);
      parts.push(`maxRow=${maxRow}, maxCol=${maxCol}`);
      parts.push('');
      parts.push('=== ① opendoc 返回 JSON 结构摘要 ===');
      parts.push(summarizeObject(first));
      parts.push('');

      // get/sheet：保留当前解析结果，同时输出真实 JSON 结构摘要，方便修正 findCellMapDeep。
      const allRows=[]; let cells=0; let chunks=0;
      for(let start=0;start<=maxRow;start+=256){
        const end=Math.min(start+255,maxRow);
        const obj=await getSheetChunk(sheet,start,end,meta);
        parts.push(`\n=== ② get/sheet ${start}-${end} JSON 结构摘要 ===`);
        parts.push(summarizeObject(obj,500));
        const p=parseCellMap(obj,maxCol,start);
        if(p.cellCount){ cells+=p.cellCount; chunks++; p.rows.forEach((r,i)=>{if(r)allRows[i]=Object.assign(allRows[i]||{},r);}); }
      }
      parts.push(`\nget/sheet 当前解析结果：chunks=${chunks}, cells=${cells}, rows=${allRows.length}`);
      parts.push(rowsToDiagnosticText(allRows));

      // v8.3.17：重点检查 initialAttributedText.workbook。
      // v8.3.17 的 0x22 记录已确认更像“格式/范围”记录：
      // 其 12 字段中的两个 varint 会形成连续的起止位置（例如 48/48、48/49、52/56），
      // 而不是 maxRow=283、maxCol=45 意义上的真实单元格坐标。
      // 因此本版不再把 0x22 候选当作单元格；改为直接解压 workbook，
      // 检查真正的工作簿载荷中是否存在单元格文本、改枪码、二维位置等信息。
      const workbookB64s = [];
      const seenWorkbook = new Set();
      function collectWorkbook(v){
        if(!v || typeof v!=='object') return;
        if(Array.isArray(v)) { v.forEach(collectWorkbook); return; }
        for(const [k,val] of Object.entries(v)){
          if(k==='workbook' && typeof val==='string' && val.length>100 && !seenWorkbook.has(val)){
            seenWorkbook.add(val); workbookB64s.push(val);
          }
          if(val && typeof val==='object') collectWorkbook(val);
        }
      }
      collectWorkbook(first);
      if(workbookB64s.length){
        let wbNo=0;
        for(const b64 of workbookB64s){
          try{
            const z=await inflateBase64(b64);
            wbNo++;
            parts.push(`\n\n=== ③ initialAttributedText.workbook #${wbNo} ===`);
            parts.push(`压缩后 Base64 长度：${b64.length}`);
            parts.push(`解压后字节数：${z.bytes.length}`);
            parts.push('\n--- HEX 前 4096 bytes ---');
            parts.push(hexPreview(z.bytes,4096));
            parts.push('\n--- 可打印 UTF-8 字符串片段 ---');
            const runs=printableUtf8Runs(z.bytes,2,1200);
            parts.push(runs.length?runs.map((x,i)=>`[${i}] ${x}`).join('\n'):'（没有识别到可打印字符串）');
            parts.push('\n--- 改枪码/中文关键字直接扫描 ---');
            const wbText=z.text;
            const codeMatches=[...wbText.matchAll(/[^\x00-\x1F\x7F]{1,120}-烽火地带-[A-Z0-9]{10,}/g)].map(m=>m[0]).slice(0,100);
            const keyMatches=[...wbText.matchAll(/(?:改枪码|价格|弹夹|备注|控枪编号|ID（网址使用）|特殊子弹ID|新兵|标准|精锐|特种|定制)/g)].map(m=>m[0]);
            parts.push('改枪码候选数量：'+codeMatches.length);
            if(codeMatches.length) parts.push(codeMatches.map((x,i)=>`[${i}] ${x}`).join('\n'));
            parts.push('表头/等级关键字命中数量：'+keyMatches.length);
            if(keyMatches.length) parts.push([...new Set(keyMatches)].join(' | '));
            parts.push('\n--- Protobuf-like 顶层字段摘要 ---');
            parts.push(decodeProto(z.bytes,5,6000));
          }catch(e){
            parts.push(`\n=== initialAttributedText.workbook #${wbNo+1} 解压/解析失败 ===\n${e.stack||e.message||e}`);
          }
        }
      }else{
        parts.push('\n=== ③ initialAttributedText.workbook ===\n没有找到 workbook Base64');
      }

      // related_sheet：这是二进制 protobuf-like 数据。v8.3.17 的 0x22 扫描仅作为格式诊断，
      // 本版明确标记为“范围/格式候选”，不再把它命名为单元格。

      const blocks=findBlockDatas(first); let rawNo=0;
      for(const b of blocks){
        if(!b?.related_sheet) continue;
        try{
          const z=await inflateBase64(b.related_sheet);
          rawNo++;
          parts.push(`\n\n=== ④ related_sheet #${rawNo} 二进制信息 ===`);
          parts.push(`压缩后 Base64 长度：${String(b.related_sheet).length}`);
          parts.push(`解压后字节数：${z.bytes.length}`);
          parts.push('\n--- HEX 前 4096 bytes ---');
          parts.push(hexPreview(z.bytes,4096));
          parts.push('\n--- 可打印 UTF-8 字符串片段 ---');
          const runs=printableUtf8Runs(z.bytes,3,800);
          parts.push(runs.length?runs.map((x,i)=>`[${i}] ${x}`).join('\n'):'（没有识别到可打印字符串）');
          parts.push('\n--- Protobuf-like 字段解析（仅诊断，不代表最终 schema） ---');
          parts.push(decodeProto(z.bytes,6,12000));
          parts.push('\n--- 人类可读单元格候选（重点看这里） ---');
          parts.push(formatHumanCellCandidates(z.bytes));
        }catch(e){ parts.push(`\n=== related_sheet #${rawNo+1} 解压/解析失败 ===\n${e.stack||e.message||e}`); }
      }
      if(!rawNo) parts.push('\n=== ④ related_sheet ===\n没有找到 block_datas.related_sheet');

      const payload=parts.join('\n');
      showRawDialog(sheet.name, payload);
      log(`  ✓ 二进制诊断完成：maxRow=${maxRow}, maxCol=${maxCol}, get/sheet cells=${cells}, related_sheet=${rawNo} 块`);
    }catch(e){
      console.error(e);
      log(`❌ 原始结构诊断失败：${e.message||e}`);
      toast('原始结构诊断失败：'+(e.message||e),true);
    }
  }

  async function resetTencentData() {
    if (!confirm('确定清空本地所有腾讯同步数据吗？\n\n只会删除 data/tx/ 下的腾讯同步数据，不会影响手动新增、收藏和无效记录。\n清空后请重新选择Sheet并点击“开始同步”。')) return;
    try {
      const r = await fetch(LOCAL + '/api/tencent-sync/reset', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.err || ('HTTP ' + r.status));
      log(`🧹 已清空腾讯同步数据：${j.files || 0} 个文件，${j.records || 0} 条记录`);
      toast('已清空腾讯同步数据，可以重新同步');
    } catch (e) {
      console.error(e);
      toast('清空失败：' + (e.message || e), true);
    }
  }

  async function start() {
    if (state.running) return;
    const selected = state.sheets.filter(s => state.selected.has(s.id));
    if (!selected.length) { toast('请至少选择一个 Sheet', true); return; }
    state.running = true;
    const btn = document.getElementById('mw-sync-start');
    btn.disabled = true; btn.style.opacity = '.55';
    try {
      let total = 0, added = 0, updated = 0, duplicate = 0;
      for (const sheet of selected) {
        log(`▶ ${sheet.name}：读取中…`);
        const data = await loadSheet(sheet);
        log(`  读取 ${data.records.length} 条改枪码，${data.cells || 0} 个单元格；普通压枪ID ${data.gunIds || 0} 条；特殊子弹ID ${data.specialGunIds || 0} 条`); if (data.idWarning) log(`  ⚠ ${data.idWarning}`); if (data.false) log(`  📄 原始数据诊断已保存；ID列检测：${data.idHeader ? '有' : '无'}；特殊子弹ID列：${data.specialHeader ? '有' : '无'}；原始ID解析 ${data.idParsed || 0} 条`);
        const r = await postSheet(sheet, data.records);
        total += Number(r.total || 0); added += Number(r.added || 0); updated += Number(r.updated || 0); duplicate += Number(r.duplicate || 0);
        log(`  ✓ 新增 ${r.added || 0}，更新 ${r.updated || 0}，重复 ${r.duplicate || 0}`);
      }
      log(`\n✅ 同步完成：共 ${total} 条；新增 ${added}；更新 ${updated}；重复 ${duplicate}`);
      const st = document.getElementById('mw-sync-status');
      if (st) st.textContent = `同步完成：新增 ${added}，更新 ${updated}，重复 ${duplicate}`;
      toast('同步完成，可以回到魔王S工具刷新数据');
    } catch (e) {
      console.error(e);
      log(`❌ ${e.message || e}`);
      const st = document.getElementById('mw-sync-status');
      if (st) st.textContent = '同步失败，请看下方日志';
      toast('同步失败：' + (e.message || e), true);
    } finally {
      state.running = false;
      btn.disabled = false; btn.style.opacity = '1';
    }
  }

  window.__MAOWANGS_TENCENT_SYNC__ = { open: async () => { panel(); try { await loadSheetList(); } catch(e) { log('❌ ' + e.message); toast(e.message, true); } } };
  window.__MAOWANGS_TENCENT_SYNC__.open();
})();
