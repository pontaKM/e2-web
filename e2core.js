/*
 * e2core.js  —  electribe2 用の土台（接続層＋状態層）  v1
 *
 * 画面側の使い方：
 *   E2.on(function (type, detail) { ... });   // 変化の通知を受け取る
 *   E2.start();                               // 接続して最初の読み込み
 *   E2.state.parts[1..16].level などを読む
 *   E2.setPart(3, "mfxSend", 1);              // 送信＋状態更新
 *   E2.setAllParts("mfxSend", 0);             // 16パートまとめて
 *   E2.requestDump("理由");                    // 読み直し
 *
 * 通知の種類（type）：
 *   "status"   接続状態・ポートが変わった
 *   "loaded"   ダンプを読み込んで状態が全部入れ替わった
 *   "part"     1パートの1項目が変わった  detail = {part, field, value, source:"e2"|"app"}
 *   "verify"   照合結果  detail = {mismatches:[...], checked:n}
 *   "midi"     受信・送信の記録（ログ用） detail = 文字列
 *   "error"    エラー  detail = 文字列
 *
 * iOS 12 の古い JavaScript でも動くように、var と function だけで書いています。
 */
(function (global) {
  "use strict";

  // ---------------- 定数 ----------------
  var PRODUCT_ID = 0x24;          // hacktribe = 0x24 / 標準 e2 = 0x23（実機確認済み：0x24）
  var PART_BASE = 0x800, PART_LEN = 0x330, DUMP_SIZE = 0x4000;

  // パートの項目：ダンプ内の位置、対応する CC、値の種類
  //   kind "u" : 0〜127、CC の値そのまま（カットオフで実機確認済み）
  //   kind "s" : 符号付き。CC 64 が 0 と仮定（未確認 → 照合機能で確かめる）
  //   kind "b" : オン/オフ。状態は 0/1、CC は 0/127
  //   kind "r" : 読むだけ（CC なし）
  var FIELDS = {
    mute:        { off: 0x01, kind: "r" },
    voiceAssign: { off: 0x02, kind: "r" },
    oscType:     { off: 0x08, kind: "r16" },
    oscEdit:     { off: 0x0B, kind: "u", cc: 82 },
    filterType:  { off: 0x0C, kind: "r" },
    cutoff:      { off: 0x0D, kind: "u", cc: 74 },
    reso:        { off: 0x0E, kind: "u", cc: 71 },
    filterEG:    { off: 0x0F, kind: "s", cc: 83 },
    modType:     { off: 0x10, kind: "r" },
    modSpeed:    { off: 0x11, kind: "u", cc: 86 },
    modDepth:    { off: 0x12, kind: "u", cc: 85 },
    attack:      { off: 0x14, kind: "u", cc: 73 },
    decay:       { off: 0x15, kind: "u", cc: 72 },
    level:       { off: 0x18, kind: "u", cc: 7 },
    pan:         { off: 0x19, kind: "s", cc: 10 },
    mfxSend:     { off: 0x1B, kind: "b", cc: 105 },
    ifxOn:       { off: 0x20, kind: "b", cc: 104 },
    ifxType:     { off: 0x21, kind: "r" },
    ifxEdit:     { off: 0x22, kind: "u", cc: 87 },
    pitch:       { off: 0x24, kind: "s", cc: 80 },
    glide:       { off: 0x25, kind: "u", cc: 81 }
  };
  var CC_TO_FIELD = {};
  (function () { for (var f in FIELDS) if (FIELDS[f].cc) CC_TO_FIELD[FIELDS[f].cc] = f; })();

  var MFX_TYPES = ['Mod Delay','Tape Delay','High Pass Delay','Hall Reverb','Room Reverb','Wet Reverb','Looper','Pitch Looper','Step Shifter','Slicer','Jag Filter','Grain Shifter','Vinyl Break','Seq Reverse','Seq Doubler','Odd Stepper','Even Stepper','Low Pass Filter','High Pass Filter','Band Plus Filter','Touch Wah','Tube EQ','Decimator','Distortion','Compressor','Limiter','Chorus','XY Flanger','LFO Flanger','XY Phaser','LFO Phaser','Auto Pan'];
  var FILTER_TYPES = ['OFF','electribe LPF','MS20 LPF','MG LPF','P5 LPF','OB LPF','Acid LPF','electribe HPF','MS20 HPF','P5 HPF','OB HPF','Acid HPF','electribe BPF','MS20 BPF','P5 BPF','OB BPF','Acid BPF'];

  // ---------------- 状態 ----------------
  var state = {
    loaded: false,          // 一度でもダンプを読めたか
    loadedAt: null,         // 最後に読み込んだ時刻（Date）
    global: {},             // name, tempo, mfxType, mfxTypeName, padX, padY, mfxHold, playLevel
    parts: []               // parts[1]〜parts[16]
  };
  var status = {
    midi: "starting",       // starting / ready / unsupported / denied
    inNames: [],
    outName: "",
    busy: false,            // ダンプ受信中
    pendingPattern: null    // 切替予約中のパターン番号（なければ null）
  };
  var options = {
    globalCh: 1,            // MIDI GLOBAL CH（このe2は 1）
    autoReloadOnPattern: true,   // パターン切替（プログラムチェンジ）で読み直す
    verifyAfterEdit: true,       // 操作が止まってから読み直して照合する
    verifyDelay: 1500,           // 何ミリ秒止まったら照合するか
    verifyMinInterval: 5000,     // 照合の読み直しは最短でもこの間隔をあける
    pollInterval: 1000           // 切替待ちの読み直し間隔
  };

  // ---------------- 通知 ----------------
  var listeners = [];
  function on(fn) { listeners.push(fn); }
  function emit(type, detail) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](type, detail); } catch (e) { if (global.console) console.log(e); }
    }
  }

  // ---------------- 小物 ----------------
  function hex2(n) { var s = n.toString(16).toUpperCase(); return s.length < 2 ? "0" + s : s; }
  function hexArr(a, max) {
    var out = [], n = Math.min(a.length, max || a.length);
    for (var i = 0; i < n; i++) out.push(hex2(a[i]));
    if (a.length > n) out.push("…");
    return out.join(" ");
  }
  function sbyte(b) { return b > 127 ? b - 256 : b; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function toList(m) {
    var a = [];
    if (!m) return a;
    if (typeof m === "function") m = m();
    if (m.forEach) { m.forEach(function (p) { a.push(p); }); return a; }
    if (m.length !== undefined) { for (var i = 0; i < m.length; i++) a.push(m[i]); }
    return a;
  }

  // CC の値 ⇔ 状態の値
  function ccToValue(field, cc) {
    var k = FIELDS[field].kind;
    if (k === "b") return cc > 0 ? 1 : 0;
    if (k === "s") return cc - 64;            // 仮定（照合で確認する）
    return cc;
  }
  function valueToCc(field, v) {
    var k = FIELDS[field].kind;
    if (k === "b") return v ? 127 : 0;
    if (k === "s") return clamp(v + 64, 0, 127);
    return clamp(v, 0, 127);
  }

  // ---------------- 接続層 ----------------
  var midi = null, inputs = [], outputs = [], outIndex = -1;

  function start() {
    if (!global.navigator || !navigator.requestMIDIAccess) {
      status.midi = "unsupported"; emit("status", status); return;
    }
    navigator.requestMIDIAccess({ sysex: true }).then(function (access) {
      midi = access;
      status.midi = "ready";
      refreshPorts();
      midi.onstatechange = function () { refreshPorts(); };
      setTimeout(function () { requestDump("起動"); }, 400);
    }, function (err) {
      status.midi = "denied";
      emit("error", "MIDI を使えませんでした：" + err);
      emit("status", status);
    });
  }

  function refreshPorts() {
    inputs = toList(midi.inputs);
    outputs = toList(midi.outputs);
    status.inNames = [];
    for (var i = 0; i < inputs.length; i++) {
      status.inNames.push(inputs[i].name);
      inputs[i].onmidimessage = onMessage;
    }
    // 出力：前回のものが残っていればそれ、なければ e2 らしい名前、なければ先頭
    var keep = (outIndex >= 0 && outputs[outIndex] && outputs[outIndex].name === status.outName);
    if (!keep) {
      outIndex = -1;
      for (var j = 0; j < outputs.length; j++) {
        if (/SOUND|electribe/i.test(outputs[j].name)) { outIndex = j; break; }
      }
      if (outIndex < 0 && outputs.length) outIndex = 0;
    }
    status.outName = outIndex >= 0 ? outputs[outIndex].name : "";
    emit("status", status);
  }
  function listOutputs() {
    var a = [];
    for (var i = 0; i < outputs.length; i++) a.push(outputs[i].name);
    return a;
  }
  function selectOutput(i) {
    if (outputs[i]) { outIndex = i; status.outName = outputs[i].name; emit("status", status); }
  }
  function send(arr) {
    if (outIndex < 0 || !outputs[outIndex]) { emit("error", "出力ポートがありません"); return false; }
    try { outputs[outIndex].send(arr); return true; }
    catch (e) { emit("error", "送信エラー：" + e); return false; }
  }

  // ---------------- 受信 ----------------
  // 受け取ったバイトを1つずつ解釈する（古いアプリで分割・連結されて届いても正しく扱うため）
  var sx = null;     // 受信中の SysEx { active, bytes }
  var cm = null;     // 組み立て中のチャンネルメッセージ { bytes, need }
  var lastPcAt = 0;  // 最後にプログラムチェンジを受けた時刻
  var t0 = Date.now();
  function ts() { return ((Date.now() - t0) / 1000).toFixed(2) + "s"; }

  function onMessage(ev) {
    var d = ev.data;
    for (var i = 0; i < d.length; i++) feed(d[i]);
  }
  function feed(b) {
    if (b >= 0xF8) return;                         // クロック等は無視
    if (b === 0xF0) {
      if (sx && sx.active) abortSysex("次の SysEx が始まった");
      cm = null;
      sx = { active: true, bytes: [0xF0] };
      return;
    }
    if (b === 0xF7) {
      if (sx && sx.active) { sx.bytes.push(b); finishSysex(true); }
      return;
    }
    if (b >= 0x80) {                               // チャンネルメッセージの始まり
      if (sx && sx.active) abortSysex("途中に 0x" + hex2(b) + " が割り込んだ");
      var t = b & 0xF0;
      cm = { bytes: [b], need: (t === 0xC0 || t === 0xD0) ? 2 : 3 };
      return;
    }
    // データバイト
    if (sx && sx.active) { sx.bytes.push(b); return; }
    if (cm) {
      cm.bytes.push(b);
      if (cm.bytes.length === cm.need) { handleChannel(cm.bytes); cm = { bytes: [cm.bytes[0]], need: cm.need }; } // ランニングステータス対応
    }
  }
  function abortSysex(why) {
    var n = sx.bytes.length;
    sx.active = false;
    emit("error", ts() + " ダンプ受信が中断（" + why + "、" + n + " バイト時点）");
    failDump("中断");
  }

  function handleChannel(m) {
    var type = m[0] & 0xF0, ch = (m[0] & 0x0F) + 1;
    if (type === 0xB0) {
      emit("midi", ts() + " 受信 ch" + ch + " CC#" + m[1] + " = " + m[2]);
      var f = CC_TO_FIELD[m[1]];
      if (f) noteCc(ch, f, m[2]);
      if (f && state.loaded) applyPart(ch, f, ccToValue(f, m[2]), "e2");
    } else if (type === 0xC0) {
      lastPcAt = Date.now();
      emit("midi", ts() + " 受信 ch" + ch + " プログラムチェンジ " + m[1] + "（パターン " + (m[1] + 1) + " へ切替予約）");
      if (options.autoReloadOnPattern) startPatternWait(m[1]);
    }
  }

  // 項目ごとに、直近に届いた CC を5件まで覚えておく（不一致の原因調べ用）
  var ccHist = {};
  function noteCc(p, f, v) {
    var k = p + ":" + f, h = ccHist[k] || (ccHist[k] = []);
    h.push(ts() + "=" + v);
    if (h.length > 5) h.shift();
  }

  // ---------------- ダンプ ----------------
  var dumpTimer = null, dumpReason = "", dumpT0 = 0, pendingDump = null, retryCount = 0;

  function requestDump(reason, isRetry) {
    if (status.busy) { pendingDump = reason || "再要求"; return; }   // 受信中なら終わってからもう一度
    if (status.midi !== "ready") return;
    if (!isRetry) retryCount = 0;
    var msg = [0xF0, 0x42, 0x30 + options.globalCh - 1, 0x00, 0x01, PRODUCT_ID, 0x10, 0xF7];
    dumpReason = reason || "";
    dumpT0 = Date.now();
    if (!send(msg)) return;
    status.busy = true;
    emit("status", status);
    if (dumpTimer) clearTimeout(dumpTimer);
    dumpTimer = setTimeout(function () {
      dumpTimer = null;
      if (sx && sx.active) { sx.active = false; emit("error", ts() + " ダンプが5秒で終わらない（" + sx.bytes.length + " バイト）"); failDump("時間切れ"); return; }
      emit("error", ts() + " e2 から応答がありません（" + dumpReason + "）");
      failDump("無応答");
    }, 5000);
  }

  // 読み込み失敗：少し待って読み直す（最大2回）
  function failDump(why) {
    if (dumpTimer) { clearTimeout(dumpTimer); dumpTimer = null; }
    if (!status.busy) return;
    status.busy = false;
    emit("status", status);
    if (retryCount < 2) {
      retryCount++;
      var r = dumpReason;
      emit("midi", ts() + " 読み直します（" + retryCount + "回目、" + why + "）");
      setTimeout(function () { requestDump(r, true); }, 500);
    } else {
      emit("error", ts() + " 読み込みをあきらめました（" + dumpReason + "）。表示は前の値のままです");
      if (pendingDump) { var p = pendingDump; pendingDump = null; requestDump(p); }
    }
  }

  function finishSysex(complete) {
    var b = sx.bytes;
    sx.active = false;
    var isDump = b[0] === 0xF0 && b[1] === 0x42 && b[4] === 0x01 && b[6] === 0x40;
    if (!isDump) {
      emit("midi", ts() + " 受信 SysEx（ダンプ以外）: " + hexArr(b, 12));
      if (status.busy && b[1] === 0x42) failDump("ダンプ以外の応答");
      return;
    }
    if (dumpTimer) { clearTimeout(dumpTimer); dumpTimer = null; }
    var data = decode7(b.slice(7, b.length - 1));
    if (data.length !== DUMP_SIZE) {
      emit("error", ts() + " ダンプが不完全：" + b.length + " バイト（本来 18733）。末尾 " + hexArr(b.slice(-6)));
      failDump("不完全");
      return;
    }
    status.busy = false;
    var ms = Date.now() - dumpT0;
    loadFromDump(data, ms);
    emit("status", status);
    if (pendingDump) { var r = pendingDump; pendingDump = null; requestDump(r); }
  }

  function decode7(src) {
    var out = [];
    for (var i = 0; i < src.length; i += 8) {
      var msb = src[i];
      for (var j = 0; j < 7 && i + 1 + j < src.length; j++) out.push(src[i + 1 + j] | (((msb >> j) & 1) << 7));
    }
    return out;
  }

  function readPart(data, p) {
    var base = PART_BASE + PART_LEN * (p - 1), o = {};
    for (var f in FIELDS) {
      var F = FIELDS[f], raw = data[base + F.off];
      if (F.kind === "s") o[f] = sbyte(raw);
      else if (F.kind === "b") o[f] = raw ? 1 : 0;
      else if (F.kind === "r16") o[f] = raw + 256 * data[base + F.off + 1];
      else o[f] = raw;
    }
    o.mute = o.mute ? 1 : 0;
    o.filterTypeName = FILTER_TYPES[o.filterType] || ("#" + o.filterType);
    return o;
  }

  function loadFromDump(data, ms) {
    var name = "";
    for (var i = 0x10; i < 0x22; i++) { if (!data[i]) break; name += String.fromCharCode(data[i]); }
    var g = {
      name: name.replace(/\s+$/, ""),
      tempo: (data[0x22] + 256 * data[0x23]) / 10,
      mfxType: data[0x3D],
      mfxTypeName: MFX_TYPES[data[0x3D]] || ("#" + data[0x3D]),
      padX: data[0x3E], padY: data[0x3F],
      mfxHold: data[0x41] ? 1 : 0,
      playLevel: 127 - data[0x2A],
      lengthBars: (data[0x25] & 3) + 1      // 0〜3 → 1〜4小節（実機の値 3 = 4小節と推定）
    };
    var parts = [null];
    for (var p = 1; p <= 16; p++) parts.push(readPart(data, p));

    // 前回読んだデータとの違いのうち、その間に届いた CC で説明できないもの＝パターンが替わった印
    var unexplained = 0;
    if (lastData) {
      for (var o = 0; o < data.length; o++) if (data[o] !== lastData[o] && !touched[o]) unexplained++;
    } else unexplained = -1;
    lastData = data;
    touched = {};
    var switched = false;
    if (pending) {
      if (unexplained !== 0) {
        switched = true;
        emit("midi", ts() + " パターン " + (pending.program + 1) + " への切替を確認（予約から " + ((Date.now() - pending.at) / 1000).toFixed(1) + "s）");
        pending = null;
        verifyQueue = {};          // 切替前の操作は照合しない
      } else if (Date.now() - pending.at < pending.maxWait) {
        pollTimer = setTimeout(function () { pollTimer = null; requestDump("切替待ち"); }, options.pollInterval);
      } else {
        emit("midi", ts() + " 切替待ちを終了（" + (pending.maxWait / 1000).toFixed(1) + "s 内容に変化なし。同じ内容のパターンの可能性）");
        pending = null;
      }
      status.pendingPattern = pending ? pending.program : null;
      emit("status", status);
    }

    // 照合：操作で予測していた値と、実際に読んだ値を比べる（切替待ちの間はしない）
    var checks = pending ? {} : verifyQueue, mismatches = [], checked = 0;
    if (!pending) verifyQueue = {};
    if (state.loaded && !switched) {
      for (var key in checks) {
        var c = checks[key];
        checked++;
        var actual = parts[c.part][c.field];
        if (actual !== c.value) {
          mismatches.push({ part: c.part, field: c.field, expected: c.value, actual: actual, cc: c.cc, source: c.source,
                            history: (ccHist[c.part + ":" + c.field] || []).join(" ") });
        }
      }
    }

    state.global = g;
    state.parts = parts;
    state.loaded = true;
    state.loadedAt = new Date();
    state.loadMs = ms;
    state.reason = dumpReason;
    // 内容が前回と同じか（パターン切替の直後に、まだ前のパターンを読んでいないかを見るため）
    var fp = 0;
    for (var q = 0; q < data.length; q++) fp = (fp * 31 + data[q]) | 0;
    var same = (fp === lastFingerprint);
    lastFingerprint = fp;
    var sincePc = lastPcAt ? " / 切替から " + ((Date.now() - lastPcAt) / 1000).toFixed(2) + "s" : "";
    emit("midi", ts() + " 読込完了（" + dumpReason + "、" + ms + "ms、内容" + (same ? "は前回と同じ" : "が変化") + (unexplained > 0 ? "・CC で説明できない変化 " + unexplained + " バイト" : "") + sincePc + "）名前=" + g.name + " BPM=" + g.tempo);
    emit("loaded", state);
    if (checked) emit("verify", { mismatches: mismatches, checked: checked });
  }

  // ---------------- 状態の更新と照合 ----------------
  var lastFingerprint = null;
  var lastData = null;       // 前回読んだダンプ
  var touched = {};          // 前回の読み込み以降に CC で変わったはずのバイト位置
  var pending = null;        // 切替待ち { program, at, maxWait }
  var pollTimer = null;

  // パターン切替の予約を受けたら、内容が変わるまで読み直し続ける
  function startPatternWait(program) {
    cancelVerify();
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    var g = state.global || {};
    var bars = (g.lengthBars || 4), bpm = g.tempo || 60;
    var maxWait = Math.round(bars * 4 * 60000 / bpm) + 2000;     // 最長で1パターン分＋余裕
    if (maxWait < 3000) maxWait = 3000;
    if (maxWait > 40000) maxWait = 40000;
    pending = { program: program, at: Date.now(), maxWait: maxWait };
    status.pendingPattern = program;
    emit("status", status);
    pollTimer = setTimeout(function () { pollTimer = null; requestDump("切替待ち"); }, 300);
  }
  var verifyQueue = {};      // "パート:項目" → {part, field, value, cc, source}
  var verifyTimer = null;

  function applyPart(p, field, value, source) {
    if (!state.loaded || !state.parts[p]) return;
    touched[PART_BASE + PART_LEN * (p - 1) + FIELDS[field].off] = true;
    state.parts[p][field] = value;
    emit("part", { part: p, field: field, value: value, source: source });
    verifyQueue[p + ":" + field] = { part: p, field: field, value: value, cc: valueToCc(field, value), source: source };
    scheduleVerify();
  }
  function scheduleVerify() {
    if (!options.verifyAfterEdit) { verifyQueue = {}; return; }
    if (pending) return;       // 切替待ちの読み直しが続いている間は不要
    if (verifyTimer) clearTimeout(verifyTimer);
    var wait = options.verifyDelay;
    var gap = state.loadedAt ? (state.loadedAt.getTime() + options.verifyMinInterval - Date.now()) : 0;
    if (gap > wait) wait = gap;
    verifyTimer = setTimeout(function () { verifyTimer = null; requestDump("照合"); }, wait);
  }
  function cancelVerify() { if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; } }

  // ---------------- 送信（画面から呼ぶ） ----------------
  function setPart(p, field, value) {
    var F = FIELDS[field];
    if (!F || !F.cc) { emit("error", field + " は送信できない項目です"); return; }
    var cc = valueToCc(field, value);
    if (send([0xB0 + (p - 1), F.cc, cc])) {
      emit("midi", "送信 ch" + p + " CC#" + F.cc + " = " + cc);
      applyPart(p, field, ccToValue(field, cc), "app");
    }
  }
  function setAllParts(field, value) {
    for (var p = 1; p <= 16; p++) setPart(p, field, value);
  }
  // タッチパッド（全体 ch）。x, y は 0〜127、touch は true/false。null の項目は送らない
  function setPad(x, y, touch) {
    var st = 0xB0 + (options.globalCh - 1);
    if (x !== null && x !== undefined) send([st, 102, clamp(x, 0, 127)]);
    if (y !== null && y !== undefined) send([st, 103, clamp(y, 0, 127)]);
    if (touch !== null && touch !== undefined) send([st, 106, touch ? 127 : 0]);
  }

  // ---------------- 公開 ----------------
  global.E2 = {
    version: "core-v3",
    FIELDS: FIELDS,
    state: state,
    status: status,
    options: options,
    on: on,
    start: start,
    requestDump: requestDump,
    setPart: setPart,
    setAllParts: setAllParts,
    setPad: setPad,
    listOutputs: listOutputs,
    selectOutput: selectOutput,
    _decode7: decode7
  };
})(this);
