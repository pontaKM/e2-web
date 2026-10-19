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
    busy: false             // ダンプ受信中
  };
  var options = {
    globalCh: 1,            // MIDI GLOBAL CH（このe2は 1）
    autoReloadOnPattern: true,   // パターン切替（プログラムチェンジ）で読み直す
    verifyAfterEdit: true,       // 操作が止まってから読み直して照合する
    verifyDelay: 1500            // 何ミリ秒止まったら照合するか
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
  var sx = null;   // 受信中の SysEx { bytes, active, t0 }
  function onMessage(ev) {
    var d = ev.data, i;
    if (sx && sx.active) {
      for (i = 0; i < d.length; i++) {
        if (d[i] >= 0xF8) continue;
        sx.bytes.push(d[i]);
        if (d[i] === 0xF7) { finishSysex(true); return; }
      }
      return;
    }
    if (!d.length) return;
    var st = d[0];
    if (st === 0xF0) {
      sx = { active: true, bytes: [] };
      for (i = 0; i < d.length; i++) {
        if (d[i] >= 0xF8) continue;
        sx.bytes.push(d[i]);
        if (d[i] === 0xF7) { finishSysex(true); return; }
      }
      return;
    }
    if (st >= 0xF8) return;
    var type = st & 0xF0, ch = (st & 0x0F) + 1;
    if (type === 0xB0) {
      emit("midi", "受信 ch" + ch + " CC#" + d[1] + " = " + d[2]);
      var f = CC_TO_FIELD[d[1]];
      if (f && state.loaded) applyPart(ch, f, ccToValue(f, d[2]), "e2");
    } else if (type === 0xC0) {
      emit("midi", "受信 ch" + ch + " プログラムチェンジ " + d[1]);
      if (options.autoReloadOnPattern) {
        cancelVerify();
        setTimeout(function () { requestDump("パターン切替"); }, 300);
      }
    }
  }

  // ---------------- ダンプ ----------------
  var dumpTimer = null, dumpReason = "", dumpT0 = 0, pendingDump = null;

  function requestDump(reason) {
    if (status.busy) { pendingDump = reason || "再要求"; return; }   // 受信中なら終わってからもう一度
    if (status.midi !== "ready") return;
    var msg = [0xF0, 0x42, 0x30 + options.globalCh - 1, 0x00, 0x01, PRODUCT_ID, 0x10, 0xF7];
    dumpReason = reason || "";
    dumpT0 = Date.now();
    sx = null;
    if (!send(msg)) return;
    status.busy = true;
    emit("status", status);
    if (dumpTimer) clearTimeout(dumpTimer);
    dumpTimer = setTimeout(function () {
      if (sx && sx.active) { finishSysex(false); return; }
      status.busy = false;
      emit("status", status);
      emit("error", "e2 から応答がありません（" + dumpReason + "）");
    }, 5000);
  }

  function finishSysex(complete) {
    var b = sx.bytes;
    sx.active = false;
    if (dumpTimer) { clearTimeout(dumpTimer); dumpTimer = null; }
    var isDump = b[0] === 0xF0 && b[1] === 0x42 && b[4] === 0x01 && b[6] === 0x40;
    if (!isDump) {
      emit("midi", "受信 SysEx（ダンプ以外）: " + hexArr(b, 12));
      if (status.busy && b[1] === 0x42) { status.busy = false; emit("status", status); }
      return;
    }
    status.busy = false;
    if (!complete) { emit("error", "ダンプが途中で切れました（" + b.length + " バイト）"); emit("status", status); return; }
    var data = decode7(b.slice(7, b.length - 1));
    if (data.length !== DUMP_SIZE) { emit("error", "ダンプの大きさが想定外：" + data.length); emit("status", status); return; }
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
      playLevel: 127 - data[0x2A]
    };
    var parts = [null];
    for (var p = 1; p <= 16; p++) parts.push(readPart(data, p));

    // 照合：操作で予測していた値と、実際に読んだ値を比べる
    var checks = verifyQueue, mismatches = [], checked = 0;
    verifyQueue = {};
    if (state.loaded) {
      for (var key in checks) {
        var c = checks[key];
        checked++;
        var actual = parts[c.part][c.field];
        if (actual !== c.value) {
          mismatches.push({ part: c.part, field: c.field, expected: c.value, actual: actual, cc: c.cc, source: c.source });
        }
      }
    }

    state.global = g;
    state.parts = parts;
    state.loaded = true;
    state.loadedAt = new Date();
    state.loadMs = ms;
    state.reason = dumpReason;
    emit("loaded", state);
    if (checked) emit("verify", { mismatches: mismatches, checked: checked });
  }

  // ---------------- 状態の更新と照合 ----------------
  var verifyQueue = {};      // "パート:項目" → {part, field, value, cc, source}
  var verifyTimer = null;

  function applyPart(p, field, value, source) {
    if (!state.loaded || !state.parts[p]) return;
    state.parts[p][field] = value;
    emit("part", { part: p, field: field, value: value, source: source });
    verifyQueue[p + ":" + field] = { part: p, field: field, value: value, cc: valueToCc(field, value), source: source };
    scheduleVerify();
  }
  function scheduleVerify() {
    if (!options.verifyAfterEdit) { verifyQueue = {}; return; }
    if (verifyTimer) clearTimeout(verifyTimer);
    verifyTimer = setTimeout(function () { verifyTimer = null; requestDump("照合"); }, options.verifyDelay);
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
    version: "core-v1",
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
