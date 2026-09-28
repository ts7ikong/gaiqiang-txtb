/*
 * 魔王S 腾讯文档同步助手 v9.0.0
 *
 * 数据链路：opendoc -> block_datas[].related_sheet(Base64) -> zlib 解压 -> Protobuf -> 单元格网格 -> 业务记录
 * 字段号为逆向观察所得，与 TencentSheetParser.java 保持一致：
 *   根 1 -> 5 -> 19 为表体；表体中 5=值池，6=单元格(重复)
 *   值池：1=字符串 {1:string}，3=数字 {1:fixed64 double}
 *   单元格：1=行(0 时省略) 2=列(0 时省略) 3=内容 {1:类型(4文本/2数字), 2:{1:值索引(0 时省略)}}
 *
 * 不读取、不上传 Cookie；请求使用当前腾讯文档页面的登录态。
 */
(() => {
  'use strict';

  // =====================================================================
  // 解析器：纯函数，不依赖 DOM，可以直接在 Node 中单测
  // =====================================================================
  const Parser = (() => {
    const td = new TextDecoder('utf-8');
    // 改枪码：枪名-模式-编码，枪名部分懒惰匹配，允许 AS-VAL 这类自带横杠的名字
    const CODE_RE = /(\S.*?)-(烽火地带|全面战场|爆破)-([A-Z0-9]{10,})/;
    const CODE_RE_G = /([^\x00-\x1F\x7F\s\uFFFD][^\x00-\x1F\x7F\uFFFD]{0,99}?)-(烽火地带|全面战场|爆破)-([A-Z0-9]{10,})/g;

    // ---------- Protobuf 读取 ----------

    // varint 用乘法累加，避免超过 32 位时 JS 位运算溢出
    function readVarint(b, p) {
      let r = 0, mul = 1;
      for (let i = 0; i < 10; i++) {
        if (p.i >= b.length) throw new Error('varint 越界');
        const c = b[p.i++];
        r += (c & 0x7f) * mul;
        if (!(c & 0x80)) return r;
        mul *= 128;
      }
      throw new Error('varint 过长');
    }

    function take(b, p, n) {
      if (n < 0 || p.i + n > b.length) throw new Error('长度越界');
      const out = b.subarray(p.i, p.i + n);
      p.i += n;
      return out;
    }

    /** 读取一层消息的全部字段：[{no, wire, varint, bytes}] */
    function readFields(b) {
      const list = [];
      const p = { i: 0 };
      while (p.i < b.length) {
        const tag = readVarint(b, p);
        const f = { no: Math.floor(tag / 8), wire: tag % 8, varint: 0, bytes: null };
        switch (f.wire) {
          case 0: f.varint = readVarint(b, p); break;
          case 1: f.bytes = take(b, p, 8); break;
          case 5: f.bytes = take(b, p, 4); break;
          case 2: f.bytes = take(b, p, readVarint(b, p)); break;
          default: throw new Error('不支持的 wire type: ' + f.wire);
        }
        list.push(f);
      }
      return list;
    }

    /** 取第一个指定字段号的 bytes（空消息返回长度为 0 的数组，不是 null） */
    function first(msg, no) {
      if (!msg) return null;
      for (const f of readFields(msg)) if (f.no === no && f.bytes) return f.bytes;
      return null;
    }

    function firstVarint(msg, no) {
      for (const f of readFields(msg)) if (f.no === no && f.wire === 0) return f.varint;
      return null;
    }

    // ---------- 数据块 -> 网格 ----------

    /**
     * 解析一个解压后的 related_sheet，把值写入 grid(Map<row, Map<col, value>>)
     * 返回写入的单元格数量
     */
    function parseBlock(raw, grid) {
      const body = first(first(first(raw, 1), 5), 19);
      if (!body) return 0;

      // 值池：字符串和数字分两个列表
      const strs = [], nums = [];
      const pool = first(body, 5);
      if (pool) {
        for (const f of readFields(pool)) {
          if (!f.bytes) continue;
          const v = first(f.bytes, 1);
          if (f.no === 1) strs.push(v ? td.decode(v) : '');
          if (f.no === 3) nums.push(v && v.length === 8 ? new DataView(v.buffer, v.byteOffset, 8).getFloat64(0, true) : 0);
        }
      }

      // 先收集单元格引用，再统一换算数字索引
      const refs = [];
      let minNumIdx = Infinity;
      for (const cf of readFields(body)) {
        if (cf.no !== 6 || !cf.bytes) continue;
        let row = 0, col = 0, content = null;
        for (const f of readFields(cf.bytes)) {
          if (f.no === 1 && f.wire === 0) row = f.varint;
          else if (f.no === 2 && f.wire === 0) col = f.varint;
          else if (f.no === 3 && f.bytes) content = f.bytes;
        }
        if (!content) continue;
        let type = -1, idx = -1;
        for (const f of readFields(content)) {
          if (f.no === 1 && f.wire === 0) type = f.varint;
          else if (f.no === 2 && f.bytes) {
            const i = firstVarint(f.bytes, 1);
            idx = i == null ? 0 : i;            // 空消息表示索引 0
          }
        }
        if (idx < 0) continue;                  // 只有样式没有值
        if (type === 2) minNumIdx = Math.min(minNumIdx, idx);
        refs.push([row, col, type, idx]);
      }

      let count = 0;
      for (const [row, col, type, idx] of refs) {
        let val = null;
        if (type === 4) {
          val = idx < strs.length ? strs[idx] : null;          // 文本索引从 0 开始
        } else if (type === 2) {
          const i = idx - minNumIdx;                          // 数字索引带偏移，按块内最小值归零
          val = i >= 0 && i < nums.length ? nums[i] : null;
        }
        if (val == null) continue;
        if (!grid.has(row)) grid.set(row, new Map());
        grid.get(row).set(col, val);
        count++;
      }
      return count;
    }

    // ---------- 网格 -> 业务记录 ----------

    function norm(s) {
      return String(s ?? '').replace(/[\u00a0\u3000]/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    }

    function cellText(v) {
      if (v == null) return '';
      if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
      return norm(v);
    }

    /** Excel 序列号转日期字符串 YYYY/M/D（与查询页 dateVal 解析规则一致） */
    function serialToDate(serial) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
      return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    }

    function toId(v) {
      if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? String(Math.round(v)) : '';
      const s = cellText(v).replace(/\.0+$/, '');
      return /^\d+$/.test(s) ? s : '';
    }

    function inferMode(sheetName) {
      const n = String(sheetName || '');
      if (/全面战场/.test(n)) return '全面战场';
      if (/爆破/.test(n)) return '爆破';
      return '烽火地带';
    }

    /** 按表头关键字定位列；找不到表头时退回 Java 版的固定布局 */
    function detectHeader(rows) {
      for (const [r, cols] of rows.slice(0, 80)) {
        const texts = [...cols].map(([c, v]) => [c, cellText(v)]);
        if (!texts.some(([, t]) => t.includes('改枪码') && !t.includes('更新时间'))) continue;
        const map = {};
        for (const [c, t] of texts) {
          if (!t) continue;
          // 顺序有讲究：“特殊子弹ID”必须先于普通 ID 判断
          if (t.includes('改枪码')) map.code ??= c;
          else if (t.includes('特殊子弹')) map.special ??= c;
          else if (t.includes('网址使用') || t.includes('控枪编号') || /^(ID|编号)$/i.test(t)) map.gunId ??= c;
          else if (t.includes('价格')) map.price ??= c;
          else if (t.includes('弹夹')) map.ammo ??= c;
          else if (t.includes('备注')) map.note ??= c;
          else if (t.includes('日期')) map.date ??= c;
        }
        return { headerRow: r, map };
      }
      return { headerRow: -1, map: { price: 1, note: 2, code: 3, date: 4, gunId: 9 } };
    }

    /** 表头是合并单元格时，数值可能落在表头右侧一列，用前几行数据校正 */
    function fixIdColumn(rows, headerRow, col) {
      if (col == null) return col;
      const sample = rows.filter(([r]) => r > headerRow).slice(0, 15);
      let cur = 0, next = 0;
      for (const [, cols] of sample) {
        if (toId(cols.get(col))) cur++;
        if (toId(cols.get(col + 1))) next++;
      }
      return next > cur ? col + 1 : col;
    }

    function gridToRecords(grid, sheetName) {
      const rows = [...grid.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([r, cols]) => [r, new Map([...cols].sort((a, b) => a[0] - b[0]))]);
      const { headerRow, map } = detectHeader(rows);
      map.gunId = fixIdColumn(rows, headerRow, map.gunId);
      map.special = fixIdColumn(rows, headerRow, map.special);

      // 表格顶部的“改枪码更新时间”作为没有日期列时的默认日期
      let defaultDate = '';
      for (const [, cols] of rows.slice(0, 15)) {
        for (const v of cols.values()) {
          const m = cellText(v).match(/改枪码更新时间\s*[:：]?\s*(\d{1,2})[./月](\d{1,2})/);
          if (m) { defaultDate = `${new Date().getFullYear()}/${+m[1]}/${+m[2]}`; break; }
        }
        if (defaultDate) break;
      }

      const out = [];
      const seen = new Set();
      let category = '';
      for (const [r, cols] of rows) {
        if (r <= headerRow) continue;
        const get = k => (map[k] == null ? undefined : cols.get(map[k]));

        // 优先读改枪码列，读不到再扫描整行（防止列错位）
        let m = CODE_RE.exec(cellText(get('code')));
        if (!m) {
          for (const v of cols.values()) {
            if (typeof v === 'string' && (m = CODE_RE.exec(norm(v)))) break;
          }
        }

        if (!m) {
          // 分组标题行：整行只有一个文本值（如“M700全自动”“MP5”），后续记录继承该分组
          const vals = [...cols.values()].filter(v => cellText(v));
          if (vals.length === 1 && typeof vals[0] === 'string' && cellText(vals[0]).length <= 40) {
            category = cellText(vals[0]);
          }
          continue;
        }

        const code = m[0].trim();
        if (seen.has(code)) continue;
        seen.add(code);

        const dateRaw = get('date');
        const date = typeof dateRaw === 'number' && dateRaw > 30000 && dateRaw < 80000
          ? serialToDate(dateRaw)
          : (cellText(dateRaw) || defaultDate);

        out.push({
          row: r,
          code,
          gunNameRaw: m[1].replace(/^\d+/, '').trim(),
          mode: m[2],
          category,
          price: cellText(get('price')),     // 制式套这里就是等级名，保持原样，查询页 isZhishi 能识别
          ammo: cellText(get('ammo')),
          note: cellText(get('note')),
          date,
          gunId: toId(get('gunId')),
          specialGunId: toId(get('special')),
          sheet: sheetName
        });
      }
      return out;
    }

    /**
     * 新版腾讯文档结构兜底：不依赖固定 field 号，递归读取 Protobuf 中的“叶子值”。
     * 当前 related_sheet 的真实结构里，业务表格经常表现为：
     *   .../children/N/children/0 = 改枪码
     *   .../children/N/children/1 = 价格
     *   .../children/N/children/2 = 弹夹
     *   .../children/N/children/3 = 备注
     * 但这些字段外层并不是稳定的 row/col message，因此旧 parseBlock 会得到 0 cell。
     * 这里保留值的遍历顺序，再按“下一个改枪码”切分记录。
     */
    function isUsefulLeafString(s) {
      s = String(s ?? '');
      if (!s) return false;
      if (s.length > 1200) return false;
      for (const ch of s) {
        const n = ch.charCodeAt(0);
        if (n < 32 && ch !== '\n' && ch !== '\r' && ch !== '\t') return false;
      }
      return /[\u4e00-\u9fffA-Za-z0-9]/.test(s);
    }

    function readLeafSequence(raw) {
      const seq = [];
      function walk(buf, path, depth) {
        if (depth > 40 || !buf || !buf.length) return;
        let fs;
        try { fs = readFields(buf); } catch { return; }
        let fi = 0;
        for (const f of fs) {
          const p = path.concat(fi++);
          if (f.wire === 2 && f.bytes) {
            let s = '';
            try { s = td.decode(f.bytes); } catch {}
            if (isUsefulLeafString(s) && !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(s)) {
              seq.push({ path: p, type: 'text', value: s });
            } else {
              walk(f.bytes, p, depth + 1);
            }
          } else if (f.wire === 1 && f.bytes?.length === 8) {
            try {
              const n = new DataView(f.bytes.buffer, f.bytes.byteOffset, 8).getFloat64(0, true);
              if (Number.isFinite(n) && Math.abs(n) < 1e12) seq.push({ path: p, type: 'number', value: n });
            } catch {}
          }
        }
      }
      walk(raw, [], 0);
      return seq;
    }

    function cleanSequenceText(s) {
      return norm(String(s ?? '').replace(/^[\r\n\t ]+/, ''));
    }

    function sequenceFallback(rawBlocks, sheetName) {
      const seq = [];
      for (const raw of rawBlocks) seq.push(...readLeafSequence(raw));

      const out = [];
      const seen = new Set();
      let category = '';
      let current = null;
      const flush = () => {
        if (!current) return;
        if (!current.price && current.values.length) {
          const price = current.values.find(v => typeof v === 'string' && /^\d+(?:\.\d+)?w$/i.test(v));
          if (price) current.price = price;
        }
        if (!current.ammo && current.values.length) {
          const ammo = current.values.find(v => typeof v === 'string' && /^\d+(?:\+\d+)?发$/.test(v));
          if (ammo) current.ammo = ammo;
        }
        if (!current.note && current.values.length) {
          const note = current.values.find(v => typeof v === 'string' && v !== current.price && v !== current.ammo && v.length <= 300);
          if (note) current.note = note;
        }
        const code = current.code;
        if (code && !seen.has(code)) {
          seen.add(code);
          const m = CODE_RE.exec(code);
          out.push({
            row: current.index,
            code,
            gunNameRaw: m ? m[1].replace(/^\d+/, '').trim() : '',
            mode: m ? m[2] : inferMode(sheetName),
            category,
            price: current.price || '',
            ammo: current.ammo || '',
            note: current.note || '',
            date: '', gunId: '', specialGunId: '', sheet: sheetName
          });
        }
        current = null;
      };

      let codeCount = 0;
      for (let i = 0; i < seq.length; i++) {
        const item = seq[i];
        const raw = item.type === 'text' ? cleanSequenceText(item.value) : item.value;
        if (item.type === 'text') {
          const m = CODE_RE.exec(raw);
          if (m) {
            flush();
            const code = m[0].trim();
            current = { index: codeCount++, code, values: [], price: '', ammo: '', note: '' };
            continue;
          }
          // 只有一个短文本、且明显像分组标题时，更新分类；不把定制备注当分类。
          if (!current && raw && raw.length <= 40 && !/[\-]{2,}/.test(raw) && !/^\d/.test(raw)) {
            category = raw;
            continue;
          }
          if (current && raw) current.values.push(raw);
        } else if (current && typeof raw === 'number') {
          // 数字叶子多为日期/ID/图片尺寸等元数据，先不强行映射到 ID，避免污染。
          current.values.push(raw);
        }
      }
      flush();
      return { records: out, sequence: seq.length };
    }

    /** 兜底：protobuf 结构变了时，至少从解压文本里把改枪码捞出来，不丢码 */
    function textFallback(text, sheetName) {
      const out = [], seen = new Set();
      const te = new TextEncoder();
      for (const m of String(text || '').matchAll(CODE_RE_G)) {
        let code = m[0].trim();
        // 解压文本里字符串前面紧挨着 protobuf 长度字节，<128 时会被解码成一个可见字符（如 '3'）。
        // 首字符编码恰好等于剩余部分的 UTF-8 字节数时，判定为长度前缀并去掉；93R 这类真实数字开头的枪名不受影响
        const rest = code.slice(1);
        if (code.charCodeAt(0) === te.encode(rest).length) code = rest;
        if (seen.has(code)) continue;
        seen.add(code);
        const cm = CODE_RE.exec(code);
        out.push({ code, gunNameRaw: cm ? cm[1].trim() : '', mode: m[2], category: '',
          price: '', ammo: '', note: '', date: '', gunId: '', specialGunId: '', sheet: sheetName });
      }
      return out;
    }

    return { readFields, parseBlock, gridToRecords, sequenceFallback, readLeafSequence, textFallback, serialToDate, inferMode, cellText };
  })();

  // Node 单测入口：没有 window 时只导出解析器
  if (typeof window === 'undefined') {
    if (typeof module !== 'undefined') module.exports = Parser;
    return;
  }

  // =====================================================================
  // 页面部分：面板、腾讯接口请求、推送本地服务
  // =====================================================================
  if (window.__MAOWANGS_TENCENT_SYNC__) {
    window.__MAOWANGS_TENCENT_SYNC__.open();
    return;
  }

  const VERSION = '9.0.2';
  const LOCAL = 'http://localhost:8080';
  const PANEL_ID = 'mw-tencent-sync-panel';
  const DOC_ID = (location.pathname.match(/\/sheet\/([^/?]+)/) || [])[1];
  const TAB_ID = new URLSearchParams(location.search).get('tab') || '';
  const state = { sheets: [], selected: new Set(), running: false };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg, bad = false) {
    const el = document.getElementById('mw-sync-toast');
    if (!el) return;
    el.textContent = msg;
    el.style.background = bad ? '#8b1e2d' : '#151a2a';
    el.style.display = 'block';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => (el.style.display = 'none'), 2600);
  }

  function log(msg) {
    const el = document.getElementById('mw-sync-log');
    if (!el) return;
    el.textContent += (el.textContent ? '\n' : '') + msg;
    el.scrollTop = el.scrollHeight;
  }

  function setStatus(msg) {
    const el = document.getElementById('mw-sync-status');
    if (el) el.textContent = msg;
  }

  const BTN = 'padding:8px 12px;border-radius:9px;cursor:pointer;';
  function panel() {
    document.getElementById(PANEL_ID)?.remove();
    const box = document.createElement('div');
    box.id = PANEL_ID;
    box.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483646;font-family:Arial,'Microsoft YaHei',sans-serif">
        <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:540px;max-width:calc(100vw - 30px);max-height:82vh;overflow:auto;background:#15172a;color:#eee;border:1px solid #3b4260;border-radius:16px;box-shadow:0 20px 70px rgba(0,0,0,.5);padding:22px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div style="font-size:20px;font-weight:800">🔄 魔王S 腾讯文档同步 <span style="font-size:12px;color:#697394;font-weight:600">v${VERSION}</span></div>
            <button data-act="close" style="border:0;background:transparent;color:#aaa;font-size:22px;cursor:pointer">×</button>
          </div>
          <div id="mw-sync-status" style="font-size:13px;color:#aeb6d1;margin-bottom:12px">正在读取 Sheet 列表…</div>
          <div style="display:flex;gap:8px;margin-bottom:10px">
            <button data-act="all" style="${BTN}border:1px solid #475078;background:#202640;color:#ddd">全选</button>
            <button data-act="none" style="${BTN}border:1px solid #475078;background:#202640;color:#ddd">全不选</button>
          </div>
          <div id="mw-sync-sheets" style="border:1px solid #303750;border-radius:10px;padding:8px;min-height:80px"></div>
          <div id="mw-sync-log" style="margin-top:12px;white-space:pre-wrap;font-size:12px;line-height:1.6;color:#8992b0;max-height:180px;overflow:auto"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;gap:8px;flex-wrap:wrap">
            <div style="display:flex;gap:8px">
              <button data-act="preview" style="${BTN}border:1px solid #465b8a;background:#18233d;color:#b9d1ff">预览解析结果</button>
              <button data-act="reset" style="${BTN}border:1px solid #7a3042;background:#2a1720;color:#ff9db3">清空腾讯同步数据</button>
            </div>
            <div style="display:flex;gap:10px">
              <button data-act="close" style="${BTN}border:1px solid #3e4662;background:transparent;color:#aaa">关闭</button>
              <button data-act="start" id="mw-sync-start" style="${BTN}border:0;background:linear-gradient(135deg,#ff3366,#ff6b9d);color:#fff;font-weight:800">开始同步</button>
            </div>
          </div>
        </div>
      </div>
      <div id="mw-sync-toast" style="display:none;position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:2147483647;color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.35)"></div>`;
    document.body.appendChild(box);

    // 事件委托，避免给每个按钮单独绑定
    box.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') box.remove();
      else if (act === 'all') { state.sheets.forEach(s => state.selected.add(s.id)); renderSheets(); }
      else if (act === 'none') { state.selected.clear(); renderSheets(); }
      else if (act === 'start') start();
      else if (act === 'preview') preview();
      else if (act === 'reset') resetTencentData();
    });
  }

  function renderSheets() {
    const el = document.getElementById('mw-sync-sheets');
    if (!el) return;
    el.innerHTML = state.sheets.map(s => `
      <label style="display:flex;align-items:center;gap:9px;padding:9px 8px;border-radius:7px;cursor:pointer">
        <input type="checkbox" data-sheet-id="${esc(s.id)}" ${state.selected.has(s.id) ? 'checked' : ''}>
        <span style="flex:1">${esc(s.name)}</span>
        <span style="font-size:11px;color:#68718f">${esc(Parser.inferMode(s.name))} · ${esc(s.id)}</span>
      </label>`).join('');
    el.querySelectorAll('input[data-sheet-id]').forEach(cb => {
      cb.onchange = () => (cb.checked ? state.selected.add(cb.dataset.sheetId) : state.selected.delete(cb.dataset.sheetId));
    });
  }

  // ---------- 腾讯接口 ----------

  function parseCallback(text) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
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

  function makeUrl(tab, start, end) {
    const p = new URLSearchParams({
      tab, u: '', noEscape: '1', enableSmartsheetSplit: '1',
      startrow: String(start), endrow: String(end),
      frozenStartRow: '0', frozenEndRow: '20', needFrozen: '1', needSheetState: '1', sliceStates: '1',
      block_start_col: '0', block_end_col: '63', block_start_row: String(start), block_end_row: String(end),
      id: DOC_ID, normal: '1', outformat: '1', wb: '1', nowb: '0', callback: 'clientVarsCallback'
    });
    const tok = (document.cookie.match(/(?:^|;\s*)TOK=([^;]+)/) || [])[1];
    if (tok) p.set('xsrf', decodeURIComponent(tok));
    p.set('t', Date.now().toString(36));
    return '/dop-api/opendoc?' + p.toString();
  }

  /** Base64 + zlib 解压（数据以 78 01 开头，对应 DecompressionStream 的 deflate 格式） */
  async function inflate(b64) {
    if (!('DecompressionStream' in window)) throw new Error('当前浏览器不支持数据解压，请使用最新版 Edge/Chrome');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** 深度遍历收集所有 block_datas[].related_sheet，用 Set 去重（分段请求可能返回相同块） */
  function collectRelatedSheets(obj, out) {
    const seen = new WeakSet();
    (function walk(v) {
      if (!v || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v.block_datas)) {
        for (const b of v.block_datas) if (typeof b?.related_sheet === 'string') out.add(b.related_sheet);
      }
      (Array.isArray(v) ? v : Object.values(v)).forEach(walk);
    })(obj);
    return out;
  }

  async function loadSheetList() {
    if (!DOC_ID) throw new Error('当前页面不是腾讯文档 Sheet 页面');
    const obj = await getJSON(makeUrl(TAB_ID || 'BB08J2', 0, 255));
    const header = getVars(obj).header;
    const d = (Array.isArray(header) ? header : []).find(x => x?.type === 'ms')?.d || [];
    state.sheets = d.filter(x => x?.id && x?.name).map(x => ({ id: x.id, name: x.name }));
    state.selected.clear();
    if (TAB_ID && state.sheets.some(s => s.id === TAB_ID)) state.selected.add(TAB_ID);
    else if (state.sheets[0]) state.selected.add(state.sheets[0].id);
    renderSheets();
    setStatus(`找到 ${state.sheets.length} 个 Sheet，默认选中当前 Sheet`);
  }

  /** 读取一个 Sheet：分段拉取 -> 解压 -> protobuf 网格 -> 业务记录 */
  async function loadSheet(sheet) {
    const firstResp = await getJSON(makeUrl(sheet.id, 0, 255));
    const maxRow = Number(getVars(firstResp).maxRow ?? 0);
    const blobs = collectRelatedSheets(firstResp, new Set());
    for (let s = 256; s <= maxRow; s += 256) {
      collectRelatedSheets(await getJSON(makeUrl(sheet.id, s, Math.min(s + 255, maxRow))), blobs);
    }

    const grid = new Map();
    const texts = [];
    const td = new TextDecoder('utf-8');
    let cells = 0, errors = 0;
    for (const b64 of blobs) {
      const raw = await inflate(b64);
      try { cells += Parser.parseBlock(raw, grid); }
      catch (e) { errors++; console.warn('[魔王S] 数据块解析失败', e); }
      texts.push(td.decode(raw));
    }

    let records = Parser.gridToRecords(grid, sheet.name);
    let strategy = 'protobuf-grid';
    let sequenceValues = 0;
    if (!records.length) {
      // 新版 related_sheet：先用递归 Protobuf 叶子序列恢复“改枪码→价格→弹夹→备注”。
      const seq = Parser.sequenceFallback([...blobs].map(b64 => null), sheet.name);
      // 上面不能直接把 Base64 当 raw，因此实际序列恢复在下方重新读取 raw。
      records = [];
    }
    if (!records.length) {
      // 重新解压，走结构自适应序列解析；不依赖固定 field 号。
      const raws = [];
      for (const b64 of blobs) raws.push(await inflate(b64));
      const seq = Parser.sequenceFallback(raws, sheet.name);
      records = seq.records;
      sequenceValues = seq.sequence;
      strategy = records.length ? 'protobuf-sequence' : 'text';
    }
    if (!records.length) {
      records = Parser.textFallback(texts.join('\n'), sheet.name);
      strategy = 'text';
    }
    return { records, grid, maxRow, blocks: blobs.size, cells, errors, strategy, sequenceValues };
  }

  /** 按模式分组推送，一个 Sheet 里混了多个模式也能落到正确目录 */
  async function postSheet(sheet, records) {
    const groups = new Map();
    for (const r of records) {
      const mode = r.mode || Parser.inferMode(sheet.name);
      if (!groups.has(mode)) groups.set(mode, []);
      groups.get(mode).push(r);
    }
    const sum = { total: 0, added: 0, updated: 0, duplicate: 0 };
    for (const [mode, list] of groups) {
      const r = await fetch(LOCAL + '/api/tencent-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId: DOC_ID, sheetId: sheet.id, sheetName: sheet.name, mode, records: list })
      });
      if (!r.ok) throw new Error(`本地服务 HTTP ${r.status}`);
      const j = await r.json();
      if (j.ok === false) throw new Error(j.err || '本地服务返回失败');
      for (const k of Object.keys(sum)) sum[k] += Number(j[k] || 0);
    }
    return sum;
  }

  // ---------- 操作 ----------

  async function start() {
    if (state.running) return;
    const selected = state.sheets.filter(s => state.selected.has(s.id));
    if (!selected.length) { toast('请至少选择一个 Sheet', true); return; }
    state.running = true;
    const btn = document.getElementById('mw-sync-start');
    btn.disabled = true; btn.style.opacity = '.55';
    try {
      const sum = { total: 0, added: 0, updated: 0, duplicate: 0 };
      for (const sheet of selected) {
        log(`▶ ${sheet.name}：读取中…`);
        const d = await loadSheet(sheet);
        log(`  数据块 ${d.blocks}，单元格 ${d.cells}，改枪码 ${d.records.length} 条；压枪ID ${d.records.filter(x => x.gunId).length}，特殊子弹ID ${d.records.filter(x => x.specialGunId).length}`);
        if (d.errors) log(`  ⚠ ${d.errors} 个数据块解析失败，详见控制台`);
        if (d.strategy === 'text') log('  ⚠ protobuf 未解析出记录，已退回文本扫描（只有改枪码，无价格/ID）');
        if (!d.records.length) { log('  跳过：没有改枪码'); continue; }
        const r = await postSheet(sheet, d.records);
        for (const k of Object.keys(sum)) sum[k] += r[k];
        log(`  ✓ 新增 ${r.added}，更新 ${r.updated}，重复 ${r.duplicate}`);
      }
      log(`\n✅ 同步完成：共 ${sum.total} 条；新增 ${sum.added}；更新 ${sum.updated}；重复 ${sum.duplicate}`);
      setStatus(`同步完成：新增 ${sum.added}，更新 ${sum.updated}，重复 ${sum.duplicate}`);
      toast('同步完成，回到查询页刷新即可');
    } catch (e) {
      console.error(e);
      log(`❌ ${e.message || e}`);
      setStatus('同步失败，请看下方日志');
      toast('同步失败：' + (e.message || e), true);
    } finally {
      state.running = false;
      btn.disabled = false; btn.style.opacity = '1';
    }
  }

  /** 预览：只解析不写入，输出记录和原始网格，方便核对列映射 */
  async function preview() {
    const selected = state.sheets.filter(s => state.selected.has(s.id));
    if (selected.length !== 1) { toast('预览请只选择一个 Sheet', true); return; }
    const sheet = selected[0];
    try {
      log(`🔎 ${sheet.name}：解析中…`);
      const d = await loadSheet(sheet);
      const lines = [
        `Sheet: ${sheet.name}（${sheet.id}）`,
        `maxRow=${d.maxRow}，数据块=${d.blocks}，单元格=${d.cells}，失败块=${d.errors}，策略=${d.strategy}`,
        '',
        `=== 解析出的记录（${d.records.length} 条） ===`,
        ...d.records.map(r => [
          `R${r.row ?? '-'}`, r.category && `[${r.category}]`, r.code,
          `价格=${r.price}`, `弹夹=${r.ammo}`, `日期=${r.date}`, `ID=${r.gunId}`, `特殊ID=${r.specialGunId}`, `备注=${r.note}`
        ].filter(Boolean).join(' | ')),
        '',
        '=== 原始网格（前 300 行） ==='
      ];
      const rows = [...d.grid.entries()].sort((a, b) => a[0] - b[0]).slice(0, 300);
      for (const [r, cols] of rows) {
        const cells = [...cols].sort((a, b) => a[0] - b[0]).map(([c, v]) => `[${c}] ${JSON.stringify(v)}`);
        lines.push(`ROW ${r}: ${cells.join('  ')}`);
      }
      showTextDialog(`解析预览 - ${sheet.name}`, lines.join('\n'));
      log(`  ✓ 预览完成：${d.records.length} 条`);
    } catch (e) {
      console.error(e);
      log(`❌ 预览失败：${e.message || e}`);
      toast('预览失败：' + (e.message || e), true);
    }
  }

  function showTextDialog(title, text) {
    document.getElementById('mw-raw-dialog')?.remove();
    const box = document.createElement('div');
    box.id = 'mw-raw-dialog';
    box.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:2147483647;font-family:Arial,'Microsoft YaHei',sans-serif">
        <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1100px,94vw);height:min(760px,90vh);background:#101522;color:#e8ecf5;border:1px solid #3d4868;border-radius:14px;display:flex;flex-direction:column;overflow:hidden">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #2c354d">
            <b style="font-size:16px">${esc(title)}</b>
            <div style="display:flex;gap:8px">
              <button data-act="copy" style="${BTN}border:1px solid #465b8a;background:#18233d;color:#c6d8ff">复制全部</button>
              <button data-act="download" style="${BTN}border:1px solid #465b8a;background:#18233d;color:#c6d8ff">下载 TXT</button>
              <button data-act="close" style="border:0;background:transparent;color:#aaa;font-size:22px;cursor:pointer">×</button>
            </div>
          </div>
          <pre style="flex:1;margin:0;padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-all;font:12px/1.55 Consolas,'Microsoft YaHei',monospace;color:#c9d2e8"></pre>
        </div>
      </div>`;
    box.querySelector('pre').textContent = text;
    document.body.appendChild(box);
    box.addEventListener('click', async e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') box.remove();
      else if (act === 'copy') {
        try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('复制失败，请手动选择', true); }
      } else if (act === 'download') {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        a.download = title.replace(/[\\/:*?"<>|]+/g, '_') + '.txt';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      }
    });
  }

  async function resetTencentData() {
    if (!confirm('确定清空本地所有腾讯同步数据吗？\n\n只删除 data/tx/，不影响手动新增、收藏和无效记录。')) return;
    try {
      const r = await fetch(LOCAL + '/api/tencent-sync/reset', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.err || 'HTTP ' + r.status);
      log(`🧹 已清空腾讯同步数据：${j.files || 0} 个文件，${j.records || 0} 条记录`);
      toast('已清空，可以重新同步');
    } catch (e) {
      toast('清空失败：' + (e.message || e), true);
    }
  }

  window.__MAOWANGS_TENCENT_SYNC__ = {
    parser: Parser,
    open: async () => {
      panel();
      try { await loadSheetList(); } catch (e) { log('❌ ' + e.message); toast(e.message, true); }
    }
  };
  window.__MAOWANGS_TENCENT_SYNC__.open();
})();
