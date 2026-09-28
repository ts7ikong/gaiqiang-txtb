/*
 * 魔王S 腾讯文档同步助手 v9.0.8
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
          else if (t.includes('镜子') || t.includes('瞄准镜')) map.scope ??= c;
          else if (t.includes('弹夹') || t.includes('弹匣')) map.ammo ??= c;
          else if (t.includes('属性图') || t.includes('属性')) map.attributeImage ??= c;
          else if (t.includes('改装展示') || t.includes('改装图')) map.modShow ??= c;
          else if (t.includes('备注')) map.note ??= c;
          else if (t.includes('日期') || t.includes('时间')) map.date ??= c;
          else if (/^FOV$/i.test(t) || t.includes('FOV')) map.fov ??= c;
          else if (t.includes('精校')) map.precision ??= c;
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
      // S11 烽火地带的已知业务列顺序：
      // 改枪码、价格、镜子、弹夹、属性图、改装展示、备注、ID、特殊ID、FOV、精校……
      // 仅在当前响应没有读到表头时使用；一旦有真实表头，始终以表头为准。
      if (headerRow < 0 && /S11\s*烽火地带|S11烽火地带/.test(sheetName || '')) {
        Object.assign(map, { code: 0, price: 1, scope: 2, ammo: 3, attributeImage: 4, modShow: 5, note: 6, gunId: 7, special: 8, fov: 9, precision: 10 });
      }
      if (headerRow >= 0) {
        map.gunId = fixIdColumn(rows, headerRow, map.gunId);
        map.special = fixIdColumn(rows, headerRow, map.special);
      }

      let defaultDate = '';
      for (const [, cols] of rows.slice(0, 30)) {
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
        if (headerRow >= 0 && r <= headerRow) continue;

        const values = [...cols.entries()].sort((a, b) => a[0] - b[0]);
        const get = k => (map[k] == null ? undefined : cols.get(map[k]));

        // 先找真正的改枪码；不要依赖固定第 0/3 列。
        let code = '';
        let codeCol = -1;
        for (const [c, v] of values) {
          const m = typeof v === 'string' ? CODE_RE.exec(norm(v)) : null;
          CODE_RE.lastIndex = 0;
          if (m) { code = m[0].trim(); codeCol = c; break; }
        }

        if (!code) {
          // 分组标题行，例如“M700全自动”“射手步枪合集”。
          const vals = values.map(([, v]) => cellText(v)).filter(Boolean);
          if (vals.length === 1 && typeof vals[0] === 'string' && vals[0].length <= 60 && !CODE_RE.test(vals[0])) {
            category = vals[0];
          }
          CODE_RE.lastIndex = 0;
          continue;
        }

        if (seen.has(code)) continue;
        seen.add(code);
        const m = CODE_RE.exec(code); CODE_RE.lastIndex = 0;

        // 有表头时严格按列读取；没有表头时，只按“同一行的值形态”推断，
        // 绝不再把下一行/下一列的数据硬拼进当前记录。
        let price = cellText(get('price'));
        let ammo = cellText(get('ammo'));
        let note = cellText(get('note'));
        let dateRaw = get('date');
        let gunId = toId(get('gunId'));
        let specialGunId = toId(get('special'));
        let scope = map.scope == null ? '' : cellText(cols.get(map.scope));
        let attributeImage = map.attributeImage == null ? '' : cellText(cols.get(map.attributeImage));
        let modShow = map.modShow == null ? '' : cellText(cols.get(map.modShow));
        let fov = map.fov == null ? '' : cellText(cols.get(map.fov));
        let precision = map.precision == null ? '' : cellText(cols.get(map.precision));

        if (headerRow < 0 && map.code == null) {
          const after = values.filter(([c]) => c > codeCol).map(([, v]) => v);
          if (!price) price = after.find(v => /^\d+(?:\.\d+)?w$/i.test(cellText(v))) ? cellText(after.find(v => /^\d+(?:\.\d+)?w$/i.test(cellText(v)))) : '';
          if (!ammo) ammo = after.find(v => /^\d+(?:\+\d+)?发$/.test(cellText(v))) ? cellText(after.find(v => /^\d+(?:\+\d+)?发$/.test(cellText(v)))) : '';
          if (!note) {
            const candidate = after.find(v => {
              const t = cellText(v);
              return t && !/^\d+(?:\.\d+)?w$/i.test(t) && !/^\d+(?:\+\d+)?发$/.test(t) && t.length <= 300 && !/^\d+$/.test(t);
            });
            note = cellText(candidate);
          }
          if (!gunId) {
            const nums = after.filter(v => /^\d{4,6}$/.test(cellText(v))).map(v => cellText(v));
            gunId = nums.find(x => x.length === 4) || '';
            specialGunId = nums.find(x => x !== gunId && x.length === 4) || '';
          }
        }

        const date = typeof dateRaw === 'number' && dateRaw > 30000 && dateRaw < 80000
          ? serialToDate(dateRaw)
          : (cellText(dateRaw) || defaultDate);

        out.push({
          row: r,
          code,
          gunNameRaw: m ? m[1].replace(/^\d+/, '').trim() : '',
          mode: m ? m[2] : inferMode(sheetName),
          category,
          price, scope, ammo, attributeImage, modShow, note,
          date, gunId, specialGunId, fov, precision,
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

    // 新版序列业务解析：当前 S11 的 protobuf 叶子并不是“每 13 个值一行”。
    // 空单元格/图片对象可能没有可读文本，因此不能按固定下标取列。
    // 这里以“改枪码”为行锚点，在下一个改枪码前按值类型/语义识别业务字段。
    function sequenceFallback(rawBlocks, sheetName) {
      const seq = [];
      for (const raw of rawBlocks) seq.push(...readLeafSequence(raw));

      const out = [], seen = new Set();
      let category = '';
      let current = null;

      const isPrice = v => typeof v === 'string' && /^\d+(?:\.\d+)?w$/i.test(v);
      const isAmmo = v => typeof v === 'string' && /^\d+(?:\+\d+)?发$/.test(v);
      const isIdNum = v => typeof v === 'number' && Number.isInteger(v) && v >= 1000 && v <= 999999;
      const isFov = v => typeof v === 'string' && /^(通用|固定FOV|任意FOV|FOV任意|默认)$/.test(v);
      const isNoise = v => {
        if (typeof v === 'number') return false;
        const s = String(v || '');
        return !s || /^\d+(?:\.\d+)?$/.test(s) || /^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}/.test(s);
      };
      const clean = v => typeof v === 'string' ? cleanSequenceText(v) : v;

      function normalizeGunCode(code) {
        const m = CODE_RE.exec(String(code || ''));
        CODE_RE.lastIndex = 0;
        if (!m) return String(code || '').trim();
        // 腾讯当前 S11 叶子文本把行/富文本标记中的数字前缀也带进了枪名，
        // 例如“5汤姆逊…”、“2MDR…”。这些不是游戏内枪名，剥掉前导数字。
        const gunName = String(m[1] || '').replace(/^\d+(?=[\u4e00-\u9fffA-Za-z])/, '').trim();
        return `${gunName}-${m[2]}-${m[3]}`;
      }

      function buildRecord(c) {
        if (!c || !c.code) return null;
        const normalizedCode = normalizeGunCode(c.code);
        const vals = c.values.map(clean).filter(v => !isNoise(v));
        const strings = vals.filter(v => typeof v === 'string' && v.length > 0);

        let price = vals.find(isPrice) || '';
        let ammo = vals.find(isAmmo) || '';
        let fov = strings.find(isFov) || '';

        // ID 通常出现在备注/图片相关字段之后、FOV 附近。
        // 优先选择位于 FOV 前面的 4~6 位整数；没有 FOV 时取最后一个合理整数。
        const fovIndex = fov ? vals.lastIndexOf(fov) : vals.length;
        const beforeFovNums = vals
          .slice(0, fovIndex)
          .map((v, i) => ({ v, i }))
          .filter(x => isIdNum(x.v));
        const gunIdObj = beforeFovNums.length ? beforeFovNums[beforeFovNums.length - 1] : null;
        const gunId = gunIdObj ? String(gunIdObj.v) : '';

        // 业务顺序：价格 -> 镜子 -> 弹夹 -> 图片/对象 -> 备注 -> ID -> FOV。
        // 图片没有可读叶子，因此剩下的短文本按顺序恢复镜子/备注。
        const afterPrice = [];
        let started = false;
        for (const v of vals) {
          if (!started) {
            if (v === price) started = true;
            continue;
          }
          if (v === ammo || v === gunIdObj?.v || v === fov) continue;
          if (typeof v === 'string' && !isPrice(v) && !isAmmo(v) && !isFov(v)) afterPrice.push(v);
        }

        // 第一段短文本通常是镜子，第二段通常是备注；如果只有一段，结合
        // 常见镜子名称判断，否则按“备注”处理，避免把备注误当镜子。
        const scopeRe = /^(红点|反射5000|全息|三倍|四倍|五倍|六倍|二倍|1倍|2倍|3倍|4倍|5倍|6倍|微型红点|俄式2倍|俄式三倍|轻语|堡垒|斜角|双流|共振|瞄准镜|无镜)$/i;
        let scope = '';
        let note = '';
        for (const v of afterPrice) {
          if (!scope && scopeRe.test(v)) scope = v;
          else if (!note) note = v;
        }
        if (!scope && afterPrice.length >= 2) scope = afterPrice[0];
        if (!note && afterPrice.length >= 2) note = afterPrice[afterPrice.length - 1];
        if (!note && afterPrice.length === 1 && !scope) note = afterPrice[0];

        const m = CODE_RE.exec(normalizedCode);
        CODE_RE.lastIndex = 0;
        return {
          row: c.index,
          code: normalizedCode,
          gunNameRaw: m ? m[1].trim() : '',
          mode: m ? m[2] : inferMode(sheetName),
          category: /S11\s*烽火地带|S11烽火地带/.test(sheetName || '') ? '' : (c.category || category),
          price,
          scope,
          ammo,
          attributeImage: '',
          modShow: '',
          note,
          date: '',
          gunId,
          specialGunId: '',
          fov: fov || (/S11\s*烽火地带|S11烽火地带/.test(sheetName || '') ? '通用' : ''),
          precision: '',
          sheet: sheetName
        };
      }

      const flush = () => {
        if (!current) return;
        const rec = buildRecord(current);
        if (rec && rec.code && !seen.has(rec.code)) {
          seen.add(rec.code);
          out.push(rec);
        }
        current = null;
      };

      let codeCount = 0;
      for (const item of seq) {
        const raw = item.type === 'text' ? cleanSequenceText(item.value) : item.value;
        if (item.type === 'text') {
          const m = CODE_RE.exec(raw);
          CODE_RE.lastIndex = 0;
          if (m) {
            flush();
            current = { index: codeCount++, code: m[0].trim(), values: [], category };
            continue;
          }
          if (!current && raw && raw.length <= 60 && !/[-]{2,}/.test(raw) && !/^\d/.test(raw)) {
            category = raw;
            continue;
          }
          if (current && raw) current.values.push(raw);
        } else if (current && typeof raw === 'number' && Number.isFinite(raw)) {
          current.values.push(raw);
        }
      }
      flush();
      return { records: out, sequence: seq.length };
    }



    // 针对当前 S11 烽火地带：新版 related_sheet 的业务表会被编码成
    // “同一消息里 field=1 的重复子消息列表”。每个重复项就是一个单元格，
    // occurrence index 就是该单元格在扁平表格中的真实位置。
    function firstLeafValue(buf, depth = 0) {
      if (!buf || !buf.length || depth > 12) return '';
      let fs;
      try { fs = readFields(buf); } catch { return ''; }
      for (const f of fs) {
        if (f.wire === 2 && f.bytes) {
          let s = '';
          try { s = td.decode(f.bytes); } catch {}
          if (s && !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(s)) return s;
          const nested = firstLeafValue(f.bytes, depth + 1);
          if (nested !== '') return nested;
        } else if (f.wire === 1 && f.bytes?.length === 8) {
          try {
            const n = new DataView(f.bytes.buffer, f.bytes.byteOffset, 8).getFloat64(0, true);
            if (Number.isFinite(n) && Math.abs(n) < 1e12) return n;
          } catch {}
        }
      }
      return '';
    }

    function findFlatCellLists(raw) {
      const candidates = [];
      function walk(buf, path, depth) {
        if (!buf || !buf.length || depth > 30) return;
        let fs;
        try { fs = readFields(buf); } catch { return; }
        const byField = new Map();
        for (const f of fs) {
          if (f.wire === 2 && f.bytes) {
            if (!byField.has(f.no)) byField.set(f.no, []);
            byField.get(f.no).push(f.bytes);
          }
        }
        for (const [field, children] of byField) {
          if (children.length < 20) continue;
          const cells = children.map((b, i) => ({ index: i, value: firstLeafValue(b), raw: b }));
          const codeCount = cells.filter(c => typeof c.value === 'string' && CODE_RE.test(c.value)).length;
          CODE_RE.lastIndex = 0;
          if (codeCount >= 2) {
            candidates.push({ path, field, cells, score: codeCount * 100000 + children.length });
          }
        }
        for (const f of fs) {
          if (f.wire === 2 && f.bytes) walk(f.bytes, path.concat(f.no), depth + 1);
        }
      }
      walk(raw, [], 0);
      candidates.sort((a, b) => b.score - a.score);
      return candidates;
    }

    function columnRecordFallback(rawBlocks, sheetName) {
      if (!/S11\s*烽火地带|S11烽火地带/.test(sheetName || '')) return { records: [], cells: 0 };
      const all = [];
      for (const raw of rawBlocks) {
        for (const c of findFlatCellLists(raw)) {
          all.push(c);
        }
      }
      if (!all.length) return { records: [], cells: 0 };
      all.sort((a, b) => b.score - a.score);
      const chosen = all[0];
      const cells = chosen.cells;
      const valueAt = i => {
        if (i < 0 || i >= cells.length) return '';
        const v = cells[i].value;
        return typeof v === 'number' ? String(v) : norm(String(v ?? ''));
      };
      const out = [];
      const seen = new Set();
      for (let i = 0; i < cells.length; i++) {
        const code = valueAt(i);
        if (!code || !CODE_RE.test(code)) { CODE_RE.lastIndex = 0; continue; }
        CODE_RE.lastIndex = 0;
        const m = CODE_RE.exec(code);
        if (!m || seen.has(code)) continue;
        // 表头/说明文字不符合完整改枪码结构的，CODE_RE 本身就会过滤掉。
        const row = {
          row: out.length,
          code,
          gunNameRaw: m[1].replace(/^\\d+/, '').trim(),
          mode: m[2] || inferMode(sheetName),
          category: '',
          price: valueAt(i + 1),
          scope: valueAt(i + 2),
          ammo: valueAt(i + 3),
          attributeImage: valueAt(i + 4),
          modShow: valueAt(i + 5),
          note: valueAt(i + 6),
          date: '',
          gunId: valueAt(i + 7),
          specialGunId: valueAt(i + 8),
          fov: valueAt(i + 9),
          precision: valueAt(i + 10),
          sheet: sheetName
        };
        // 只有明确的 ID 数字才写入，避免把普通文本污染到 ID 字段。
        row.gunId = /^\d+$/.test(row.gunId) ? row.gunId : '';
        row.specialGunId = /^\d+$/.test(row.specialGunId) ? row.specialGunId : '';
        seen.add(code);
        out.push(row);
      }
      return { records: out, cells: cells.length, candidatePath: chosen.path, candidateField: chosen.field };
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

    return { readFields, parseBlock, gridToRecords, sequenceFallback, readLeafSequence, columnRecordFallback, findFlatCellLists, textFallback, serialToDate, inferMode, cellText };
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

  const VERSION = '9.0.8';
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

  // S11 的 ID(网址使用) 是 fixed64 double，不一定紧跟表头文本，
  // 也不一定符合旧版“09 + 8字节连续数组”的布局。
  // v9.0.8：递归收集所有 fixed64 数字叶子，再寻找“连续的 4 位整数序列”。
  // 这是针对当前 S11 结构的 ID 候选恢复，不把普通文本数字误当 ID。
  function extractIdColumn(rawParts, maxCount) {
    const nums = [];
    function walk(buf, depth = 0) {
      if (!buf || !buf.length || depth > 40) return;
      let fs;
      try { fs = Parser.readFields(buf); } catch { return; }
      for (const f of fs) {
        if (f.wire === 1 && f.bytes?.length === 8) {
          try {
            const v = new DataView(f.bytes.buffer, f.bytes.byteOffset, 8).getFloat64(0, true);
            if (Number.isFinite(v)) nums.push(v);
          } catch {}
        } else if (f.wire === 2 && f.bytes?.length) {
          walk(f.bytes, depth + 1);
        }
      }
    }
    for (const raw of rawParts) walk(raw);

    // ID(网址使用) 当前是 4 位整数；排除日期、坐标、比例等常见数字。
    const ints = nums.map((v, i) => ({ v: Math.round(v), raw: v, i }))
      .filter(x => Math.abs(x.raw - x.v) < 1e-9 && x.v >= 1000 && x.v <= 9999);

    // 计算候选连续段。允许中间夹少量非 ID 数字，但不能跨太大的间隔。
    const runs = [];
    let run = [];
    for (let i = 0; i < ints.length; i++) {
      if (!run.length) { run = [ints[i]]; continue; }
      const gap = ints[i].i - run[run.length - 1].i;
      if (gap <= 4) run.push(ints[i]);
      else {
        if (run.length >= 2) runs.push(run);
        run = [ints[i]];
      }
    }
    if (run.length >= 2) runs.push(run);

    // 优先长度，其次优先更像“控枪编号”的 7xxx/6xxx 数字段。
    runs.sort((a, b) => {
      const score = r => r.length * 100 + r.filter(x => x.v >= 6000 && x.v <= 9999).length;
      return score(b) - score(a);
    });
    const best = runs[0] || [];
    const ids = [];
    for (const x of best) {
      if (!ids.length || ids[ids.length - 1] !== String(x.v)) ids.push(String(x.v));
      if (ids.length >= maxCount) break;
    }
    return ids;
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
    const raws = [];
    const td = new TextDecoder('utf-8');
    let cells = 0, errors = 0;
    for (const b64 of blobs) {
      const raw = await inflate(b64);
      raws.push(raw);
      try { cells += Parser.parseBlock(raw, grid); }
      catch (e) { errors++; console.warn('[魔王S] 数据块解析失败', e); }
      texts.push(td.decode(raw));
    }

    let records = Parser.gridToRecords(grid, sheet.name);
    let strategy = records.length ? 'protobuf-grid' : 'protobuf-grid-empty';
    let sequenceValues = 0;
    if (!records.length) {
      const seq = Parser.sequenceFallback(raws, sheet.name);
      records = seq.records;
      sequenceValues = seq.sequence;
      strategy = records.length ? 'protobuf-sequence' : 'text';
    }
    if (!records.length) {
      records = Parser.textFallback(texts.join('\n'), sheet.name);
      strategy = 'text';
    }

    // S11 当前表的 ID 列是独立的 fixed64 数字列，不在文本叶子序列中。
    // 只在业务记录已经按代码顺序恢复后回填，避免再次把其它数字字段误当 ID。
    if (records.length && /S11\s*烽火地带|S11烽火地带/.test(sheet.name || '')) {
      try {
        const ids = extractIdColumn(raws, records.length);
        for (let i = 0; i < records.length && i < ids.length; i++) {
          if (!records[i].gunId && /^\d{4}$/.test(String(ids[i] || ''))) records[i].gunId = String(ids[i]);
        }
      } catch (e) {
        console.warn('[魔王S] ID 列解析失败', e);
      }
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
        log(`  数据块 ${d.blocks}，单元格 ${d.cells}，序列值 ${d.sequenceValues || 0}，改枪码 ${d.records.length} 条；ID ${d.records.filter(x => x.gunId).length}，特殊子弹ID ${d.records.filter(x => x.specialGunId).length}`);
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
          `价格=${r.price}`, `镜子=${r.scope || ''}`, `弹夹=${r.ammo}`,
          `属性图=${r.attributeImage || ''}`, `改装展示=${r.modShow || ''}`,
          `备注=${r.note}`, `ID=${r.gunId}`, `特殊ID=${r.specialGunId}`,
          `FOV=${r.fov || ''}`, `精校=${r.precision || ''}`
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
